// The venue directory: every place that has hosted a night in the archive (which also holds the
// listings coming up), with its spellings from different platforms merged into one venue.
//
// Row format, written to archive/data/venues.json:
//   [id, name, cityId, lat, lon, flags, address, nights, upcoming, first, last, next, genres, regulars, aliases]
//   nights, upcoming: distinct nights (a night runs 6 am to 6 am local time, so two rooms or two shows
//   on one night count once), all of them and those still to come
//   flags: 1 = position is only the city's (no exact address), 2 = a concert venue (arena, theatre...)
//   first, last: the first and latest past night (YYYY-MM-DD, local); next: the next night coming up
//   genres: { family: nights }; regulars: names on two or more of its lineups, busiest first
//   aliases: other name keys that mean this venue (the page matches listings to venues with them)
import { norm, slug, km } from './lib/util.js';

const PLACEHOLDER = /^(tba|tbc|tbd|more tba|special guests?|secret guests?|guests?|and more|\+ ?more|line-?up tba)$/i;
// Big rooms that host the odd electronic show: worth telling apart from clubs. A club inside a
// casino or a theatre ("Hakkasan Nightclub at MGM Grand Hotel & Casino") is still a club.
const CONCERT = /\b(arena|stadium|stadion|amphitheat(?:er|re)|autodromo|raceway|racetrack|speedway|fairgrounds?|showgrounds?|expo|exhibition cent(?:er|re)|convention cent(?:er|re)|casino|theat(?:er|re)|hippodrome|velodrome|o2 academy|o2|forum|bowl)\b/i;
// Not places, matched on the name key: "TBA", "TBA - Brooklyn" (Resident Advisor's location-to-come,
// sometimes with a hint), "Secret location", "Venue to be announced", "Online".
export const NOT_A_VENUE = /^(?:(?:venue|location|address|place)\s+)?(?:tba|tbc|tbd|to be (?:announced|confirmed|revealed))(?:\s|$)|^(?:secret|undisclosed|private|hidden)\s+(?:location|venue|address|spot)(?:\s|$)|^(?:secret|undisclosed)$|^(?:various|multiple|several)\s+(?:venues|locations)(?:\s|$)|^(?:online|livestream|live stream|virtual|streaming)$/;
const CLUB = /\b(night ?club|day ?club|beach club|club|lounge|bar|discoth[eè]que|disco|warehouse|basement)\b/i;
export const isConcertVenue = name => CONCERT.test(name) && !CLUB.test(name);

/**
 * A venue's name as a matching key: lowercase, no accents or punctuation, no rooms in brackets (even
 * an unclosed one), no leading "the", and without the city's name at either end ("Clock Factory
 * Bristol" = "Clock Factory").
 */
export function venueKey(name, cityName = '') {
  let s = norm(String(name || '').replace(/\([^)]*\)|\[[^\]]*\]|\([^)]*$/g, ' ')).replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const c = norm(cityName).replace(/[^a-z0-9]+/g, ' ').trim();
  if (c && s !== c) {
    if (s.endsWith(' ' + c)) s = s.slice(0, -c.length - 1);
    if (s.startsWith(c + ' ')) s = s.slice(c.length + 1);
  }
  return s.replace(/^the /, '').trim();
}

/** The name to show beside the city: without the city at the end ("Clock Factory Bristol" is
 *  "Clock Factory" in Bristol), unless that leaves too little ("Hï Ibiza" stays). */
export function displayName(name, cityName = '') {
  const words = String(name || '').trim().split(/\s+/), city = norm(cityName).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!city.length || words.length <= city.length) return String(name || '').trim();
  const tail = words.slice(-city.length).map(w => norm(w).replace(/[^a-z0-9]+/g, '')).join(' ');
  if (tail !== city.join(' ')) return String(name || '').trim();
  const rest = words.slice(0, -city.length).join(' ').replace(/[\s,;:|·\-–—]+$/, '');
  return rest.replace(/[^\p{L}\p{N}]/gu, '').length >= 4 ? rest : String(name || '').trim();
}

// The night a listing belongs to: its local date, 6 hours back, so 1 am Sunday is Saturday night.
const fmts = {};
function nightOf(iso, tz) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const f = fmts[tz] ||= new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  try { return f.format(t - 6 * 3600e3); } catch { return String(iso).slice(0, 10); }
}

const median = arr => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
const tokens = k => new Set(k.split(' ').filter(Boolean));
// What a name has in brackets, as keys: "Barras Art And Design (BAaD)" is also "baad".
const bracketKeys = name => (String(name || '').match(/\(([^)]+)\)|\[([^\]]+)\]/g) || []).map(b => venueKey(b.slice(1, -1))).filter(Boolean);
const subset = (a, b) => [...a].every(t => b.has(t));

/** records: archive records; cities: { id: { name } }; now: ISO time. */
export function buildVenues(records, cities = {}, now = new Date().toISOString()) {
  // 1. Group by city and name key.
  const groups = new Map();
  for (const r of records) {
    const v = r.venue;
    if (!v || !v.name || !r.cityId) continue;
    const key = venueKey(v.name, cities[r.cityId]?.name);
    if (!key || NOT_A_VENUE.test(key)) continue;
    const gk = r.cityId + '|' + key;
    let g = groups.get(gk);
    if (!g) groups.set(gk, g = { cityId: r.cityId, keys: new Set([key]), brackets: new Set(), recs: [] });
    g.recs.push(r);
    for (const b of bracketKeys(v.name)) g.brackets.add(b);
  }
  // 2. Within a city, fold a group into a bigger one at the same spot whose name contains it
  //    ("Phonox Brixton" into "Phonox", "Melkweg Oude Zaal" into "Melkweg"), is the same without spaces
  //    ("Room 2" and "Room2"), or is what the other has in brackets ("BAaD" and "Barras Art And Design (BAaD)").
  const pos = g => {
    const ex = g.recs.filter(r => !r.venue.approx && Number.isFinite(r.venue.lat) && Number.isFinite(r.venue.lon));
    return ex.length ? [median(ex.map(r => r.venue.lat)), median(ex.map(r => r.venue.lon))] : null;
  };
  const byCity = {};
  for (const g of groups.values()) (byCity[g.cityId] ||= []).push(g);
  for (const list of Object.values(byCity)) {
    list.sort((a, b) => b.recs.length - a.recs.length);
    for (let i = list.length - 1; i > 0; i--) {
      const small = list[i], sp = pos(small), sk = [...small.keys][0], st = tokens(sk);
      for (let j = 0; j < i; j++) {
        const big = list[j], bp = pos(big), bk = [...big.keys][0], bt = tokens(bk);
        if (!sp || !bp) continue;
        const d = km(sp[0], sp[1], bp[0], bp[1]);
        const same = d <= 1 && sk.replace(/ /g, '') === bk.replace(/ /g, '');
        if (!same && (d > 0.15 || !(subset(bt, st) || subset(st, bt) || big.brackets.has(sk) || small.brackets.has(bk)))) continue;
        for (const k of small.keys) big.keys.add(k);
        for (const b of small.brackets) big.brackets.add(b);
        big.recs.push(...small.recs);
        list.splice(i, 1);
        break;
      }
    }
  }
  // 3. One row per venue.
  const out = [];
  for (const list of Object.values(byCity)) for (const g of list) {
    const names = {}, addrs = {}, fam = {}, who = {}, all = new Set(), coming = new Set(), past = [];
    const tz = cities[g.cityId]?.tz || 'UTC';
    let next = '';
    for (const r of g.recs) {
      names[r.venue.name] = (names[r.venue.name] || 0) + 1;
      if (r.venue.address) addrs[r.venue.address] = (addrs[r.venue.address] || 0) + 1;
      if (r.status === 'cancelled') continue;
      const night = nightOf(r.start, r.tz || tz);
      if (!night) continue;
      all.add(night);
      for (const f of r.genres || []) fam[f] = (fam[f] || 0) + 1;
      for (const a of new Set((r.lineup || []).map(s => String(s).trim()).filter(s => s && !PLACEHOLDER.test(s)))) who[a] = (who[a] || 0) + 1;
      if (r.start >= now) { coming.add(night); if (!next || night < next) next = night; }
      else past.push(night);
    }
    if (!all.size) continue;
    past.sort();
    const top = obj => Object.keys(obj).sort((a, b) => obj[b] - obj[a] || a.localeCompare(b));
    // The base name names the venue: "Club Space", not "The Ground at Club Space".
    const key = [...g.keys].sort((a, b) => a.split(' ').length - b.split(' ').length || a.length - b.length)[0];
    const cityName = cities[g.cityId]?.name;
    const name = displayName(top(names).find(n => venueKey(n, cityName) === key) || top(names)[0], cityName);
    const p = pos(g);
    const anyPos = g.recs.find(r => Number.isFinite(r.venue.lat));
    const lat = p ? p[0] : anyPos ? anyPos.venue.lat : null, lon = p ? p[1] : anyPos ? anyPos.venue.lon : null;
    const flags = (p ? 0 : 1) | (isConcertVenue(name) || g.recs.some(r => isConcertVenue(r.venue.name)) && !CLUB.test(name) ? 2 : 0);
    const regulars = top(who).filter(a => who[a] > 1).slice(0, 6);
    const genres = Object.fromEntries(top(fam).map(f => [f, fam[f]]));
    out.push([
      g.cityId + '-' + slug(key), name, g.cityId, lat == null ? null : +lat.toFixed(5), lon == null ? null : +lon.toFixed(5), flags,
      top(addrs)[0] || null, all.size, coming.size, past[0] || null, past[past.length - 1] || null, next || null, genres, regulars,
      [...g.keys].filter(k => k !== key)
    ]);
  }
  // Busiest first.
  out.sort((a, b) => b[8] - a[8] || b[7] - a[7] || a[1].localeCompare(b[1]));
  return { updatedAt: now, venues: out };
}
