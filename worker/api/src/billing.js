// Supporters: $5 a month through Stripe, on api.ravemonitor.com/v1/billing/...
//
// Paying and cancelling happen on Stripe's own pages (Checkout and the customer portal), so the site
// loads nothing from Stripe. Stripe's webhook, signed with the secret the deploy stored for the key's
// mode (STRIPE_WEBHOOK_SECRET_TEST or _LIVE), keeps each account's subscription in D1; the account,
// the calendar feed and the alerts step (pipeline/notify.js) read it from there.
//
// The deploy (.github/workflows/api-worker.yml) makes the price (lookup key rm_supporter_monthly),
// the portal settings (metadata app=ravemonitor) and the webhook, from STRIPE_SECRET_KEY alone.
// Logs carry Stripe's error codes and event types, never addresses.

const DAY = 864e5;
export const GRACE = 3 * DAY;                     // after the paid period, while Stripe retries a card
export const PRICE_KEY = 'rm_supporter_monthly';
export const ACTIVE = ['active', 'trialing', 'past_due'];
export const WEBHOOK_EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];

/** Whether this account's perks are on: a live subscription whose paid period hasn't run out. */
export function isSupporter(u, now = Date.now()) {
  return !!u && ACTIVE.includes(u.sub_status) && (Number(u.sub_until) || 0) + GRACE > now;
}
export const stripeMode = key => /^(sk|rk)_live_/.test(key || '') ? 'live' : /^(sk|rk)_test_/.test(key || '') ? 'test' : '';
const webhookSecret = env => { const m = stripeMode(env.STRIPE_SECRET_KEY); return m ? env['STRIPE_WEBHOOK_SECRET_' + m.toUpperCase()] || '' : ''; };
/** Billing is on once the deploy has stored a key and its webhook's secret. */
export const billingOn = env => !!webhookSecret(env);

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
    method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : qs
  });
  let data = {};
  try { data = await r.json(); } catch (err) { data = {}; }
  if (!r.ok) {
    const e = new Error((data.error && data.error.code) || 'stripe_' + r.status);
    e.status = r.status;
    throw e;
  }
  return data;
}

// The price and the portal settings the deploy made, looked up once per Worker instance.
const found = {};
async function lookup(env, what, fetchImpl) {
  const k = what + ':' + stripeMode(env.STRIPE_SECRET_KEY);
  if (found[k]) return found[k];
  let id = '';
  if (what === 'price') {
    const r = await stripe(env, 'GET', '/prices', { lookup_keys: [PRICE_KEY], active: 'true', limit: 1 }, fetchImpl);
    id = (r.data && r.data[0] && r.data[0].id) || '';
  } else {
    const r = await stripe(env, 'GET', '/billing_portal/configurations', { active: 'true', limit: 50 }, fetchImpl);
    id = ((r.data || []).find(c => c.metadata && c.metadata.app === 'ravemonitor') || {}).id || '';
  }
  if (id) found[k] = id;
  return id;
}

const siteUrl = env => String(env.SITE_URL || 'https://ravemonitor.com').replace(/\/+$/, '');

/** POST /v1/billing/checkout: a Stripe Checkout page for $5 a month, for the signed-in person. */
export async function checkout(env, ctx, me) {
  if (!billingOn(env)) return ctx.out({ ok: false, error: 'not_configured' }, 503);
  const u = me.user;
  if (isSupporter(u)) return ctx.out({ ok: false, error: 'already' }, 409);
  try {
    const price = await lookup(env, 'price', ctx.fetch);
    if (!price) { console.log('billing: no price with lookup key', PRICE_KEY); return ctx.out({ ok: false, error: 'not_configured' }, 503); }
    const site = siteUrl(env);
    const params = {
      mode: 'subscription', line_items: [{ price, quantity: 1 }], client_reference_id: u.id,
      subscription_data: { metadata: { user_id: u.id } }, metadata: { user_id: u.id },
      success_url: site + '/?account=supporter&checkout=done', cancel_url: site + '/?account=supporter',
      allow_promotion_codes: 'true'
    };
    if (u.stripe_customer) params.customer = u.stripe_customer; else params.customer_email = u.email;
    if (env.STRIPE_TAX === '1') { params.automatic_tax = { enabled: 'true' }; if (u.stripe_customer) params.customer_update = { address: 'auto' }; }
    const s = await stripe(env, 'POST', '/checkout/sessions', params, ctx.fetch);
    return ctx.out({ ok: true, url: s.url }, 200);
  } catch (err) {
    console.log('billing checkout failed', err.status || '', err.message);
    return ctx.out({ ok: false, error: 'billing' }, 502);
  }
}

/** POST /v1/billing/portal: Stripe's page for changing the card or cancelling. */
export async function portal(env, ctx, me) {
  if (!billingOn(env)) return ctx.out({ ok: false, error: 'not_configured' }, 503);
  if (!me.user.stripe_customer) return ctx.out({ ok: false, error: 'no_subscription' }, 400);
  try {
    const conf = await lookup(env, 'portal', ctx.fetch);
    const s = await stripe(env, 'POST', '/billing_portal/sessions', { customer: me.user.stripe_customer, return_url: siteUrl(env) + '/?account=supporter', configuration: conf || undefined }, ctx.fetch);
    return ctx.out({ ok: true, url: s.url }, 200);
  } catch (err) {
    console.log('billing portal failed', err.status || '', err.message);
    return ctx.out({ ok: false, error: 'billing' }, 502);
  }
}

/** When an account is deleted: its Stripe customer goes too, which ends the subscription at once. */
export async function forgetCustomer(env, user, fetchImpl) {
  if (!user.stripe_customer || !stripeMode(env.STRIPE_SECRET_KEY)) return true;
  try { await stripe(env, 'DELETE', '/customers/' + encodeURIComponent(user.stripe_customer), null, fetchImpl); return true; }
  catch (err) { if (err.status === 404) return true; console.log('billing: deleting the customer failed', err.status || '', err.message); return false; }
}

/* ---------- the webhook ---------- */

const hexOf = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
function sameText(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
/** Stripe-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "t.payload">; five minutes' leeway. */
export async function verifySignature(payload, header, secret, now = Date.now(), tolerance = 300) {
  if (!secret) return false;
  const parts = String(header || '').split(',').map(p => p.trim().split('='));
  const t = (parts.find(p => p[0] === 't') || [])[1];
  const sigs = parts.filter(p => p[0] === 'v1' && p[1]).map(p => p[1]);
  if (!t || !/^\d{1,12}$/.test(t) || !sigs.length || Math.abs(now / 1000 - Number(t)) > tolerance) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hexOf(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + payload)));
  return sigs.some(s => sameText(s, mac));
}

// The end of the paid period: on the subscription in older API versions, on its items in newer ones.
const periodEnd = s => 1000 * (Number(s.current_period_end) || Math.max(0, ...((s.items && s.items.data) || []).map(i => Number(i.current_period_end) || 0)));
const idOf = x => typeof x === 'string' ? x : (x && x.id) || '';

/** The account's subscription as Stripe has it now (events can arrive out of order). */
async function sync(env, fetchImpl, { userId, customer, subId }) {
  if (!subId) return;
  const s = await stripe(env, 'GET', '/subscriptions/' + encodeURIComponent(subId), null, fetchImpl);
  const cust = idOf(customer) || idOf(s.customer);
  let user = userId ? await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(String(userId)).first() : null;
  if (!user && cust) user = await env.DB.prepare('SELECT * FROM users WHERE stripe_customer = ?').bind(cust).first();
  if (!user) { console.log('billing webhook: no account for this subscription'); return; }
  // Another subscription ending while the one we track still runs (say, a second checkout): keep ours.
  if (user.stripe_sub && user.stripe_sub !== s.id && isSupporter(user) && !ACTIVE.includes(s.status)) return;
  const live = ACTIVE.includes(s.status);
  await env.DB.prepare('UPDATE users SET stripe_customer = ?, stripe_sub = ?, sub_status = ?, sub_until = ?, sub_cancel_at_end = ?, supporter_since = COALESCE(supporter_since, ?) WHERE id = ?')
    .bind(cust || user.stripe_customer || null, s.id, String(s.status || ''), periodEnd(s), (s.cancel_at_period_end || s.cancel_at) && live ? 1 : 0, live ? Date.now() : null, user.id).run();
}

/** POST /v1/billing/webhook: from Stripe, signed; no session or Origin. */
export async function webhook(request, env, ctx) {
  if (!billingOn(env)) return ctx.out({ ok: false, error: 'not_configured' }, 503);
  const raw = await request.text();
  if (raw.length > 512 * 1024) return ctx.out({ ok: false, error: 'too_large' }, 413);
  if (!(await verifySignature(raw, request.headers.get('Stripe-Signature'), webhookSecret(env)))) return ctx.out({ ok: false, error: 'signature' }, 400);
  let ev = null;
  try { ev = JSON.parse(raw); } catch (err) { ev = null; }
  if (!ev || typeof ev.type !== 'string') return ctx.out({ ok: false, error: 'bad_request' }, 400);
  // A test-mode event reaching a live-mode Worker (or the reverse) changes nothing.
  if (!!ev.livemode !== (stripeMode(env.STRIPE_SECRET_KEY) === 'live')) return ctx.out({ ok: true, ignored: 'mode' }, 200);
  const o = (ev.data && ev.data.object) || {};
  try {
    if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
      await sync(env, ctx.fetch, { userId: o.client_reference_id || (o.metadata && o.metadata.user_id), customer: o.customer, subId: idOf(o.subscription) });
    } else if (/^customer\.subscription\./.test(ev.type)) {
      await sync(env, ctx.fetch, { userId: o.metadata && o.metadata.user_id, customer: o.customer, subId: o.id });
    }
  } catch (err) {
    // Stripe tries again later.
    console.log('billing webhook failed', ev.type, err.status || '', err.message);
    return ctx.out({ ok: false, error: 'retry' }, 500);
  }
  return ctx.out({ ok: true }, 200);
}
