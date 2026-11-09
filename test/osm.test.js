import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bboxOf, overpassQuery, parseElements, refreshOsm } from '../pipeline/osm.js';

const berlin = { id: 'berlin', name: 'Berlin', country: 'DE', lat: 52.52, lon: 13.405 };
const london = { id: 'london', name: 'London', country: 'GB', lat: 51.5072, lon: -0.1276 };

test('a city box is about 30 km each way; the query asks for clubs and music venues in each box', () => {
  const [s, w, n, e] = bboxOf(berlin);
  assert.ok(Math.abs((n - s) * 111.32 - 60) < 0.5);
  assert.ok(e - w > n - s); // longitude degrees are shorter up north
  const q = overpassQuery([berlin, london]);
  assert.match(q, /^\[out:json\]/);
  assert.equal(q.match(/nwr\["amenity"~"\^\(nightclub\|music_venue\)\$"\]/g).length, 2);
  assert.match(q, /out center tags qt;$/);
});

test('elements become rows: names, centres for buildings, addresses in local order, websites, other names', () => {
  const els = [
    { type: 'way', id: 1, center: { lat: 52.5111, lon: 13.4430 }, tags: { amenity: 'nightclub', name: 'Berghain', 'addr:street': 'Am Wriezener Bahnhof', 'addr:housenumber': '1', website: 'berghain.berlin' } },
    { type: 'node', id: 2, lat: 51.5246, lon: -0.0711, tags: { amenity: 'music_venue', name: 'Village Underground', 'addr:street': 'Holywell Lane', 'addr:housenumber': '54', 'contact:website': 'https://villageunderground.co.uk/' } },
    { type: 'node', id: 3, lat: 52.50, lon: 13.40, tags: { amenity: 'nightclub' } },                         // no name
    { type: 'node', id: 4, lat: 52.50, lon: 13.40, tags: { amenity: 'nightclub', name: 'Golden Strip Club' } }, // not for this map
    { type: 'node', id: 2, lat: 51.5246, lon: -0.0711, tags: { amenity: 'music_venue', name: 'Village Underground' } }, // twice
    { type: 'node', id: 5, lat: 48.85, lon: 2.35, tags: { amenity: 'nightclub', name: 'Far Away' } },        // in no box
    { type: 'node', id: 6, lat: 52.49, lon: 13.42, tags: { amenity: 'nightclub', name: 'Клуб', 'name:en': 'Club One', website: 'javascript:alert(1)' } }
  ];
  const rows = parseElements(els, [berlin, london]);
  assert.deepEqual(rows.berlin.map(r => r[1]), ['Berghain', 'Клуб']);
  assert.deepEqual(rows.berlin[0], ['w1', 'Berghain', 52.5111, 13.443, 0, 'Am Wriezener Bahnhof 1', 'https://berghain.berlin']);
  assert.deepEqual(rows.london, [['n2', 'Village Underground', 51.5246, -0.0711, 1, '54 Holywell Lane', 'https://villageunderground.co.uk/']]);
  assert.equal(rows.berlin[1][6], ''); // not a web address
  assert.equal(rows.berlin[1][7], 'Club One');
});

test('a place goes to the nearest city only, even when it was fetched with another', () => {
  const leeds = { id: 'leeds', name: 'Leeds', country: 'GB', lat: 53.8008, lon: -1.5491 };
  const manchester = { id: 'manchester', name: 'Manchester', country: 'GB', lat: 53.4808, lon: -2.2426 };
  // In both cities' boxes, nearer Leeds.
  const el = { type: 'node', id: 9, lat: 53.65, lon: -1.85, tags: { amenity: 'nightclub', name: 'Between' } };
  assert.deepEqual(parseElements([el], [manchester], [leeds, manchester]).manchester, []);
  const both = parseElements([el], [leeds, manchester]);
  assert.deepEqual([both.leeds.length, both.manchester.length], [1, 0]);
});

test('refresh writes each city, an index for search, skips fresh lists and keeps the last on failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-osm-'));
  const answer = { elements: [{ type: 'node', id: 7, lat: 52.53, lon: 13.41, tags: { amenity: 'nightclub', name: 'Tresor' } }] };
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, json: async () => answer }; };
  const logs = [];
  const r1 = await refreshOsm(dir, [berlin, london], { fetchImpl: ok, log: m => logs.push(m), pause: 0, now: Date.parse('2026-11-09T00:00:00Z') });
  assert.equal(calls, 1); // both cities in one query
  assert.equal(r1.fetched, 2);
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'osm', 'berlin.json'), 'utf8'));
  assert.equal(b.clubs[0][1], 'Tresor');
  assert.match(b.license, /OpenStreetMap contributors/);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'osm', 'index.json'), 'utf8'));
  assert.deepEqual(idx.clubs, [['berlin', 'n7', 'Tresor']]);
  // A day later nothing is due.
  const r2 = await refreshOsm(dir, [berlin, london], { fetchImpl: ok, log: () => {}, pause: 0, now: Date.parse('2026-11-10T00:00:00Z') });
  assert.equal(r2.fetched, 0); assert.equal(calls, 1);
  // Eight days later both are due; every endpoint fails, so the lists stay.
  const fail = async () => { throw new Error('offline'); };
  const r3 = await refreshOsm(dir, [berlin, london], { fetchImpl: fail, log: () => {}, pause: 0, now: Date.parse('2026-11-17T12:00:00Z') });
  assert.equal(r3.fetched, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'osm', 'berlin.json'), 'utf8')).clubs[0][1], 'Tresor');
  fs.rmSync(dir, { recursive: true, force: true });
});
