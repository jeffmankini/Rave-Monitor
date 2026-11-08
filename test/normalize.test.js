import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genresFrom, electronicScore, parsePrice, fromMinor, eventType } from '../pipeline/lib/normalize.js';
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
