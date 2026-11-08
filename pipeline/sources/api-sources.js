// Sources with free official APIs: Ticketmaster Discovery and Skiddle.
import { fetchJson, sleep, num, pick, isoDay, localToUtc } from '../lib/util.js';
import { makeEvent, genresFrom, electronicScore, parsePrice } from '../lib/normalize.js';

const citiesFor = (ctx, key) => {
  const want = ctx.settings.cities;
  return ctx.cities.filter(c => c.sources && c.sources[key] && (!Array.isArray(want) || want.includes(c.id)));
};

function geohash(lat, lon, precision = 9) {
  const B = '0123456789bcdefghjkmnpqrstuvwxyz';
  let latR = [-90, 90], lonR = [-180, 180], hash = '', bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    const r = even ? lonR : latR, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch = ch << 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { hash += B[ch]; bit = 0; ch = 0; }
  }
  return hash;
}
const isoNoMs = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';

/* ---------------- Ticketmaster Discovery API ---------------- */
export const ticketmaster = {
  id: 'ticketmaster', label: 'Ticketmaster', needs: ['TICKETMASTER_KEY'],
  async collect(ctx) {
    const s = ctx.settings, out = [], seen = new Set();
    for (const c of citiesFor(ctx, 'ticketmaster')) {
      for (let page = 0; page < (s.maxPagesPerCity || 2); page++) {
        const q = new URLSearchParams({
          apikey: ctx.env.TICKETMASTER_KEY, classificationName: 'Dance/Electronic', geoPoint: geohash(c.lat, c.lon),
          radius: String(s.radiusKm || 40), unit: 'km', startDateTime: isoNoMs(ctx.from), endDateTime: isoNoMs(ctx.to),
          size: '200', page: String(page), sort: 'date,asc'
        });
        let j;
        try { j = await fetchJson(`https://app.ticketmaster.com/discovery/v2/events.json?${q}`, {}, { label: `Ticketmaster ${c.name}` }); }
        catch (err) { ctx.warn(err.message); break; }
        await sleep(250); // stay under 5 requests a second
        for (const e of (j && j._embedded && j._embedded.events) || []) if (!seen.has(e.id)) { seen.add(e.id); out.push({ ...e, __city: c.id }); }
        if (!j || !j.page || page >= j.page.totalPages - 1) break;
      }
    }
    return out;
  },
  normalize(x, ctx) {
    const v = pick(x, '_embedded.venues.0') || {};
    const cls = (x.classifications || [])[0] || {};
    const sub = pick(cls, 'subGenre.name'), gen = pick(cls, 'genre.name');
    const pr = (x.priceRanges || [])[0];
    const code = pick(x, 'dates.status.code');
    return makeEvent(ctx, {
      source: 'ticketmaster', sourceName: 'Ticketmaster', id: x.id, title: x.name, url: x.url,
      startMs: Date.parse(pick(x, 'dates.start.dateTime')), tz: pick(x, 'dates.timezone') || v.timezone,
      venueName: v.name, address: [pick(v, 'address.line1'), pick(v, 'city.name')].filter(Boolean).join(', '),
      lat: num(pick(v, 'location.latitude')), lon: num(pick(v, 'location.longitude')),
      cityName: pick(v, 'city.name'), country: pick(v, 'country.countryCode'), cityHint: x.__city,
      lineup: (pick(x, '_embedded.attractions') || []).map(a => a.name),
      genres: genresFrom([sub, gen].filter(n => n && n !== 'Undefined'), x.name), tags: [sub, gen].filter(n => n && n !== 'Undefined'),
      price: pr ? { min: pr.min, max: pr.max, currency: pr.currency } : null,
      status: code === 'cancelled' ? 'cancelled' : code === 'offsale' ? 'offsale' : code === 'onsale' ? 'onsale' : code === 'postponed' || code === 'rescheduled' ? 'postponed' : 'unknown',
      isConcert: true
    });
  }
};

/* ---------------- Skiddle (UK) ---------------- */
export const skiddle = {
  id: 'skiddle', label: 'Skiddle', needs: ['SKIDDLE_KEY'],
  async collect(ctx) {
    const s = ctx.settings, out = [], seen = new Set();
    for (const c of citiesFor(ctx, 'skiddle')) {
      for (let offset = 0; offset < (s.maxItemsPerCity || 200); offset += 100) {
        const q = new URLSearchParams({
          api_key: ctx.env.SKIDDLE_KEY, latitude: String(c.lat), longitude: String(c.lon), radius: String(s.radiusMiles || 15),
          eventcode: 'CLUB', minDate: isoDay(ctx.from), maxDate: isoDay(ctx.to), limit: '100', offset: String(offset), description: '1', order: 'date'
        });
        let j;
        try { j = await fetchJson(`https://www.skiddle.com/api/v1/events/search/?${q}`, {}, { label: `Skiddle ${c.name}` }); }
        catch (err) { ctx.warn(err.message); break; }
        const res = (j && j.results) || [];
        for (const e of res) if (!seen.has(e.id)) { seen.add(e.id); out.push({ ...e, __city: c.id }); }
        if (res.length < 100) break;
        await sleep(300);
      }
    }
    return out;
  },
  normalize(it, ctx) {
    if (String(it.cancelled) === '1') return null;
    const genreNames = (it.genres || []).map(g => g.name || g).filter(Boolean);
    const genres = genresFrom(genreNames, it.eventname);
    if (!genres.length && electronicScore(it.eventname, it.description, genreNames.join(' ')) < 1) return null;
    const tz = 'Europe/London', v = it.venue || {};
    const startMs = it.startdate ? localToUtc(it.startdate, tz) : localToUtc(`${it.date}T${(pick(it, 'openingtimes.doorsopen') || '22:00')}:00`, tz);
    return makeEvent(ctx, {
      source: 'skiddle', sourceName: 'Skiddle', id: it.id, title: it.eventname, url: it.link,
      startMs, endMs: it.enddate ? localToUtc(it.enddate, tz) : undefined, tz,
      venueName: v.name, address: [v.address, v.town].filter(Boolean).join(', '),
      lat: num(v.latitude), lon: num(v.longitude), cityName: v.town, country: 'GB', cityHint: it.__city,
      lineup: (it.artists || []).map(a => a.name || a), genres, tags: genreNames,
      price: parsePrice(it.entryprice, 'GBP'), status: String(it.ticketsavailable) === '0' ? 'soldout' : 'onsale',
      age: it.minage ? it.minage + '+' : undefined
    });
  }
};
