import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, hasSqlite } from './helpers/fake-d1.js';
import { handleAccounts } from '../worker/api/src/accounts.js';
import { searchTerm, MIN_GROUP } from '../worker/api/src/insights.js';

const SITE = 'https://ravemonitor.com';
const API = 'https://api.ravemonitor.com';
const skip = !hasSqlite && 'node:sqlite needs Node 22.5 or later';
const DAY = 864e5;

function setup() {
  const DB = fakeD1();
  const sent = [];
  const env = {
    DB, ALLOWED_ORIGINS: SITE, SITE_URL: SITE, TURNSTILE_SECRET: 'secret', TURNSTILE_HOSTNAMES: 'ravemonitor.com',
    POSTMARK_TOKEN: 'pm-token', ADMIN_EMAILS: 'Boss@Example.com, other@example.com'
  };
  const fetch = async (url, init) => {
    if (String(url).includes('turnstile')) return new Response(JSON.stringify({ success: true, hostname: 'ravemonitor.com' }));
    if (String(url).startsWith('https://api.postmarkapp.com/email')) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ErrorCode: 0 })); }
    throw new Error('unexpected fetch ' + url);
  };
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const h = { Origin: SITE, 'CF-Connecting-IP': '203.0.113.9', ...headers };
    if (cookie && !('Cookie' in headers)) h.Cookie = cookie;
    const res = await handleAccounts(new Request(API + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env, { fetch });
    const set = res.headers.get('Set-Cookie');
    if (set) { const v = set.split(';')[0]; cookie = /=$/.test(v) ? '' : v; }
    const type = res.headers.get('Content-Type') || '';
    return { res, status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  const signIn = async email => {
    await call('POST', '/v1/auth/start', { email, turnstile: 'tok' });
    const token = new URL(sent.at(-1).TextBody.match(/https:\/\/\S+/)[0]).searchParams.get('signin');
    return call('POST', '/v1/auth/verify', { token, tz: 'America/Chicago' });
  };
  return { env, DB, call, signIn, signOut: () => { cookie = ''; } };
}

// People with follows, saves, cities and genres, written straight to the database.
function seed(DB, n, { follow = [], cities = ['chicago'], genres = ['house'], save = null, ago = 2 } = {}) {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const id = 'u' + Math.random().toString(36).slice(2, 10);
    DB.db.prepare('INSERT INTO users (id, email, created_at, seen_at, cities, genres, unsub) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, id + '@example.com', now - ago * DAY, now - ago * DAY, JSON.stringify(cities), JSON.stringify(genres), 'unsub-' + id);
    for (const [kind, key, label, city] of follow) DB.db.prepare('INSERT INTO follows (user_id, kind, key, label, city, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, kind, key, label, city || null, now - ago * DAY);
    if (save) DB.db.prepare('INSERT INTO saves (user_id, event_id, title, start, city, venue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, save.id, save.title, save.start, save.city, save.venue, now);
  }
}

test('search terms: lowercased and trimmed; addresses, phone numbers and links are never kept', () => {
  assert.equal(searchTerm('  Hessle   Audio '), 'hessle audio');
  assert.equal(searchTerm('BRKS'), 'brks');
  assert.equal(searchTerm('x'), '');
  assert.equal(searchTerm('someone@example.com'), '');
  assert.equal(searchTerm('414 555 0199'), '');
  assert.equal(searchTerm('(414) 555-0199'), '');
  assert.equal(searchTerm('https://ra.co/dj/x'), '');
  assert.equal(searchTerm('www.example.org'), '');
  assert.equal(searchTerm('a'.repeat(61)), '');
  assert.equal(searchTerm('dj 2024'), 'dj 2024');
});

test('a search is counted by day, with nothing about who searched', { skip }, async () => {
  const { call, DB, signIn } = setup();
  await signIn('fan@example.com');   // a signed-in browser's cookie must not matter
  let r = await call('POST', '/v1/log/search', '{"q":"  BRKS ","kind":"artist","pick":"BRKS","city":"chicago","results":1}', { 'Content-Type': 'text/plain;charset=UTF-8' });
  assert.equal(r.status, 204);
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), SITE);
  await call('POST', '/v1/log/search', { q: 'brks', kind: 'artist', pick: 'BRKS', city: 'chicago', results: 1 });
  await call('POST', '/v1/log/search', { q: 'warehouse rave', kind: '', results: 0 });
  await call('POST', '/v1/log/search', { q: 'me@example.com', kind: '', results: 0 });     // not kept
  await call('POST', '/v1/log/search', { q: 'techno', kind: 'nope', pick: 'x', city: '../x', results: 3 });
  const rows = DB.rows('SELECT q, kind, pick, city, found, n FROM search_daily ORDER BY q');
  assert.deepEqual(rows.map(x => [x.q, x.kind, x.pick, x.city, x.found, x.n]), [
    ['brks', 'artist', 'BRKS', 'chicago', 1, 2],
    ['techno', '', '', '', 1, 1],
    ['warehouse rave', '', '', '', 0, 1]
  ]);
  // The table has no column that could hold an account, an IP address or a cookie.
  const cols = DB.rows('PRAGMA table_info(search_daily)').map(c => c.name);
  assert.deepEqual(cols, ['day', 'q', 'kind', 'pick', 'city', 'found', 'n']);
  // Only the site itself can send them.
  r = await call('POST', '/v1/log/search', { q: 'house', results: 1 }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  // Junk gets the same quiet answer.
  r = await call('POST', '/v1/log/search', 'not json');
  assert.equal(r.status, 204);
});

test('the dashboard: signed out 401, signed in but not an admin 403, admins get counts and no addresses', { skip }, async () => {
  const { call, DB, signIn, signOut } = setup();
  assert.equal((await call('GET', '/v1/admin/stats')).status, 401);
  await signIn('fan@example.com');
  const no = await call('GET', '/v1/admin/stats');
  assert.equal(no.status, 403);
  assert.equal(no.body.error, 'not_admin');
  signOut();

  seed(DB, 12, { follow: [['artist', 'brks', 'BRKS'], ['venue', 'smart-bar', 'Smart Bar', 'chicago']], cities: ['chicago'], genres: ['house', 'techno'], save: { id: 'ev1', title: 'Disco Sundown', start: new Date(Date.now() + 3 * DAY).toISOString(), city: 'chicago', venue: 'Smart Bar' } });
  seed(DB, 3, { follow: [['artist', 'geff bohm', 'Geff Bohm']], cities: ['milwaukee'], genres: ['house'], ago: 40 });
  await call('POST', '/v1/log/search', { q: 'brks', kind: 'artist', pick: 'BRKS', city: 'chicago', results: 1 });
  await call('POST', '/v1/log/search', { q: 'warehouse rave', results: 0 });

  await signIn('boss@example.com');    // ADMIN_EMAILS matches whatever the case
  const r = await call('GET', '/v1/admin/stats?days=30');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body;
  assert.equal(s.days, 30);
  assert.equal(s.totals.users, 17);            // 15 seeded, the fan and the admin
  assert.equal(s.totals.new_users, 14);        // the three from 40 days ago are outside the period
  assert.deepEqual(s.follows.top.artist.map(a => [a.name, a.n, a.recent]), [['BRKS', 12, 12], ['Geff Bohm', 3, 0]]);
  assert.deepEqual(s.follows.top.venue.map(a => [a.name, a.city, a.n]), [['Smart Bar', 'chicago', 12]]);
  assert.deepEqual(s.cities.slice(0, 2), [{ id: 'chicago', n: 12 }, { id: 'milwaukee', n: 3 }]);
  assert.deepEqual(s.genres[0], { id: 'house', n: 15 });
  assert.deepEqual(s.follows.artistsByCity.chicago, [{ name: 'BRKS', n: 12 }]);
  assert.deepEqual(s.saves.top.map(x => [x.title, x.n]), [['Disco Sundown', 12]]);
  assert.equal(s.searches.totals.n, 2);
  assert.equal(s.searches.totals.misses, 1);
  assert.deepEqual(s.searches.misses, [{ q: 'warehouse rave', n: 1 }]);
  assert.deepEqual(s.searches.picks, [{ kind: 'artist', pick: 'BRKS', n: 1 }]);
  // Counts only: no email address anywhere in what the dashboard gets.
  assert.ok(!/@/.test(JSON.stringify(s)), 'an address leaked into the stats');
  // Unknown periods fall back to 30 days.
  assert.equal((await call('GET', '/v1/admin/stats?days=3')).body.days, 30);
});

test('research exports: CSV, only groups of at least ten, whatever is asked for', { skip }, async () => {
  const { call, DB, signIn } = setup();
  seed(DB, MIN_GROUP, { follow: [['artist', 'brks', 'BRKS']], cities: ['chicago'], genres: ['house'] });
  seed(DB, MIN_GROUP - 1, { follow: [['artist', 'solo', '=HYPERLINK("x")']], cities: ['milwaukee'], genres: ['techno'] });
  for (let i = 0; i < MIN_GROUP; i++) await call('POST', '/v1/log/search', { q: 'warehouse rave', results: 0 });
  for (let i = 0; i < 3; i++) await call('POST', '/v1/log/search', { q: 'rare name', results: 0 });
  await signIn('other@example.com');
  let r = await call('GET', '/v1/admin/export?table=follows&min=1');
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get('Content-Type'), /^text\/csv/);
  assert.match(r.res.headers.get('Content-Disposition'), /^attachment; filename="rave-monitor-follows-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(r.res.headers.get('X-Min-Group'), String(MIN_GROUP));
  assert.equal(r.body, `kind,name,city,followers,new_followers\r\nartist,BRKS,,${MIN_GROUP},${MIN_GROUP}\r\n`);
  r = await call('GET', '/v1/admin/export?table=interest');
  assert.equal(r.body, `city,genre,people\r\nchicago,house,${MIN_GROUP}\r\n`);
  r = await call('GET', '/v1/admin/export?table=searches&days=7');
  assert.equal(r.body, `search,searches,no_results\r\nwarehouse rave,${MIN_GROUP},${MIN_GROUP}\r\n`);
  assert.equal((await call('GET', '/v1/admin/export?table=users')).status, 400);
  // A name that looks like a formula is written so spreadsheets don't run it.
  seed(DB, 1, { follow: [['artist', 'solo', '=HYPERLINK("x")']] });
  r = await call('GET', '/v1/admin/export?table=follows');
  assert.match(r.body, /artist,"'=HYPERLINK\(""x""\)",,10,10/);
});
