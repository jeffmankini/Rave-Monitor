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

/** fetch JSON with retries on 429 and 5xx. */
export async function fetchJson(url, opts = {}, { retries = 3, label = url } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429 || res.status >= 500) {
        last = new Error(`${label}: HTTP ${res.status}`);
        await sleep(1000 * 2 ** i);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    } catch (err) {
      last = err;
      if (i < retries) await sleep(800 * 2 ** i);
    }
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
