// The calendar feed, a supporter perk: GET /v1/cal/<secret>.ics, for Google, Apple or Outlook
// Calendar to subscribe to. It holds the person's upcoming saved shows and the new shows the alerts
// step found from who they follow. Calendar apps can't sign in, so the address itself is the secret;
// it can be reset from the account. When someone stops supporting, the feed empties.
import { isSupporter } from './billing.js';

const DAY = 864e5, HOUR = 36e5;
const text = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const enc = new TextEncoder();
/** Lines longer than 75 bytes continue on the next, after a space. */
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const parse = (s, fallback) => { try { return JSON.parse(s); } catch (err) { return fallback; } };
const cityName = id => String(id || '').split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');

/** The feed's events: saved shows first (they win over the same show from an alert). */
export async function calendarEvents(env, user, now = Date.now()) {
  if (!isSupporter(user, now)) return [];
  const [saves, alerts] = await env.DB.batch([
    env.DB.prepare('SELECT event_id, title, start, venue, city, url FROM saves WHERE user_id = ? AND start > ? ORDER BY start LIMIT 500').bind(user.id, new Date(now - DAY).toISOString()),
    env.DB.prepare("SELECT ref, body, data FROM notifications WHERE user_id = ? AND kind = 'new_show' AND created_at > ? ORDER BY id DESC LIMIT 500").bind(user.id, now - 180 * DAY)
  ]);
  const out = new Map();
  for (const s of saves.results) {
    const start = Date.parse(s.start);
    if (!Number.isFinite(start)) continue;
    out.set(s.event_id, { id: s.event_id, title: s.title, start, end: start + 4 * HOUR, where: [s.venue, cityName(s.city)].filter(Boolean).join(', '), url: s.url, note: 'You saved this show.' });
  }
  for (const n of alerts.results) {
    const d = parse(n.data, {}), start = Date.parse(d.start), end = Date.parse(d.end);
    if (!d.id || out.has(d.id) || !Number.isFinite(start) || start < now - DAY) continue;
    out.set(d.id, { id: d.id, title: d.title, start, end: Number.isFinite(end) && end > start ? end : start + 4 * HOUR, where: [d.venue, d.cityName].filter(Boolean).join(', '), url: d.url, note: n.body || '' });
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

export function icsFile(events, { siteUrl = 'https://ravemonitor.com', now = Date.now() } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rave Monitor//Calendar feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Rave Monitor', 'X-WR-CALDESC:Your saved shows and new shows from who you follow, from Rave Monitor', 'REFRESH-INTERVAL;VALUE=DURATION:PT3H', 'X-PUBLISHED-TTL:PT3H'];
  for (const e of events) {
    const page = siteUrl + '/?event=' + encodeURIComponent(e.id);
    lines.push('BEGIN:VEVENT', 'UID:' + text(e.id) + '@ravemonitor.com', 'DTSTAMP:' + stamp(now), 'DTSTART:' + stamp(e.start), 'DTEND:' + stamp(e.end),
      'SUMMARY:' + text(e.title), ...(e.where ? ['LOCATION:' + text(e.where)] : []), 'URL:' + text(page),
      'DESCRIPTION:' + text([e.note, 'On Rave Monitor: ' + page, e.url ? 'Listing: ' + e.url : ''].filter(Boolean).join('\n')), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** GET /v1/cal/<secret>.ics */
export async function calendarFeed(env, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return new Response('Not found', { status: 404 });
  const user = await env.DB.prepare('SELECT * FROM users WHERE cal_token = ?').bind(token).first();
  if (!user) return new Response('Not found', { status: 404 });
  const body = icsFile(await calendarEvents(env, user), { siteUrl: String(env.SITE_URL || 'https://ravemonitor.com').replace(/\/+$/, '') });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=900', 'Content-Disposition': 'inline; filename="rave-monitor.ics"', 'X-Robots-Tag': 'noindex' } });
}
