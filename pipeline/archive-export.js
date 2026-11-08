#!/usr/bin/env node
// Turns the archive into downloads for the site: archive.sqlite, events.csv and summary.json.
//
//   node pipeline/archive-export.js <archive-dir> <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArchive, summarize } from './archive.js';

// Lineup entries that aren't artists, left out of the artists table.
const PLACEHOLDER = /^(tba|tbc|tbd|tba\.?|more tba|special guests?|secret guests?|guests?|and more|\+ ?more|lineup tba|line-up tba)$/i;
const csvCell = v => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** Flat rows shared by the CSV and the database. */
export function rows(archive) {
  return [...archive.records.values()].sort((a, b) => a.start.localeCompare(b.start)).map(r => {
    const c = archive.cities[r.cityId] || {};
    return {
      id: r.id, title: r.title, start: r.start, end: r.end || null, tz: r.tz || null,
      city_id: r.cityId || null, city: c.name || null, country: c.country || null,
      venue: r.venue?.name || null, address: r.venue?.address || null,
      lat: Number.isFinite(r.venue?.lat) ? r.venue.lat : null, lon: Number.isFinite(r.venue?.lon) ? r.venue.lon : null,
      type: r.type || null, genres: r.genres.join(', '), tags: r.tags.join(', '), lineup: r.lineup.join(', '),
      price_min: r.price?.min ?? null, price_max: r.price?.max ?? null, currency: r.price?.currency || null,
      status: r.status || null, listed_on: r.sources.map(s => s.name).join(', '), links: r.sources.map(s => s.url).filter(Boolean).join(' '),
      first_seen: r.firstSeen, last_seen: r.lastSeen
    };
  });
}

export async function exportArchive(dir, out) {
  const archive = loadArchive(dir);
  fs.mkdirSync(out, { recursive: true });
  const flat = rows(archive);
  const cols = Object.keys(flat[0] || { id: 1 });
  fs.writeFileSync(path.join(out, 'events.csv'), [cols.join(','), ...flat.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summarize(archive), null, 1) + '\n');

  // Node's built-in SQLite (Node 22.5+). Without it, the CSV and summary are still written.
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { return { events: flat.length, sqlite: false }; }
  const file = path.join(out, 'archive.sqlite');
  fs.rmSync(file, { force: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE events (${cols.map(c => `${c} ${['lat', 'lon', 'price_min', 'price_max'].includes(c) ? 'REAL' : 'TEXT'}${c === 'id' ? ' PRIMARY KEY' : ''}`).join(', ')});
    CREATE TABLE event_artists (event_id TEXT, artist TEXT);
    CREATE TABLE event_sources (event_id TEXT, source TEXT, url TEXT);
    CREATE TABLE event_status (event_id TEXT, status TEXT, seen_at TEXT);
    CREATE TABLE cities (id TEXT PRIMARY KEY, name TEXT, country TEXT, lat REAL, lon REAL, tz TEXT);
  `);
  const insEvent = db.prepare(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const insArtist = db.prepare('INSERT INTO event_artists VALUES (?, ?)');
  const insSource = db.prepare('INSERT INTO event_sources VALUES (?, ?, ?)');
  const insStatus = db.prepare('INSERT INTO event_status VALUES (?, ?, ?)');
  const insCity = db.prepare('INSERT INTO cities VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const r of flat) insEvent.run(...cols.map(c => r[c]));
  for (const r of archive.records.values()) {
    for (const a of r.lineup) if (!PLACEHOLDER.test(a.trim())) insArtist.run(r.id, a);
    for (const s of r.sources) insSource.run(r.id, s.name, s.url || null);
    for (const s of r.statusLog) insStatus.run(r.id, s.status, s.at);
  }
  for (const [id, c] of Object.entries(archive.cities)) insCity.run(id, c.name ?? null, c.country ?? null, c.lat ?? null, c.lon ?? null, c.tz ?? null);
  db.exec(`COMMIT;
    CREATE INDEX events_start ON events (start);
    CREATE INDEX events_city ON events (city_id, start);
    CREATE INDEX artists_name ON event_artists (artist);`);
  db.close();
  return { events: flat.length, sqlite: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) { console.error('usage: node pipeline/archive-export.js <archive-dir> <out-dir>'); process.exit(2); }
  const r = await exportArchive(dir, out);
  console.log(`Archive export: ${r.events} events to ${out} (events.csv, summary.json${r.sqlite ? ', archive.sqlite' : ''}).`);
}
