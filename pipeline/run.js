#!/usr/bin/env node
// Builds public/events.json: collect from every enabled source, keep electronic music,
// normalize to one shape, merge duplicates across platforms, write the feed.
//
//   node pipeline/run.js            real run (needs APIFY_TOKEN and/or API keys)
//   node pipeline/run.js --sample   offline run on the sample data in pipeline/sample
//   node pipeline/run.js --only ra,dice --fresh
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runActor, setMemoryBudget, setMaxRuns } from './lib/apify.js';
import { loadOrCollect, scrapeKey, cityCache, splitSourceCache } from './lib/cache.js';
import { dedupe } from './lib/dedupe.js';
import { ra, dice, posh, partiful, luma } from './sources/apify-sources.js';
import { ticketmaster, skiddle } from './sources/api-sources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [ra, dice, ticketmaster, skiddle, posh, luma, partiful];
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

function loadEnv() {
  const env = { ...process.env };
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return env;
}

/** Sample mode: move the fixed sample dates so they land in the coming days. */
function shiftDates(value, deltaMs) {
  if (Array.isArray(value)) return value.map(v => shiftDates(v, deltaMs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftDates(v, deltaMs)]));
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)) {
    const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(value);
    const ms = Date.parse(hasZone ? value : value.replace(/(\.\d+)?$/, '') + 'Z') + deltaMs;
    const iso = new Date(ms).toISOString();
    return hasZone ? iso : iso.replace(/\.\d+Z$/, value.includes('.') ? '.000' : '').replace(/Z$/, '');
  }
  return value;
}

async function main() {
  const sample = flag('sample'), fresh = flag('fresh');
  const only = opt('only') ? opt('only').split(',') : null;
  const outDir = path.resolve(ROOT, opt('out') || 'public');
  const cacheDir = path.join(ROOT, 'cache');
  const env = loadEnv();
  const cityCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/cities.json'), 'utf8'));
  const srcCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/sources.json'), 'utf8'));
  const now = Date.now();
  const from = now - 6 * 3600e3, to = now + (srcCfg.windowDays || 14) * 86400e3;
  const cities = structuredClone(cityCfg.cities);
  const cityById = Object.fromEntries(cities.map(c => [c.id, c]));
  const SAMPLE_ANCHOR = Date.parse('2026-11-12T00:00:00Z');
  // Shift by whole weeks so weekdays stay put (a Saturday party stays on a Saturday).
  const sampleDelta = Math.ceil((now - SAMPLE_ANCHOR - 86400e3) / (7 * 86400e3)) * 7 * 86400e3;

  const all = [], report = [];
  const windowDays = srcCfg.windowDays || 14;
  setMemoryBudget(srcCfg.apifyMemoryMb);
  setMaxRuns(srcCfg.apifyMaxRuns);
  const tasks = SOURCES.filter(s => (!only || only.includes(s.id)) && srcCfg.sources[s.id] && srcCfg.sources[s.id].enabled !== false);

  await Promise.all(tasks.map(async src => {
    const settings = srcCfg.sources[src.id];
    const t0 = Date.now(), warnings = [];
    const entry = { id: src.id, label: src.label, ok: false, raw: 0, kept: 0, cached: false, estCostUsd: 0, ms: 0, error: null, warnings };
    report.push(entry);
    const ctx = {
      // A source can scrape further ahead (scrapeDays) than the feed shows, so a monthly pull covers the month.
      cities, cityById, settings, env, from, to: now + (settings.scrapeDays || windowDays) * 86400e3,
      log: (...m) => console.log(`[${src.id}]`, ...m),
      warn: m => { warnings.push(m); console.warn(`[${src.id}] ${m}`); },
      apify: async (actor, input, o = {}) => {
        const r = await runActor(actor, input, { token: env.APIFY_TOKEN, log: m => console.log(`[${src.id}]${m}`), ...o });
        entry.runs = (entry.runs || 0) + 1;
        return r;
      }
    };
    try {
      let raw;
      const cacheFile = path.join(cacheDir, `${src.id}.json`);
      if (sample) {
        const f = path.join(ROOT, 'pipeline/sample', `${src.id}.json`);
        raw = fs.existsSync(f) ? shiftDates(JSON.parse(fs.readFileSync(f, 'utf8')), sampleDelta) : [];
      } else {
        const missing = src.needs.filter(k => !env[k]);
        if (missing.length) { entry.error = `skipped: set ${missing.join(' and ')}`; console.log(`[${src.id}] ${entry.error}`); return; }
        if (src.perCity) {
          // One scrape per city, each saved on its own (see cityCache).
          const moved = splitSourceCache({ dir: cacheDir, srcId: src.id, settings, windowDays, cities: cityCfg.cities });
          if (moved) console.log(`[${src.id}] split the saved scrape into ${moved} city files`);
          const stats = {};
          ctx.cachedCity = cityCache({ dir: cacheDir, srcId: src.id, settings, windowDays, fresh, now, warn: ctx.warn, stats });
          raw = await src.collect(ctx);
          entry.cityRuns = { scraped: stats.scraped || 0, saved: stats.saved || 0, stale: stats.stale || 0 };
          entry.cached = !stats.scraped && (stats.saved || stats.stale) > 0;
          if (entry.cached && stats.stale) entry.stale = true;
          if (stats.oldestAt) entry.scrapedAt = new Date(stats.oldestAt).toISOString();
          entry.estCostUsd = +((stats.scrapedItems || 0) * (settings.pricePerResultUsd || 0)).toFixed(3);
          console.log(`[${src.id}] cities: ${entry.cityRuns.scraped} scraped, ${entry.cityRuns.saved} saved, ${entry.cityRuns.stale} kept from an earlier scrape`);
        } else {
          const got = await loadOrCollect({
            file: cacheFile, fresh, now, warn: ctx.warn,
            key: scrapeKey(src.id, settings, windowDays, cityCfg.cities),
            maxAgeHours: settings.maxAgeHours || 24,
            collect: () => src.collect(ctx)
          });
          raw = got.items;
          entry.cached = got.cached; entry.scrapedAt = new Date(got.at).toISOString();
          if (got.stale) entry.stale = true;
          if (got.cached) console.log(`[${src.id}] using the ${got.stale ? 'last good' : 'saved'} scrape from ${entry.scrapedAt} (${raw.length} items)`);
          else entry.estCostUsd = +(raw.length * (settings.pricePerResultUsd || 0)).toFixed(3);
        }
      }
      entry.raw = raw.length;
      // Counts only, so a run can be tuned from the public feed without publishing what was dropped.
      entry.filtered = 0; entry.outsideWindow = 0;
      for (const item of raw) {
        try {
          const e = src.normalize(item, ctx);
          if (!e) entry.filtered++;
          else if (Date.parse(e.end) > from && Date.parse(e.start) < to) { all.push(e); entry.kept++; }
          else entry.outsideWindow++;
        } catch (err) { warnings.push(`item skipped: ${err.message}`); }
      }
      entry.ok = true;
    } catch (err) {
      entry.error = err.message;
      console.error(`[${src.id}] failed: ${err.message}`);
    } finally {
      entry.ms = Date.now() - t0;
      if (warnings.length > 20) entry.warnings = warnings.slice(0, 20).concat(`…and ${warnings.length - 20} more`);
    }
  }));

  const { events, merged } = dedupe(all);
  events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const usedCities = [...new Set(events.map(e => e.cityId))].map(id => cityById[id]).filter(Boolean)
    .map(({ id, name, country, lat, lon, tz, region, currency }) => ({ id, name, country, lat, lon, tz, region, currency }));
  report.sort((a, b) => SOURCES.findIndex(s => s.id === a.id) - SOURCES.findIndex(s => s.id === b.id));
  // The feed is public: make sure no key ever rides along in an error message.
  const secrets = ['APIFY_TOKEN', 'TICKETMASTER_KEY', 'SKIDDLE_KEY', 'NETLIFY_AUTH_TOKEN'].map(k => env[k]).filter(v => v && v.length >= 6);
  const scrub = s => secrets.reduce((t, v) => t.split(v).join('***'), String(s));
  for (const r of report) { if (r.error) r.error = scrub(r.error); r.warnings = r.warnings.map(scrub); }

  const feed = {
    version: 1, generatedAt: new Date(now).toISOString(), sample: sample || undefined,
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    sources: report, merged, cities: usedCities, events
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(feed));
  const cost = report.reduce((s, r) => s + (r.estCostUsd || 0), 0);
  console.log('\nSource          raw   kept  note');
  for (const r of report) console.log(`${r.label.padEnd(15)} ${String(r.raw).padStart(4)}  ${String(r.kept).padStart(5)}  ${r.error || (r.stale ? 'last good scrape' : r.cached ? 'cached' : r.ok ? 'ok' : '')}${r.estCostUsd ? `  ~$${r.estCostUsd}` : ''}`);
  console.log(`\n${events.length} events in ${usedCities.length} cities after merging ${merged} duplicates. Estimated scraper cost this run: $${cost.toFixed(2)}.`);
  console.log(`Wrote ${path.relative(ROOT, path.join(outDir, 'events.json'))}`);
}

main().catch(err => { console.error(err); process.exit(1); });
