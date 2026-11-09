// Merges the same night listed on several platforms (say RA and DICE) into one event
// that keeps every source link.
import { km, norm, tzOffsetMin } from './util.js';

const STOP = new Set(['the', 'a', 'an', 'and', 'with', 'w', 'presents', 'pres', 'present', 'at', 'in', 'feat', 'ft', 'featuring', 'b2b', 'all', 'night', 'long', 'live', 'dj', 'djs', 'set', 'party', 'x', 'vs', 'club', 'tickets', 'event', 'of', 'for', 'on']);
const PRIORITY = { ra: 7, dice: 6, ticketmaster: 5, skiddle: 4, posh: 3, luma: 2, partiful: 1 };

const tokens = s => new Set(norm(s).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function nightKey(e) {
  const t = Date.parse(e.start);
  let off = 0;
  try { off = tzOffsetMin(e.tz, t) * 60000; } catch { /* unknown zone: use UTC */ }
  return e.cityId + '|' + new Date(t + off - 6 * 3600e3).toISOString().slice(0, 10);
}
function venueMatch(a, b) {
  const ta = tokens(a.venue.name), tb = tokens(b.venue.name);
  const named = jaccard(ta, tb) >= 0.5 || (ta.size && tb.size && ([...ta].every(x => tb.has(x)) || [...tb].every(x => ta.has(x))));
  if (named) return true;
  if (a.venue.approx || b.venue.approx) return false;
  return km(a.venue.lat, a.venue.lon, b.venue.lat, b.venue.lon) <= 0.3;
}
export function sameEvent(a, b) {
  if (a.sources[0].id === b.sources[0].id && a.id !== b.id && !a.venue.approx) {
    // Two listings from one platform are only merged when they are clearly identical.
    return norm(a.title) === norm(b.title) && venueMatch(a, b);
  }
  if (!venueMatch(a, b)) return false;
  const ts = jaccard(tokens(a.title), tokens(b.title));
  const la = new Set(a.lineup.map(norm)), overlap = b.lineup.some(n => la.has(norm(n)));
  const close = Math.abs(Date.parse(a.start) - Date.parse(b.start)) <= 90 * 60e3;
  return ts >= 0.4 || overlap || (close && ts >= 0.2);
}

function richness(e) {
  return (PRIORITY[e.sources[0].id] || 0) * 10 + e.lineup.length + (e.price ? 3 : 0) + (e.venue.approx ? -8 : 0) + (e.sets ? 4 : 0);
}

function merge(group) {
  group.sort((x, y) => richness(y) - richness(x));
  const out = structuredClone(group[0]);
  for (const e of group.slice(1)) {
    for (const s of e.sources) if (!out.sources.some(x => x.id === s.id && x.url === s.url)) out.sources.push(s);
    for (const n of e.lineup) if (!out.lineup.some(x => norm(x) === norm(n))) out.lineup.push(n);
    for (const g of e.genres) if (g !== 'other' && !out.genres.includes(g)) out.genres.push(g);
    for (const t of e.tags) if (!out.tags.includes(t)) out.tags.push(t);
    if (!out.price && e.price) out.price = e.price;
    if (out.status === 'unknown' && e.status !== 'unknown') out.status = e.status;
    if (e.status === 'soldout') out.status = 'soldout';
    if (Number.isFinite(e.popularity)) out.popularity = Math.max(out.popularity || 0, e.popularity);
    if (!out.sets && e.sets) out.sets = e.sets;
    if (out.venue.approx && !e.venue.approx) out.venue = e.venue;
    if (!out.age && e.age) out.age = e.age;
    for (const f of ['labels', 'promoters']) for (const x of e[f] || []) { out[f] ||= []; if (!out[f].includes(x)) out[f].push(x); }
  }
  if (out.genres.length > 1) out.genres = out.genres.filter(g => g !== 'other');
  out.lineup = out.lineup.slice(0, 24);
  return out;
}

/** Group by city and night, cluster look-alikes, merge each cluster. */
export function dedupe(events) {
  const buckets = new Map();
  for (const e of events) {
    const k = nightKey(e);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }
  const out = [];
  let merged = 0;
  for (const list of buckets.values()) {
    const parent = list.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (find(i) !== find(j) && sameEvent(list[i], list[j])) parent[find(j)] = find(i);
    const groups = new Map();
    list.forEach((e, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e); });
    for (const g of groups.values()) { if (g.length > 1) merged += g.length - 1; out.push(g.length > 1 ? merge(g) : g[0]); }
  }
  return { events: out, merged };
}
