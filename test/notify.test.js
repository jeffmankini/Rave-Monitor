import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, hasSqlite } from './helpers/fake-d1.js';
import { planAlerts, planEmails, digestTimes, venueResolver, fingerprint, run, zoned } from '../pipeline/notify.js';

const skip = !hasSqlite && 'node:sqlite needs Node 22.5 or later';
const NOW = Date.parse('2026-11-11T12:00:00Z');   // Wednesday, 6am in Milwaukee
const H = 36e5;
const CITIES = { milwaukee: 'Milwaukee', chicago: 'Chicago' };
const cityName = id => CITIES[id] || id;
const iso = t => new Date(t).toISOString();
const ev = (id, city, venue, start, extra = {}) => ({
  id, title: 'Night ' + id, start: iso(start), end: iso(start + 5 * H), tz: 'America/Chicago', cityId: city,
  venue: { name: venue, lat: 43, lon: -87.9 }, lineup: [], genres: ['house'], status: 'onsale', sources: [{ id: 'ra', name: 'Resident Advisor', url: 'https://ra.co/events/' + id }], ...extra
});
const EVENTS = [
  ev('ra:1', 'milwaukee', 'Split Shift', NOW + 50 * H, { lineup: ['Ben UFO', 'Someone'], promoters: ['Body & Soul'], popularity: 40 }),
  ev('ra:2', 'chicago', 'Smartbar', NOW + 70 * H, { lineup: ['Bén UFO'] }),
  ev('ra:3', 'milwaukee', 'Cafe Lounge', NOW + 20 * H, { lineup: ['DJ X'] }),
  ev('ra:4', 'milwaukee', 'The Cooperage', NOW + 100 * H, { status: 'cancelled', genres: ['techno'] })
];
const user = (id, over = {}) => ({ id, email: id + '@example.com', created_at: NOW - H, cities: '[]', genres: '[]', tz: 'America/Chicago', email_freq: 'instant', alerts: '{"follows":true,"saved":true,"picks":false}', mine: 1, unsub: 'u'.repeat(32), digest_at: 0, ...over });
const USERS = [
  user('u1', { cities: '["milwaukee"]', alerts: '{"follows":true,"saved":true,"picks":true}' }),
  user('u2', { email_freq: 'daily' }),
  user('u3', { email_freq: 'off', mine: 0, cities: '["milwaukee"]' })
];
const FOLLOWS = [
  { user_id: 'u1', kind: 'artist', key: 'ben ufo', label: 'Ben UFO' },
  { user_id: 'u1', kind: 'venue', key: 'milwaukee-split-shift', label: 'split/shift' },
  { user_id: 'u2', kind: 'promoter', key: 'body and soul', label: 'Body & Soul' },
  { user_id: 'u3', kind: 'artist', key: 'ben ufo', label: 'Ben UFO' }
];
const SAVES = [{ user_id: 'u1', event_id: 'ra:3' }, { user_id: 'u1', event_id: 'ra:4' }];
const venueOf = venueResolver([], [{ name: 'split/shift', match: ['splitshift', 'split shift'], city: 'milwaukee' }], cityName);
const seenAll = (evs, status) => evs.map(e => ({ id: e.id, fp: fingerprint(e, cityName), first_seen: NOW - 30 * H, status: status || e.status }));

test('first run only takes note, but still reminds about saved shows', () => {
  const p = planAlerts({ events: EVENTS, seen: [], users: USERS, follows: FOLLOWS, saves: SAVES, now: NOW, cityName, venueOf });
  assert.equal(p.bootstrap, true);
  assert.equal(p.seenNew.length, 4);
  assert.equal(p.alerts.filter(a => a.kind === 'new_show').length, 0);
  const r = p.alerts.find(a => a.kind === 'reminder');
  assert.equal(r.user_id, 'u1');
  assert.equal(r.ref, 'ra:3');
  assert.match(r.body, /^Tomorrow at 2:00 AM\. You saved this show\.$/);
});

test('new listings become alerts for their followers, in their cities', () => {
  const seen = seenAll(EVENTS.slice(2), 'onsale');   // ra:3 and ra:4 known, ra:4 was on sale
  const p = planAlerts({ events: EVENTS, seen, users: USERS, follows: FOLLOWS, saves: SAVES, now: NOW, cityName, venueOf });
  const news = p.alerts.filter(a => a.kind === 'new_show').map(a => `${a.user_id} ${a.ref} ${a.body}`).sort();
  assert.deepEqual(news, [
    'u1 ra:1 You follow Ben UFO and split/shift',   // not ra:2: u1 only wants Milwaukee
    'u2 ra:1 You follow Body & Soul',
    'u3 ra:1 You follow Ben UFO',                    // u3 wants everywhere (and gets no email, but the alert shows on the site)
    'u3 ra:2 You follow Ben UFO'
  ]);
  const a = p.alerts.find(x => x.user_id === 'u1' && x.kind === 'new_show');
  const data = JSON.parse(a.data);
  assert.equal(data.cityName, 'Milwaukee');
  assert.equal(data.url, 'https://ra.co/events/ra:1');
  // A saved show that was cancelled since the last run.
  const c = p.alerts.find(x => x.kind === 'cancelled');
  assert.equal(c.user_id, 'u1');
  assert.equal(c.ref, 'ra:4');
  assert.deepEqual(p.seenStatus, [{ id: 'ra:4', status: 'cancelled', was: 'onsale' }]);
  // Weekly picks for u1's city, soonest first; the cancelled night isn't one.
  const pk = p.alerts.find(x => x.kind === 'picks');
  assert.equal(pk.ref, 'picks:2026-11-05');
  assert.equal(pk.title, 'Picks for your week in Milwaukee');
  assert.deepEqual(JSON.parse(pk.data).events.map(e => e.id), ['ra:3', 'ra:1']);
});

test('the same night under a new id is not news', () => {
  const seen = seenAll(EVENTS);
  const moved = { ...EVENTS[0], id: 'tm:99' };
  const p = planAlerts({ events: [moved], seen, users: USERS, follows: FOLLOWS, saves: [], now: NOW, cityName, venueOf });
  assert.equal(p.alerts.filter(a => a.kind === 'new_show').length, 0);
  assert.deepEqual(p.seenNew.map(s => [s.id, s.first_seen]), [['tm:99', NOW - 30 * H]]);
});

test('digest times follow each person\'s clock', () => {
  const tz = 'America/Chicago';
  // Wednesday 6am: today's 8am hasn't come, so the last daily time is Tuesday 8am; weekly is last Thursday.
  let t = digestTimes(NOW, tz);
  assert.equal(iso(t.daily), '2026-11-10T14:00:00.000Z');
  assert.equal(iso(t.weekly), '2026-11-05T14:00:00.000Z');
  // Thursday 9am.
  t = digestTimes(Date.parse('2026-11-12T15:00:00Z'), tz);
  assert.equal(iso(t.daily), '2026-11-12T14:00:00.000Z');
  assert.equal(t.week, '2026-11-12');
  assert.equal(iso(zoned(2026, 3, 8, 8, tz)), '2026-03-08T13:00:00.000Z'); // the morning clocks go forward
});

test('emails: instant goes now, digests wait for 8am, changes never wait', () => {
  const n = (id, user_id, kind) => ({ id, user_id, kind, ref: 'ra:' + id, title: 'Night', body: '', data: '{}' });
  const unsent = [n(1, 'u1', 'new_show'), n(2, 'u2', 'new_show'), n(3, 'u2', 'cancelled'), n(4, 'u3', 'new_show')];
  let e = planEmails({ unsent, users: USERS, now: NOW });
  assert.deepEqual(e.map(x => [x.user.id, x.freq, x.items.map(i => i.id)]), [['u1', 'instant', [1]], ['u2', 'instant', [3]]]);
  // 9am Thursday: u2's daily digest is due, and takes everything.
  e = planEmails({ unsent, users: USERS, now: Date.parse('2026-11-12T15:00:00Z') });
  assert.deepEqual(e.find(x => x.user.id === 'u2').items.map(i => i.id), [2, 3]);
  assert.equal(e.find(x => x.user.id === 'u2').freq, 'daily');
  // Not twice in a day.
  const done = USERS.map(u => u.id === 'u2' ? { ...u, digest_at: Date.parse('2026-11-12T14:30:00Z') } : u);
  assert.deepEqual(planEmails({ unsent, users: done, now: Date.parse('2026-11-12T18:00:00Z') }).find(x => x.user.id === 'u2').items.map(i => i.id), [3]);
});

test('instant alerts: anyone who chose them gets everything at once, with no digest', () => {
  const n = (id, user_id, kind) => ({ id, user_id, kind, ref: 'ra:' + id, title: 'Night', body: '', data: '{}' });
  const fan = user('u9'), weekly = user('u8', { email_freq: 'weekly' });
  const unsent = [n(1, 'u9', 'new_show'), n(2, 'u9', 'reminder'), n(3, 'u8', 'new_show')];
  const e = planEmails({ unsent, users: [fan, weekly], now: NOW });
  assert.deepEqual(e.map(x => [x.user.id, x.freq, x.digest, x.items.map(i => i.id)]), [['u9', 'instant', false, [1, 2]]]);
});

test('scene alerts: every new night in their cities and genres, once', () => {
  const fan = user('s1', { cities: '["milwaukee","chicago"]', genres: '["techno"]', scene: 1, alerts: '{"follows":true,"saved":true,"picks":false}' });
  const local = user('s2', { cities: '["milwaukee"]', scene: 1, alerts: '{"follows":true,"saved":true,"picks":false}' });  // every genre
  const off = user('s3', { cities: '["milwaukee"]', scene: 0, alerts: '{"follows":true,"saved":true,"picks":false}' });
  const evs = [
    ev('n:1', 'milwaukee', 'Cactus Club', NOW + 30 * H, { genres: ['techno'] }),
    ev('n:2', 'chicago', 'Smartbar', NOW + 50 * H, { genres: ['techno', 'house'] }),
    ev('n:3', 'chicago', 'Sound-Bar', NOW + 60 * H, { genres: ['house'] }),         // not their genre
    ev('n:4', 'detroit', 'TV Lounge', NOW + 40 * H, { genres: ['techno'] }),        // not their city
    ev('n:5', 'milwaukee', 'Fuel Cafe', NOW + 20 * H, { genres: ['techno'], lineup: ['Ben UFO'] })  // a new show they follow
  ];
  const seen = seenAll(EVENTS);
  const p = planAlerts({ events: evs, seen, users: [fan, local, off], follows: [{ user_id: 's1', kind: 'artist', key: 'ben ufo', label: 'Ben UFO' }], saves: [], now: NOW, cityName, venueOf });
  const scene = p.alerts.filter(a => a.kind === 'scene');
  assert.deepEqual(scene.map(a => a.user_id), ['s1', 's2']);
  assert.equal(scene[0].title, '2 new nights in Milwaukee and Chicago');
  assert.deepEqual(JSON.parse(scene[0].data).events.map(e => e.id), ['n:1', 'n:2']);
  // Without genres picked, every new night in their city, soonest first; n:5 counts, since s2 doesn't follow Ben UFO.
  assert.equal(scene[1].title, '2 new nights in Milwaukee');
  assert.deepEqual(JSON.parse(scene[1].data).events.map(e => e.id), ['n:5', 'n:1']);
  assert.ok(p.alerts.some(a => a.user_id === 's1' && a.kind === 'new_show' && a.ref === 'n:5'));
  // Seen next time: nothing new.
  const again = planAlerts({ events: evs, seen: seen.concat(p.seenNew), users: [fan], follows: [], saves: [], now: NOW + H, cityName, venueOf });
  assert.equal(again.alerts.filter(a => a.kind === 'scene').length, 0);
});

test('venues match the directory, its other spellings and the curated list', () => {
  const rows = [['milwaukee-cafe-lounge', 'Cafe Lounge', 'milwaukee', 43, -87.9, 0, null, 5, 1, null, null, null, {}, [], ['cafe lounge room']]];
  const of = venueResolver(rows, [{ name: 'split/shift', match: ['splitshift'], city: 'milwaukee' }], cityName);
  assert.equal(of(ev('a', 'milwaukee', 'Cafe Lounge Milwaukee', NOW)), 'milwaukee-cafe-lounge');
  assert.equal(of(ev('b', 'milwaukee', 'The Cafe Lounge Room', NOW)), 'milwaukee-cafe-lounge');
  assert.equal(of(ev('c', 'milwaukee', 'SPLITSHIFT', NOW)), 'milwaukee-split-shift');
  assert.equal(of(ev('d', 'milwaukee', 'Somewhere New', NOW)), 'milwaukee-somewhere-new');
});

test('a run writes alerts once, emails them and keeps count', { skip }, async () => {
  const D = fakeD1();
  const db = {
    all: async (sql, params = []) => D.rows(sql, ...params),
    batch: async stmts => { D.db.exec('BEGIN'); try { for (const s of stmts) D.db.prepare(s.sql).run(...s.params); D.db.exec('COMMIT'); } catch (err) { D.db.exec('ROLLBACK'); throw err; } }
  };
  for (const u of USERS) D.db.prepare('INSERT INTO users (id, email, created_at, seen_at, cities, genres, tz, email_freq, alerts, mine, unsub) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)').run(u.id, u.email, u.created_at, u.cities, u.genres, u.tz, u.email_freq, u.alerts, u.mine, u.unsub);
  for (const f of FOLLOWS) D.db.prepare('INSERT INTO follows (user_id, kind, key, label, created_at) VALUES (?, ?, ?, ?, 0)').run(f.user_id, f.kind, f.key, f.label);
  for (const s of SAVES) D.db.prepare('INSERT INTO saves (user_id, event_id, title, created_at) VALUES (?, ?, ?, 0)').run(s.user_id, s.event_id, 'x');
  const outbox = [];
  const mail = { from: 'hello@ravemonitor.com', fromName: 'Rave Monitor', stream: async () => 'alerts', send: async msgs => { outbox.push(...msgs); return { ok: true, status: 200, data: msgs.map(m => ({ ErrorCode: m.To.startsWith('u2') ? 406 : 0 })) }; } };
  const feed = { cities: [{ id: 'milwaukee', name: 'Milwaukee' }, { id: 'chicago', name: 'Chicago' }], events: EVENTS.slice(2) };
  const curated = [{ name: 'split/shift', match: ['splitshift', 'split shift'], city: 'milwaukee' }];
  const quiet = () => {};
  // First run: notes ra:3 and ra:4, reminds u1 about ra:3, and u1's weekly picks.
  await run({ db, feed, venues: null, curated, now: NOW, mail, log: quiet });
  assert.equal(D.rows('SELECT COUNT(*) AS n FROM seen_events')[0].n, 2);
  assert.deepEqual(D.rows('SELECT user_id, kind FROM notifications ORDER BY id').map(r => r.user_id + ' ' + r.kind), ['u1 reminder', 'u1 picks']);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].To, 'u1@example.com');
  assert.equal(outbox[0].MessageStream, 'alerts');
  assert.match(outbox[0].Headers[0].Value, /^<https:\/\/api\.ravemonitor\.com\/v1\/unsubscribe\?u=u1&t=u{32}>$/);
  assert.equal(outbox[0].Headers[1].Value, 'List-Unsubscribe=One-Click');
  assert.match(outbox[0].HtmlBody, /\?event=ra%3A3/);

  // Second run, an hour on (7am in Milwaukee): ra:1 and ra:2 are new.
  outbox.length = 0;
  await run({ db, feed: { ...feed, events: EVENTS }, venues: null, curated, now: NOW + H, mail, log: quiet });
  const kinds = D.rows('SELECT user_id, kind, ref FROM notifications ORDER BY id').map(r => `${r.user_id} ${r.kind} ${r.ref}`);
  assert.deepEqual(kinds.slice(2).sort(), ['u1 new_show ra:1', 'u2 new_show ra:1', 'u3 new_show ra:1', 'u3 new_show ra:2'].sort());
  // ra:4 was first seen cancelled, so there's no change to report.
  assert.equal(kinds.filter(k => k.includes('cancelled')).length, 0);
  // u1 (instant) gets an email now; u2's daily digest waits for 8am; u3 has emails off.
  assert.deepEqual(outbox.map(m => m.To), ['u1@example.com']);
  assert.equal(outbox[0].Subject, 'New show: Night ra:1');
  assert.equal(D.rows("SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'u3' AND emailed_at = 0")[0].n, 2);

  // Thursday 9am: a new week's picks for u1, and u2's daily digest, but Postmark won't deliver to u2's
  // address, so emails are turned off for them.
  outbox.length = 0;
  await run({ db, feed: { ...feed, events: EVENTS }, venues: null, curated, now: Date.parse('2026-11-12T15:00:00Z'), mail, log: quiet });
  assert.deepEqual(outbox.map(m => m.To), ['u1@example.com', 'u2@example.com']);
  assert.equal(outbox[0].Subject, 'Picks for your week in Milwaukee');
  assert.equal(outbox[1].Subject, 'New show: Night ra:1');
  assert.equal(outbox[1].Tag, 'daily-digest');
  assert.equal(D.rows("SELECT email_freq FROM users WHERE id = 'u2'")[0].email_freq, 'off');
  // Nothing repeats.
  outbox.length = 0;
  const count = D.rows('SELECT COUNT(*) AS n FROM notifications')[0].n;
  await run({ db, feed: { ...feed, events: EVENTS }, venues: null, curated, now: Date.parse('2026-11-12T18:00:00Z'), mail, log: quiet });
  assert.equal(D.rows('SELECT COUNT(*) AS n FROM notifications')[0].n, count);
  assert.equal(outbox.length, 0);
});
