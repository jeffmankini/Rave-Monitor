// The alerts step, run after each refresh is live (.github/workflows/refresh.yml, job "alerts").
//
// It reads the live feed and the venue directory, then, in the accounts database (Cloudflare D1):
//  - new listings that match someone's follows (artists, venues, promoters, labels) become "new show"
//    alerts, only in their cities if they asked for that;
//  - shows people saved get a reminder the day before, and an alert when they sell out, are cancelled
//    or are postponed;
//  - once a week, people who picked cities get that week's picks there, in their genres;
// then emails what's new through Postmark: changes and reminders right away, new shows and picks as
// each person chose (right away, a daily digest or a weekly one), each with one-click unsubscribe.
//
// Only listings first seen since the last run count as new (seen_events), so a refresh never repeats
// an alert, and the first run just takes note of what's there.
//
//   node pipeline/notify.js [--feed <file or URL>] [--venues <file or URL>] [--dry-run]
//
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (D1 over Cloudflare's API; D1_DATABASE names the
// database, default ravemonitor-accounts), POSTMARK_TOKEN, SITE_URL, API_URL.
// Without the Cloudflare settings it does nothing; without POSTMARK_TOKEN it writes alerts but sends no email.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { venueKey } from './venues.js';
import { slug } from './lib/util.js';
import { akey, lkey } from '../worker/api/src/keys.js';
import { alertsEmail, when } from '../worker/api/src/emails.js';
import { postmark, sendBatch, message } from '../worker/api/src/postmark.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 36e5, DAY = 24 * HOUR;
const URGENT = ['reminder', 'soldout', 'cancelled', 'postponed'];
const GONE = ['cancelled', 'postponed'];
const REMIND_BEFORE = 30 * HOUR;
const DIGEST_HOUR = 8;          // digests go out from 8am in each person's time zone
const STALE = 7 * DAY;          // alerts older than this are no longer emailed
const PICKS = 8;

const parse = (s, fallback) => { try { return JSON.parse(s); } catch (err) { return fallback; } };

/* ---------- time in a person's (or a listing's) time zone ---------- */

const dtf = {};
function parts(ms, tz) {
  const k = tz || 'UTC';
  if (!dtf[k]) {
    try { dtf[k] = new Intl.DateTimeFormat('en-US', { timeZone: k, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }); }
    catch (err) { return parts(ms, 'UTC'); }
  }
  const p = Object.fromEntries(dtf[k].formatToParts(ms).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
export const localDate = (ms, tz) => { const p = parts(ms, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
/** The moment it's h:00 on y-m-d in tz. */
export function zoned(y, m, d, h, tz) {
  let t = Date.UTC(y, m - 1, d, h);
  for (let i = 0; i < 2; i++) {
    const p = parts(t, tz);
    t -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Date.UTC(y, m - 1, d, h);
  }
  return t;
}
const addDays = (y, m, d, n) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; };
/** When today's digest is due (8am local); and the latest Thursday 8am, when weekly ones are. */
export function digestTimes(now, tz) {
  const p = parts(now, tz);
  const daily = zoned(p.y, p.m, p.d, DIGEST_HOUR, tz);
  let back = (p.dow - 4 + 7) % 7;
  if (back === 0 && now < daily) back = 7;
  const [y, m, d] = addDays(p.y, p.m, p.d, -back);
  return { daily: now >= daily ? daily : zoned(...addDays(p.y, p.m, p.d, -1), DIGEST_HOUR, tz), weekly: zoned(y, m, d, DIGEST_HOUR, tz), week: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/* ---------- what a listing is, as follows compare it ---------- */

/** Directory ids for venues, as the site works them out: the venue directory's names and spellings,
 *  then the curated venues (config/venues.json), then the name itself. */
export function venueResolver(rows, curated, cityName) {
  const byKey = new Map();
  for (const r of rows || []) {
    const c = cityName(r[2]);
    for (const k of [venueKey(r[1], c), ...(r[14] || [])]) if (k && !byKey.has(r[2] + '|' + k)) byKey.set(r[2] + '|' + k, r[0]);
  }
  for (const cv of curated || []) {
    const c = cityName(cv.city);
    const keys = [cv.name, ...(cv.match || [])].map(n => venueKey(n, c)).filter(Boolean);
    if (!keys.length) continue;
    const id = keys.map(k => byKey.get(cv.city + '|' + k)).find(Boolean) || cv.city + '-' + (slug(keys[0]) || 'venue');
    for (const k of keys) byKey.set(cv.city + '|' + k, id);
  }
  return e => {
    const k = venueKey(e.venue && e.venue.name, cityName(e.cityId));
    return k ? byKey.get(e.cityId + '|' + k) || e.cityId + '-' + (slug(k) || 'venue') : '';
  };
}

/** A listing's fingerprint: the same night at the same place under another id is no news. */
export const fingerprint = (e, cityName) => [e.cityId, localDate(Date.parse(e.start), e.tz), venueKey(e.venue && e.venue.name, cityName(e.cityId)), lkey(e.title).slice(0, 48)].join('|');

const eventData = (e, cityName, why) => ({
  id: e.id, title: e.title, start: e.start, end: e.end, tz: e.tz, city: e.cityId, cityName: cityName(e.cityId),
  venue: e.venue && e.venue.name, url: (e.sources && e.sources[0] && e.sources[0].url) || null, ...(why ? { why } : {})
});
const names = list => list.length <= 2 ? list.join(' and ') : list.slice(0, -1).join(', ') + ' and ' + list.at(-1);

/** The user's settings, from their row. */
export function prefs(u) {
  const a = parse(u.alerts, {});
  return {
    cities: parse(u.cities, []), genres: parse(u.genres, []), tz: u.tz || 'UTC', freq: u.email_freq || 'daily', mine: !!u.mine,
    alerts: { follows: a.follows !== false, saved: a.saved !== false, picks: a.picks !== false }
  };
}

/* ---------- 1. which alerts to write ---------- */

/**
 * events: the feed's listings. seen: rows of seen_events. users, follows, saves: rows of those tables.
 * Returns the alerts to write and how seen_events changes.
 */
export function planAlerts({ events, seen, users, follows, saves, now, cityName, venueOf }) {
  const out = [], seenNew = [], seenStatus = [];
  const byId = new Map(seen.map(r => [r.id, r])), byFp = new Map(seen.map(r => [r.fp, r]));
  const bootstrap = seen.length === 0;
  const people = new Map(users.map(u => [u.id, { u, p: prefs(u) }]));
  const live = events.filter(e => Date.parse(e.end) > now);
  const add = (userId, kind, ref, title, body, data) => out.push({ user_id: userId, kind, ref, title: String(title).slice(0, 200), body: String(body || '').slice(0, 300), data: JSON.stringify(data), created_at: now });

  // Follows, by what they're of.
  const followers = new Map();
  for (const f of follows) {
    const k = (f.kind === 'label' ? 'promoter' : f.kind) + '|' + f.key;   // labels and promoters are one set of names
    if (!followers.has(k)) followers.set(k, []);
    followers.get(k).push(f);
  }

  const fresh = [];
  for (const e of live) {
    const fp = fingerprint(e, cityName), st = e.status || '';
    const prev = byId.get(e.id) || byFp.get(fp);
    if (!prev) { seenNew.push({ id: e.id, fp, first_seen: now, status: st }); if (!bootstrap) fresh.push(e); continue; }
    // The same night under a new id keeps the day it was first seen.
    if (!byId.has(e.id)) seenNew.push({ id: e.id, fp, first_seen: prev.first_seen, status: st });
    if (st !== (prev.status || '')) seenStatus.push({ id: e.id, status: st, was: prev.status || '' });
  }

  // New shows from who people follow.
  for (const e of fresh) {
    if (Date.parse(e.start) < now || GONE.includes(e.status)) continue;
    const keys = [...new Set((e.lineup || []).map(akey).filter(Boolean))].map(k => 'artist|' + k)
      .concat([...new Set([...(e.promoters || []), ...(e.labels || [])].map(lkey).filter(Boolean))].map(k => 'promoter|' + k));
    const v = venueOf(e);
    if (v) keys.push('venue|' + v);
    const hits = new Map();
    for (const k of keys) for (const f of followers.get(k) || []) {
      const h = hits.get(f.user_id) || { why: [], venue: false };
      if (!h.why.includes(f.label)) h.why.push(f.label);
      if (f.kind === 'venue') h.venue = true;
      hits.set(f.user_id, h);
    }
    for (const [uid, h] of hits) {
      const x = people.get(uid);
      if (!x || !x.p.alerts.follows) continue;
      if (x.p.mine && x.p.cities.length && !x.p.cities.includes(e.cityId) && !h.venue) continue;
      add(uid, 'new_show', e.id, e.title, 'You follow ' + names(h.why), eventData(e, cityName, h.why));
    }
  }

  // Saved shows: reminders and changes.
  const byEvent = new Map(live.map(e => [e.id, e]));
  const changed = new Map(seenStatus.map(s => [s.id, s]));
  for (const s of saves) {
    const e = byEvent.get(s.event_id), x = people.get(s.user_id);
    if (!e || !x || !x.p.alerts.saved) continue;
    const start = Date.parse(e.start);
    const ch = changed.get(e.id);
    if (ch && ['soldout', 'cancelled', 'postponed'].includes(ch.status)) {
      const body = { soldout: 'It just sold out.', cancelled: 'The listing now says it is cancelled.', postponed: 'The listing now says it is postponed.' }[ch.status];
      add(s.user_id, ch.status, e.id, e.title, body, eventData(e, cityName));
    }
    if (start > now && start - now <= REMIND_BEFORE && !GONE.includes(e.status)) {
      const day = localDate(start, e.tz) === localDate(now, e.tz) ? 'Today' : 'Tomorrow';
      add(s.user_id, 'reminder', e.id, e.title, `${day} at ${when(e.start, e.tz).split(', ')[1]}. You saved this show.`, eventData(e, cityName));
    }
  }

  // The week's picks in people's cities, from Thursday morning their time.
  const following = new Map();
  for (const f of follows) { if (!following.has(f.user_id)) following.set(f.user_id, new Set()); following.get(f.user_id).add((f.kind === 'label' ? 'promoter' : f.kind) + '|' + f.key); }
  for (const { u, p } of people.values()) {
    if (!p.alerts.picks || !p.cities.length) continue;
    const t = digestTimes(now, p.tz);
    const mine = following.get(u.id) || new Set();
    const score = e => {
      let s = Number.isFinite(e.popularity) ? Math.log10(1 + e.popularity) : 0;
      if ((e.lineup || []).some(n => mine.has('artist|' + akey(n))) || mine.has('venue|' + venueOf(e)) || [...(e.promoters || []), ...(e.labels || [])].some(n => mine.has('promoter|' + lkey(n)))) s += 10;
      return s;
    };
    const pool = live.filter(e => p.cities.includes(e.cityId) && Date.parse(e.start) > now && Date.parse(e.start) < now + 7 * DAY && !GONE.includes(e.status) &&
      (!p.genres.length || (e.genres || []).some(g => p.genres.includes(g))));
    if (!pool.length) continue;
    const top = pool.map(e => [e, score(e)]).sort((a, b) => b[1] - a[1] || Date.parse(a[0].start) - Date.parse(b[0].start)).slice(0, PICKS).map(x => x[0])
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const where = p.cities.length > 2 ? 'your cities' : names(p.cities.map(cityName));
    add(u.id, 'picks', 'picks:' + t.week, 'Picks for your week in ' + where,
      `${top.length} ${top.length === 1 ? 'night' : 'nights'} in the next 7 days${p.genres.length ? ', in the genres you picked' : ''}.`,
      { events: top.map(e => eventData(e, cityName)) });
  }
  return { alerts: out, seenNew, seenStatus, bootstrap };
}

/* ---------- 2. which emails to send ---------- */

/** unsent: alerts not emailed yet, each with its user's row fields. Returns one email per person due one. */
export function planEmails({ unsent, users, now }) {
  const byUser = new Map();
  for (const n of unsent) { if (!byUser.has(n.user_id)) byUser.set(n.user_id, []); byUser.get(n.user_id).push(n); }
  const out = [];
  for (const u of users) {
    const items = byUser.get(u.id);
    if (!items || !items.length) continue;
    const p = prefs(u);
    if (p.freq === 'off') continue;
    const urgent = items.filter(n => URGENT.includes(n.kind)), rest = items.filter(n => !URGENT.includes(n.kind));
    let freq = 'instant', send = urgent, digest = false;
    if (p.freq === 'instant') send = items;
    else if (rest.length) {
      const t = digestTimes(now, p.tz);
      const due = p.freq === 'daily' ? t.daily : t.weekly;
      // Since the last digest, or since they joined: a new account's first digest waits for 8am too.
      if (now >= due && Math.max(u.digest_at || 0, u.created_at || 0) < due) { send = items; freq = p.freq; digest = true; }
    }
    if (send.length) out.push({ user: u, items: send, freq, digest });
  }
  return out;
}

/* ---------- talking to D1 and Postmark ---------- */

/** D1 over Cloudflare's API: all(sql, params) and batch([{ sql, params }]). */
export function d1Rest({ token, account, database, fetchImpl = fetch }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`;
  async function call(body) {
    const r = await fetchImpl(base, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.success) throw new Error(`D1 ${r.status}: ${((j && j.errors) || []).map(e => e.code + ' ' + e.message).join('; ') || 'no answer'}`);
    return j.result;
  }
  return {
    all: async (sql, params = []) => (await call({ sql, params }))[0].results,
    batch: async stmts => { for (let i = 0; i < stmts.length; i += 50) await call({ batch: stmts.slice(i, i + 50) }); }
  };
}

export async function findDatabase({ token, account, name, fetchImpl = fetch }) {
  const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database?name=${encodeURIComponent(name)}`, { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.success) throw Object.assign(new Error(`D1 lookup ${r.status}: ${((j && j.errors) || []).map(e => e.code + ' ' + e.message).join('; ') || 'no answer'}`), { status: r.status });
  const db = (j.result || []).find(d => d.name === name);
  return db ? db.uuid : null;
}

/** Alerts and digests go out on a broadcast stream of their own, made the first time. */
export async function alertStream(token, fetchImpl = fetch) {
  const got = await postmark(token, '/message-streams/alerts', undefined, fetchImpl, 'GET');
  if (got.ok) return 'alerts';
  const made = await postmark(token, '/message-streams', { ID: 'alerts', Name: 'Alerts and digests', MessageStreamType: 'Broadcasts', SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } }, fetchImpl);
  if (made.ok) return 'alerts';
  console.log(`Couldn't make Postmark's "alerts" stream (${made.status} ${(made.data && made.data.Message) || ''}); using the default stream.`);
  return 'outbound';
}

/* ---------- the run ---------- */

const inserts = (table, cols, rows, verb = 'INSERT OR IGNORE') => rows.map(r => ({ sql: `${verb} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params: cols.map(c => r[c] ?? null) }));

export async function run({ db, feed, venues, curated, cities, now = Date.now(), mail = null, siteUrl = 'https://ravemonitor.com', apiUrl = 'https://api.ravemonitor.com', log = console.log, dryRun = false }) {
  const cityById = new Map((feed.cities || []).map(c => [c.id, c.name]));
  for (const c of cities || []) if (!cityById.has(c.id)) cityById.set(c.id, c.name);
  const cityName = id => cityById.get(id) || id;
  const venueOf = venueResolver((venues && venues.venues) || [], curated, cityName);

  const [seen, users, follows, saves] = await Promise.all([
    db.all('SELECT id, fp, first_seen, status FROM seen_events'),
    db.all('SELECT * FROM users'),
    db.all('SELECT user_id, kind, key, label FROM follows'),
    db.all('SELECT user_id, event_id FROM saves')
  ]);
  const plan = planAlerts({ events: feed.events || [], seen, users, follows, saves, now, cityName, venueOf });
  log(`Alerts: ${users.length} accounts, ${follows.length} follows, ${saves.length} saved shows; ${plan.bootstrap ? `first run, noting ${plan.seenNew.length} listings` : `${plan.seenNew.length} new listings, ${plan.seenStatus.length} status changes`}; ${plan.alerts.length} alerts to write.`);
  if (dryRun) return { plan, emails: [] };

  await db.batch([
    ...inserts('seen_events', ['id', 'fp', 'first_seen', 'status'], plan.seenNew),
    ...plan.seenStatus.map(s => ({ sql: 'UPDATE seen_events SET status = ? WHERE id = ?', params: [s.status, s.id] })),
    { sql: 'DELETE FROM seen_events WHERE first_seen < ?', params: [now - 90 * DAY] },
    ...inserts('notifications', ['user_id', 'kind', 'ref', 'title', 'body', 'data', 'created_at'], plan.alerts),
    // Too old to email, or emails are off: never email these.
    { sql: 'UPDATE notifications SET emailed_at = 0 WHERE emailed_at IS NULL AND (created_at < ? OR user_id IN (SELECT id FROM users WHERE email_freq = ?))', params: [now - STALE, 'off'] }
  ]);

  const unsent = await db.all('SELECT id, user_id, kind, ref, title, body, data, created_at FROM notifications WHERE emailed_at IS NULL ORDER BY id');
  const emails = planEmails({ unsent, users, now });
  if (!emails.length) { log('Emails: none due.'); return { plan, emails: [] }; }
  if (!mail) { log(`Emails: ${emails.length} due, but POSTMARK_TOKEN isn't set, so none sent.`); return { plan, emails }; }

  const stream = await mail.stream();
  const msgs = emails.map(({ user, items, freq }) => {
    const unsub = `${apiUrl}/v1/unsubscribe?u=${encodeURIComponent(user.id)}&t=${encodeURIComponent(user.unsub)}`;
    const m = alertsEmail({ items: items.map(n => ({ ...n, data: parse(n.data, {}) })), freq, siteUrl, settingsUrl: siteUrl + '/?account=settings', unsubUrl: unsub });
    return message({
      from: mail.from, fromName: mail.fromName, to: user.email, subject: m.subject, html: m.html, text: m.text, stream,
      tag: freq === 'instant' ? 'alerts' : freq + '-digest',
      headers: [{ Name: 'List-Unsubscribe', Value: `<${unsub}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }]
    });
  });
  let sent = 0, failed = 0, inactive = 0;
  for (let i = 0; i < msgs.length; i += 500) {
    const chunk = emails.slice(i, i + 500);
    const r = await mail.send(msgs.slice(i, i + 500));
    const results = Array.isArray(r.data) ? r.data : [];
    const done = [], dead = [];
    chunk.forEach((em, j) => {
      const code = results[j] ? results[j].ErrorCode : -1;
      if (code === 0) done.push(em);
      else if (code === 406) dead.push(em);   // Postmark won't send to this address: it bounced or complained
      else { failed++; log(`Email failed: Postmark ${r.status} code ${code} ${results[j] ? results[j].Message : ''}`.trim()); }
    });
    sent += done.length; inactive += dead.length;
    // D1 takes at most 100 values a statement.
    const stamp = (list, at) => list.flatMap(em => {
      const ids = em.items.map(n => n.id), out = [];
      for (let k = 0; k < ids.length; k += 90) out.push({ sql: `UPDATE notifications SET emailed_at = ? WHERE id IN (${ids.slice(k, k + 90).map(() => '?').join(',')})`, params: [at, ...ids.slice(k, k + 90)] });
      return out;
    });
    await db.batch([
      ...stamp(done, now), ...stamp(dead, 0),
      ...done.filter(em => em.digest).map(em => ({ sql: 'UPDATE users SET digest_at = ? WHERE id = ?', params: [now, em.user.id] })),
      ...dead.map(em => ({ sql: "UPDATE users SET email_freq = 'off' WHERE id = ?", params: [em.user.id] }))
    ]);
  }
  log(`Emails: ${sent} sent${failed ? `, ${failed} failed` : ''}${inactive ? `, ${inactive} to addresses Postmark won't deliver to (emails turned off for them)` : ''}.`);
  return { plan, emails };
}

async function load(src) {
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src + (src.includes('?') ? '&' : '?') + 't=' + Date.now(), { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(fs.readFileSync(src, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, POSTMARK_TOKEN: pm } = process.env;
  if (!token || !account) { console.log('Alerts: Cloudflare settings not set; skipping.'); return; }
  const name = process.env.D1_DATABASE || 'ravemonitor-accounts';
  let database;
  try { database = await findDatabase({ token, account, name }); }
  catch (err) {
    // Accounts aren't switched on until the token can use D1.
    if (err.status === 401 || err.status === 403 || /\b10000\b/.test(err.message)) { console.log(`Alerts: the Cloudflare token can't use D1 yet (${err.message}); skipping.`); return; }
    throw err;
  }
  if (!database) { console.log(`Alerts: no "${name}" database yet (the API Worker's deploy makes it); skipping.`); return; }
  const feed = await load(opt('--feed') || path.join(ROOT, 'public', 'events.json'));
  const venues = await load(opt('--venues') || path.join(ROOT, 'dist', 'archive', 'data', 'venues.json')).catch(err => { console.log(`Venue directory not loaded (${err.message}); venue follows match by name.`); return null; });
  const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'venues.json'), 'utf8')).venues;
  const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'cities.json'), 'utf8')).cities;
  const mail = pm ? {
    from: process.env.MAIL_FROM || 'hello@ravemonitor.com', fromName: process.env.MAIL_FROM_NAME || 'Rave Monitor',
    stream: () => alertStream(pm), send: msgs => sendBatch(pm, msgs)
  } : null;
  await run({
    db: d1Rest({ token, account, database }), feed, venues, curated, cities: Array.isArray(cities) ? cities : Object.entries(cities).map(([id, c]) => ({ id, ...c })), mail,
    siteUrl: (process.env.SITE_URL || 'https://ravemonitor.com').replace(/\/+$/, ''), apiUrl: (process.env.API_URL || 'https://api.ravemonitor.com').replace(/\/+$/, ''),
    dryRun: args.includes('--dry-run')
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error('Alerts failed:', err.message); process.exit(1); });
}
