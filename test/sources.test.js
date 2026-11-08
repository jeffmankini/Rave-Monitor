import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { ra, dice } from '../pipeline/sources/apify-sources.js';
import { fetchJson } from '../pipeline/lib/util.js';

const cities = JSON.parse(fs.readFileSync(new URL('../config/cities.json', import.meta.url), 'utf8')).cities;
function makeCtx(settings, apify) {
  const ctx = { cities: structuredClone(cities), settings, apify, warnings: [],
    from: Date.parse('2026-11-08T00:00:00Z'), to: Date.parse('2026-11-22T00:00:00Z') };
  ctx.cityById = Object.fromEntries(ctx.cities.map(c => [c.id, c]));
  ctx.warn = m => ctx.warnings.push(m);
  return ctx;
}

test('RA runs once per city, each with its own cap, and tags items with their city', async () => {
  const calls = [];
  const ctx = makeCtx({ actor: 'x~ra', cities: ['berlin', 'tokyo'], maxItemsPerCity: 40, maxChargeUsdPerRun: 0.2 }, async (actor, input, o) => {
    calls.push({ input, o });
    return { items: [{ id: input.startUrls[0].url }] };
  });
  const items = await ra.collect(ctx);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.input.startUrls.length === 1 && c.input.maxItems === 40 && c.o.maxItems === 40 && c.o.maxChargeUsd === 0.2));
  assert.deepEqual(items.map(i => i.__city).sort(), ['berlin', 'tokyo']);
});

test('a city that fails is skipped, and a source whose every city fails reports the error', async () => {
  const settings = { actor: 'x~dice', cities: ['london', 'berlin'], maxItemsPerCity: 10 };
  const some = makeCtx(settings, async (a, input) => { if (input.city === 'Berlin') throw new Error('HTTP 502'); return { items: [{ id: 1 }] }; });
  assert.equal((await dice.collect(some)).length, 1);
  assert.match(some.warnings[0], /Berlin: HTTP 502/);
  const none = makeCtx(settings, async () => { throw new Error('HTTP 401 token is not valid'); });
  await assert.rejects(dice.collect(none), /token is not valid/);
});

test('RA wall-clock times use the scraped city time zone when the item has none', () => {
  const e = ra.normalize({
    id: '1', title: 'Test Night', startTime: '2026-11-14T23:00:00.000', endTime: '2026-11-15T06:00:00.000',
    artists: [{ name: 'A' }], genres: [{ name: 'Techno' }], venue: { name: 'Club' }, __city: 'berlin'
  }, makeCtx({}));
  assert.equal(Date.parse(e.start), Date.parse('2026-11-14T22:00:00Z'));
  assert.equal(e.cityId, 'berlin');
});

test('fetchJson stops at once on a rejected key and keeps the key out of the message', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ fault: { faultstring: 'Invalid ApiKey' } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const err = await fetchJson(`http://127.0.0.1:${server.address().port}/v2/events.json?apikey=SECRET123`).catch(e => e);
  server.close();
  assert.equal(hits, 1);
  assert.equal(err.status, 401);
  assert.match(err.message, /HTTP 401 Invalid ApiKey/);
  assert.ok(!err.message.includes('SECRET123'));
});
