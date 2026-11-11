import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, hasSqlite } from './helpers/fake-d1.js';
import { handleAccounts } from '../worker/api/src/accounts.js';
import { cents, dollars, stripeMode, publishableKey, STRIPE_VERSION } from '../worker/api/src/donate.js';
import { icsFile } from '../worker/api/src/calendar.js';

const SITE = 'https://ravemonitor.com';
const API = 'https://api.ravemonitor.com';
const skip = !hasSqlite && 'node:sqlite needs Node 22.5 or later';
const NOW = Date.now();

// A Worker with a test-mode Stripe key, Stripe answered by a fake.
function setup(over = {}) {
  const DB = fakeD1();
  const sent = [], stripeCalls = [];
  const sessions = {
    cs_test_a1b2c3d4e5f6: { id: 'cs_test_a1b2c3d4e5f6', status: 'complete', payment_status: 'paid', mode: 'subscription', amount_total: 500, metadata: { app: 'ravemonitor' }, customer_details: { email: 'donor@example.com' } },
    cs_test_zzzzzzzzzzzz: { id: 'cs_test_zzzzzzzzzzzz', status: 'complete', payment_status: 'paid', mode: 'payment', amount_total: 9900, metadata: {} }
  };
  let portals = [{ id: 'bpc_1', is_default: true, metadata: { app: 'ravemonitor' }, login_page: { enabled: true, url: 'https://billing.stripe.com/p/login/test_abc123' } }];
  const env = {
    DB, ALLOWED_ORIGINS: SITE, SITE_URL: SITE, TURNSTILE_SECRET: 'secret', TURNSTILE_HOSTNAMES: 'ravemonitor.com',
    POSTMARK_TOKEN: 'pm-token', STRIPE_SECRET_KEY: 'rk_test_abc', ...over
  };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('turnstile')) return new Response(JSON.stringify({ success: true, hostname: 'ravemonitor.com' }));
    if (u.startsWith('https://api.postmarkapp.com/email')) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ErrorCode: 0, Message: 'OK' })); }
    if (u.startsWith('https://api.stripe.com/v1/')) {
      const path = u.slice('https://api.stripe.com/v1'.length).split('?')[0];
      const body = Object.fromEntries(new URLSearchParams(init.body || u.split('?')[1] || ''));
      stripeCalls.push({ method: init.method, path, body, headers: init.headers });
      const ok = data => new Response(JSON.stringify(data), { status: 200 });
      if (path === '/checkout/sessions' && init.method === 'POST') {
        return ok(body.ui_mode === 'embedded_page' ? { id: 'cs_test_new', client_secret: 'cs_test_new_secret_xyz' } : { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
      }
      if (path.startsWith('/checkout/sessions/')) { const s = sessions[path.split('/')[3]]; return s ? ok(s) : new Response(JSON.stringify({ error: { code: 'resource_missing' } }), { status: 404 }); }
      if (path === '/billing_portal/configurations') return ok({ data: portals });
      return new Response(JSON.stringify({ error: { code: 'unexpected' } }), { status: 400 });
    }
    throw new Error('unexpected fetch ' + u);
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
    return { res, status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  const signIn = async (email = 'fan@example.com') => {
    await call('POST', '/v1/auth/start', { email, turnstile: 'tok' });
    const token = new URL(sent.at(-1).TextBody.match(/https:\/\/\S+/)[0]).searchParams.get('signin');
    await call('POST', '/v1/auth/verify', { token, tz: 'America/Chicago' });
    return DB.rows('SELECT id FROM users WHERE email = ?', email)[0].id;
  };
  return { env, DB, stripeCalls, call, signIn, setPortals: p => { portals = p; } };
}
const lastCheckout = calls => calls.filter(c => c.path === '/checkout/sessions').at(-1);

test('amounts: whole or cents, $1 to $1,000', () => {
  assert.deepEqual([5, '12.50', '$20', '1', '1000', 12.5].map(cents), [500, 1250, 2000, 100, 100000, 1250]);
  assert.deepEqual([0, '0.99', '1000.01', 'abc', '12.345', '', null, '-5', '1e3'].map(cents), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([500, 1250, 100000].map(dollars), ['$5', '$12.50', '$1000']);
  assert.equal(stripeMode('sk_live_x'), 'live'); assert.equal(stripeMode('rk_test_x'), 'test'); assert.equal(stripeMode('pk_test_x'), '');
  // The publishable key only counts in the same mode as the secret key.
  assert.equal(publishableKey({ STRIPE_SECRET_KEY: 'rk_live_a', STRIPE_PUBLISHABLE_KEY: 'pk_live_0123456789ab' }), 'pk_live_0123456789ab');
  assert.equal(publishableKey({ STRIPE_SECRET_KEY: 'rk_test_a', STRIPE_PUBLISHABLE_KEY: 'pk_live_0123456789ab' }), '');
  assert.equal(publishableKey({ STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: 'pk_test_0123456789ab' }), '');
});

test('donations stay off without a Stripe key', { skip }, async () => {
  const off = setup({ STRIPE_SECRET_KEY: '' });
  const h = (await off.call('GET', '/v1/health')).body;
  assert.equal(h.donate, false);
  assert.equal(h.donateInPopup, false);
  assert.equal((await off.call('POST', '/v1/donate', { amount: 5 })).status, 503);
  // Monthly donors are sent to the contact page when there's no portal to send them to.
  const m = await off.call('GET', '/v1/donate/manage', undefined, { Origin: '' });
  assert.equal(m.status, 302);
  assert.equal(m.res.headers.get('Location'), SITE + '/contact/');
});

test('a one-time gift on Stripe\'s page: no account needed, only from the site', { skip }, async () => {
  const { call, stripeCalls } = setup();
  assert.equal((await call('GET', '/v1/health')).body.donate, true);
  assert.equal((await call('GET', '/v1/health')).body.donateInPopup, false);
  const r = await call('POST', '/v1/donate', { amount: 10, colors: { bg: '#0C0F22', accent: '#f6ecd8' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
  const cs = lastCheckout(stripeCalls);
  assert.equal(cs.headers.Authorization, 'Bearer rk_test_abc');
  assert.equal(cs.headers['Stripe-Version'], STRIPE_VERSION);
  const b = cs.body;
  assert.deepEqual([b.mode, b.ui_mode, b.submit_type], ['payment', 'hosted_page', 'donate']);
  assert.deepEqual([b['line_items[0][price_data][product]'], b['line_items[0][price_data][unit_amount]'], b['line_items[0][price_data][currency]'], b['line_items[0][quantity]']], ['rm_donation', '1000', 'usd', '1']);
  assert.equal(b['line_items[0][price_data][recurring][interval]'], undefined);
  assert.equal(b.success_url, SITE + '/?donated={CHECKOUT_SESSION_ID}');
  assert.equal(b.cancel_url, SITE + '/?donate=open');
  assert.equal(b['payment_intent_data[description]'], 'Donation to Rave Monitor');
  assert.equal(b['metadata[app]'], 'ravemonitor');
  assert.equal(b['managed_payments[enabled]'], 'false'); // a donation isn't a digital product sale
  assert.deepEqual([0, 1, 2, 3].map(i => b['excluded_payment_method_types[' + i + ']']), ['klarna', 'affirm', 'afterpay_clearpay', 'zip']);
  assert.deepEqual([b['branding_settings[background_color]'], b['branding_settings[button_color]']], ['#0c0f22', '#f6ecd8']);
  // Nothing about the visitor goes to Stripe from here.
  assert.ok(!Object.keys(b).some(k => /customer|email/.test(k)));
  // Only from the site itself, and only amounts we take.
  assert.equal((await call('POST', '/v1/donate', { amount: 10 }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/v1/donate', { amount: 0.5 })).body.error, 'bad_amount');
  assert.equal((await call('POST', '/v1/donate', { amount: 5000 })).body.error, 'bad_amount');
  // Colors that aren't #rrggbb are left out.
  await call('POST', '/v1/donate', { amount: 3, colors: { bg: 'red', accent: '#ffffff' } });
  assert.equal(lastCheckout(stripeCalls).body['branding_settings[background_color]'], undefined);
});

test('a monthly gift inside the pop-up, with the publishable key', { skip }, async () => {
  const { call, stripeCalls } = setup({ STRIPE_PUBLISHABLE_KEY: 'pk_test_0123456789abcdef' });
  assert.equal((await call('GET', '/v1/health')).body.donateInPopup, true);
  const r = await call('POST', '/v1/donate', { amount: '5', monthly: true });
  assert.deepEqual(r.body, { ok: true, clientSecret: 'cs_test_new_secret_xyz', publishableKey: 'pk_test_0123456789abcdef' });
  const b = lastCheckout(stripeCalls).body;
  assert.deepEqual([b.mode, b.ui_mode, b.redirect_on_completion], ['subscription', 'embedded_page', 'if_required']);
  assert.equal(b['line_items[0][price_data][recurring][interval]'], 'month');
  assert.equal(b['line_items[0][price_data][product]'], 'rm_donation_monthly');
  assert.equal(b['line_items[0][price_data][unit_amount]'], '500');
  assert.equal(b.return_url, SITE + '/?donated={CHECKOUT_SESSION_ID}');
  assert.equal(b.cancel_url, undefined);
  assert.equal(b['subscription_data[description]'], 'Monthly donation to Rave Monitor');
  assert.match(b['custom_text[submit][message]'], /^\$5 today, then each month\. Cancel any time/);
  // If Stripe.js can't load in the browser, the pop-up asks for Stripe's page instead.
  assert.ok((await call('POST', '/v1/donate', { amount: 5, monthly: true, ui: 'hosted' })).body.url);
  // A publishable key from the other mode is ignored.
  const mixed = setup({ STRIPE_PUBLISHABLE_KEY: 'pk_live_0123456789abcdef' });
  assert.ok((await mixed.call('POST', '/v1/donate', { amount: 5 })).body.url);
});

test('donations are rate limited per address', { skip }, async () => {
  const keys = [];
  const { call } = setup({ AUTH_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: keys.length < 3 }; } } });
  assert.equal((await call('POST', '/v1/donate', { amount: 5 })).status, 200);
  assert.equal((await call('POST', '/v1/donate', { amount: 5 })).status, 200);
  assert.equal((await call('POST', '/v1/donate', { amount: 5 })).status, 429);
  assert.equal(keys[0], 'donate:203.0.113.9');
});

test('the thank-you asks how it went, and learns nothing personal', { skip }, async () => {
  const { call } = setup();
  const r = await call('GET', '/v1/donate/session?id=cs_test_a1b2c3d4e5f6', undefined, { Origin: '' });
  assert.deepEqual(r.body, { ok: true, status: 'complete', paid: true, monthly: true, amount: 500 });
  assert.equal((await call('GET', '/v1/donate/session?id=cs_test_zzzzzzzzzzzz')).status, 404); // not one of ours
  assert.equal((await call('GET', '/v1/donate/session?id=cs_test_nope000000')).status, 404);
  assert.equal((await call('GET', '/v1/donate/session?id=../../customers')).status, 400);
});

test('monthly donors manage their gift on Stripe\'s portal', { skip }, async () => {
  const { call, setPortals, stripeCalls } = setup();
  const r = await call('GET', '/v1/donate/manage', undefined, { Origin: '' });
  assert.equal(r.status, 302);
  assert.equal(r.res.headers.get('Location'), 'https://billing.stripe.com/p/login/test_abc123');
  assert.equal(stripeCalls.at(-1).headers['Stripe-Version'], STRIPE_VERSION);
  setPortals([{ id: 'bpc_1', is_default: true, metadata: {}, login_page: { enabled: false, url: null } }]);
  assert.equal((await call('GET', '/v1/donate/manage', undefined, { Origin: '' })).res.headers.get('Location'), SITE + '/contact/');
});

test('every perk is free: instant alerts, scene alerts, own colors, the calendar feed', { skip }, async () => {
  const { call, signIn, DB } = setup();
  const uid = await signIn();
  const me0 = (await call('GET', '/v1/me')).body;
  assert.equal('billing' in me0, false);
  assert.equal('supporter' in me0.user, false);
  assert.equal((await call('PATCH', '/v1/me', { freq: 'instant', scene: true, customTheme: { bg: '#3A0D0D', accent: '#ffd166' } })).status, 200);
  let me = (await call('GET', '/v1/me')).body.user;
  assert.deepEqual([me.freq, me.scene, me.customTheme], ['instant', true, { bg: '#3a0d0d', accent: '#ffd166' }]);
  assert.equal((await call('PATCH', '/v1/me', { customTheme: { bg: 'red', accent: '#fff' } })).body.error, 'bad_colors');
  // The color theme follows the account: a preset's id, or custom for their own colors.
  assert.equal(me.theme, null);
  assert.equal((await call('PATCH', '/v1/me', { theme: 'ember' })).body.user.theme, 'ember');
  assert.equal((await call('PATCH', '/v1/me', { theme: 'Ember; DROP' })).body.error, 'bad_theme');
  assert.equal((await call('PATCH', '/v1/me', { theme: 'custom' })).body.user.theme, 'custom');
  assert.equal((await call('GET', '/v1/me')).body.user.theme, 'custom');
  assert.equal((await call('PATCH', '/v1/me', { scene: false, customTheme: null, theme: null, freq: 'daily' })).status, 200);
  me = (await call('GET', '/v1/me')).body.user;
  assert.deepEqual([me.freq, me.scene, me.customTheme, me.theme], ['daily', false, null, null]);

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
  // Deleting the account takes the feed with it.
  assert.equal((await call('DELETE', '/v1/me', { confirm: 'delete' })).status, 200);
  assert.equal((await call('GET', new URL(c2.body.url).pathname, undefined, { Cookie: '', Origin: '' })).status, 404);
  assert.equal(DB.rows('SELECT COUNT(*) AS n FROM users')[0].n, 0);
});

test('the calendar file', () => {
  const ics = icsFile([{ id: 'x', title: 'Ø'.repeat(80), start: Date.UTC(2026, 10, 14, 3), end: Date.UTC(2026, 10, 14, 7), where: 'A', url: '' }], { now: Date.UTC(2026, 10, 10) });
  assert.match(ics, /DTSTART:20261114T030000Z\r\n/);
  assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});
