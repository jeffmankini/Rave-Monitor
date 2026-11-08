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
