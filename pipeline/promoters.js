// The promoters and record labels in the archive, for the map page's Promoters tab: who throws nights,
// how many, where, at which venues and in what sound. Promoter names come from the listings and
// config/promoters.json, labels from config/labels.json (pipeline/lib/labels.js); one spelling each.
//
// { updatedAt, promoters: rows, labels: rows }, a row:
//   [name, nights, upcoming, first, last, cities, genres, venues]
//   nights, upcoming: distinct nights (per city: two rooms the same night count once), all and to come
//   first, last: the first and latest past night (YYYY-MM-DD, local)
//   cities: { cityId: nights }, genres: { family: listings }, venues: [[venue name, cityId, nights]] (top three)
import { fold } from './lib/labels.js';
import { nightOf } from './venues.js';

function build(records, cities, field, now) {
  const groups = new Map();
  for (const r of records) {
    if (r.status === 'cancelled' || !r.cityId) continue;
    const names = Array.isArray(r[field]) ? r[field] : [];
    if (!names.length) continue;
    const night = nightOf(r.start, r.tz || cities[r.cityId]?.tz || 'UTC');
    if (!night) continue;
    for (const name of new Set(names)) {
      const k = fold(name).trim();
      if (!k) continue;
      let g = groups.get(k);
      if (!g) groups.set(k, g = { names: {}, all: new Set(), coming: new Set(), past: [], cities: {}, genres: {}, venues: {} });
      g.names[name] = (g.names[name] || 0) + 1;
      const cn = r.cityId + '|' + night;
      if (!g.all.has(cn)) {
        g.all.add(cn);
        g.cities[r.cityId] = (g.cities[r.cityId] || 0) + 1;
        if (r.start >= now) g.coming.add(cn); else g.past.push(night);
        const v = r.venue && r.venue.name;
        if (v && !/^venue to be announced$/i.test(v)) { const vk = r.cityId + '|' + v; g.venues[vk] = (g.venues[vk] || 0) + 1; }
      }
      for (const f of r.genres || []) g.genres[f] = (g.genres[f] || 0) + 1;
    }
  }
  const top = obj => Object.keys(obj).sort((a, b) => obj[b] - obj[a] || a.localeCompare(b));
  const rows = [];
  for (const g of groups.values()) {
    g.past.sort();
    rows.push([
      top(g.names)[0], g.all.size, g.coming.size, g.past[0] || null, g.past[g.past.length - 1] || null,
      Object.fromEntries(top(g.cities).map(c => [c, g.cities[c]])), Object.fromEntries(top(g.genres).map(f => [f, g.genres[f]])),
      top(g.venues).slice(0, 3).map(vk => { const i = vk.indexOf('|'); return [vk.slice(i + 1), vk.slice(0, i), g.venues[vk]]; })
    ]);
  }
  return rows.sort((a, b) => b[2] - a[2] || b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** records: the archive's records; cities: { cityId: { tz } }. */
export function buildCrews(records, cities = {}, now = new Date().toISOString()) {
  return { updatedAt: now, promoters: build(records, cities, 'promoters', now), labels: build(records, cities, 'labels', now) };
}
