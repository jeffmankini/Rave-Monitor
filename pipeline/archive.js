#!/usr/bin/env node
// The living archive: every listing the feed has ever shown, merged across platforms and kept after
// the night is over. Stored as one NDJSON file per month (events/YYYY-MM.ndjson, by local date) in
// the archive branch, plus cities.json and summary.json.
//
//   node pipeline/archive.js <archive-dir> <events.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isContactLine, positionQuality, jitter, splitLineup, genresFrom, fallbackGenre } from './lib/normalize.js';
import { detectLabels, detectPromoters, mergePromoters } from './lib/labels.js';
import { norm } from './lib/util.js';

const uniq = a => [...new Set(a.filter(x => x !== undefined && x !== null && x !== ''))];

/** Everything that identifies one listing: its feed id and each platform page it links to. */
export const keysOf = e => uniq([e.id, ...(e.sources || []).map(s => s.url)]);

/** Local year-month of an event, for its archive file. */
export function monthOf(rec) {
  const d = new Date(rec.start);
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: rec.tz || 'UTC', year: 'numeric', month: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}`;
  } catch { return d.toISOString().slice(0, 7); }
}

export function loadArchive(dir) {
  const records = new Map();
  const evDir = path.join(dir, 'events');
  if (fs.existsSync(evDir)) {
    for (const f of fs.readdirSync(evDir).filter(f => f.endsWith('.ndjson')).sort()) {
      for (const line of fs.readFileSync(path.join(evDir, f), 'utf8').split('\n')) if (line.trim()) {
        const r = JSON.parse(line); records.set(r.id, r);
      }
    }
  }
  const cityFile = path.join(dir, 'cities.json');
  const cities = fs.existsSync(cityFile) ? JSON.parse(fs.readFileSync(cityFile, 'utf8')) : {};
  for (const r of records.values()) tidy(r, cities);
  return { records, cities };
}

/**
 * Clean up records saved before the feed's own checks: free-text and contact lines in lineups, venues
 * at 0,0. Labels are worked out again each time, so additions to config/labels.json reach old nights.
 */
function tidy(r, cities) {
  if (Array.isArray(r.lineup)) r.lineup = [...new Set(splitLineup(r.lineup).filter(n => !isContactLine(n)))];
  // Nights saved before the 'electronic' and 'misc' buckets said 'other' (or nothing).
  if (!Array.isArray(r.genres) || !r.genres.length || (r.genres.length === 1 && r.genres[0] === 'other')) {
    const fam = genresFrom(r.title, r.tags || []);
    r.genres = fam.length ? fam : [fallbackGenre({ title: r.title, tags: r.tags || [], source: (r.sources && r.sources[0] && r.sources[0].id) || '' })];
  } else r.genres = r.genres.filter(g => g !== 'other');
  const labels = detectLabels(r);
  if (labels.length) r.labels = labels; else delete r.labels;
  // Curated promoters and event series too (config/promoters.json), so additions reach old nights.
  const promoters = mergePromoters(r.promoters, detectPromoters(r));
  if (promoters.length) r.promoters = promoters; else delete r.promoters;
  const v = r.venue, c = cities[r.cityId];
  if (v && c && positionQuality(v.lat, v.lon) === 'none') {
    const [lat, lon] = jitter(`${r.cityId}:${norm(v.name || r.id)}`, c.lat, c.lon);
    r.venue = { ...v, lat: +lat.toFixed(5), lon: +lon.toFixed(5), approx: true };
  }
}

const FIELDS = ['title', 'start', 'end', 'tz', 'cityId', 'venue', 'type', 'price', 'age', 'popularity'];

/** Fold one feed into the archive. Returns counts of new and updated listings. */
// Dates are kept to the day, so each daily run changes only what actually changed.
export function mergeFeed(archive, feed, now = new Date().toISOString().slice(0, 10)) {
  const { records, cities } = archive;
  const index = new Map();
  for (const r of records.values()) for (const k of r.keys) index.set(k, r.id);
  for (const c of feed.cities || []) cities[c.id] = { name: c.name, country: c.country, lat: c.lat, lon: c.lon, tz: c.tz };
  let added = 0, updated = 0;
  for (const e of feed.events || []) {
    const keys = keysOf(e);
    const ids = uniq(keys.map(k => index.get(k)));
    let rec;
    if (!ids.length) {
      rec = { id: e.id, keys: [], firstSeen: now, sources: [], lineup: [], genres: [], tags: [], statusLog: [] };
      records.set(rec.id, rec); added++;
    } else {
      // The feed can merge listings the archive still holds apart (a night seen on Ticketmaster one
      // day and on RA the next): fold the extra records into the oldest one.
      const found = ids.map(id => records.get(id)).sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
      rec = found[0];
      for (const extra of found.slice(1)) {
        rec.keys = uniq([...rec.keys, ...extra.keys]);
        for (const f of ['lineup', 'genres', 'tags']) rec[f] = uniq([...rec[f], ...extra[f]]);
        for (const f of ['labels', 'promoters']) if (extra[f]) rec[f] = uniq([...(rec[f] || []), ...extra[f]]);
        rec.sources = mergeSources(rec.sources, extra.sources);
        rec.statusLog = [...rec.statusLog, ...extra.statusLog].sort((a, b) => a.at.localeCompare(b.at));
        records.delete(extra.id);
      }
      updated++;
    }
    for (const f of FIELDS) if (e[f] !== undefined && e[f] !== null) rec[f] = e[f];
    if (e.sets && e.sets.length) rec.sets = e.sets;
    rec.keys = uniq([...rec.keys, ...keys]);
    rec.lineup = uniq([...rec.lineup, ...(e.lineup || [])]);
    rec.genres = uniq([...rec.genres, ...(e.genres || [])]);
    rec.tags = uniq([...rec.tags, ...(e.tags || [])]);
    for (const f of ['labels', 'promoters']) if (e[f] && e[f].length) rec[f] = uniq([...(rec[f] || []), ...e[f]]);
    rec.sources = mergeSources(rec.sources, (e.sources || []).map(s => ({ name: s.name, url: s.url })));
    if (e.status && (rec.statusLog.at(-1) || {}).status !== e.status) rec.statusLog.push({ status: e.status, at: now });
    rec.status = e.status || rec.status;
    rec.lastSeen = now;
    for (const k of rec.keys) index.set(k, rec.id);
  }
  return { added, updated };
}

function mergeSources(a, b) {
  const out = [...a];
  for (const s of b) if (!out.some(x => (x.url && x.url === s.url) || (!x.url && x.name === s.name))) out.push(s);
  return out;
}

export function summarize(archive, now = new Date().toISOString().slice(0, 10)) {
  const tally = (m, k) => { if (k) m[k] = (m[k] || 0) + 1; };
  const months = {}, cities = {}, genres = {}, sources = {};
  let first = null, last = null;
  for (const r of archive.records.values()) {
    tally(months, monthOf(r)); tally(cities, r.cityId);
    for (const g of r.genres) tally(genres, g);
    for (const s of r.sources) tally(sources, s.name);
    if (!first || r.start < first) first = r.start;
    if (!last || r.start > last) last = r.start;
  }
  const sortDesc = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  return {
    updatedAt: now, events: archive.records.size, firstEvent: first, lastEvent: last,
    months: Object.fromEntries(Object.entries(months).sort()), cities: sortDesc(cities), genres: sortDesc(genres), sources: sortDesc(sources)
  };
}

const ARCHIVE_README = `# Rave Monitor archive

Every listing [Rave Monitor](https://ravemonitor.com) has shown, merged across platforms and kept after
the night is over. Updated by the daily refresh job; don't edit by hand.

- \`events/YYYY-MM.ndjson\`: one JSON object per line, filed by the event's local month. Each has the
  event facts (title, start, end, tz, cityId, venue, lineup, genres, tags, type, price, status, and
  record labels and promoter names when known), the
  platforms it was listed on (\`sources\`), when it was first and last seen, and \`statusLog\`
  (status changes such as sold out or cancelled, with when they were seen).
- \`cities.json\`: names and coordinates for each \`cityId\`.
- \`summary.json\`: counts by month, city, genre and platform.
- \`osm/\`: clubs and music venues around each city from OpenStreetMap, refreshed weekly, for the map's
  venues layer (\`osm/<city>.json\`, and \`osm/index.json\` with their names for search). That data is
  © OpenStreetMap contributors and available under the Open Database License (ODbL 1.0):
  https://www.openstreetmap.org/copyright

Event facts only: no descriptions, attendee lists or organizer contact details. The site also offers
the whole archive as a SQLite database and a CSV file.
`;

/** Write the archive back, touching only files whose contents changed. */
export function writeArchive(dir, archive, now = new Date().toISOString().slice(0, 10)) {
  const evDir = path.join(dir, 'events');
  fs.mkdirSync(evDir, { recursive: true });
  const byMonth = {};
  for (const r of archive.records.values()) (byMonth[monthOf(r)] ||= []).push(r);
  const write = (file, text) => { if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text); };
  for (const [m, list] of Object.entries(byMonth)) {
    list.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    write(path.join(evDir, `${m}.ndjson`), list.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  for (const f of fs.readdirSync(evDir)) if (f.endsWith('.ndjson') && !byMonth[f.slice(0, -7)]) fs.rmSync(path.join(evDir, f));
  write(path.join(dir, 'cities.json'), JSON.stringify(Object.fromEntries(Object.entries(archive.cities).sort()), null, 1) + '\n');
  write(path.join(dir, 'summary.json'), JSON.stringify(summarize(archive, now), null, 1) + '\n');
  write(path.join(dir, 'README.md'), ARCHIVE_README);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, feedFile] = process.argv.slice(2);
  if (!dir || !feedFile) { console.error('usage: node pipeline/archive.js <archive-dir> <events.json>'); process.exit(2); }
  const feed = JSON.parse(fs.readFileSync(feedFile, 'utf8'));
  if (feed.sample) { console.log('Sample feed: not archived.'); process.exit(0); }
  const archive = loadArchive(dir);
  const { added, updated } = mergeFeed(archive, feed);
  writeArchive(dir, archive);
  console.log(`Archive: ${added} new and ${updated} updated listings; ${archive.records.size} in total.`);
}
