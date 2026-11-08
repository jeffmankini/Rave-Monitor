// Saved scrapes: reuse a recent pull, pull again when the config changes, and keep the
// last good pull when a new one fails or comes back empty.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** How long past its refresh age a saved scrape can stand in for a failed one. Old events still drop out by date. */
export const STALE_LIMIT_DAYS = 30;

/**
 * Settings that change how a scrape runs, is paid for or how far ahead the next one reaches, not what
 * it asks for now; changing them waits for the next scheduled pull instead of forcing one.
 */
const NOT_ASKS = ['maxAgeHours', 'pricePerResultUsd', 'maxChargeUsdPerRun', 'concurrency', 'enabled', 'scrapeDays'];

/** Fingerprint of everything that changes what a source asks for, so editing it triggers a new pull. */
export function scrapeKey(srcId, settings = {}, windowDays = 14, cities = []) {
  const asks = Object.fromEntries(Object.entries(settings).filter(([k]) => !NOT_ASKS.includes(k)));
  const perCity = cities.map(c => [c.id, c.sources?.[srcId] ?? null]);
  return crypto.createHash('sha1').update(JSON.stringify({ asks, windowDays, perCity })).digest('hex').slice(0, 12);
}

function readSaved(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved && Array.isArray(saved.items) && saved.items.length && typeof saved.at === 'number' ? saved : null;
  } catch { return null; }
}

/**
 * Returns { items, cached, stale, at }.
 * cached: the items came from a saved scrape. stale: they did because the new pull failed or came back empty.
 */
export async function loadOrCollect({ file, key, maxAgeHours = 24, fresh = false, now = Date.now(), collect, warn = () => {} }) {
  const saved = readSaved(file);
  if (!fresh && saved && saved.key === key && now - saved.at < maxAgeHours * 3600e3) {
    return { items: saved.items, cached: true, stale: false, at: saved.at };
  }
  let items = null, failure = null;
  try { items = await collect(); } catch (err) { failure = err; }
  if (items && items.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: now, key, items }));
    return { items, cached: false, stale: false, at: now };
  }
  if (saved && now - saved.at < maxAgeHours * 3600e3 + STALE_LIMIT_DAYS * 86400e3) {
    const why = failure ? failure.message : 'the new scrape came back empty';
    warn(`${why}; showing the scrape from ${new Date(saved.at).toISOString().slice(0, 10)} instead`);
    return { items: saved.items, cached: true, stale: true, at: saved.at };
  }
  if (failure) throw failure;
  return { items: items || [], cached: false, stale: false, at: now };
}

/**
 * Saved scrapes per city, for sources that run one scrape per city. Fixing one city's page or adding
 * a city only pulls that city again, and a city whose pull fails keeps its own last good scrape.
 * Tallies what happened in stats: scraped, saved, stale, scrapedItems, oldestAt.
 */
export function cityCache({ dir, srcId, settings = {}, windowDays = 14, fresh = false, now = Date.now(), warn = () => {}, stats = {} }) {
  const { cities, ...asks } = settings;
  return async (city, collect) => {
    const got = await loadOrCollect({
      file: path.join(dir, srcId, `${city.id}.json`), key: scrapeKey(srcId, asks, windowDays, [city]),
      maxAgeHours: settings.maxAgeHours || 24, fresh, now, collect, warn: m => warn(`${city.name}: ${m}`)
    });
    const kind = got.stale ? 'stale' : got.cached ? 'saved' : 'scraped';
    stats[kind] = (stats[kind] || 0) + 1;
    if (kind === 'scraped') stats.scrapedItems = (stats.scrapedItems || 0) + got.items.length;
    stats.oldestAt = Math.min(stats.oldestAt ?? got.at, got.at);
    return got.items;
  };
}

/** One-time move from a whole-source saved scrape (items tagged __city) to per-city files. */
export function splitSourceCache({ dir, srcId, settings = {}, windowDays = 14, cities = [] }) {
  const file = path.join(dir, `${srcId}.json`), saved = readSaved(file);
  if (!saved) return 0;
  const { cities: _, ...asks } = settings;
  let moved = 0;
  for (const c of cities) {
    const out = path.join(dir, srcId, `${c.id}.json`);
    const items = saved.items.filter(i => i.__city === c.id).map(({ __city, ...rest }) => rest);
    if (!items.length || fs.existsSync(out)) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ at: saved.at, key: scrapeKey(srcId, asks, windowDays, [c]), items }));
    moved++;
  }
  fs.rmSync(file);
  return moved;
}
