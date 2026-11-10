import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPromoters, detectLabels, mergePromoters, promoterList } from '../pipeline/lib/labels.js';
import { buildCrews } from '../pipeline/promoters.js';

test('curated promoters and groups are found in titles, lead-only names only up front, word-like names only in their sound', () => {
  assert.deepEqual(detectPromoters({ title: 'split/shift presents: Ammara all night long', genres: ['house'] }), ['split/shift']);
  assert.deepEqual(detectPromoters({ title: 'Splitshift Block Party', genres: ['techno'] }), ['split/shift']);
  assert.deepEqual(detectPromoters({ title: 'ANTS @ Ushuaïa', genres: ['house'] }), ['ANTS']);
  assert.deepEqual(detectPromoters({ title: 'Ants in the pants', genres: ['house'] }), []);
  assert.deepEqual(detectPromoters({ title: 'Awakenings Festival', genres: ['techno'] }), ['Awakenings']);
  assert.deepEqual(detectPromoters({ title: 'Spiritual Awakenings brunch', genres: ['house'] }), []);
  assert.deepEqual(detectPromoters({ title: 'Ben UFO', promoters: ['The Warehouse Project'], genres: ['house'] }), ['The Warehouse Project']);
  // split/shift is a label too.
  assert.deepEqual(detectLabels({ title: 'split/shift: label night', genres: ['techno'] }), ['split/shift']);
  // Every curated entry compiles and has a kind for its card.
  for (const p of promoterList()) assert.ok(p.match.length || p.lead.length, p.name);
});

test('listed promoters first, curated ones after, once each, at most five', () => {
  assert.deepEqual(mergePromoters(['Split/Shift', 'Rhythm Lab'], ['split/shift', 'Boiler Room']), ['Split/Shift', 'Rhythm Lab', 'Boiler Room']);
  assert.equal(mergePromoters(['a', 'b', 'c', 'd'], ['e', 'f']).length, 5);
});

test('the promoters directory counts distinct nights per city, where, which venues and what sound', () => {
  const rec = (id, start, cityId, venue, promoters, extra = {}) => ({ id, title: id, start, tz: 'America/Chicago', cityId, venue: { name: venue }, genres: ['house'], promoters, ...extra });
  const crews = buildCrews([
    rec('1', '2026-11-01T03:00:00Z', 'milwaukee', 'Cactus Club', ['split/shift']),
    rec('2', '2026-11-01T04:00:00Z', 'milwaukee', 'Cactus Club', ['Split/Shift']),   // same night, another room
    rec('3', '2026-11-20T03:00:00Z', 'milwaukee', 'Fuel Cafe', ['split/shift'], { genres: ['techno'] }),
    rec('4', '2026-11-21T03:00:00Z', 'chicago', 'Smartbar', ['split/shift']),
    rec('5', '2026-11-22T03:00:00Z', 'chicago', 'Smartbar', ['split/shift'], { status: 'cancelled' }),
    rec('6', '2026-11-21T03:00:00Z', 'chicago', 'Smartbar', [], { labels: ['Hessle Audio'] }),
    rec('7', '2026-11-26T03:00:00Z', 'milwaukee', 'Cactus Club', ['split/shift'])
  ], { milwaukee: { tz: 'America/Chicago' }, chicago: { tz: 'America/Chicago' } }, '2026-11-09T00:00:00Z');
  const ss = crews.promoters.find(r => r[0] === 'split/shift');
  assert.equal(ss[1], 4);                 // nights
  assert.equal(ss[2], 3);                 // still to come
  assert.equal(ss[3], '2026-10-31');      // first night (local, 9 pm Saturday)
  assert.deepEqual(ss[5], { milwaukee: 3, chicago: 1 });
  assert.deepEqual(ss[6], { house: 4, techno: 1 });
  assert.deepEqual(ss[7][0], ['Cactus Club', 'milwaukee', 2]);
  assert.deepEqual(crews.labels.map(r => r[0]), ['Hessle Audio']);
});
