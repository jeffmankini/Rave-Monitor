import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dedupe } from '../pipeline/lib/dedupe.js';
import { ra, dice, posh, partiful, luma } from '../pipeline/sources/apify-sources.js';
import { ticketmaster, skiddle } from '../pipeline/sources/api-sources.js';

const read = f => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
const cities = read('../config/cities.json').cities;
const ctx = { cities: structuredClone(cities), settings: {}, warn() {} };
ctx.cityById = Object.fromEntries(ctx.cities.map(c => [c.id, c]));

function run(src) {
  return read(`../pipeline/sample/${src.id}.json`).map(it => src.normalize(it, ctx)).filter(Boolean);
}

test('each source keeps electronic events and drops the rest', () => {
  const kept = Object.fromEntries([ra, dice, posh, partiful, luma, ticketmaster, skiddle].map(s => [s.id, run(s).length]));
  assert.deepEqual(kept, { ra: 5, dice: 3, posh: 2, partiful: 2, luma: 2, ticketmaster: 2, skiddle: 2 });
});

test('Posh events whose organizers opted out of third-party sites are skipped', () => {
  assert.ok(!run(posh).some(e => e.title.includes('Warehouse Techno Takeover')));
});

test('the same night on several platforms becomes one event with every source', () => {
  const all = [ra, dice, posh, partiful, luma, ticketmaster, skiddle].flatMap(run);
  const { events, merged } = dedupe(all);
  assert.equal(merged, 4);
  const bodyHeat = events.find(e => e.title.startsWith('Body Heat'));
  assert.deepEqual(bodyHeat.sources.map(s => s.id).sort(), ['dice', 'ra', 'skiddle']);
  assert.equal(bodyHeat.sets.length, 2);
  const velvet = events.find(e => e.title.includes('Velvet Ledger'));
  assert.equal(velvet.status, 'soldout');
});

test('Partiful events without coordinates land near their city', () => {
  const loft = run(partiful).find(e => e.title.includes('Loft'));
  assert.equal(loft.cityId, 'newyork');
  assert.equal(loft.venue.approx, true);
});
