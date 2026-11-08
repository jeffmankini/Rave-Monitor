import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCollect, scrapeKey } from '../pipeline/lib/cache.js';

const DAY = 86400e3;
const now = Date.parse('2026-11-20T10:00:00Z');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rm-cache-')), 'ra.json');
const save = (file, at, key, items) => fs.writeFileSync(file, JSON.stringify({ at, key, items }));
const pull = items => { const f = async () => { f.calls++; if (items instanceof Error) throw items; return items; }; f.calls = 0; return f; };

test('a recent scrape with the same settings is reused without pulling', async () => {
  const file = tmp(); save(file, now - DAY, 'k1', [{ id: 1 }]);
  const collect = pull([{ id: 2 }]);
  const r = await loadOrCollect({ file, key: 'k1', maxAgeHours: 168, now, collect });
  assert.equal(collect.calls, 0);
  assert.deepEqual(r.items, [{ id: 1 }]);
  assert.equal(r.cached, true);
});

test('changed settings, an old scrape or --fresh pull again and save the result', async () => {
  for (const [key, age, fresh] of [['k2', DAY, false], ['k1', 8 * DAY, false], ['k1', DAY, true]]) {
    const file = tmp(); save(file, now - age, 'k1', [{ id: 1 }]);
    const collect = pull([{ id: 2 }]);
    const r = await loadOrCollect({ file, key, maxAgeHours: 168, now, fresh, collect });
    assert.equal(collect.calls, 1);
    assert.deepEqual(r.items, [{ id: 2 }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: now, key, items: [{ id: 2 }] });
  }
});

test('a failed or empty pull falls back to the last good scrape and keeps it saved', async () => {
  for (const result of [new Error('HTTP 402 usage limit'), []]) {
    const file = tmp(); save(file, now - 9 * DAY, 'k1', [{ id: 1 }]);
    const warnings = [];
    const r = await loadOrCollect({ file, key: 'k1', maxAgeHours: 168, now, collect: pull(result), warn: m => warnings.push(m) });
    assert.deepEqual(r.items, [{ id: 1 }]);
    assert.equal(r.stale, true);
    assert.match(warnings[0], /showing the scrape from 2026-11-11/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).at, now - 9 * DAY);
  }
});

test('with nothing usable saved, failures surface and empty pulls are not saved', async () => {
  const file = tmp();
  await assert.rejects(loadOrCollect({ file, key: 'k1', now, collect: pull(new Error('boom')) }), /boom/);
  const r = await loadOrCollect({ file, key: 'k1', now, collect: pull([]) });
  assert.deepEqual(r.items, []);
  assert.equal(fs.existsSync(file), false);
  save(file, now - 40 * DAY, 'k1', [{ id: 1 }]);
  await assert.rejects(loadOrCollect({ file, key: 'k1', now, collect: pull(new Error('boom')) }), /boom/);
});

test('the scrape key follows what a source asks for, not its cache or price settings', () => {
  const cities = [{ id: 'berlin', sources: { ra: 'https://ra.co/events/de/berlin' } }];
  const base = scrapeKey('ra', { cities: ['berlin'], maxItemsPerCity: 40, maxAgeHours: 168 }, 14, cities);
  assert.equal(base, scrapeKey('ra', { cities: ['berlin'], maxItemsPerCity: 40, maxAgeHours: 24, pricePerResultUsd: 1 }, 14, cities));
  assert.notEqual(base, scrapeKey('ra', { cities: ['berlin'], maxItemsPerCity: 50, maxAgeHours: 168 }, 14, cities));
  assert.notEqual(base, scrapeKey('ra', { cities: ['berlin'], maxItemsPerCity: 40, maxAgeHours: 168 }, 14,
    [{ id: 'berlin', sources: { ra: 'https://ra.co/events/de/berlin-x' } }]));
});

test('per-city saves: one city failing keeps its last scrape, others pull fresh, stats add up', async () => {
  const { cityCache } = await import('../pipeline/lib/cache.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-city-'));
  const settings = { cities: ['berlin', 'london'], maxItemsPerCity: 40, maxAgeHours: 168 };
  const berlin = { id: 'berlin', name: 'Berlin', sources: { ra: 'b' } }, london = { id: 'london', name: 'London', sources: { ra: 'l' } };
  const first = cityCache({ dir, srcId: 'ra', settings, now: now - 9 * DAY });
  await first(berlin, async () => [{ id: 'b1' }]);
  await first(london, async () => [{ id: 'l1' }]);
  const stats = {}, warnings = [];
  const again = cityCache({ dir, srcId: 'ra', settings, now, stats, warn: m => warnings.push(m) });
  assert.deepEqual(await again(berlin, async () => { throw new Error('HTTP 402'); }), [{ id: 'b1' }]);
  assert.deepEqual(await again(london, async () => [{ id: 'l2' }, { id: 'l3' }]), [{ id: 'l2' }, { id: 'l3' }]);
  assert.deepEqual({ ...stats, oldestAt: undefined }, { stale: 1, scraped: 1, scrapedItems: 2, oldestAt: undefined });
  assert.match(warnings[0], /^Berlin: HTTP 402/);
  // Changing only London's page pulls London again; Berlin's fresh save is reused.
  const later = cityCache({ dir, srcId: 'ra', settings, now: now + DAY });
  let pulls = 0;
  await later(berlin, async () => { pulls++; return [{ id: 'x' }]; });
  await later({ ...london, sources: { ra: 'l-new' } }, async () => { pulls++; return [{ id: 'y' }]; });
  assert.equal(pulls, 2); // Berlin's save is 10 days old by now, so both pull
  const soon = cityCache({ dir, srcId: 'ra', settings, now: now + DAY + 3600e3 });
  pulls = 0;
  await soon(berlin, async () => { pulls++; return []; });
  await soon({ ...london, sources: { ra: 'l-newer' } }, async () => { pulls++; return [{ id: 'z' }]; });
  assert.equal(pulls, 1);
});

test('a whole-source save splits into city files once, without the city tags', async () => {
  const { splitSourceCache, cityCache } = await import('../pipeline/lib/cache.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-split-'));
  const cities = [{ id: 'berlin', name: 'Berlin', sources: { ra: 'b' } }, { id: 'newyork', name: 'New York', sources: { ra: ['a', 'b'] } }];
  const settings = { cities: ['berlin', 'newyork'], maxItemsPerCity: 40, maxAgeHours: 168 };
  fs.writeFileSync(path.join(dir, 'ra.json'), JSON.stringify({ at: now - DAY, key: 'old', items: [{ id: 1, __city: 'berlin' }, { id: 2, __city: 'berlin' }] }));
  assert.equal(splitSourceCache({ dir, srcId: 'ra', settings, cities }), 1);
  assert.equal(fs.existsSync(path.join(dir, 'ra.json')), false);
  assert.equal(splitSourceCache({ dir, srcId: 'ra', settings, cities }), 0);
  const read = cityCache({ dir, srcId: 'ra', settings, now });
  let pulled = false;
  assert.deepEqual(await read(cities[0], async () => { pulled = true; return []; }), [{ id: 1 }, { id: 2 }]);
  assert.equal(pulled, false);
});

test('a monthly source keeps its last good scrape well past a month when a pull fails', async () => {
  const file = tmp(); save(file, now - 45 * DAY, 'k1', [{ id: 1 }]);
  const r = await loadOrCollect({ file, key: 'k1', maxAgeHours: 720, now, collect: pull(new Error('HTTP 402 usage limit')) });
  assert.deepEqual(r.items, [{ id: 1 }]);
  assert.equal(r.stale, true);
});

test('changing how far ahead a source scrapes waits for its next scheduled pull', () => {
  assert.equal(scrapeKey('ra', { maxItemsPerCity: 40 }), scrapeKey('ra', { maxItemsPerCity: 40, scrapeDays: 31 }));
});

test('forcing a city pulls it now and adds the new listings to what was saved; others wait', async () => {
  const { cityCache } = await import('../pipeline/lib/cache.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-force-'));
  const settings = { cities: ['berlin', 'tokyo'], maxItemsPerCity: 40, maxAgeHours: 720 };
  const berlin = { id: 'berlin', name: 'Berlin', sources: { ra: 'b' } }, tokyo = { id: 'tokyo', name: 'Tokyo', sources: { ra: 't' } };
  const first = cityCache({ dir, srcId: 'ra', settings, now: now - DAY });
  await first(berlin, async () => [{ id: 'tonight' }, { id: 'sat' }]);
  await first(tokyo, async () => [{ id: 't1' }]);
  const stats = {};
  const again = cityCache({ dir, srcId: 'ra', settings, now, force: new Set(['berlin']), stats });
  const b = await again(berlin, async () => [{ id: 'sat', v: 2 }, { id: 'next-fri' }]);
  assert.deepEqual(b, [{ id: 'sat', v: 2 }, { id: 'next-fri' }, { id: 'tonight' }]);
  assert.deepEqual(await again(tokyo, async () => { throw new Error('should not pull'); }), [{ id: 't1' }]);
  assert.equal(stats.scraped, 1); assert.equal(stats.saved, 1);
  assert.equal(stats.scrapedItems, 2); // only the new pull counts toward cost
});
