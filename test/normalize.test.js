import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genresFrom, electronicScore, parsePrice, fromMinor, eventType, positionQuality, makeEvent, isContactLine, splitLineup } from '../pipeline/lib/normalize.js';
import { localToUtc } from '../pipeline/lib/util.js';

test('genre rules pick the specific family first', () => {
  assert.deepEqual(genresFrom('Afro House Rooftop'), ['afro']);
  assert.deepEqual(genresFrom('Drum & Bass all night'), ['dnb']);
  assert.deepEqual(genresFrom(['Techno', 'Hard Groove']), ['techno']);
  assert.deepEqual(genresFrom('Bass house warehouse'), ['bass']);
});

test('indie disco is not electronic', () => {
  assert.deepEqual(genresFrom('Indie Disco Classics'), []);
  assert.ok(electronicScore('Indie Disco Classics') < 1);
});

test('electronic score keeps raves and drops non-music events', () => {
  assert.ok(electronicScore('Loft Techno Party', 'Techno and house in a loft') >= 1);
  assert.ok(electronicScore('Sample Sale', 'End-of-season sample sale') < 1);
  assert.ok(electronicScore('Hip-Hop & R&B Brunch', 'Bottomless brunch with a DJ') < 1);
  assert.ok(electronicScore('AI Founders Dinner', 'Dinner for founders') < 1);
});

test('prices parse from text and minor units', () => {
  assert.deepEqual(parsePrice('£15.00'), { min: 15, max: 15, currency: 'GBP' });
  assert.deepEqual(parsePrice('€15-25'), { min: 15, max: 25, currency: 'EUR' });
  assert.equal(parsePrice('Free before midnight').free, true);
  assert.equal(fromMinor(1500, 'GBP'), 15);
  assert.equal(fromMinor(3000, 'JPY'), 3000);
});

test('local wall-clock times convert with the venue time zone', () => {
  assert.equal(new Date(localToUtc('2026-11-14T23:59:00.000', 'Europe/Berlin')).toISOString(), '2026-11-14T22:59:00.000Z');
  assert.equal(new Date(localToUtc('2026-11-14T22:00:00.000', 'America/Chicago')).toISOString(), '2026-11-15T04:00:00.000Z');
  assert.equal(new Date(localToUtc('2026-11-14T22:00:00+00:00', 'Europe/London')).toISOString(), '2026-11-14T22:00:00.000Z');
});

test('ticket-site shows that start late count as club nights', () => {
  const at = local => ({ title: 'Eli Brown', tz: 'Europe/London', startMs: localToUtc(local, 'Europe/London'), isConcert: true });
  assert.equal(eventType(at('2026-11-21T20:00:00')), 'concert');
  assert.equal(eventType(at('2026-11-21T22:30:00')), 'club');
  assert.equal(eventType(at('2026-11-22T01:00:00')), 'club');
  assert.equal(eventType(at('2026-11-21T15:00:00')), 'day');
});

test('venue positions at 0,0 or on whole degrees are treated as missing', () => {
  assert.equal(positionQuality(0, 0), 'none');
  assert.equal(positionQuality(53, 13), 'none');
  assert.equal(positionQuality(undefined, 13.4), 'none');
  assert.equal(positionQuality(52.5, 13.4), 'rough');
  assert.equal(positionQuality(52.5111, 13.4432), 'exact');
  const berlin = { id: 'berlin', name: 'Berlin', lat: 52.52, lon: 13.405, tz: 'Europe/Berlin' };
  const ctx = { cities: [berlin], cityById: { berlin } };
  const base = { source: 'ra', title: 'Techno night', startMs: Date.parse('2026-11-14T22:00:00Z'), cityHint: 'berlin' };
  const lost = makeEvent(ctx, { ...base, id: '1', venueName: 'AMT', lat: 0, lon: 0 });
  assert.equal(lost.cityId, 'berlin');
  assert.equal(lost.venue.approx, true);
  assert.ok(Math.abs(lost.venue.lat - 52.52) < 0.05 && Math.abs(lost.venue.lon - 13.405) < 0.08, 'placed near the city center');
  const again = makeEvent(ctx, { ...base, id: '2', venueName: 'AMT', lat: 0, lon: 0 });
  assert.deepEqual([again.venue.lat, again.venue.lon], [lost.venue.lat, lost.venue.lon], 'one spot per venue');
  const coarse = makeEvent(ctx, { ...base, id: '3', venueName: 'Dunckerclub', lat: 53, lon: 13 });
  assert.equal(coarse.venue.approx, true);
  const exact = makeEvent(ctx, { ...base, id: '4', venueName: 'Berghain', lat: 52.5111, lon: 13.4432 });
  assert.equal(exact.venue.approx, undefined);
  assert.equal(exact.venue.lat, 52.5111);
});

test('contact and credit lines are dropped from lineups, billed handles are kept', () => {
  for (const bad of ['booking: someone.berlin@gmail.com', 'Instagram: somepromoter', 'Founder @somelabel', '(Ex) Initiator and co-founder @club_x', '@', 'https://instagram.com/x', 'Bookings - agent@agency.co'])
    assert.equal(isContactLine(bad), true, bad);
  for (const ok of ['@veralyn', 'DJ SILK (@SILKSHUTDOWN)', 'Z@p', 'Second Contact', 'Club Nights @ The Jazz Cafe', 'Ben UFO'])
    assert.equal(isContactLine(ok), false, ok);
});

test('free-text lineups are split into names, without room headers or role labels', () => {
  assert.deepEqual(
    splitLineup(['【RING】〈OPEN FORMAT〉', 'LIVE：Nia Varan / Marco / 404ghostboy / HADES', ',', 'DJ：MAGOLLA / KENNY', '-CRUCIAL SOUND-', '【R BAR】〈HOUSE / TECH HOUSE〉', 'BIRTHDAY PICK UP LIVE：CR.GAEL']),
    ['Nia Varan', 'Marco', '404ghostboy', 'HADES', 'MAGOLLA', 'KENNY', 'CR.GAEL']);
  assert.deepEqual(splitLineup(['Ben UFO', 'DJ Seinfeld', 'AC/DC', 'Kerri Chandler b2b Dennis Ferrer', 'Âme']), ['Ben UFO', 'DJ Seinfeld', 'AC/DC', 'Kerri Chandler b2b Dennis Ferrer', 'Âme']);
});

test('no family: electronic or misc', async () => {
  const { fallbackGenre, genresFrom } = await import('../pipeline/lib/normalize.js');
  assert.equal(fallbackGenre({ title: 'Flammable', tags: ['Dance/Electronic'], source: 'ticketmaster' }), 'electronic');
  assert.equal(fallbackGenre({ title: 'iKeda', tags: ['Dance Pop', 'Dance/Electronic'], source: 'ticketmaster' }), 'electronic');
  assert.equal(fallbackGenre({ title: 'Mogwai 30', tags: ['Pop/Rock'], source: 'ticketmaster' }), 'misc');
  assert.equal(fallbackGenre({ title: 'Carl Cox - Club Darc', tags: ['Other'], source: 'ticketmaster' }), 'electronic');
  assert.equal(fallbackGenre({ title: 'N2Deep R&B Brunch', tags: ['R&B'], source: 'ra' }), 'misc');
  assert.equal(fallbackGenre({ title: 'Atomiser presents: Nirosta Steel', tags: [], source: 'ra' }), 'electronic');
  assert.equal(fallbackGenre({ title: 'Ska night', tags: ['Ska', 'Reggae', 'Dub'], source: 'skiddle' }), 'misc');
  assert.equal(fallbackGenre({ title: 'Sunday Perreo City', tags: [], text: 'reggaeton and perreo all night with DJs', source: 'posh' }), 'misc');
  assert.equal(fallbackGenre({ title: 'Warehouse party', tags: [], text: 'a rave in a warehouse', source: 'posh' }), 'electronic');
  assert.equal(fallbackGenre({ title: 'Pop-up party', tags: [], text: 'dj set till late', source: 'partiful' }), 'electronic');
  assert.deepEqual(genresFrom("Drum 'n' Bass", 'Andy C'), ['dnb']);
  assert.deepEqual(genresFrom('Psy/GoaTrance'), ['trance']);
});
