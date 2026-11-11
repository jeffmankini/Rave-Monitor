import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeD1, hasSqlite } from './helpers/fake-d1.js';
import { handleAccounts } from '../worker/api/src/accounts.js';
import { verifySignature, isSupporter, stripeMode } from '../worker/api/src/billing.js';
import { icsFile } from '../worker/api/src/calendar.js';

const SITE = 'https://ravemonitor.com';
const API = 'https://api.ravemonitor.com';
const WHSEC = 'whsec_test_secret_123';
const skip = !hasSqlite && 'node:sqlite needs Node 22.5 or later';
const NOW = Date.now();

// A Worker with billing on (a test-mode key and its webhook secret), Stripe answered by a fake.
function setup(over = {}) {
  const DB = fakeD1();
  const sent = [], stripeCalls = [];
  const subs = { sub_1: { id: 'sub_1', object: 'subscription', status: 'active', customer: 'cus_1', cancel_at_period_end: false, items: { data: [{ current_period_end: Math.round(NOW / 1000) + 30 * 86400 }] }, metadata: {} } };
  const env = {
    DB, ALLOWED_ORIGINS: SITE, SITE_URL: SITE, TURNSTILE_SECRET: 'secret', TURNSTILE_HOSTNAMES: 'ravemonitor.com',
    POSTMARK_TOKEN: 'pm-token', STRIPE_SECRET_KEY: 'rk_test_abc', STRIPE_WEBHOOK_SECRET_TEST: WHSEC, ...over
  };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('turnstile')) return new Response(JSON.stringify({ success: true, hostname: 'ravemonitor.com' }));
    if (u.startsWith('https://api.postmarkapp.com/email')) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ErrorCode: 0, Message: 'OK' })); }
    if (u.startsWith('https://api.stripe.com/v1/')) {
      const path = u.slice('https://api.stripe.com/v1'.length).split('?')[0];
      const body = Object.fromEntries(new URLSearchParams(init.body || u.split('?')[1] || ''));
      stripeCalls.push({ method: init.method, path, body, auth: init.headers.Authorization });
      const ok = data => new Response(JSON.stringify(data), { status: 200 });
      if (path === '/prices') return ok({ data: [{ id: 'price_5' }] });
      if (path === '/checkout/sessions') return ok({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
      if (path === '/billing_portal/configurations') return ok({ data: [{ id: 'bpc_other', metadata: {} }, { id: 'bpc_rm', metadata: { app: 'ravemonitor' } }] });
      if (path === '/billing_portal/sessions') return ok({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/1' });
      if (path.startsWith('/subscriptions/')) { const s = subs[path.split('/')[2]]; return s ? ok(s) : new Response(JSON.stringify({ error: { code: 'resource_missing' } }), { status: 404 }); }
      if (path.startsWith('/customers/') && init.method === 'DELETE') return ok({ id: path.split('/')[2], deleted: true });
      return new Response(JSON.stringify({ error: { code: 'unexpected' } }), { status: 400 });
    }
    throw new Error('unexpected fetch ' + u);
  };
  let cookie = '';
  const call = async (method, path, body, headers = {}, raw) => {
    const h = { Origin: SITE, 'CF-Connecting-IP': '203.0.113.9', ...headers };
    if (cookie && !('Cookie' in headers)) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await handleAccounts(new Request(API + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) }), env, { fetch });
    const set = res.headers.get('Set-Cookie');
    if (set) { const v = set.split(';')[0]; cookie = /=$/.test(v) ? '' : v; }
    const type = res.headers.get('Content-Type') || '';
    return { res, status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  const signIn = async (email = 'fan@example.com') => {
    await call('POST', '/v1/auth/start', { email, turnstile: 'tok' });
    const token = new URL(sent.at(-1).TextBody.match(/https:\/\/\S+/)[0]).searchParams.get('signin');
    const v = await call('POST', '/v1/auth/verify', { token, tz: 'America/Chicago' });
    return DB.rows('SELECT id FROM users WHERE email = ?', email)[0].id;
  };
  // Stripe's signed POST to the webhook.
  const deliver = async (event, secret = WHSEC, t = Math.round(Date.now() / 1000)) => {
    const raw = JSON.stringify(event);
    const sig = crypto.createHmac('sha256', secret).update(t + '.' + raw).digest('hex');
    return call('POST', '/v1/billing/webhook', undefined, { 'Stripe-Signature': `t=${t},v1=${sig}`, Origin: '' }, raw);
  };
  return { env, DB, sent, stripeCalls, subs, call, signIn, deliver };
}

test('billing stays off until the key and its webhook secret are there', { skip }, async () => {
  const off = setup({ STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET_TEST: '' });
  assert.equal((await off.call('GET', '/v1/health')).body.billing, false);
  assert.equal((await off.call('GET', '/v1/me')).body.billing, null);
  await off.signIn();
  assert.equal((await off.call('POST', '/v1/billing/checkout', {})).status, 503);
  // A live key with only the test webhook secret is still off.
  const half = setup({ STRIPE_SECRET_KEY: 'rk_live_abc' });
  assert.equal((await half.call('GET', '/v1/health')).body.billing, false);
  const on = setup();
  assert.equal((await on.call('GET', '/v1/health')).body.billing, true);
  // A test-mode key says so; the site only shows it in a browser that opened the preview link.
  assert.deepEqual((await on.call('GET', '/v1/me')).body.billing, { price: '$5 a month', test: true });
  const live = setup({ STRIPE_SECRET_KEY: 'rk_live_abc', STRIPE_WEBHOOK_SECRET_LIVE: WHSEC });
  assert.deepEqual((await live.call('GET', '/v1/me')).body.billing, { price: '$5 a month' });
  assert.equal(stripeMode('sk_live_x'), 'live'); assert.equal(stripeMode('rk_test_x'), 'test'); assert.equal(stripeMode('pk_test_x'), '');
});

test('checkout: a $5-a-month Stripe page for the signed-in person', { skip }, async () => {
  const { call, signIn, stripeCalls } = setup();
  assert.equal((await call('POST', '/v1/billing/checkout', {})).status, 401);
  const uid = await signIn();
  const r = await call('POST', '/v1/billing/checkout', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.url, 'https://checkout.stripe.com/c/pay/cs_1');
  const cs = stripeCalls.find(c => c.path === '/checkout/sessions');
  assert.equal(cs.auth, 'Bearer rk_test_abc');
  assert.equal(cs.body['line_items[0][price]'], 'price_5');
  assert.equal(cs.body.mode, 'subscription');
  assert.equal(cs.body.client_reference_id, uid);
  assert.equal(cs.body['subscription_data[metadata][user_id]'], uid);
  assert.equal(cs.body.customer_email, 'fan@example.com');
  assert.equal(cs.body.success_url, SITE + '/?account=supporter&checkout=done');
  // Only from the site itself.
  assert.equal((await call('POST', '/v1/billing/checkout', {}, { Origin: 'https://evil.example' })).status, 403);
});

test('the webhook: signed by Stripe, it turns the perks on and off', { skip }, async () => {
  const { call, signIn, deliver, DB, subs } = setup();
  const uid = await signIn();
  const done = { id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { mode: 'subscription', client_reference_id: uid, customer: 'cus_1', subscription: 'sub_1' } } };
  // Unsigned, wrongly signed or stale: refused.
  assert.equal((await call('POST', '/v1/billing/webhook', undefined, { Origin: '' }, JSON.stringify(done))).status, 400);
  assert.equal((await deliver(done, 'whsec_wrong')).status, 400);
  assert.equal((await deliver(done, WHSEC, Math.round(Date.now() / 1000) - 3600)).status, 400);
  // A live-mode event reaching the test-mode Worker changes nothing.
  assert.equal((await deliver({ ...done, livemode: true })).body.ignored, 'mode');
  assert.equal((await call('GET', '/v1/me')).body.user.supporter, null);

  assert.equal((await deliver(done)).status, 200);
  let me = (await call('GET', '/v1/me')).body.user;
  assert.ok(me.supporter && !me.supporter.ending && !me.supporter.late);
  assert.equal(DB.rows('SELECT stripe_customer, stripe_sub, sub_status FROM users')[0].stripe_customer, 'cus_1');
  // Now right-away emails, scene alerts and their own colors are allowed.
  assert.equal((await call('PATCH', '/v1/me', { freq: 'instant', scene: true, customTheme: { bg: '#3A0D0D', accent: '#ffd166' } })).status, 200);
  me = (await call('GET', '/v1/me')).body.user;
  assert.deepEqual([me.freq, me.scene, me.customTheme], ['instant', true, { bg: '#3a0d0d', accent: '#ffd166' }]);
  assert.equal((await call('PATCH', '/v1/me', { customTheme: { bg: 'red', accent: '#fff' } })).body.error, 'bad_colors');

  // They cancel in the portal: perks run to the end of the month.
  subs.sub_1 = { ...subs.sub_1, cancel_at_period_end: true };
  await deliver({ id: 'evt_2', type: 'customer.subscription.updated', livemode: false, data: { object: { id: 'sub_1', customer: 'cus_1', metadata: {} } } });
  assert.equal((await call('GET', '/v1/me')).body.user.supporter.ending, true);
  // The month ends.
  subs.sub_1 = { ...subs.sub_1, status: 'canceled' };
  await deliver({ id: 'evt_3', type: 'customer.subscription.deleted', livemode: false, data: { object: { id: 'sub_1', customer: 'cus_1', metadata: {} } } });
  me = (await call('GET', '/v1/me')).body.user;
  assert.equal(me.supporter, null);
  assert.equal(me.scene, false);
  assert.equal(me.billingAccount, true);
  assert.equal((await call('PATCH', '/v1/me', { freq: 'instant' })).body.error, 'supporters_only');
  // Turning things off, or clearing colors, always works.
  assert.equal((await call('PATCH', '/v1/me', { scene: false, customTheme: null, freq: 'daily' })).status, 200);
});

test('perks are supporters only, and the portal needs a Stripe customer', { skip }, async () => {
  const { call, signIn } = setup();
  await signIn();
  assert.equal((await call('PATCH', '/v1/me', { freq: 'instant' })).body.error, 'supporters_only');
  assert.equal((await call('PATCH', '/v1/me', { scene: true })).body.error, 'supporters_only');
  assert.equal((await call('PATCH', '/v1/me', { customTheme: { bg: '#000000', accent: '#ffffff' } })).body.error, 'supporters_only');
  assert.equal((await call('POST', '/v1/me/calendar', {})).body.error, 'supporters_only');
  assert.equal((await call('POST', '/v1/billing/portal', {})).body.error, 'no_subscription');
  assert.equal((await call('PATCH', '/v1/me', { freq: 'weekly' })).status, 200);
});

test('portal, calendar feed and deleting a supporter account', { skip }, async () => {
  const { call, signIn, deliver, DB, stripeCalls } = setup();
  const uid = await signIn();
  await deliver({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { mode: 'subscription', client_reference_id: uid, customer: 'cus_1', subscription: 'sub_1' } } });
  const p = await call('POST', '/v1/billing/portal', {});
  assert.equal(p.body.url, 'https://billing.stripe.com/p/session/1');
  const ps = stripeCalls.find(c => c.path === '/billing_portal/sessions');
  assert.deepEqual([ps.body.customer, ps.body.configuration, ps.body.return_url], ['cus_1', 'bpc_rm', SITE + '/?account=supporter']);

  // Calendar: a saved show and a new show from someone they follow.
  const start = new Date(NOW + 3 * 864e5).toISOString();
  await call('POST', '/v1/saves', { event: { id: 'ra:1', title: 'Night; One, Two', start, city: 'st-petersburg', venue: 'Club X', url: 'https://ra.co/events/1' } });
  DB.db.prepare("INSERT INTO notifications (user_id, kind, ref, title, body, data, created_at) VALUES (?, 'new_show', 'tm:9', 'Big Night', 'You follow Ben UFO', ?, ?)")
    .run(uid, JSON.stringify({ id: 'tm:9', title: 'Big Night', start: new Date(NOW + 9 * 864e5).toISOString(), end: new Date(NOW + 9 * 864e5 + 5 * 36e5).toISOString(), cityName: 'Chicago', venue: 'Smartbar' }), NOW);
  const c = await call('POST', '/v1/me/calendar', {});
  assert.match(c.body.url, /^https:\/\/api\.ravemonitor\.com\/v1\/cal\/[A-Za-z0-9_-]{32}\.ics$/);
  assert.equal((await call('GET', '/v1/me')).body.calendar, c.body.url);
  const feed = await call('GET', new URL(c.body.url).pathname, undefined, { Cookie: '', Origin: '' });
  assert.equal(feed.status, 200);
  assert.match(feed.res.headers.get('Content-Type'), /^text\/calendar/);
  assert.match(feed.body, /SUMMARY:Night\\; One\\, Two/);
  assert.match(feed.body, /LOCATION:Club X\\, St Petersburg/);
  assert.match(feed.body, /SUMMARY:Big Night/);
  assert.match(feed.body, /DESCRIPTION:You follow Ben UFO/);
  assert.ok(feed.body.split('\r\n').every(l => Buffer.byteLength(l) <= 75), 'lines fold at 75 bytes');
  // A reset makes the old address stop working.
  const c2 = await call('POST', '/v1/me/calendar', { reset: true });
  assert.notEqual(c2.body.url, c.body.url);
  assert.equal((await call('GET', new URL(c.body.url).pathname, undefined, { Cookie: '', Origin: '' })).status, 404);

  // Deleting the account deletes the Stripe customer, which ends the subscription.
  const d = await call('DELETE', '/v1/me', { confirm: 'delete' });
  assert.equal(d.status, 200);
  assert.ok(stripeCalls.some(x => x.method === 'DELETE' && x.path === '/customers/cus_1'));
  assert.equal(DB.rows('SELECT COUNT(*) AS n FROM users')[0].n, 0);
});

test('signatures and the calendar file', async () => {
  const raw = '{"id":"evt"}', t = Math.round(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WHSEC).update(t + '.' + raw).digest('hex');
  assert.equal(await verifySignature(raw, `t=${t},v1=deadbeef,v1=${sig}`, WHSEC), true);
  assert.equal(await verifySignature(raw + ' ', `t=${t},v1=${sig}`, WHSEC), false);
  assert.equal(await verifySignature(raw, `t=${t}`, WHSEC), false);
  assert.equal(await verifySignature(raw, `t=${t},v1=${sig}`, ''), false);
  assert.equal(isSupporter({ sub_status: 'trialing', sub_until: Date.now() + 1000 }), true);
  assert.equal(isSupporter({ sub_status: 'incomplete', sub_until: Date.now() + 1e9 }), false);
  const ics = icsFile([{ id: 'x', title: 'Ø'.repeat(80), start: Date.UTC(2026, 10, 14, 3), end: Date.UTC(2026, 10, 14, 7), where: 'A', url: '' }], { now: Date.UTC(2026, 10, 10) });
  assert.match(ics, /DTSTART:20261114T030000Z\r\n/);
  assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});
