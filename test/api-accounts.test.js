import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, hasSqlite } from './helpers/fake-d1.js';
import { handleAccounts, sha256 } from '../worker/api/src/accounts.js';

const SITE = 'https://ravemonitor.com';
const API = 'https://api.ravemonitor.com';
const skip = !hasSqlite && 'node:sqlite needs Node 22.5 or later';

function setup(over = {}) {
  const DB = fakeD1();
  const sent = [];
  const env = {
    DB, ALLOWED_ORIGINS: SITE, SITE_URL: SITE, TURNSTILE_SECRET: 'secret', TURNSTILE_HOSTNAMES: 'ravemonitor.com',
    POSTMARK_TOKEN: 'pm-token', MAIL_FROM: 'hello@ravemonitor.com', MAIL_FROM_NAME: 'Rave Monitor', ...over
  };
  const fetch = async (url, init) => {
    if (String(url).includes('turnstile')) return new Response(JSON.stringify({ success: true, hostname: 'ravemonitor.com' }));
    if (String(url).startsWith('https://api.postmarkapp.com/email')) { sent.push({ token: init.headers['X-Postmark-Server-Token'], msg: JSON.parse(init.body) }); return new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'm1' })); }
    throw new Error('unexpected fetch ' + url);
  };
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const h = { Origin: SITE, 'CF-Connecting-IP': '203.0.113.9', ...headers };
    if (cookie && !('Cookie' in headers)) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await handleAccounts(new Request(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, { fetch });
    const set = res.headers.get('Set-Cookie');
    if (set) { const v = set.split(';')[0]; cookie = /=$/.test(v) ? '' : v; }
    const type = res.headers.get('Content-Type') || '';
    return { res, status: res.status, body: type.includes('json') ? await res.json() : await res.text(), setCookie: set };
  };
  const signIn = async (email = 'Fan@Example.com') => {
    const start = await call('POST', '/v1/auth/start', { email, turnstile: 'tok' });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const link = sent.at(-1).msg.TextBody.match(/https:\/\/\S+/)[0];
    const token = new URL(link).searchParams.get('signin');
    return call('POST', '/v1/auth/verify', { token, tz: 'America/Chicago' });
  };
  return { env, DB, sent, call, signIn, getCookie: () => cookie, setCookie: c => { cookie = c; } };
}

test('preflight allows the site with credentials', { skip }, async () => {
  const { call } = setup();
  const r = await call('OPTIONS', '/v1/me');
  assert.equal(r.status, 204);
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), SITE);
  assert.equal(r.res.headers.get('Access-Control-Allow-Credentials'), 'true');
});

test('sign-in link: emailed through Postmark, only its hash stored, works once', { skip }, async () => {
  const { call, sent, DB, signIn } = setup();
  assert.equal((await call('POST', '/v1/auth/start', { email: 'not an email', turnstile: 't' })).body.error, 'invalid_email');
  assert.equal((await call('POST', '/v1/auth/start', { email: 'a@b.co' }, { Origin: 'https://evil.example' })).status, 403);
  const v = await signIn();
  assert.equal(v.status, 200);
  assert.equal(v.body.user.email, 'fan@example.com');
  assert.equal(v.body.user.tz, 'America/Chicago');
  assert.equal(v.body.user.freq, 'daily');
  assert.match(v.setCookie, /^rm_session=[A-Za-z0-9_-]{40,}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/);
  const m = sent[0].msg;
  assert.equal(sent[0].token, 'pm-token');
  assert.equal(m.To, 'fan@example.com');
  assert.equal(m.From, 'Rave Monitor <hello@ravemonitor.com>');
  assert.equal(m.MessageStream, 'outbound');
  assert.equal(m.TrackLinks, 'None');
  const token = new URL(m.TextBody.match(/https:\/\/\S+/)[0]).searchParams.get('signin');
  const stored = DB.rows('SELECT hash FROM login_links');
  assert.equal(stored[0].hash, await sha256(token));
  assert.ok(!JSON.stringify(stored).includes(token));
  // The same link can't sign in again.
  assert.equal((await call('POST', '/v1/auth/verify', { token })).body.error, 'link_expired');
});

test('expired links and too many links are refused', { skip }, async () => {
  const { call, DB } = setup();
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/v1/auth/start', { email: 'x@y.co', turnstile: 't' })).status, 200);
  assert.equal((await call('POST', '/v1/auth/start', { email: 'x@y.co', turnstile: 't' })).body.error, 'too_many_links');
  DB.db.exec('UPDATE login_links SET expires_at = 1');
  assert.equal((await call('POST', '/v1/auth/verify', { token: 'A'.repeat(43) })).body.error, 'link_expired');
});

test('sign-in needs Turnstile and Postmark set up', { skip }, async () => {
  const { call } = setup({ POSTMARK_TOKEN: '' });
  assert.equal((await call('POST', '/v1/auth/start', { email: 'x@y.co', turnstile: 't' })).body.error, 'not_configured');
  const { call: call2 } = setup({ TURNSTILE_SECRET: '' });
  assert.equal((await call2('POST', '/v1/auth/start', { email: 'x@y.co', turnstile: 't' })).body.error, 'challenge');
});

test('dev mode on localhost returns the link instead of emailing it', { skip }, async () => {
  const { call, sent } = setup({ DEV_MODE: '1', SITE_URL: 'http://localhost:8778', ALLOWED_ORIGINS: 'http://localhost:8778', POSTMARK_TOKEN: '' });
  const r = await call('POST', '/v1/auth/start', { email: 'dev@example.com' }, { Origin: 'http://localhost:8778' });
  assert.match(r.body.devLink, /^http:\/\/localhost:8778\/\?signin=/);
  assert.equal(sent.length, 0);
  // Not on a production site URL.
  const { call: prod } = setup({ DEV_MODE: '1', POSTMARK_TOKEN: '' });
  assert.equal((await prod('POST', '/v1/auth/start', { email: 'dev@example.com', turnstile: 't' })).body.error, 'not_configured');
});

test('the account: read, preferences, follows, saves', { skip }, async () => {
  const { call, signIn, setCookie } = setup();
  await signIn();
  let me = await call('GET', '/v1/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.follows, []);

  const p = await call('PATCH', '/v1/me', { cities: ['milwaukee', 'chicago', 'BAD ID', 'milwaukee'], genres: ['house'], freq: 'weekly', alerts: { follows: true, saved: true, picks: false }, mine: false, tz: 'Nowhere/Fake' });
  assert.deepEqual(p.body.user.cities, ['milwaukee', 'chicago']);
  assert.equal(p.body.user.freq, 'weekly');
  assert.equal(p.body.user.alerts.picks, false);
  assert.equal(p.body.user.mine, false);
  assert.equal(p.body.user.tz, 'America/Chicago');
  assert.equal((await call('PATCH', '/v1/me', { freq: 'hourly' })).status, 400);

  // The key comes from the name, whatever the page sent.
  const f = await call('POST', '/v1/follows', { kind: 'artist', key: 'whatever', label: 'Ben UFO' });
  assert.deepEqual([f.body.follow.kind, f.body.follow.key, f.body.follow.label], ['artist', 'ben ufo', 'Ben UFO']);
  assert.equal((await call('POST', '/v1/follows', { kind: 'promoter', label: 'Body & Soul' })).body.follow.key, 'body and soul');
  assert.equal((await call('POST', '/v1/follows', { kind: 'venue', key: 'milwaukee-split-shift', label: 'split/shift', city: 'milwaukee' })).body.follow.key, 'milwaukee-split-shift');
  assert.equal((await call('POST', '/v1/follows', { kind: 'venue', key: 'Not An Id', label: 'x' })).body.error, 'bad_name');
  assert.equal((await call('POST', '/v1/follows', { kind: 'planet', label: 'x' })).body.error, 'bad_kind');
  await call('POST', '/v1/follows', { kind: 'artist', label: 'ben ufo', on: false });

  const s = await call('POST', '/v1/saves', { event: { id: 'ra:123', title: 'Night', start: '2026-12-01T22:00:00Z', city: 'milwaukee', venue: 'split/shift', url: 'https://ra.co/events/123' } });
  assert.equal(s.body.save.id, 'ra:123');
  assert.equal((await call('POST', '/v1/saves', { event: { id: 'has space', title: 'x' } })).body.error, 'bad_event');
  me = await call('GET', '/v1/me');
  assert.deepEqual(me.body.follows.map(x => x.key).sort(), ['body and soul', 'milwaukee-split-shift']);
  assert.equal(me.body.saves[0].url, 'https://ra.co/events/123');
  await call('POST', '/v1/saves', { event: { id: 'ra:123' }, on: false });
  assert.equal((await call('GET', '/v1/me')).body.saves.length, 0);

  // Another site can't change anything, and without the cookie nothing is there.
  assert.equal((await call('POST', '/v1/follows', { kind: 'artist', label: 'X' }, { Origin: 'https://evil.example' })).status, 403);
  setCookie('');
  const out = await call('GET', '/v1/me');
  assert.equal(out.status, 200);
  assert.equal(out.body.user, null);
  assert.equal((await call('GET', '/v1/notifications')).status, 401);
});

test('alerts: list, unread count, mark read', { skip }, async () => {
  const { call, signIn, DB } = setup();
  await signIn();
  const uid = DB.rows('SELECT id FROM users')[0].id;
  for (let i = 1; i <= 3; i++) DB.db.prepare('INSERT INTO notifications (user_id, kind, ref, title, body, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid, 'new_show', 'ra:' + i, 'Show ' + i, 'You follow Ben UFO', JSON.stringify({ id: 'ra:' + i }), i);
  let r = await call('GET', '/v1/notifications');
  assert.equal(r.body.unread, 3);
  assert.deepEqual(r.body.items.map(x => x.title), ['Show 3', 'Show 2', 'Show 1']);
  assert.equal(r.body.items[0].data.id, 'ra:3');
  r = await call('POST', '/v1/notifications/read', { ids: [r.body.items[0].id] });
  assert.equal(r.body.unread, 2);
  assert.equal((await call('POST', '/v1/notifications/read', { all: true })).body.unread, 0);
  assert.equal((await call('GET', '/v1/me')).body.unread, 0);
});

test('unsubscribe link: a page with a button, then emails off', { skip }, async () => {
  const { call, signIn, DB } = setup();
  await signIn();
  const u = DB.rows('SELECT id, unsub FROM users')[0];
  const path = `/v1/unsubscribe?u=${u.id}&t=${u.unsub}`;
  const g = await call('GET', path, undefined, { Origin: '' });
  assert.equal(g.status, 200);
  assert.match(g.body, /<form method="post">/);
  assert.equal(DB.rows('SELECT email_freq FROM users')[0].email_freq, 'daily');
  // Mail apps' one-click unsubscribe posts with no Origin.
  const p = await handleAccounts(new Request(API + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }), { DB, ALLOWED_ORIGINS: SITE, SITE_URL: SITE });
  assert.equal(p.status, 200);
  assert.equal(DB.rows('SELECT email_freq FROM users')[0].email_freq, 'off');
  assert.equal((await call('GET', `/v1/unsubscribe?u=${u.id}&t=${'x'.repeat(32)}`, undefined, { Origin: '' })).status, 400);
});

test('export, sign out and delete', { skip }, async () => {
  const { call, signIn, DB, getCookie } = setup();
  await signIn();
  await call('POST', '/v1/follows', { kind: 'label', label: 'Hessle Audio' });
  const x = await call('GET', '/v1/me/export');
  assert.match(x.res.headers.get('Content-Disposition'), /attachment/);
  assert.equal(x.body.account.email, 'fan@example.com');
  assert.equal(x.body.follows[0].label, 'Hessle Audio');

  const saved = getCookie();
  assert.equal((await call('POST', '/v1/auth/signout', {})).status, 200);
  assert.equal(getCookie(), '');
  assert.equal(DB.rows('SELECT COUNT(*) AS n FROM sessions')[0].n, 0);
  assert.equal((await call('GET', '/v1/me', undefined, { Cookie: saved })).body.user, null);

  await signIn();
  assert.equal((await call('DELETE', '/v1/me', {})).body.error, 'confirm');
  assert.equal((await call('DELETE', '/v1/me', { confirm: 'delete' })).status, 200);
  for (const t of ['users', 'follows', 'saves', 'sessions', 'login_links', 'notifications']) assert.equal(DB.rows(`SELECT COUNT(*) AS n FROM ${t}`)[0].n, 0, t);
});

test('rate limits and missing database', { skip }, async () => {
  const { call } = setup({ API_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await call('GET', '/v1/me')).status, 429);
  const { call: call2 } = setup({ AUTH_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await call2('POST', '/v1/auth/start', { email: 'a@b.co', turnstile: 't' })).status, 429);
  const r = await handleAccounts(new Request(API + '/v1/me', { headers: { Origin: SITE } }), { ALLOWED_ORIGINS: SITE });
  assert.equal(r.status, 503);
});
