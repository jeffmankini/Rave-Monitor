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
  const some = makeCtx(settings, async (a, input) => { if (input.startUrls[0].url.includes('/berlin-')) throw new Error('HTTP 502'); return { items: [{ id: 1 }] }; });
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

test('DICE events in its own format map to the shared shape, and off-genre DJ nights drop out', () => {
  const ctx = makeCtx({});
  const base = {
    id: '694282a40dafe70001cafd21', name: 'Warehouse Session', perm_name: 'g5kb95-warehouse-session',
    status: 'on-sale', price: { currency: 'GBP', amount: null, amount_from: 1500 },
    dates: { timezone: 'Europe/London', event_start_date: '2026-11-14T22:00:00+00:00', event_end_date: '2026-11-15T05:00:00+00:00' },
    venues: [{ name: 'Corsica Studios', address: '4-5 Elephant Rd, London', location: { lat: 51.494, lng: -0.0994 }, city: { name: 'London', country_code: 'GB', location: { place: 'Europe/London' } } }],
    summary_lineup: { top_artists: [{ name: 'Objekt' }, { name: 'Call Super' }] },
    tags_types: [{ name: 'dj', value: 'music:dj' }], tags_genres: [{ name: 'techno', value: 'dj:techno' }], __city: 'london'
  };
  const e = dice.normalize(base, ctx);
  assert.equal(e.cityId, 'london');
  assert.equal(e.start, '2026-11-14T22:00:00.000Z');
  assert.deepEqual(e.lineup, ['Objekt', 'Call Super']);
  assert.deepEqual(e.price, { min: 15, max: 15, currency: 'GBP' });
  assert.equal(e.status, 'onsale');
  assert.equal(e.sources[0].url, 'https://dice.fm/event/g5kb95-warehouse-session');
  assert.ok(e.genres.includes('techno'));
  assert.equal(dice.normalize({ ...base, name: 'Throwback RnB Night', tags_genres: [{ value: 'dj:rnb' }, { value: 'dj:hiphop' }] }, ctx), null);
});

test('DICE asks for each city\'s DJ page within the window', async () => {
  const calls = [];
  const ctx = makeCtx({ actor: 'x~dice', cities: ['london'], maxItemsPerCity: 30, maxChargeUsdPerRun: 0.15 }, async (a, input) => { calls.push(input); return { items: [] }; });
  await dice.collect(ctx);
  assert.deepEqual(calls[0].startUrls.map(u => u.url), [
    'https://dice.fm/browse/london-54d8a23438fe5d27d500001c/music/dj?from=2026-11-08&until=2026-11-22',
    'https://dice.fm/browse/london-54d8a23438fe5d27d500001c/music/dj',
    'https://dice.fm/browse/london-54d8a23438fe5d27d500001c'
  ]);
});

test('RA asks for its own scrape window, not the feed window', async () => {
  const calls = [];
  const ctx = makeCtx({ actor: 'x~ra', cities: ['berlin'], maxItemsPerCity: 40 }, async (a, input) => { calls.push(input); return { items: [] }; });
  ctx.to = ctx.from + 31 * 86400e3;
  await ra.collect(ctx);
  assert.equal(calls[0].dateRangeTo, '2026-12-09');
});

test('busy RA cities share their cap across every Friday and Saturday; others pull once', async () => {
  const { localDays, shareCap } = await import('../pipeline/lib/util.js');
  assert.deepEqual(shareCap(40, 9), [5, 5, 5, 5, 4, 4, 4, 4, 4]);
  const days = localDays(Date.parse('2026-12-09T10:00:00Z'), Date.parse('2027-01-09T10:00:00Z'), 'Europe/Berlin');
  assert.equal(days[0].date, '2026-12-09');
  assert.equal(days.filter(d => d.weekday === 'Fri').length, 5);
  const calls = [];
  const ctx = makeCtx({ actor: 'x~ra', cities: ['berlin', 'tbilisi'], spreadCities: ['berlin'], maxItemsPerCity: 40, maxChargeUsdPerRun: 0.2 },
    async (a, input) => { calls.push(input); return { items: [{ id: `${input.startUrls[0].url}|${input.dateRangeFrom}` }] }; });
  ctx.from = Date.parse('2026-12-09T10:00:00Z'); ctx.to = Date.parse('2027-01-09T10:00:00Z');
  const items = await ra.collect(ctx);
  const berlin = calls.filter(c => c.startUrls[0].url.includes('/berlin'));
  const nights = berlin.map(c => c.dateRangeFrom);
  assert.ok(berlin.every(c => c.dateRangeFrom === c.dateRangeTo));
  assert.ok(nights.every(d => [5, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())), nights.join());
  assert.equal(berlin.reduce((n, c) => n + c.maxItems, 0), 40);
  assert.equal(berlin.length, 10); // Dec 11, 12, 18, 19, 25, 26, Jan 1, 2, 8, 9
  const tbilisi = calls.filter(c => c.startUrls[0].url.includes('/tbilisi'));
  assert.deepEqual(tbilisi.map(c => [c.dateRangeFrom, c.dateRangeTo, c.maxItems]), [['2026-12-09', '2027-01-09', 40]]);
  assert.equal(items.filter(i => i.__city === 'berlin').length, 10);
});
