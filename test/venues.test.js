import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venueKey, buildVenues, displayName, isConcertVenue, NOT_A_VENUE } from '../pipeline/venues.js';

test('venue keys ignore case, accents, rooms, "the" and the city name', () => {
  assert.equal(venueKey('Clock Factory Bristol', 'Bristol'), 'clock factory');
  assert.equal(venueKey('The Bellwether', 'Los Angeles'), 'bellwether');
  assert.equal(venueKey('Melkweg (Oude Zaal)', 'Amsterdam'), 'melkweg');
  assert.equal(venueKey('Manchester New Century Hall', 'Manchester'), 'new century hall');
  assert.equal(venueKey('Ëlsewhere — Zone One', 'New York'), 'elsewhere zone one');
  assert.equal(venueKey('Berlin', 'Berlin'), 'berlin');
});

test('names drop the city at the end unless too little is left; clubs in casinos are clubs', () => {
  assert.equal(displayName('Clock Factory Bristol', 'Bristol'), 'Clock Factory');
  assert.equal(displayName('Phonox, London', 'London'), 'Phonox');
  assert.equal(displayName('Brooklyn Mirage New York', 'New York'), 'Brooklyn Mirage');
  assert.equal(displayName('Hï Ibiza', 'Ibiza'), 'Hï Ibiza');
  assert.equal(displayName('Sydney Opera House', 'Sydney'), 'Sydney Opera House');
  assert.equal(displayName('Zürich', 'Zürich'), 'Zürich');
  assert.equal(isConcertVenue('Hakkasan Nightclub at MGM Grand Hotel & Casino'), false);
  assert.equal(isConcertVenue('Jabbawockeez Theater at MGM Grand Hotel & Casino'), true);
  assert.equal(isConcertVenue('OVO Hydro Arena'), true);
  assert.equal(isConcertVenue('Sub Club'), false);
  for (const k of ['tba', 'tba brooklyn', 'venue tba', 'secret location', 'secret location on the telegram group', 'to be announced', 'various venues', 'online'])
    assert.ok(NOT_A_VENUE.test(k), k);
  for (const k of ['sub club', 'secret garden', 'hidden', 'hidden garden', 'privatclub']) assert.ok(!NOT_A_VENUE.test(k), k); // Hidden is a Manchester club
});

const rec = (id, venue, extra = {}) => ({ id, cityId: 'glasgow', tz: 'Europe/London', title: 'Night ' + id, start: '2026-11-20T22:00:00Z', genres: ['house'], lineup: [], venue, ...extra });
const cities = { glasgow: { name: 'Glasgow', tz: 'Europe/London' } };

test('rooms and spellings at the same spot merge into one venue under its base name', () => {
  const v = buildVenues([
    rec('1', { name: 'SWG3', lat: 55.8646, lon: -4.2998 }, { lineup: ['Ammara', 'MDDLTN'] }),
    rec('2', { name: 'SWG3 Poetry Club', lat: 55.8647, lon: -4.2999 }, { start: '2026-11-21T23:00:00Z', lineup: ['Ammara'] }),
    // Another room the same night (after midnight still counts as that night).
    rec('2b', { name: 'Poetry Club SWG3', lat: 55.8647, lon: -4.2999 }, { start: '2026-11-22T01:00:00Z' }),
    rec('3', { name: 'TV Studio SWG3', lat: 55.8645, lon: -4.2997 }, { start: '2026-10-01T22:00:00Z', genres: ['techno'] }),
    rec('4', { name: 'Sub Club', lat: 55.8589, lon: -4.2534, address: '22 Jamaica St' }),
    rec('5', { name: 'Arena Glasgow', lat: 55.86, lon: -4.28 }, { status: 'cancelled' }),
    rec('6', { name: 'OVO Hydro Arena', lat: 55.8603, lon: -4.2857 }),
    rec('7', { name: 'TBA', lat: 55.86, lon: -4.25, approx: true }),
    rec('8', { name: 'Secret Location (Glasgow)', lat: 55.86, lon: -4.25, approx: true }),
    rec('9', { name: 'Venue TBA Glasgow', lat: 55.86, lon: -4.25, approx: true }),
    rec('10', { name: 'TBA - Finnieston', lat: 55.86, lon: -4.25, approx: true })
  ], cities, '2026-11-09T00:00:00Z');
  const byName = Object.fromEntries(v.venues.map(r => [r[1], r]));
  assert.deepEqual(Object.keys(byName).sort(), ['OVO Hydro Arena', 'SWG3', 'Sub Club']);
  const swg = byName.SWG3;
  assert.equal(swg[0], 'glasgow-swg3');
  assert.equal(swg[7], 3);            // nights (two rooms on one night count once)
  assert.equal(swg[8], 2);            // coming up
  assert.equal(swg[9], '2026-10-01'); // first past night
  assert.equal(swg[11], '2026-11-20'); // next
  assert.deepEqual(swg[12], { house: 3, techno: 1 });
  assert.deepEqual(swg[13], ['Ammara']);
  assert.deepEqual(swg[14].sort(), ['poetry club swg3', 'swg3 poetry club', 'tv studio swg3']);
  assert.equal(byName['Sub Club'][6], '22 Jamaica St');
  assert.equal(byName['OVO Hydro Arena'][5] & 2, 2); // concert venue
  assert.equal(byName['Sub Club'][5], 0);
});

test('far-apart places with overlapping names stay separate; no position means the city only', () => {
  const v = buildVenues([
    rec('1', { name: 'Room 2', lat: 55.86, lon: -4.25 }),
    rec('2', { name: 'Room 2 Annex', lat: 55.90, lon: -4.35 }),
    rec('3', { name: 'Hidden Garden', lat: 55.8609, lon: -4.2514, approx: true })
  ], cities, '2026-11-09T00:00:00Z');
  assert.equal(v.venues.length, 3);
  const hidden = v.venues.find(r => r[1] === 'Hidden Garden');
  assert.equal(hidden[5] & 1, 1);
});
