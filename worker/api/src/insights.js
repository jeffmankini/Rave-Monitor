// Rave Monitor's own numbers, for its admins (the emails in the ADMIN_EMAILS secret):
//
//   POST /v1/log/search    from the map: one search, counted by day with nothing about who searched
//                          (no account, IP address or cookie; the site sends it without cookies)
//   GET  /v1/admin/stats   the dashboard at /admin/: accounts, follows, saves, cities, genres,
//                          searches and alerts, as counts only (never an email address or one
//                          person's follows)
//   GET  /v1/admin/export  research downloads (CSV), aggregated, with every row covering at least
//                          MIN_GROUP people (or searches), so nobody can be picked out of them
//
// The admin routes need a signed-in session whose email is in ADMIN_EMAILS (accounts.js checks the
// session; this file checks the email).

const DAY = 864e5;
export const MIN_GROUP = 10;
const KEEP_DAYS = 400;
export const PERIODS = [7, 30, 90, 365];
export const PICK_KINDS = ['artist', 'venue', 'promoter', 'label', 'city', 'genre', 'event', 'osm'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const line = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

/** What was typed, as it's counted: lowercased and trimmed, or '' when it isn't kept. */
export function searchTerm(s) {
  const q = String(s == null ? '' : s).normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (q.length < 2 || q.length > 60) return '';
  // Anything that could be about a person rather than the scene: addresses, phone-like numbers, links.
  if (/@|:\/\/|www\.|\.(com|net|org|io|co)\b|\d{5,}|(\d[\s().+-]*){7,}/.test(q)) return '';
  return q;
}

export function isAdmin(env, user) {
  const email = String((user && user.email) || '').toLowerCase();
  return !!email && String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(email);
}

/** POST /v1/log/search: count one search. Always answers 204, so the page never waits on it. */
export async function logSearch(env, ctx, d) {
  const done = new Response(null, { status: 204, headers: ctx.cors });
  const q = searchTerm(d && d.q);
  if (!q) return done;
  const kind = PICK_KINDS.includes(d.kind) ? d.kind : '';
  const pick = kind ? line(d.pick, 80) : '';
  const city = ID_RE.test(String(d.city || '')) ? String(d.city) : '';
  const found = kind || +d.results > 0 ? 1 : 0;
  const now = Date.now();
  const stmts = [env.DB.prepare('INSERT INTO search_daily (day, q, kind, pick, city, found, n) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT (day, q, kind, pick, city, found) DO UPDATE SET n = n + 1')
    .bind(dayOf(now), q, kind, pick, city, found)];
  // Now and then, drop the oldest days.
  if (Math.random() < 0.02) stmts.push(env.DB.prepare('DELETE FROM search_daily WHERE day < ?').bind(dayOf(now - KEEP_DAYS * DAY)));
  try { await env.DB.batch(stmts); } catch (err) { console.log('search count failed', String(err && err.message).slice(0, 120)); }
  return done;
}

const period = url => { const d = +url.searchParams.get('days'); return PERIODS.includes(d) ? d : 30; };

/** GET /v1/admin/stats?days=30: everything the dashboard shows, for the period chosen. */
export async function adminStats(url, env, ctx, me) {
  if (!isAdmin(env, me.user)) return ctx.out({ ok: false, error: 'not_admin' }, 403);
  const days = period(url), now = Date.now(), since = now - days * DAY, sinceDay = dayOf(since + DAY);
  const q = (sql, ...p) => env.DB.prepare(sql).bind(...p);
  const [totals, freq, signups, followKinds, followTop, followDays, savesTop, savesTotals, cities, genres, cityArtists,
    searchTotals, searchDays, searchTop, searchMisses, searchPicks, searchKinds, alertDays, alertKinds] = await env.DB.batch([
    q(`SELECT COUNT(*) AS users, COALESCE(SUM(created_at > ?), 0) AS new_users, COALESCE(SUM(seen_at > ?), 0) AS active, COALESCE(SUM(email_freq != 'off'), 0) AS emails_on,
       COALESCE(SUM(scene = 1), 0) AS scene_on, COALESCE(SUM(cal_token IS NOT NULL), 0) AS calendars FROM users`, since, since),
    q(`SELECT email_freq AS k, COUNT(*) AS n FROM users GROUP BY email_freq ORDER BY n DESC`),
    q(`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM users WHERE created_at > ? GROUP BY day ORDER BY day`, since),
    q(`SELECT kind, COUNT(*) AS n, COUNT(DISTINCT user_id) AS people, COALESCE(SUM(created_at > ?), 0) AS recent FROM follows GROUP BY kind`, since),
    q(`SELECT kind, label, city, n, recent FROM (
         SELECT kind, key, MAX(label) AS label, MAX(city) AS city, COUNT(*) AS n, COALESCE(SUM(created_at > ?), 0) AS recent,
           ROW_NUMBER() OVER (PARTITION BY kind ORDER BY COUNT(*) DESC, MAX(label)) AS rk
         FROM follows GROUP BY kind, key) WHERE rk <= 25 ORDER BY kind, n DESC, label`, since),
    q(`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM follows WHERE created_at > ? GROUP BY day ORDER BY day`, since),
    q(`SELECT MAX(title) AS title, MAX(venue) AS venue, MAX(city) AS city, MAX(start) AS start, COUNT(*) AS n FROM saves
       GROUP BY event_id HAVING MAX(start) >= ? ORDER BY n DESC, start LIMIT 25`, new Date(now).toISOString()),
    q(`SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS people, COALESCE(SUM(created_at > ?), 0) AS recent FROM saves`, since),
    q(`SELECT j.value AS id, COUNT(*) AS n FROM users, json_each(users.cities) AS j GROUP BY j.value ORDER BY n DESC, id LIMIT 30`),
    q(`SELECT j.value AS id, COUNT(*) AS n FROM users, json_each(users.genres) AS j GROUP BY j.value ORDER BY n DESC, id`),
    q(`SELECT city, label, n FROM (
         SELECT c.value AS city, f.key, MAX(f.label) AS label, COUNT(*) AS n,
           ROW_NUMBER() OVER (PARTITION BY c.value ORDER BY COUNT(*) DESC, MAX(f.label)) AS rk
         FROM follows f JOIN users u ON u.id = f.user_id, json_each(u.cities) AS c WHERE f.kind = 'artist' GROUP BY c.value, f.key)
       WHERE rk <= 5 ORDER BY city, n DESC, label`),
    q(`SELECT COALESCE(SUM(n), 0) AS n, COALESCE(SUM(CASE WHEN found = 0 THEN n ELSE 0 END), 0) AS misses, COUNT(DISTINCT q) AS terms FROM search_daily WHERE day >= ?`, sinceDay),
    q(`SELECT day, SUM(n) AS n, SUM(CASE WHEN found = 0 THEN n ELSE 0 END) AS misses FROM search_daily WHERE day >= ? GROUP BY day ORDER BY day`, sinceDay),
    q(`SELECT q, SUM(n) AS n, SUM(CASE WHEN found = 0 THEN n ELSE 0 END) AS misses FROM search_daily WHERE day >= ? GROUP BY q ORDER BY n DESC, q LIMIT 40`, sinceDay),
    q(`SELECT q, SUM(n) AS n FROM search_daily WHERE day >= ? AND found = 0 GROUP BY q ORDER BY n DESC, q LIMIT 30`, sinceDay),
    q(`SELECT kind, pick, SUM(n) AS n FROM search_daily WHERE day >= ? AND kind != '' GROUP BY kind, pick ORDER BY n DESC, pick LIMIT 40`, sinceDay),
    q(`SELECT kind, SUM(n) AS n FROM search_daily WHERE day >= ? GROUP BY kind ORDER BY n DESC`, sinceDay),
    q(`SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n, COALESCE(SUM(emailed_at IS NOT NULL), 0) AS emailed FROM notifications WHERE created_at > ? GROUP BY day ORDER BY day`, since),
    q(`SELECT kind, COUNT(*) AS n FROM notifications WHERE created_at > ? GROUP BY kind ORDER BY n DESC`, since)
  ]);
  const rows = r => r.results || [];
  const top = {};
  for (const r of rows(followTop)) (top[r.kind] = top[r.kind] || []).push({ name: r.label, city: r.city || null, n: r.n, recent: r.recent });
  const byCity = {};
  for (const r of rows(cityArtists)) (byCity[r.city] = byCity[r.city] || []).push({ name: r.label, n: r.n });
  return ctx.out({
    ok: true, days, from: sinceDay, to: dayOf(now), generatedAt: new Date(now).toISOString(),
    totals: rows(totals)[0] || {}, freq: rows(freq), signups: rows(signups),
    follows: { kinds: rows(followKinds), top, byDay: rows(followDays), artistsByCity: byCity },
    saves: { totals: rows(savesTotals)[0] || {}, top: rows(savesTop) },
    cities: rows(cities), genres: rows(genres),
    searches: { totals: rows(searchTotals)[0] || {}, byDay: rows(searchDays), top: rows(searchTop), misses: rows(searchMisses), picks: rows(searchPicks), kinds: rows(searchKinds) },
    alerts: { byDay: rows(alertDays), kinds: rows(alertKinds) }
  }, 200);
}

// A spreadsheet cell, safe to open: quoted when needed, and never read as a formula.
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const csv = (head, rows) => [head.join(','), ...rows.map(r => head.map(h => cell(r[h])).join(','))].join('\r\n') + '\r\n';

// The research tables. Every row is a group of at least `min` people (searches: `min` searches).
const EXPORTS = {
  follows: {
    about: 'Who people follow: each artist, venue, promoter and record label with its number of followers.',
    head: ['kind', 'name', 'city', 'followers', 'new_followers'],
    sql: `SELECT kind, MAX(label) AS name, MAX(city) AS city, COUNT(DISTINCT user_id) AS followers, COALESCE(SUM(created_at > ?1), 0) AS new_followers
          FROM follows GROUP BY kind, key HAVING COUNT(DISTINCT user_id) >= ?2 ORDER BY followers DESC, name`
  },
  interest: {
    about: 'Scene interest: how many people picked each city and genre together.',
    head: ['city', 'genre', 'people'],
    sql: `SELECT c.value AS city, g.value AS genre, COUNT(DISTINCT u.id) AS people FROM users u, json_each(u.cities) AS c, json_each(u.genres) AS g
          WHERE ?1 = ?1 GROUP BY c.value, g.value HAVING COUNT(DISTINCT u.id) >= ?2 ORDER BY people DESC, city, genre`
  },
  cities: {
    about: 'Cities people follow the scene in, with how many picked each.',
    head: ['city', 'people'],
    sql: `SELECT j.value AS city, COUNT(DISTINCT users.id) AS people FROM users, json_each(users.cities) AS j WHERE ?1 = ?1
          GROUP BY j.value HAVING COUNT(DISTINCT users.id) >= ?2 ORDER BY people DESC, city`
  },
  saves: {
    about: 'Shows people saved, with how many saved each.',
    head: ['show', 'venue', 'city', 'start', 'saves'],
    sql: `SELECT MAX(title) AS show, MAX(venue) AS venue, MAX(city) AS city, MAX(start) AS start, COUNT(DISTINCT user_id) AS saves FROM saves
          WHERE ?1 = ?1 GROUP BY event_id HAVING COUNT(DISTINCT user_id) >= ?2 ORDER BY saves DESC, start`
  },
  searches: {
    about: 'What people searched for on the map in the period, and how often nothing matched.',
    head: ['search', 'searches', 'no_results'],
    sql: `SELECT q AS search, SUM(n) AS searches, SUM(CASE WHEN found = 0 THEN n ELSE 0 END) AS no_results FROM search_daily
          WHERE day >= ?1 GROUP BY q HAVING SUM(n) >= ?2 ORDER BY searches DESC, search`
  }
};
export const EXPORT_TABLES = Object.keys(EXPORTS);

/** GET /v1/admin/export?table=follows&days=30: one research table as CSV. */
export async function adminExport(url, env, ctx, me) {
  if (!isAdmin(env, me.user)) return ctx.out({ ok: false, error: 'not_admin' }, 403);
  const name = url.searchParams.get('table');
  const t = EXPORTS[name];
  if (!t) return ctx.out({ ok: false, error: 'bad_table' }, 400);
  const days = period(url), now = Date.now();
  // Never fewer than MIN_GROUP people in a row, whatever is asked for.
  const min = Math.max(MIN_GROUP, Math.floor(+url.searchParams.get('min') || 0));
  const from = name === 'searches' ? dayOf(now - days * DAY + DAY) : now - days * DAY;
  const r = await env.DB.prepare(t.sql).bind(from, min).all();
  const file = `rave-monitor-${name}-${dayOf(now)}.csv`;
  return new Response(csv(t.head, r.results || []), {
    status: 200,
    headers: { ...ctx.cors, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'no-store', 'X-Min-Group': String(min) }
  });
}
