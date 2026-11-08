// Saved scrapes: reuse a recent pull, pull again when the config changes, and keep the
// last good pull when a new one fails or comes back empty.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** How long a saved scrape can stand in for a failed one. Old events still drop out by date. */
export const STALE_LIMIT_DAYS = 30;

/** Fingerprint of everything that changes what a source asks for, so editing it triggers a new pull. */
export function scrapeKey(srcId, settings = {}, windowDays = 14, cities = []) {
  const { maxAgeHours, pricePerResultUsd, ...asks } = settings;
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
  if (saved && now - saved.at < STALE_LIMIT_DAYS * 86400e3) {
    const why = failure ? failure.message : 'the new scrape came back empty';
    warn(`${why}; showing the scrape from ${new Date(saved.at).toISOString().slice(0, 10)} instead`);
    return { items: saved.items, cached: true, stale: true, at: saved.at };
  }
  if (failure) throw failure;
  return { items: items || [], cached: false, stale: false, at: now };
}
