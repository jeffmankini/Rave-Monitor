import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keysOf, monthOf, loadArchive, mergeFeed, writeArchive, pruneArchive } from '../pipeline/archive.js';
import { exportArchive } from '../pipeline/archive-export.js';

const ev = (over = {}) => ({
  id: 'ra:1', title: 'Body Heat', start: '2026-11-14T22:00:00.000Z', end: '2026-11-15T05:00:00.000Z', tz: 'Europe/London', cityId: 'london',
  venue: { name: 'Corsica Studios', lat: 51.49, lon: -0.1 }, lineup: ['Objekt'], genres: ['techno'], tags: ['Techno'], type: 'club',
  price: { min: 15, max: 15, currency: 'GBP' }, status: 'onsale', sources: [{ id: 'ra', name: 'Resident Advisor', url: 'https://ra.co/events/1' }], ...over
});
const feed = (events, cities = [{ id: 'london', name: 'London', country: 'GB', lat: 51.5, lon: -0.12, tz: 'Europe/London' }]) => ({ cities, events });
const empty = () => ({ records: new Map(), cities: {} });

test('listings are keyed by feed id and platform pages, and filed by local month', () => {
  assert.deepEqual(keysOf(ev()), ['ra:1', 'https://ra.co/events/1']);
  assert.equal(monthOf({ start: '2026-12-01T03:00:00.000Z', tz: 'America/New_York' }), '2026-11');
  assert.equal(monthOf({ start: '2026-12-01T03:00:00.000Z', tz: 'Europe/Berlin' }), '2026-12');
});

test('the same night seen again under another platform updates one record and logs status changes', () => {
  const a = empty();
  const counts = ({ added, updated }) => ({ added, updated });
  assert.deepEqual(counts(mergeFeed(a, feed([ev()]), '2026-11-08')), { added: 1, updated: 0 });
  const later = ev({ id: 'dice:9', status: 'soldout', lineup: ['Objekt', 'Call Super'],
    sources: [{ id: 'dice', name: 'DICE', url: 'https://dice.fm/event/9' }, { id: 'ra', name: 'Resident Advisor', url: 'https://ra.co/events/1' }] });
  assert.deepEqual(counts(mergeFeed(a, feed([later]), '2026-11-10')), { added: 0, updated: 1 });
  const r = a.records.get('ra:1');
  assert.equal(a.records.size, 1);
  assert.deepEqual(r.sources.map(s => s.name), ['Resident Advisor', 'DICE']);
  assert.deepEqual(r.lineup, ['Objekt', 'Call Super']);
  assert.deepEqual(r.statusLog, [{ status: 'onsale', at: '2026-11-08' }, { status: 'soldout', at: '2026-11-10' }]);
  assert.equal(r.firstSeen, '2026-11-08'); assert.equal(r.lastSeen, '2026-11-10');
  assert.equal(a.cities.london.name, 'London');
});

test('two archived records the feed later merges become one, keeping the older', () => {
  const a = empty();
  mergeFeed(a, feed([ev()]), '2026-11-08');
  mergeFeed(a, feed([ev({ id: 'skiddle:5', sources: [{ id: 'skiddle', name: 'Skiddle', url: 'https://skiddle.com/e/5' }] })]), '2026-11-09');
  assert.equal(a.records.size, 2);
  mergeFeed(a, feed([ev({ sources: [{ id: 'ra', name: 'Resident Advisor', url: 'https://ra.co/events/1' }, { id: 'skiddle', name: 'Skiddle', url: 'https://skiddle.com/e/5' }] })]), '2026-11-10');
  assert.equal(a.records.size, 1);
  assert.deepEqual([...a.records.keys()], ['ra:1']);
  assert.deepEqual(a.records.get('ra:1').sources.map(s => s.name), ['Resident Advisor', 'Skiddle']);
});

test('the archive round-trips through its files, and a moved date leaves no empty month behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-archive-'));
  const a = empty();
  mergeFeed(a, feed([ev(), ev({ id: 'ra:2', start: '2026-12-05T22:00:00.000Z', sources: [{ id: 'ra', name: 'Resident Advisor', url: 'https://ra.co/events/2' }] })]), '2026-11-08');
  writeArchive(dir, a);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'events')).sort(), ['2026-11.ndjson', '2026-12.ndjson']);
  const b = loadArchive(dir);
  assert.equal(b.records.size, 2);
  mergeFeed(b, feed([ev({ id: 'ra:2', start: '2026-11-28T22:00:00.000Z', sources: [{ id: 'ra', name: 'Resident Advisor', url: 'https://ra.co/events/2' }] })]), '2026-11-09');
  writeArchive(dir, b);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'events')), ['2026-11.ndjson']);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  assert.equal(summary.events, 2); assert.deepEqual(summary.months, { '2026-11': 2 });
});

test('the archive exports to CSV and, where Node has SQLite, a database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-export-'));
  const a = empty();
  mergeFeed(a, feed([ev({ title: 'Body Heat, "late"', lineup: ['Objekt', 'TBA'] })]), '2026-11-08');
  writeArchive(dir, a);
  const out = path.join(dir, 'out');
  const r = await exportArchive(dir, out);
  const csv = fs.readFileSync(path.join(out, 'events.csv'), 'utf8').split('\n');
  assert.match(csv[0], /^id,title,start,end/);
  assert.match(csv[1], /^ra:1,"Body Heat, ""late""",2026-11-14/);
  if (r.sqlite) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(out, 'archive.sqlite'));
    assert.equal(db.prepare('SELECT city FROM events').get().city, 'London');
    assert.deepEqual(db.prepare('SELECT artist FROM event_artists').all().map(x => x.artist), ['Objekt']);
    db.close();
  }
});

test('listings that aren\'t electronic music leave the archive, but not while the feed still shows them', () => {
  const a = empty();
  const rock = ev({ id: 'ticketmaster:A1', title: 'Alter Bridge w/ Big Wreck', genres: ['electronic'], tags: ['Dance/Electronic'],
    sources: [{ id: 'ticketmaster', name: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/A1' }] });
  const hiphop = ev({ id: 'ra:7', title: 'HIPHOP NIGHT', genres: ['misc'], tags: ['Hip-Hop', 'R&B'], sources: [{ id: 'ra', name: 'Resident Advisor', url: 'https://ra.co/events/7' }] });
  mergeFeed(a, feed([ev(), rock, hiphop]), '2026-11-08');
  // A later run (the same day, even) turned the rock show away (its id is in the list) and no longer has the hip-hop night.
  const { seen } = mergeFeed(a, feed([ev()]), '2026-11-08');
  assert.equal(pruneArchive(a, ['ticketmaster:A1'], seen), 2);
  assert.deepEqual([...a.records.keys()], ['ra:1']);
  // A listing in this feed stays even if its saved tags alone would say otherwise.
  const b = empty();
  const run = mergeFeed(b, feed([hiphop]), '2026-11-08');
  assert.equal(pruneArchive(b, [], run.seen), 0);
});

test('nights saved with Ticketmaster\'s stand-in "Amapiano" lose it when loaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-archive-'));
  const a = empty();
  mergeFeed(a, feed([ev({ id: 'ticketmaster:B1', title: 'Bonobo', genres: ['afro'], tags: ['Amapiano', 'Dance/Electronic'],
    sources: [{ id: 'ticketmaster', name: 'Ticketmaster', url: 'https://www.ticketmaster.com/event/B1' }] })]), '2026-11-08');
  writeArchive(dir, a);
  const r = loadArchive(dir).records.get('ticketmaster:B1');
  assert.deepEqual(r.tags, ['Dance/Electronic']);
  assert.deepEqual(r.genres, ['electronic']);
});

test('untagged RA nights saved as Misc are electronic again, and untagged nights are never judged without their text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-archive-'));
  const a = empty();
  mergeFeed(a, feed([ev({ id: 'ra:9', title: 'Klubnacht', genres: ['misc'], tags: [], sources: [{ id: 'ra', name: 'Resident Advisor', url: 'https://ra.co/events/9' }] }),
    ev({ id: 'posh:3', title: 'Eelke Kleijn at Audio', genres: ['misc'], tags: [], sources: [{ id: 'posh', name: 'Posh', url: 'https://posh.vip/e/3' }] })]), '2026-11-08');
  writeArchive(dir, a);
  const b = loadArchive(dir);
  assert.deepEqual(b.records.get('ra:9').genres, ['electronic']);
  const { seen } = mergeFeed(b, feed([]), '2026-11-09');
  assert.equal(pruneArchive(b, [], seen), 0);
  assert.equal(b.records.size, 2);
});
