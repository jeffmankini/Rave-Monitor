// Clubs and music venues from OpenStreetMap for the map's venues layer: every one around each city,
// including the places that haven't had a listing yet. Fetched from the Overpass API about once a week
// into the archive branch; the site serves the files as they are.
// The data is © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0).
//
//   node pipeline/osm.js <archive-dir> [--force]
//
// osm/<cityId>.json: { city, updatedAt, license, clubs: [[id, name, lat, lon, kind, address, website, otherName], ...] }
//   id: OpenStreetMap element, 'n123' (node), 'w123' (way) or 'r123' (relation); kind: 0 club, 1 music venue
//   updatedAt: when this city's list last changed
// osm/index.json: { updatedAt, license, checked: { cityId: when last fetched }, clubs: [[cityId, id, name, otherName?], ...] },
//   the names for search
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { km } from './lib/util.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const USER_AGENT = 'RaveMonitor/1.0 (+https://ravemonitor.com; a weekly list of clubs for its map)';
export const LICENSE = 'Data © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0): https://www.openstreetmap.org/copyright';
export const RADIUS_KM = 30;
const WEEK = 7 * 864e5;

/** The box around a city that its clubs come from: [south, west, north, east]. */
export function bboxOf(c, radiusKm = RADIUS_KM) {
  const dLat = radiusKm / 111.32, dLon = radiusKm / (111.32 * Math.max(0.2, Math.cos(c.lat * Math.PI / 180)));
  return [c.lat - dLat, c.lon - dLon, c.lat + dLat, c.lon + dLon].map(v => +v.toFixed(4));
}

/** One Overpass query for a group of cities: their clubs and music venues, with a centre for buildings. */
export function overpassQuery(cities) {
  return '[out:json][timeout:180];(' +
    cities.map(c => `nwr["amenity"~"^(nightclub|music_venue)$"](${bboxOf(c).join(',')});`).join('') +
    ');out center tags qt;';
}

const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// Where the house number goes before the street name ("12 Brick Lane"); elsewhere it follows it ("Am Wriezener Bahnhof 1").
const NUMBER_FIRST = new Set(['US', 'CA', 'GB', 'IE', 'FR', 'AU', 'NZ', 'ZA', 'SG', 'PH', 'IN', 'AE', 'KE', 'NG', 'HK', 'MY', 'TH']);
// Not what the map is for, whatever they're tagged as.
const ADULT = /\b(strip ?club|gentlemen'?s club|go-?go bar|table ?dance|peep ?show|lap ?dance)\b/i;

function addressOf(t, country) {
  if (t['addr:full']) return clean(t['addr:full']).slice(0, 120);
  const street = clean(t['addr:street'] || t['addr:place']), num = clean(t['addr:housenumber']);
  if (!street) return '';
  return (num ? (NUMBER_FIRST.has(country) ? num + ' ' + street : street + ' ' + num) : street).slice(0, 120);
}
function websiteOf(t) {
  let w = clean(String(t.website || t['contact:website'] || t.url || '').split(';')[0]);
  if (!w) return '';
  if (!/^https?:\/\//i.test(w)) w = 'https://' + w.replace(/^\/+/, '');
  try {
    const u = new URL(w);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') && w.length <= 200 ? w : '';
  } catch { return ''; }
}
// A second name that helps match listings: the English one, or a known other name.
function otherNameOf(t, name) {
  const alt = clean(t['name:en'] || t['name:latin'] || String(t.alt_name || '').split(';')[0]);
  return alt && alt.toLowerCase() !== name.toLowerCase() ? alt : '';
}

/**
 * Overpass elements as rows per city. Each place goes to the nearest of all the cities whose box
 * holds it, and only the cities in `group` (the ones fetched) are filled.
 */
export function parseElements(elements, group, allCities = group) {
  const out = Object.fromEntries(group.map(c => [c.id, []]));
  const boxes = allCities.map(c => ({ c, b: bboxOf(c) }));
  const seen = new Set();
  for (const el of elements || []) {
    const t = el.tags || {}, name = clean(t.name);
    const lat = Number.isFinite(el.lat) ? el.lat : el.center?.lat, lon = Number.isFinite(el.lon) ? el.lon : el.center?.lon;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (ADULT.test(name) || /strip/i.test(t.nightclub || '')) continue;
    const id = String(el.type || 'node')[0] + el.id;
    if (seen.has(id)) continue;
    seen.add(id);
    let best = null, bd = Infinity;
    for (const { c, b } of boxes) {
      if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
      const d = km(lat, lon, c.lat, c.lon);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best || !out[best.id]) continue;
    const row = [id, name, +lat.toFixed(5), +lon.toFixed(5), t.amenity === 'music_venue' ? 1 : 0, addressOf(t, best.country), websiteOf(t)];
    const other = otherNameOf(t, name);
    if (other) row.push(other);
    out[best.id].push(row);
  }
  for (const list of Object.values(out)) list.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  return out;
}

async function overpass(query, fetchImpl, log, timeoutMs) {
  for (const url of ENDPOINTS) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST', body: new URLSearchParams({ data: query }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!Array.isArray(json.elements)) throw new Error('no elements in the answer');
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark.slice(0, 120));
      return json;
    } catch (err) {
      log(`  Overpass at ${new URL(url).host}: ${err.message}`);
    }
  }
  return null;
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch the clubs for every city whose list is a week old (or all, with force), a few cities per query.
 * A city whose query fails keeps its last list and is tried again on the next run. A run stops starting
 * queries after `budgetMs`, so a slow Overpass never holds up the site: what's left is due next run.
 */
export async function refreshOsm(dir, cities, { force = false, now = Date.now(), fetchImpl = globalThis.fetch, log = console.log, batch = 6, pause = 3000, timeoutMs = 90e3, budgetMs = 5 * 60e3 } = {}) {
  const started = Date.now();
  const osmDir = path.join(dir, 'osm');
  fs.mkdirSync(osmDir, { recursive: true });
  const indexFile = path.join(osmDir, 'index.json');
  const index = readJson(indexFile) || {};
  const checked = { ...(index.checked || {}) };
  const placed = cities.filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  const due = placed.filter(c => force || !checked[c.id] || now - Date.parse(checked[c.id]) > WEEK);
  if (!due.length) { log('OpenStreetMap clubs: up to date.'); return { fetched: 0, changed: 0 }; }
  const iso = new Date(now).toISOString();
  let fetched = 0, changed = 0;
  for (let i = 0; i < due.length; i += batch) {
    const group = due.slice(i, i + batch);
    if (Date.now() - started > budgetMs) { log(`  Out of time; ${due.length - i} cities wait for the next run.`); break; }
    if (i) await sleep(pause); // one query at a time, with a pause: Overpass is a shared, free service
    const json = await overpass(overpassQuery(group), fetchImpl, log, timeoutMs);
    if (!json) { log(`  Kept the last lists for ${group.map(c => c.id).join(', ')}.`); continue; }
    log(`  ${group.map(c => c.id).join(', ')}: ${json.elements.length} places.`);
    const rows = parseElements(json.elements, group, placed);
    for (const c of group) {
      const file = path.join(osmDir, `${c.id}.json`), old = readJson(file);
      checked[c.id] = iso;
      fetched++;
      if (old && JSON.stringify(old.clubs) === JSON.stringify(rows[c.id])) continue;
      fs.writeFileSync(file, JSON.stringify({ city: c.id, updatedAt: iso, license: LICENSE, clubs: rows[c.id] }) + '\n');
      changed++;
    }
  }
  // The search index: every city's names.
  const names = [];
  for (const c of placed) {
    const list = readJson(path.join(osmDir, `${c.id}.json`))?.clubs || [];
    for (const r of list) names.push(r[7] ? [c.id, r[0], r[1], r[7]] : [c.id, r[0], r[1]]);
  }
  fs.writeFileSync(indexFile, JSON.stringify({ updatedAt: iso, license: LICENSE, checked, clubs: names }) + '\n');
  log(`OpenStreetMap clubs: fetched ${fetched} of ${due.length} cities due, ${changed} changed, ${names.length} places in all.`);
  return { fetched, changed, places: names.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dir = args.find(a => !a.startsWith('--'));
  if (!dir) { console.error('usage: node pipeline/osm.js <archive-dir> [--force]'); process.exit(2); }
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'config', 'cities.json'), 'utf8'));
  const cities = Array.isArray(conf) ? conf : conf.cities || Object.values(conf);
  refreshOsm(dir, cities, { force: args.includes('--force') }).catch(err => { console.error('OpenStreetMap refresh failed:', err.message); process.exit(1); });
}
