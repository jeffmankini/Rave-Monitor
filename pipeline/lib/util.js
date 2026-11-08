// Small helpers shared by the pipeline. No dependencies: Node 20+ has fetch and full time-zone data.

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function slug(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Great-circle distance in km. */
export function km(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** First value that is not null, undefined or an empty string. Paths look like 'venue.location.latitude'. */
export function pick(obj, ...paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** A short, readable reason from an error response (JSON APIs usually carry a message). */
export function errorReason(text) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.fault?.faultstring ?? j?.errormessage ?? j?.message ?? j?.error;
    if (typeof m === 'string' && m) return m.slice(0, 160);
  } catch {}
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * fetch JSON, retrying network errors, 408, 429 and 5xx. Other 4xx answers fail at once, with err.status set.
 * Messages use the label, never the URL, because URLs carry API keys.
 */
export async function fetchJson(url, opts = {}, { retries = 3, label = String(url).split('?')[0] } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    let res;
    try { res = await fetch(url, opts); } catch (err) {
      last = new Error(`${label}: ${err.cause?.code || err.message}`);
      if (i < retries) await sleep(800 * 2 ** i);
      continue;
    }
    const text = await res.text().catch(() => '');
    if (res.ok) return text ? JSON.parse(text) : null;
    const err = Object.assign(new Error(`${label}: HTTP ${res.status} ${errorReason(text)}`.trim()), { status: res.status });
    if (res.status !== 408 && res.status !== 429 && res.status < 500) throw err;
    last = err;
    if (i < retries) await sleep(1000 * 2 ** i);
  }
  throw last;
}

/** Run async jobs with a concurrency limit. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Offset in minutes between a time zone and UTC at a given instant. */
const dtfCache = new Map();
export function tzOffsetMin(tz, utcMs) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    dtfCache.set(tz, f);
  }
  const m = {};
  for (const p of f.formatToParts(new Date(utcMs))) m[p.type] = p.value;
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/** '2026-11-14T23:00:00' wall-clock time in tz -> UTC ms. Strings that already carry Z or an offset are parsed as-is. */
export function localToUtc(local, tz) {
  if (!local) return undefined;
  const s = String(local);
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?/);
  if (!m) return undefined;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!tz) return guess;
  try {
    let utc = guess - tzOffsetMin(tz, guess) * 60000;
    const again = guess - tzOffsetMin(tz, utc) * 60000;
    if (again !== utc) utc = again;
    return utc;
  } catch {
    return guess;
  }
}

/** Local hour (0-23) of an instant in a time zone. */
export function localHour(utcMs, tz) {
  try {
    return new Date(utcMs + tzOffsetMin(tz, utcMs) * 60000).getUTCHours();
  } catch {
    return new Date(utcMs).getUTCHours();
  }
}

export const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

/** Local calendar days from fromMs to toMs in a time zone: [{ date: 'YYYY-MM-DD', weekday: 'Fri' }]. */
export function localDays(fromMs, toMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  const out = [], seen = new Set();
  // Half-day steps so a daylight-saving change can't skip a date.
  for (let t = fromMs; t <= toMs; t += 43200e3) {
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, x.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    if (!seen.has(date)) { seen.add(date); out.push({ date, weekday: p.weekday }); }
  }
  return out;
}

/** Split a total cap across n slices as evenly as possible: shareCap(40, 9) -> [5,5,5,5,4,4,4,4,4]. */
export function shareCap(total, n) {
  return Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
}
