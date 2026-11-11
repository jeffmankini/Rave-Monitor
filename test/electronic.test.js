import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isElectronic, tagKind, fallbackGenre, makeEvent } from '../pipeline/lib/normalize.js';
import { ticketmaster, ticketmasterAct } from '../pipeline/sources/api-sources.js';

// Ticketmaster classifications as the Discovery API returns them: { segment, genre, subGenre, type, subType }.
const cls = (segment, genre, subGenre, type, subType, primary = true) => ({
  primary, segment: { name: segment }, genre: genre ? { name: genre } : undefined, subGenre: subGenre ? { name: subGenre } : undefined,
  type: type ? { name: type } : undefined, subType: subType ? { name: subType } : undefined
});
const edm = (sub = 'Dance/Electronic', type, subType) => cls('Music', 'Dance/Electronic', sub, type, subType);
const act = (name, c) => ({ name, classifications: c ? [c] : [] });
const listing = (name, event, attractions = [], localTime = '20:00:00') => ({
  id: name.replace(/\W+/g, '-'), name, classifications: [].concat(event),
  dates: { start: { localTime } }, _embedded: { attractions }
});

test('Ticketmaster: the headliner decides, not a support act or the listing', () => {
  // Filed under Dance/Electronic as a listing, but the band is filed under Rock.
  const alterBridge = listing('Alter Bridge w/ Big Wreck', edm(), [act('Alter Bridge', cls('Music', 'Rock', 'Alternative Rock')), act('Big Wreck', cls('Music', 'Rock', 'Pop'))]);
  assert.deepEqual(ticketmasterAct(alterBridge), { keep: false, why: 'headliner filed under Rock' });
  // A pop tour that came back from the Dance/Electronic search because of its DJ support.
  const popTour = listing('Bruno Mars - The Romantic Tour', cls('Music', 'Pop', 'Electro Pop'), [act('Bruno Mars', cls('Music', 'Pop', 'Pop')), act('DJ Pee .Wee', edm())]);
  assert.equal(ticketmasterAct(popTour).keep, false);
  // The listing is filed under Rock, the act under Dance/Electronic: the act wins.
  const prodigy = listing('The Prodigy', cls('Music', 'Rock', 'Punk'), [act('The Prodigy', edm('Club Dance'))]);
  assert.deepEqual(ticketmasterAct(prodigy), { keep: true, why: '', tags: ['Club Dance', 'Dance/Electronic'] });
});

test('Ticketmaster: dance troupes, tribute bands, add-ons and non-music listings go', () => {
  const troupe = listing('Jabbawockeez', edm('Amapiano'), [act('Jabbawockeez', edm('Club Dance', 'Group', 'Troupe'))]);
  assert.deepEqual(ticketmasterAct(troupe), { keep: false, why: 'dance troupe' });
  const tribute = listing('Le Freak: The Music of Chic', edm('Disco'), [act('Le Freak', edm('Disco', 'Group', 'Tribute Band'))]);
  assert.equal(ticketmasterAct(tribute).keep, false);
  const fastTrack = listing('The Prodigy | Fast Track', edm(), [act('Fast Track - O2 arena', cls('Miscellaneous', '', '', 'Upsell', 'FastLane Access')), act('The Prodigy', edm('Club Dance'))]);
  assert.equal(ticketmasterAct(fastTrack).keep, false);
  const race = listing('FRIDAY GA - T-MOBILE ZONE AT SPHERE', cls('Sports', 'Motorsports/Racing', 'Motorsports/Racing'),
    [act('FORMULA 1 LAS VEGAS GRAND PRIX', cls('Sports', 'Motorsports/Racing', 'Motorsports/Racing', 'Event Style', 'Competition')), act('Disclosure', edm('Club Dance'))]);
  assert.deepEqual(ticketmasterAct(race), { keep: false, why: 'Sports, not a music show' });
  const drag = listing('Drag Show "Pumped Fridays"', cls('Arts & Theatre', 'Performance Art', 'Drag'));
  assert.equal(ticketmasterAct(drag).keep, false);
});

test('Ticketmaster: a festival needs mostly electronic acts', () => {
  const brand = name => act(name, cls('Music', '', '', 'Event Style', 'Festival'));
  const rockFest = listing('Corona Capital', cls('Music', '', '', 'Event Style', 'Festival'),
    [brand('Corona Capital'), act('Gorillaz', cls('Music', 'Rock', 'Alternative Rock')), act('The xx', cls('Music', 'Pop', 'Pop')), act('BUNT.', edm())]);
  assert.deepEqual(ticketmasterAct(rockFest), { keep: false, why: 'festival billed mostly with other genres' });
  const timeWarp = listing('Time Warp LA', cls('Music', '', '', 'Event Style', 'Festival'),
    [act('Time Warp LA', edm('Dance/Electronic', 'Event Style', 'Festival')), act('Richie Hawtin', edm('Club Dance')), act('Ben Klock', edm('Techno'))]);
  assert.equal(ticketmasterAct(timeWarp).keep, true);
  // A club-night brand with no acts listed stands on its own classification.
  const earlybirds = listing('Earlybirds Club', edm('Amapiano'), [act('Earlybirds Club', edm('Club Dance', 'Event Style', 'Festival'))]);
  assert.deepEqual(ticketmasterAct(earlybirds), { keep: true, why: '', tags: ['Club Dance', 'Dance/Electronic'] });
});

test('Ticketmaster: big names filed under Pop stand only at a club-night hour', () => {
  const calvin = time => listing('Calvin Harris (21 and Over)', edm(), [act('Calvin Harris', cls('Music', 'Pop', 'Pop', 'Individual', 'Musician'))], time);
  assert.equal(ticketmasterAct(calvin('22:30:00')).keep, true);
  assert.equal(ticketmasterAct(calvin('19:00:00')).keep, false);
  // A specific other genre isn't a catch-all, whatever the hour.
  const rock = listing('Glassjaw', edm(), [act('Glassjaw', cls('Music', 'Rock', 'Alternative Rock'))], '23:00:00');
  assert.equal(ticketmasterAct(rock).keep, false);
});

test('Ticketmaster: with no electronic act billed, a title naming another genre decides', () => {
  assert.deepEqual(ticketmasterAct(listing('Eres Emo?', edm())), { keep: false, why: 'title names another genre' });
  assert.equal(ticketmasterAct(listing('Reggaeton Rave', edm('Amapiano'), [act('Reggaeton Rave', edm('Dance/Electronic', 'Event Style', ''))])).keep, false);
  assert.equal(ticketmasterAct(listing('ONE MORE TIME: A DAFT PUNK TRIBUTE PARTY', edm())).keep, true);
  assert.equal(ticketmasterAct(listing('Techno vs Hip Hop', edm())).keep, true);
});

test('Ticketmaster: its stand-in "Amapiano" sub-genre is dropped unless something says amapiano', () => {
  const bonobo = listing('Bonobo', edm('Amapiano'), [act('Bonobo', edm()), act('Anish Kumar', edm())]);
  assert.deepEqual(ticketmasterAct(bonobo).tags, ['Dance/Electronic']);
  const piano = listing('Amapiano Sundays', edm('Amapiano'), [act('Some DJ', edm())]);
  assert.deepEqual(ticketmasterAct(piano).tags, ['Amapiano', 'Dance/Electronic']);
  // And the listing no longer lands in the Afro & amapiano family.
  const berlin = { id: 'berlin', name: 'Berlin', lat: 52.52, lon: 13.405, tz: 'Europe/Berlin' };
  const ctx = { cities: [berlin], cityById: { berlin } };
  const e = ticketmaster.normalize({ ...bonobo, dates: { start: { dateTime: '2026-11-20T20:00:00Z' }, timezone: 'Europe/Berlin', status: { code: 'onsale' } },
    _embedded: { ...bonobo._embedded, venues: [{ name: 'Tempodrom', location: { latitude: '52.5011', longitude: '13.3816' }, city: { name: 'Berlin' } }] } }, ctx);
  assert.deepEqual(e.genres, ['electronic']);
});

test('genre tags: as many electronic styles as other genres keep a night, mostly other genres drop it', () => {
  assert.equal(isElectronic({ title: 'Your Mum\'s House', tags: ['R&B', 'Rap', 'Hip Hop', 'Afrobeat', 'Trap'], genres: ['house'] }), false);
  assert.equal(isElectronic({ title: 'Link Up Friday', tags: ['R&B', 'Dancehall', 'Hip Hop', 'Afrobeat', 'Amapiano'], genres: ['afro'] }), false);
  assert.equal(isElectronic({ title: 'Fantastic Femmes', tags: ['House', 'R&B', 'Disco', 'Afrobeat'], genres: ['disco', 'house'] }), true);
  // Soul, funk, Latin and jazz count half: a house and disco night with soul and funk stays.
  assert.equal(isElectronic({ title: 'After Hours', tags: ['House', 'Soul', 'Funk', 'Latin', 'Disco'], genres: ['disco', 'house'] }), true);
  assert.equal(isElectronic({ title: 'Vinyl Soul Night', tags: ['R&B', 'Soul', 'Funk', 'Disco', 'Northern Soul'], genres: ['disco'] }), false);
  // A title naming an electronic style outright wins over the tags.
  assert.equal(isElectronic({ title: 'MALOKA CLUB - Latin House, Tribal, Funk', tags: ['R&B', 'Funk', 'Latin', 'Salsa'], genres: ['house'] }), true);
  // Covers bands and tribute acts go, whatever they play.
  assert.equal(isElectronic({ title: 'The Abberettes', tags: ['Cheesy Dance', 'Covers Band/Tribute Act', 'Disco'], genres: ['disco'] }), false);
  // No telling tags: the family decides.
  assert.equal(isElectronic({ title: 'Warehouse party', tags: [], genres: ['electronic'] }), true);
  assert.equal(isElectronic({ title: 'Baddie Season: Ladies\' Night', tags: [], genres: ['misc'] }), false);
  assert.equal(isElectronic({ title: 'Body Heat', tags: ['Other', 'LGBTQ+'], genres: ['electronic'] }), true);
});

test('tag kinds', () => {
  for (const t of ['Techno', 'Tech-House', 'Latin Bass', 'Club', 'Baile Funk', 'Hard Dance', 'Synth Pop', 'Intelligent Dance Music', 'Footwork'])
    assert.equal(tagKind(t), 'electronic', t);
  for (const t of ['Hip-Hop/Rap', 'R&B', 'Afrobeat', 'Garage Rock', 'Alternative Rock', 'Reggaeton', 'K-pop', 'A Cappella', 'Performance Art'])
    assert.equal(tagKind(t), 'other', t);
  for (const t of ['Soul', 'Funk / Soul', 'Latin', 'Jazz']) assert.equal(tagKind(t), 'near', t);
  for (const t of ['Other', '1990s', 'LGBTQ+', 'Old Skool', 'DJ', '']) assert.equal(tagKind(t), null, t);
});

test('an untagged RA night is electronic unless its title names another genre outright', () => {
  assert.equal(fallbackGenre({ title: 'Alternative School presents: Musicology with Glenn Underground', tags: [], source: 'ra' }), 'electronic');
  assert.equal(fallbackGenre({ title: 'Hip-Hop Night: open format', tags: [], source: 'ra' }), 'misc');
  // Ticketmaster's Reggae > DJ is a sound system, not a DJ set.
  assert.equal(fallbackGenre({ title: 'Kingston Sound', tags: ['DJ', 'Reggae'], source: 'ticketmaster' }), 'misc');
});

test('listings that aren\'t electronic music are dropped and noted for the archive', () => {
  const london = { id: 'london', name: 'London', lat: 51.5, lon: -0.12, tz: 'Europe/London' };
  const ctx = { cities: [london], cityById: { london }, notElectronic: new Set() };
  const base = { source: 'ra', startMs: Date.parse('2026-11-14T22:00:00Z'), cityHint: 'london', lat: 51.49, lon: -0.1, venueName: 'Corsica Studios' };
  assert.equal(makeEvent(ctx, { ...base, id: '1', title: 'HIPHOP NIGHT', tags: ['Hip-Hop', 'R&B'] }), null);
  assert.ok(makeEvent(ctx, { ...base, id: '2', title: 'Body Heat', tags: ['Techno'] }));
  assert.deepEqual([...ctx.notElectronic], ['ra:1']);
  const tm = listing('Alter Bridge', edm(), [act('Alter Bridge', cls('Music', 'Rock', 'Alternative Rock'))]);
  assert.equal(ticketmaster.normalize(tm, ctx), null);
  assert.ok(ctx.notElectronic.has('ticketmaster:Alter-Bridge'));
});
