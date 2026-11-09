import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLabels, promoterNames, labelList } from '../pipeline/lib/labels.js';
import { makeEvent } from '../pipeline/lib/normalize.js';

test('labels are found in titles, as whole words', () => {
  assert.deepEqual(detectLabels({ title: 'Drumcode Showcase: Adam Beyer, Enrico Sangiuliano', genres: ['techno'] }), ['Drumcode']);
  assert.deepEqual(detectLabels({ title: 'FABRICLIVE X DEEP MEDi 20: Mala', genres: ['bass'] }), ['Deep Medi']);
  assert.deepEqual(detectLabels({ title: "Spinnin' Records Night", genres: ['house'] }), ["Spinnin' Records"]);
  assert.deepEqual(detectLabels({ title: 'Catch and Release Tour', genres: ['house'] }), ['Catch & Release']);
  assert.deepEqual(detectLabels({ title: 'Time Warp LA', genres: ['techno'] }), []);
  assert.deepEqual(detectLabels({ title: 'Ultra Naté | SYDNEY', genres: ['house'] }), []);
});

test('ordinary words count only for the right genres', () => {
  assert.deepEqual(detectLabels({ title: 'Hospitality On The Beach', genres: ['dnb'] }), ['Hospital Records']);
  assert.deepEqual(detectLabels({ title: 'Hospitality Industry Night', genres: ['house'] }), []);
  assert.deepEqual(detectLabels({ title: 'Cocoon Heroes', genres: ['techno'] }), ['Cocoon']);
});

test('lead phrases count only at the start of a title, before a break', () => {
  assert.deepEqual(detectLabels({ title: 'RINSE: Y U QT B2B Faster Horses', genres: ['garage'] }), ['Rinse']);
  assert.deepEqual(detectLabels({ title: 'Rinse x Fabric', genres: ['garage'] }), ['Rinse']);
  assert.deepEqual(detectLabels({ title: 'Rinse and Repeat: house all night', genres: ['house'] }), []);
});

test('lineups count as credits or whole lines, not inside artist names', () => {
  assert.deepEqual(detectLabels({ title: 'Warehouse night', lineup: ['Ben UFO (Hessle Audio)', 'Joy Orbison'], genres: ['techno'] }), ['Hessle Audio']);
  assert.deepEqual(detectLabels({ title: 'Open air', lineup: ['Dekmantel Soundsystem'], genres: ['house'] }), ['Dekmantel']);
  assert.deepEqual(detectLabels({ title: 'Big room', lineup: ['Groove Armada', 'Armand Van Helden'], genres: ['house'] }), []);
});

test('promoter names can name the label', () => {
  assert.deepEqual(detectLabels({ title: 'Sunday Sessions', promoters: ['Defected Records'], genres: ['house'] }), ['Defected']);
  assert.deepEqual(detectLabels({ title: 'Friday', promoters: ['Into The Woods LA'], genres: ['house'] }), []);
});

test('promoters named like labels count as labels', () => {
  assert.deepEqual(detectLabels({ title: 'Night', promoters: ['American Death Records', 'Pretty But Wicked'], genres: ['techno'] }), ['American Death Records']);
  assert.deepEqual(detectLabels({ title: 'Night', promoters: ['Roam Recordings'], genres: ['house'] }), ['Roam Recordings']);
  assert.deepEqual(detectLabels({ title: 'Night', promoters: ['public records'], genres: ['house'] }), []);
  assert.deepEqual(detectLabels({ title: 'Sunday Sessions', promoters: ['Defected Records'], genres: ['house'] }), ['Defected']);
  assert.deepEqual(detectLabels({ title: 'Warehouse', promoters: ['Hospital Records'], genres: ['dnb'] }), ['Hospital Records']);
});

test('promoter names: strings or objects, no links or addresses, no duplicates', () => {
  assert.deepEqual(promoterNames([{ name: 'Into The Woods LA', blurb: 'long text' }, 'Into the Woods LA', { name: 'bookings@promo.com' }, 'www.party.com', ' Hospital  Records ']),
    ['Into The Woods LA', 'Hospital Records']);
  assert.deepEqual(promoterNames('Solo Collective'), ['Solo Collective']);
  assert.deepEqual(promoterNames(undefined), []);
  assert.equal(promoterNames(['A1', 'B2', 'C3', 'D4', 'E5']).length, 4);
});

test('a custom list compiles like the config', () => {
  const list = labelList([{ name: 'Test Label', match: ['Test Label Records'], lead: ['TL'] }]);
  assert.deepEqual(detectLabels({ title: 'TL: night one' }, list), ['Test Label']);
  assert.deepEqual(detectLabels({ title: 'Test Label Records showcase' }, list), ['Test Label']);
  assert.deepEqual(detectLabels({ title: 'Test Label' }, list), []);
});

test('events carry labels and promoters only when there are some', () => {
  const berlin = { id: 'berlin', name: 'Berlin', lat: 52.52, lon: 13.405, tz: 'Europe/Berlin' };
  const ctx = { cities: [berlin], cityById: { berlin } };
  const base = { source: 'ra', sourceName: 'Resident Advisor', startMs: Date.parse('2026-11-14T22:00:00Z'), cityHint: 'berlin', venueName: 'Berghain', lat: 52.5111, lon: 13.4432 };
  const a = makeEvent(ctx, { ...base, id: '1', title: 'Klockworks Night', genres: ['techno'], promoters: [{ name: 'Klockworks' }, { name: 'Berghain' }] });
  assert.deepEqual(a.labels, ['Klockworks']);
  assert.deepEqual(a.promoters, ['Klockworks', 'Berghain']);
  const b = makeEvent(ctx, { ...base, id: '2', title: 'Techno night', genres: ['techno'] });
  assert.equal(b.labels, undefined);
  assert.equal(b.promoters, undefined);
});
