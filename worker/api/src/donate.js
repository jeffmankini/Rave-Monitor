// Donations to Rave Monitor, once or every month, through Stripe Checkout: /v1/donate on api.ravemonitor.com.
//
// Everything on Rave Monitor is free for everyone; a donation unlocks nothing. Nothing about donors is
// kept here: Stripe holds the payment and, for a monthly gift, the subscription. Monthly donors change
// or cancel on Stripe's customer portal: GET /v1/donate/manage sends them to its login page, where
// Stripe emails them a link.
//
// The site's pop-up shows Stripe's checkout inside itself (embedded Checkout) when the deploy gave the
// Worker a publishable key in the same mode as its secret key (STRIPE_PUBLISHABLE_KEY). Without one,
// it sends people to Stripe's own page and back.
//
// The deploy (.github/workflows/api-worker.yml) makes the product (id rm_donation) and turns on the
// portal's login page, from STRIPE_SECRET_KEY alone. Every call pins the API version, so the account's
// default can move on without changing what these calls mean. Logs carry Stripe's error codes, never
// names or addresses.

export const STRIPE_VERSION = '2026-10-28.endive';
export const PRODUCT = 'rm_donation';
export const MIN_CENTS = 100, MAX_CENTS = 100000;   // $1 to $1,000
const HEX = /^#[0-9a-f]{6}$/i;
const SESSION_RE = /^cs_(?:live|test)_[A-Za-z0-9]{10,250}$/;

export const stripeMode = key => /^(sk|rk)_live_/.test(key || '') ? 'live' : /^(sk|rk)_test_/.test(key || '') ? 'test' : '';
/** Donations are on once the deploy has stored a secret (or restricted) key. */
export const donateOn = env => !!stripeMode(env.STRIPE_SECRET_KEY);
/** The publishable key, if it's in the same mode as the secret key: then checkout opens in the pop-up. */
export function publishableKey(env) {
  const m = stripeMode(env.STRIPE_SECRET_KEY), pk = String(env.STRIPE_PUBLISHABLE_KEY || '').trim();
  return m && new RegExp('^pk_' + m + '_[A-Za-z0-9]{10,}$').test(pk) ? pk : '';
}

// Stripe's API takes form fields, with nested objects as a[b][c].
function fields(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object') ? fields(x, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(x)]));
    else if (typeof v === 'object') fields(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}
export async function stripe(env, method, path, params, fetchImpl = fetch) {
  const qs = new URLSearchParams(fields(params)).toString();
  const r = await fetchImpl('https://api.stripe.com/v1' + path + (method === 'GET' && qs ? '?' + qs : ''), {
    method,
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': STRIPE_VERSION },
    body: method === 'GET' ? undefined : qs
  });
  let data = {};
  try { data = await r.json(); } catch (err) { data = {}; }
  if (!r.ok) {
    const e = new Error((data.error && (data.error.code || data.error.type)) || 'stripe_' + r.status);
    e.status = r.status;
    e.param = (data.error && data.error.param) || '';
    e.detail = String((data.error && data.error.message) || '').slice(0, 200);
    throw e;
  }
  return data;
}

const siteUrl = env => String(env.SITE_URL || 'https://ravemonitor.com').replace(/\/+$/, '');

/** Dollars from the pop-up (5, "12.50", "$20") to cents, or 0 when it isn't an amount we take. */
export function cents(v) {
  const s = String(v == null ? '' : v).trim().replace(/^\$\s*/, '');
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return 0;
  const c = Math.round(Number(s) * 100);
  return c >= MIN_CENTS && c <= MAX_CENTS ? c : 0;
}
export const dollars = c => '$' + (c % 100 ? (c / 100).toFixed(2) : String(c / 100));

/** The Checkout Session for one gift. colors: the site's current panel and accent colors, so
 *  Stripe's page looks like part of the pop-up. */
export function sessionParams({ amount, monthly, embedded, site, colors }) {
  const back = site + '/?donated={CHECKOUT_SESSION_ID}';
  const p = {
    mode: monthly ? 'subscription' : 'payment',
    ui_mode: embedded ? 'embedded_page' : 'hosted_page',
    submit_type: 'donate',
    line_items: [{ quantity: 1, price_data: { currency: 'usd', product: PRODUCT, unit_amount: amount, recurring: monthly ? { interval: 'month' } : undefined } }],
    metadata: { app: 'ravemonitor', gift: monthly ? 'monthly' : 'once' },
    integration_identifier: 'ravemonitor-donate',
    branding_settings: {
      display_name: 'Rave Monitor', border_style: 'rounded',
      background_color: colors ? colors.bg : undefined, button_color: colors ? colors.accent : undefined
    },
    custom_text: {
      submit: {
        message: monthly
          ? `${dollars(amount)} today, then each month. Cancel any time: open Donate on ravemonitor.com and choose "Change or cancel a monthly gift".`
          : 'Thank you for keeping Rave Monitor free for everyone.'
      }
    }
  };
  if (monthly) p.subscription_data = { description: 'Monthly donation to Rave Monitor', metadata: { app: 'ravemonitor' } };
  else p.payment_intent_data = { description: 'Donation to Rave Monitor', metadata: { app: 'ravemonitor' } };
  if (embedded) {
    // Cards and wallets finish inside the pop-up; payment methods that send people to their bank come back here.
    p.return_url = back;
    p.redirect_on_completion = 'if_required';
  } else {
    p.success_url = back;
    p.cancel_url = site + '/?donate=open';
  }
  return p;
}

/** POST /v1/donate { amount: dollars, monthly, colors: { bg, accent }, ui: 'hosted' to skip the pop-up }:
 *  a client secret for checkout in the pop-up, or the address of Stripe's page. */
export async function donate(env, ctx, data) {
  if (!donateOn(env)) return ctx.out({ ok: false, error: 'not_configured' }, 503);
  if (env.AUTH_LIMITER) {
    const { success } = await env.AUTH_LIMITER.limit({ key: 'donate:' + (ctx.ip || 'unknown') });
    if (!success) return ctx.out({ ok: false, error: 'rate_limited' }, 429);
  }
  const amount = cents(data.amount);
  if (!amount) return ctx.out({ ok: false, error: 'bad_amount' }, 400);
  const pk = publishableKey(env), embedded = !!pk && data.ui !== 'hosted';
  const c = data.colors && typeof data.colors === 'object' ? data.colors : {};
  const colors = HEX.test(c.bg || '') && HEX.test(c.accent || '') ? { bg: c.bg.toLowerCase(), accent: c.accent.toLowerCase() } : null;
  try {
    const s = await stripe(env, 'POST', '/checkout/sessions', sessionParams({ amount, monthly: data.monthly === true, embedded, site: siteUrl(env), colors }), ctx.fetch);
    return ctx.out(embedded ? { ok: true, clientSecret: s.client_secret, publishableKey: pk } : { ok: true, url: s.url }, 200);
  } catch (err) {
    console.log('donate: checkout failed', err.status || '', err.message, err.param, err.detail);
    // Stripe's reason (an error code, the parameter, its message: nothing about the visitor), to tell
    // a setup problem in Stripe from a passing one.
    return ctx.out({ ok: false, error: 'stripe', code: err.message, param: err.param || undefined, detail: err.detail || undefined }, 502);
  }
}

/** GET /v1/donate/session?id=cs_…: how a gift went, for the thank-you. No names, emails or cards. */
export async function donation(env, ctx, id) {
  if (!donateOn(env)) return ctx.out({ ok: false, error: 'not_configured' }, 503);
  if (!SESSION_RE.test(String(id || ''))) return ctx.out({ ok: false, error: 'bad_session' }, 400);
  try {
    const s = await stripe(env, 'GET', '/checkout/sessions/' + encodeURIComponent(id), null, ctx.fetch);
    if (!s.metadata || s.metadata.app !== 'ravemonitor') return ctx.out({ ok: false, error: 'not_found' }, 404);
    return ctx.out({
      ok: true, status: s.status, paid: s.payment_status === 'paid' || s.payment_status === 'no_payment_required',
      monthly: s.mode === 'subscription', amount: Number(s.amount_total) || 0
    }, 200);
  } catch (err) {
    if (err.status === 404) return ctx.out({ ok: false, error: 'not_found' }, 404);
    console.log('donate: session lookup failed', err.status || '', err.message);
    return ctx.out({ ok: false, error: 'stripe' }, 502);
  }
}

/** GET /v1/donate/manage: to the customer portal's login page, where monthly donors change or cancel.
 *  Without one (or without Stripe), to the contact page. */
export async function manage(env, ctx) {
  let url = '';
  if (donateOn(env)) {
    try {
      const r = await stripe(env, 'GET', '/billing_portal/configurations', { active: 'true', limit: 50 }, ctx.fetch);
      const list = (r.data || []).filter(c => c.login_page && c.login_page.enabled && c.login_page.url);
      const conf = list.find(c => c.metadata && c.metadata.app === 'ravemonitor') || list.find(c => c.is_default);
      url = conf ? String(conf.login_page.url) : '';
    } catch (err) { console.log('donate: portal lookup failed', err.status || '', err.message); }
  }
  const to = /^https:\/\/billing\.stripe\.com\/[^\s"<>]+$/.test(url) ? url : siteUrl(env) + '/contact/';
  return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
