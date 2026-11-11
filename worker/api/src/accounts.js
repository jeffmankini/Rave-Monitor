// Rave Monitor accounts: the /v1 routes on api.ravemonitor.com.
//
// People sign in with a link emailed through Postmark (no passwords), then a session cookie keeps
// them signed in. They follow artists, venues, promoters and labels, save shows, pick their cities,
// genres and how often to get email, and read their alerts. The alerts are written by the alerts
// step after each refresh (pipeline/notify.js); this Worker only reads them and marks them read.
//
// Only hashes of sign-in links and session cookies are stored. Logs carry error codes, never
// addresses. Writes must come from the site's own pages (ALLOWED_ORIGINS).

import { verifyTurnstile } from './handler.js';
import { sendEmail, message } from './postmark.js';
import { signInEmail } from './emails.js';
import { followKey } from './keys.js';
import { isSupporter, billingOn, stripeMode, checkout, portal, webhook, forgetCustomer } from './billing.js';
import { calendarFeed } from './calendar.js';

const DAY = 864e5;
const LINK_TTL = 15 * 60e3;
const SESSION_TTL = 180 * DAY;
const COOKIE = 'rm_session';
export const KINDS = ['artist', 'venue', 'promoter', 'label'];
export const FREQS = ['instant', 'daily', 'weekly', 'off'];
const MAX_FOLLOWS = 1000, MAX_SAVES = 1000, MAX_BODY = 20000;
const EMAIL_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[a-z]{2,}$/i;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;     // city and genre ids
const SECRET_RE = /^[A-Za-z0-9_-]{20,100}$/;   // link and cookie secrets
const COLOR_RE = /^#[0-9a-f]{6}$/i;

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const line = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const siteUrl = env => String(env.SITE_URL || 'https://ravemonitor.com').replace(/\/+$/, '');
// Local testing only (wrangler dev against a localhost site): show the sign-in link instead of emailing it.
const devMode = env => env.DEV_MODE === '1' && /^http:\/\/localhost[:/]/.test(siteUrl(env) + '/');

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function readJson(request) {
  if (+(request.headers.get('Content-Length') || 0) > MAX_BODY) return null;
  const raw = await request.text();
  if (raw.length > MAX_BODY) return null;
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (err) { return null; }
}

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

function cookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const setCookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.round(maxAge)}`;

export function validTz(tz) {
  const s = String(tz || '');
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(s)) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: s }); return s; } catch (err) { return ''; }
}
const idList = (v, max) => Array.isArray(v) ? [...new Set(v.map(String).filter(x => ID_RE.test(x)))].slice(0, max) : [];
const parse = (s, fallback) => { try { return JSON.parse(s); } catch (err) { return fallback; } };

/** What the site gets to know about the signed-in person. */
export function publicUser(u) {
  const a = parse(u.alerts, {}), sup = isSupporter(u);
  const theme = parse(u.custom_theme, null);
  return {
    email: u.email, since: u.created_at, cities: parse(u.cities, []), genres: parse(u.genres, []), tz: u.tz,
    freq: u.email_freq, alerts: { follows: a.follows !== false, saved: a.saved !== false, picks: a.picks !== false }, mine: !!u.mine,
    // Supporters: until when their perks run, and whether they've cancelled (or a payment failed).
    supporter: sup ? { since: u.supporter_since || null, until: u.sub_until || null, ending: !!u.sub_cancel_at_end, late: u.sub_status === 'past_due' } : null,
    billingAccount: !!u.stripe_customer, scene: !!u.scene && sup,
    customTheme: theme && COLOR_RE.test(theme.bg || '') && COLOR_RE.test(theme.accent || '') ? { bg: theme.bg, accent: theme.accent } : null
  };
}
/** Billing as the site sees it: off, or on with the price to show (and whether it's Stripe's test mode,
 *  which the site only shows to a browser that opened the preview link). */
const billingInfo = env => billingOn(env) ? { price: env.SUPPORTER_PRICE || '$5 a month', ...(stripeMode(env.STRIPE_SECRET_KEY) === 'test' ? { test: true } : {}) } : null;
const calUrl = (ctx, user) => isSupporter(user) && user.cal_token ? ctx.api + '/v1/cal/' + user.cal_token + '.ics' : null;

async function mePayload(env, user, ctx) {
  const [f, s, n] = await env.DB.batch([
    env.DB.prepare('SELECT kind, key, label, city, created_at FROM follows WHERE user_id = ? ORDER BY created_at DESC').bind(user.id),
    env.DB.prepare('SELECT event_id, title, start, city, venue, url, created_at FROM saves WHERE user_id = ? ORDER BY start').bind(user.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(user.id)
  ]);
  return {
    user: publicUser(user), billing: billingInfo(env), calendar: ctx ? calUrl(ctx, user) : null,
    follows: f.results.map(r => ({ kind: r.kind, key: r.key, label: r.label, city: r.city || null, at: r.created_at })),
    saves: s.results.map(r => ({ id: r.event_id, title: r.title, start: r.start, city: r.city, venue: r.venue, url: r.url, at: r.created_at })),
    unread: (n.results[0] || {}).n || 0
  };
}

/** The signed-in person for this request, or null. Once a day the session is extended. */
async function session(request, env) {
  const sid = cookies(request.headers.get('Cookie'))[COOKIE];
  if (!sid || !SECRET_RE.test(sid)) return null;
  const hash = await sha256(sid), now = Date.now();
  const row = await env.DB.prepare('SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?').bind(hash).first();
  if (!row || row.session_expires < now) return null;
  let renew = null;
  if (now - row.seen_at > DAY) {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET seen_at = ? WHERE id = ?').bind(now, row.id),
      env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE hash = ?').bind(now + SESSION_TTL, hash)
    ]);
    row.seen_at = now;
    renew = setCookie(sid, SESSION_TTL / 1000);
  }
  return { user: row, hash, renew };
}

/* ---------- sign in ---------- */

async function authStart(request, env, ctx) {
  if (env.AUTH_LIMITER) {
    const { success } = await env.AUTH_LIMITER.limit({ key: ctx.ip || 'unknown' });
    if (!success) return ctx.out({ ok: false, error: 'rate_limited' }, 429);
  }
  const data = await readJson(request);
  if (!data) return ctx.out({ ok: false, error: 'bad_request' }, 400);
  const email = line(data.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return ctx.out({ ok: false, error: 'invalid_email' }, 400);
  if (!devMode(env)) {
    const check = await verifyTurnstile(env, data.turnstile, ctx.ip, ctx.fetch);
    if (!check.ok) { console.log('turnstile failed', check.codes.join(',')); return ctx.out({ ok: false, error: 'challenge' }, 400); }
    if (!env.POSTMARK_TOKEN) { console.log('sign-in not configured: POSTMARK_TOKEN'); return ctx.out({ ok: false, error: 'not_configured' }, 503); }
  }
  const now = Date.now();
  // At most five links an hour for one address.
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_links WHERE email = ? AND created_at > ?').bind(email, now - 3600e3).first();
  if (recent && recent.n >= 5) return ctx.out({ ok: false, error: 'too_many_links' }, 429);
  const secret = randomToken(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_links WHERE expires_at < ?').bind(now - DAY),
    env.DB.prepare('INSERT INTO login_links (hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(secret), email, now, now + LINK_TTL)
  ]);
  const link = siteUrl(env) + '/?signin=' + secret;
  if (devMode(env)) return ctx.out({ ok: true, devLink: link }, 200);
  const m = signInEmail({ link, siteUrl: siteUrl(env) });
  const r = await sendEmail(env.POSTMARK_TOKEN, message({
    from: env.MAIL_FROM || 'hello@ravemonitor.com', fromName: env.MAIL_FROM_NAME || 'Rave Monitor', to: email,
    subject: m.subject, html: m.html, text: m.text, stream: env.POSTMARK_STREAM || 'outbound', tag: 'sign-in'
  }), ctx.fetch).catch(err => ({ ok: false, status: 0, data: { Message: String(err && err.message) } }));
  if (!r.ok) {
    console.log('sign-in email failed', r.status, (r.data && r.data.ErrorCode) || '', line((r.data && r.data.Message) || '', 160).replace(/[^\s@<>"]+@[^\s@<>"]+/g, '[address]'));
    return ctx.out({ ok: false, error: 'send_failed' }, 502);
  }
  return ctx.out({ ok: true }, 200);
}

async function authVerify(request, env, ctx) {
  const data = await readJson(request);
  const secret = String((data && data.token) || '');
  if (!SECRET_RE.test(secret)) return ctx.out({ ok: false, error: 'link_invalid' }, 400);
  const hash = await sha256(secret), now = Date.now();
  const link = await env.DB.prepare('SELECT email, expires_at, used_at FROM login_links WHERE hash = ?').bind(hash).first();
  if (!link || link.used_at || link.expires_at < now) return ctx.out({ ok: false, error: 'link_expired' }, 400);
  // Use the link up first, so it can't sign in twice.
  const used = await env.DB.prepare('UPDATE login_links SET used_at = ? WHERE hash = ? AND used_at IS NULL').bind(now, hash).run();
  if (!used.meta || !used.meta.changes) return ctx.out({ ok: false, error: 'link_expired' }, 400);
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, email, created_at, seen_at, tz, unsub) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(randomToken(12), link.email, now, now, validTz(data.tz) || 'UTC', randomToken(24)).run();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(link.email).first();
  const sid = randomToken(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(user.id, now),
    env.DB.prepare('INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(sid), user.id, now, now + SESSION_TTL)
  ]);
  return ctx.out({ ok: true, isNew: user.created_at === now, ...(await mePayload(env, user, ctx)) }, 200, { 'Set-Cookie': setCookie(sid, SESSION_TTL / 1000) });
}

/* ---------- the account ---------- */

async function patchMe(request, env, ctx, me) {
  const d = await readJson(request);
  if (!d) return ctx.out({ ok: false, error: 'bad_request' }, 400);
  const sets = [], vals = [];
  if ('cities' in d) { sets.push('cities = ?'); vals.push(JSON.stringify(idList(d.cities, 12))); }
  if ('genres' in d) { sets.push('genres = ?'); vals.push(JSON.stringify(idList(d.genres, 12))); }
  if ('tz' in d) { const tz = validTz(d.tz); if (tz) { sets.push('tz = ?'); vals.push(tz); } }
  const sup = isSupporter(me.user);
  if ('freq' in d) {
    if (!FREQS.includes(d.freq)) return ctx.out({ ok: false, error: 'bad_freq' }, 400);
    // Emails the moment there's something new are a supporter perk.
    if (d.freq === 'instant' && !sup) return ctx.out({ ok: false, error: 'supporters_only' }, 403);
    sets.push('email_freq = ?'); vals.push(d.freq);
  }
  if ('scene' in d) {
    if (d.scene && !sup) return ctx.out({ ok: false, error: 'supporters_only' }, 403);
    sets.push('scene = ?'); vals.push(d.scene ? 1 : 0);
  }
  if ('customTheme' in d) {
    const t = d.customTheme;
    if (t === null) { sets.push('custom_theme = ?'); vals.push(null); }
    else {
      if (!sup) return ctx.out({ ok: false, error: 'supporters_only' }, 403);
      if (!t || !COLOR_RE.test(t.bg || '') || !COLOR_RE.test(t.accent || '')) return ctx.out({ ok: false, error: 'bad_colors' }, 400);
      sets.push('custom_theme = ?'); vals.push(JSON.stringify({ bg: t.bg.toLowerCase(), accent: t.accent.toLowerCase() }));
    }
  }
  if ('alerts' in d) {
    const a = d.alerts && typeof d.alerts === 'object' ? d.alerts : {};
    sets.push('alerts = ?'); vals.push(JSON.stringify({ follows: a.follows !== false, saved: a.saved !== false, picks: a.picks !== false }));
  }
  if ('mine' in d) { sets.push('mine = ?'); vals.push(d.mine ? 1 : 0); }
  if (sets.length) await env.DB.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').bind(...vals, me.user.id).run();
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(me.user.id).first();
  return ctx.out({ ok: true, user: publicUser(user) }, 200);
}

async function deleteMe(request, env, ctx, me) {
  const d = await readJson(request);
  if (!d || d.confirm !== 'delete') return ctx.out({ ok: false, error: 'confirm' }, 400);
  const id = me.user.id;
  // A supporter's subscription ends with the account (their Stripe customer is deleted).
  if (!(await forgetCustomer(env, me.user, ctx.fetch))) return ctx.out({ ok: false, error: 'billing' }, 502);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM notifications WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM follows WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM saves WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM login_links WHERE email = ?').bind(me.user.email),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
  ]);
  return ctx.out({ ok: true }, 200, { 'Set-Cookie': setCookie('', 0) });
}

async function exportMe(env, ctx, me) {
  const id = me.user.id;
  const [f, s, n] = await env.DB.batch([
    env.DB.prepare('SELECT kind, key, label, city, created_at FROM follows WHERE user_id = ?').bind(id),
    env.DB.prepare('SELECT event_id, title, start, city, venue, url, created_at FROM saves WHERE user_id = ?').bind(id),
    env.DB.prepare('SELECT kind, ref, title, body, data, created_at, read_at, emailed_at FROM notifications WHERE user_id = ? ORDER BY id').bind(id)
  ]);
  const body = {
    exportedAt: new Date().toISOString(), account: { ...publicUser(me.user), createdAt: new Date(me.user.created_at).toISOString() },
    follows: f.results, saves: s.results, alerts: n.results.map(r => ({ ...r, data: parse(r.data, {}) }))
  };
  return new Response(JSON.stringify(body, null, 2), { status: 200, headers: { ...ctx.cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="rave-monitor-account.json"' } });
}

/** POST /v1/me/calendar: the calendar feed's address (a new one with reset: true). Supporters only. */
async function calendarAddress(request, env, ctx, me) {
  if (!isSupporter(me.user)) return ctx.out({ ok: false, error: 'supporters_only' }, 403);
  const d = (await readJson(request)) || {};
  let token = me.user.cal_token;
  if (!token || d.reset) {
    token = randomToken(24);
    await env.DB.prepare('UPDATE users SET cal_token = ? WHERE id = ?').bind(token, me.user.id).run();
  }
  return ctx.out({ ok: true, url: ctx.api + '/v1/cal/' + token + '.ics' }, 200);
}

async function follow(request, env, ctx, me) {
  const d = await readJson(request);
  if (!d || !KINDS.includes(d.kind)) return ctx.out({ ok: false, error: 'bad_kind' }, 400);
  const label = line(d.label, 120);
  // The key is worked out here from the name, the same way the alerts step compares names.
  const key = followKey(d.kind, label, d.key);
  if (!label || !key) return ctx.out({ ok: false, error: 'bad_name' }, 400);
  const city = ID_RE.test(String(d.city || '')) ? String(d.city) : null;
  if (d.on === false) {
    await env.DB.prepare('DELETE FROM follows WHERE user_id = ? AND kind = ? AND key = ?').bind(me.user.id, d.kind, key).run();
    return ctx.out({ ok: true, follow: null }, 200);
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?').bind(me.user.id).first();
  if (n && n.n >= MAX_FOLLOWS) return ctx.out({ ok: false, error: 'too_many' }, 400);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO follows (user_id, kind, key, label, city, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, kind, key) DO UPDATE SET label = excluded.label, city = excluded.city')
    .bind(me.user.id, d.kind, key, label, city, now).run();
  return ctx.out({ ok: true, follow: { kind: d.kind, key, label, city, at: now } }, 200);
}

async function save(request, env, ctx, me) {
  const d = await readJson(request);
  const e = d && d.event && typeof d.event === 'object' ? d.event : null;
  const id = e ? line(e.id, 160) : '';
  if (!id || /\s/.test(id)) return ctx.out({ ok: false, error: 'bad_event' }, 400);
  if (d.on === false) {
    await env.DB.prepare('DELETE FROM saves WHERE user_id = ? AND event_id = ?').bind(me.user.id, id).run();
    return ctx.out({ ok: true, save: null }, 200);
  }
  const title = line(e.title, 200);
  if (!title) return ctx.out({ ok: false, error: 'bad_event' }, 400);
  const start = Number.isFinite(Date.parse(e.start)) ? new Date(Date.parse(e.start)).toISOString() : null;
  const url = /^https?:\/\/[^\s"<>]{1,500}$/.test(String(e.url || '')) ? String(e.url) : null;
  const city = ID_RE.test(String(e.city || '')) ? String(e.city) : null;
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?').bind(me.user.id).first();
  if (n && n.n >= MAX_SAVES) return ctx.out({ ok: false, error: 'too_many' }, 400);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO saves (user_id, event_id, title, start, city, venue, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, event_id) DO UPDATE SET title = excluded.title, start = excluded.start, city = excluded.city, venue = excluded.venue, url = excluded.url')
    .bind(me.user.id, id, title, start, city, line(e.venue, 120) || null, url, now).run();
  return ctx.out({ ok: true, save: { id, title, start, city, venue: line(e.venue, 120) || null, url, at: now } }, 200);
}

async function notifications(url, env, ctx, me) {
  const before = +url.searchParams.get('before') || 0;
  const limit = Math.max(1, Math.min(100, +url.searchParams.get('limit') || 50));
  const [rows, n] = await env.DB.batch([
    env.DB.prepare('SELECT id, kind, ref, title, body, data, created_at, read_at FROM notifications WHERE user_id = ? AND (? = 0 OR id < ?) ORDER BY id DESC LIMIT ?').bind(me.user.id, before, before, limit),
    env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(me.user.id)
  ]);
  return ctx.out({
    ok: true, unread: (n.results[0] || {}).n || 0,
    items: rows.results.map(r => ({ id: r.id, kind: r.kind, ref: r.ref, title: r.title, body: r.body, data: parse(r.data, {}), at: r.created_at, read: !!r.read_at }))
  }, 200);
}

async function markRead(request, env, ctx, me) {
  const d = await readJson(request);
  if (!d) return ctx.out({ ok: false, error: 'bad_request' }, 400);
  const now = Date.now();
  if (d.all) await env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(now, me.user.id).run();
  else {
    const ids = Array.isArray(d.ids) ? [...new Set(d.ids.map(Number).filter(Number.isInteger))].slice(0, 90) : [];
    if (ids.length) await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).bind(now, me.user.id, ...ids).run();
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(me.user.id).first();
  return ctx.out({ ok: true, unread: (n && n.n) || 0 }, 200);
}

/* ---------- unsubscribe (the link in every alert email) ---------- */

function page(title, bodyHtml, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Rave Monitor</title>
<style>body{margin:0;background:#070814;color:#eceaf6;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}
main{max-width:440px;background:#0c0f22;border:1px solid #1f2547;border-radius:14px;padding:26px}h1{font-size:20px;margin:0 0 10px}p{color:#a9abcb;margin:0 0 14px}
button{font:inherit;font-weight:700;background:#f6ecd8;color:#15131f;border:0;border-radius:10px;padding:11px 18px;cursor:pointer}a{color:#f6ecd8}</style></head>
<body><main>${bodyHtml}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } });
}

async function unsubscribe(request, env, url) {
  const u = String(url.searchParams.get('u') || ''), t = String(url.searchParams.get('t') || '');
  const settings = siteUrl(env) + '/?account=settings';
  const bad = () => page('Link not valid', `<h1>This link isn't valid</h1><p>It may be from an account that was deleted. You can change your emails in your <a href="${settings}">account settings</a>.</p>`, 400);
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(u) || !SECRET_RE.test(t)) return bad();
  const user = await env.DB.prepare('SELECT id, email_freq FROM users WHERE id = ? AND unsub = ?').bind(u, t).first();
  if (!user) return bad();
  if (request.method === 'POST') {
    await env.DB.prepare("UPDATE users SET email_freq = 'off' WHERE id = ?").bind(user.id).run();
    return page('Unsubscribed', `<h1>You're unsubscribed</h1><p>Rave Monitor won't email you any more. Your follows, saved shows and alerts on the site stay as they are.</p><p>To get emails again, turn them on in your <a href="${settings}">account settings</a>.</p>`);
  }
  if (user.email_freq === 'off') return page('Unsubscribed', `<h1>You're already unsubscribed</h1><p>Rave Monitor doesn't email you. To get emails again, turn them on in your <a href="${settings}">account settings</a>.</p>`);
  // A button rather than unsubscribing on the visit: mail scanners open links on their own.
  return page('Unsubscribe', `<h1>Stop Rave Monitor emails?</h1><p>You won't get alerts or digests by email. Alerts still show on the site when you're signed in.</p><form method="post"><button type="submit">Unsubscribe</button></form><p style="margin-top:16px">Or choose what we send in your <a href="${settings}">account settings</a>.</p>`);
}

/* ---------- routing ---------- */

export async function handleAccounts(request, env, deps = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const origin = request.headers.get('Origin') || '';
  const allowed = list(env.ALLOWED_ORIGINS);
  const originOk = allowed.includes(origin);
  const cors = {
    'Access-Control-Allow-Origin': originOk ? origin : (allowed[0] || ''),
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ctx = { ip, cors, api: url.origin, fetch: deps.fetch, out: (body, status, extra) => json(body, status, { ...cors, ...(extra || {}) }) };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!env.DB) return ctx.out({ ok: false, error: 'not_configured' }, 503);
  if (env.API_LIMITER) {
    const { success } = await env.API_LIMITER.limit({ key: ip || 'unknown' });
    if (!success) return ctx.out({ ok: false, error: 'rate_limited' }, 429);
  }
  if (path === '/v1/unsubscribe' && (request.method === 'GET' || request.method === 'POST')) return unsubscribe(request, env, url);
  // From Stripe and from calendar apps: no session, no Origin.
  if (path === '/v1/billing/webhook' && request.method === 'POST') return webhook(request, env, ctx);
  const cal = request.method === 'GET' && path.match(/^\/v1\/cal\/([A-Za-z0-9_-]+)\.ics$/);
  if (cal) return calendarFeed(env, cal[1]);
  // Anything that changes something must come from the site itself.
  if (request.method !== 'GET' && !originOk) return ctx.out({ ok: false, error: 'origin' }, 403);

  const route = request.method + ' ' + path;
  if (route === 'POST /v1/auth/start') return authStart(request, env, ctx);
  if (route === 'POST /v1/auth/verify') return authVerify(request, env, ctx);
  if (route === 'GET /v1/health') return ctx.out({ ok: true, signIn: !!(env.POSTMARK_TOKEN || devMode(env)), billing: billingOn(env) }, 200);

  const known = ['POST /v1/auth/signout', 'GET /v1/me', 'PATCH /v1/me', 'DELETE /v1/me', 'GET /v1/me/export', 'POST /v1/me/calendar', 'POST /v1/follows', 'POST /v1/saves', 'GET /v1/notifications', 'POST /v1/notifications/read',
    'POST /v1/billing/checkout', 'POST /v1/billing/portal'];
  if (!known.includes(route)) return ctx.out({ ok: false, error: 'not_found' }, 404);
  const me = await session(request, env);
  // Every page asks on load; signed out isn't an error there (and keeps browsers' consoles quiet).
  if (!me && route === 'GET /v1/me') return ctx.out({ ok: true, user: null, billing: billingInfo(env) }, 200);
  if (!me) return ctx.out({ ok: false, error: 'signed_out' }, 401, route === 'POST /v1/auth/signout' ? { 'Set-Cookie': setCookie('', 0) } : undefined);
  const renew = me.renew ? { 'Set-Cookie': me.renew } : undefined;
  switch (route) {
    case 'POST /v1/auth/signout':
      await env.DB.prepare('DELETE FROM sessions WHERE hash = ?').bind(me.hash).run();
      return ctx.out({ ok: true }, 200, { 'Set-Cookie': setCookie('', 0) });
    case 'GET /v1/me': return ctx.out({ ok: true, ...(await mePayload(env, me.user, ctx)) }, 200, renew);
    case 'PATCH /v1/me': return patchMe(request, env, ctx, me);
    case 'DELETE /v1/me': return deleteMe(request, env, ctx, me);
    case 'GET /v1/me/export': return exportMe(env, ctx, me);
    case 'POST /v1/me/calendar': return calendarAddress(request, env, ctx, me);
    case 'POST /v1/billing/checkout': return checkout(env, ctx, me);
    case 'POST /v1/billing/portal': return portal(env, ctx, me);
    case 'POST /v1/follows': return follow(request, env, ctx, me);
    case 'POST /v1/saves': return save(request, env, ctx, me);
    case 'GET /v1/notifications': return notifications(url, env, ctx, me);
    case 'POST /v1/notifications/read': return markRead(request, env, ctx, me);
  }
  return ctx.out({ ok: false, error: 'not_found' }, 404);
}
