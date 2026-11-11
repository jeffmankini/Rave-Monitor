// Sources with free official APIs: Ticketmaster Discovery and Skiddle.
import { fetchJson, sleep, num, pick, isoDay, localToUtc } from '../lib/util.js';
import { makeEvent, genresFrom, electronicScore, parsePrice, notElectronic, titleNamesStyle, titleNamesOtherGenre } from '../lib/normalize.js';

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
// The Dance/Electronic search also returns shows where only a support act or a classification further
// down is filed under it (a pop tour with a DJ opening, a rock band at a venue called The Rave), plus
// add-ons sold as their own listing (premium packages, fast track). Each act on a listing carries its
// own classification, which is more reliable than the listing's, so the headliner decides; for a
// festival, most of the billed acts. Ticketmaster also files most Dance/Electronic listings under the
// sub-genre "Amapiano" (Bonobo, Cut Copy, Jabbawockeez), so that word only counts when an act or the
// title says so.
const tmName = x => (x && x.name && x.name !== 'Undefined') ? x.name : '';
const tmClass = c => ({ primary: !!c.primary, segment: tmName(c.segment), genre: tmName(c.genre), subGenre: tmName(c.subGenre), type: tmName(c.type), subType: tmName(c.subType) });
const tmMain = list => { const all = (list || []).map(tmClass); return all.find(c => c.primary) || all[0] || null; };
const TM_ELECTRONIC = 'Dance/Electronic';
const tmGenreKnown = c => !!(c && c.genre && c.genre !== 'Other');

/**
 * { keep, why, tags } for a Ticketmaster listing: whether it's electronic music going by its acts'
 * classifications (why says what decided a drop), and the genre tags to show for it.
 */
export function ticketmasterAct(x) {
  const ev = (x.classifications || []).map(tmClass);
  const main = ev.find(c => c.primary) || ev[0] || {};
  const atts = (pick(x, '_embedded.attractions') || []).map(a => ({ name: a.name, c: tmMain(a.classifications) }));
  if (atts.some(a => a.c && a.c.type === 'Upsell') || ev.some(c => c.type === 'Upsell')) return { keep: false, why: 'add-on (premium package, fast track or upgrade)' };
  // Brands: the festival, party or race itself, listed as an act ("Corona Capital", "Earlybirds Club").
  // Other "Event Style" acts are artists billed as a show ("Clara La San – Chosen Silences Tour").
  const isBrand = a => a.c && a.c.type === 'Event Style' && ['Festival', 'Party/Gala', 'Competition'].includes(a.c.subType);
  const brands = atts.filter(isBrand);
  const acts = atts.filter(a => !isBrand(a));
  const known = acts.filter(a => a.c && a.c.segment === 'Music' && tmGenreKnown(a.c));
  // Dance troupes (Jabbawockeez) and tribute bands are filed under the music they perform to.
  const isElectronicAct = a => a.c.genre === TM_ELECTRONIC && a.c.subType !== 'Troupe' && a.c.subType !== 'Tribute Band';
  const festival = main.subType === 'Festival' || brands.some(b => b.c.subType === 'Festival');
  const head = acts[0];
  let keep, why = '', lead = null;
  if (main.segment && main.segment !== 'Music') { keep = false; why = `${main.segment}, not a music show`; }
  else if (head && head.c && head.c.segment && head.c.segment !== 'Music') { keep = false; why = `${head.c.segment}, not a music show`; }
  else if (festival && known.length > 1) {
    keep = known.filter(isElectronicAct).length * 2 >= known.length;
    if (!keep) why = 'festival billed mostly with other genres';
    lead = known.find(isElectronicAct) || null;
  } else if (head && head.c && head.c.segment === 'Music' && tmGenreKnown(head.c)) {
    // Pop and Rock > Pop are Ticketmaster's catch-alls for big names: a listing filed under Dance/Electronic
    // that starts at 10pm or later (Calvin Harris at XS) is a club night and stands; a concert by a
    // catch-all name (Pitbull, a pop tour) or an act with a specific genre (Alternative Rock) doesn't.
    const catchAll = (head.c.genre === 'Pop' || head.c.genre === 'Rock') && (!head.c.subGenre || head.c.subGenre === 'Pop');
    const hour = parseInt(String(pick(x, 'dates.start.localTime') || '').slice(0, 2), 10);
    const late = hour >= 22 || hour < 4;
    keep = isElectronicAct(head) || (catchAll && main.genre === TM_ELECTRONIC && late);
    lead = isElectronicAct(head) ? head : null;
    if (!keep) why = head.c.subType === 'Troupe' ? 'dance troupe' : head.c.subType === 'Tribute Band' ? 'tribute band' : `headliner filed under ${head.c.genre}`;
  } else {
    // No headliner with a genre: the brand decides, then the listing's own classification.
    const brand = brands.find(b => tmGenreKnown(b.c));
    let decider = null;
    if (brand) decider = brand.c;
    else if (tmGenreKnown(main) || (main.segment && main.segment !== 'Music')) decider = main;
    if (decider && decider.segment && decider.segment !== 'Music') { keep = false; why = `${decider.segment}, not a music show`; }
    else if (decider) { keep = decider.genre === TM_ELECTRONIC; if (!keep) why = `filed under ${decider.genre}`; }
    else { keep = !known.length || known.some(isElectronicAct); if (!keep) why = 'acts filed under other genres'; }
    lead = known.find(isElectronicAct) || null;
  }
  // With no artist filed under Dance/Electronic (only the listing, or the party billed as its own act), a
  // title naming another genre outright decides ('Emo Night', 'Reggaeton Rave'), unless it names an
  // electronic style too.
  const title = String(x.name || '');
  const artistLead = lead && lead.c.type !== 'Event Style';
  if (keep && !artistLead && titleNamesOtherGenre(title) && !titleNamesStyle(title)) { keep = false; why = 'title names another genre'; }
  if (!keep) return { keep, why };
  // Tags: the listing's own sub-genre when it's an electronic one (not the stand-in "Amapiano"), the
  // deciding act's, and Dance/Electronic when anything on the listing says so.
  const realAmapiano = /amapiano/i.test(title) || atts.some(a => a.c && /amapiano/i.test(a.c.subGenre));
  const sub = c => c && c.genre === TM_ELECTRONIC && c.subGenre && c.subGenre !== TM_ELECTRONIC && c.subGenre !== 'Other' && (c.subGenre !== 'Amapiano' || realAmapiano) ? c.subGenre : '';
  const saysElectronic = !!lead || ev.some(c => c.genre === TM_ELECTRONIC) || brands.some(b => b.c.genre === TM_ELECTRONIC);
  const tags = [...new Set([sub(main), sub(lead && lead.c), sub(brands[0] && brands[0].c), saysElectronic ? TM_ELECTRONIC : ''].filter(Boolean))];
  return { keep, why, tags };
}

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
        catch (err) { if (err.status === 401 || err.status === 403) throw err; ctx.warn(err.message); break; }
        await sleep(250); // stay under 5 requests a second
        for (const e of (j && j._embedded && j._embedded.events) || []) if (!seen.has(e.id)) { seen.add(e.id); out.push({ ...e, __city: c.id }); }
        if (!j || !j.page || page >= j.page.totalPages - 1) break;
      }
    }
    return out;
  },
  normalize(x, ctx) {
    const act = ticketmasterAct(x);
    if (!act.keep) return notElectronic(ctx, 'ticketmaster', x.id);
    const v = pick(x, '_embedded.venues.0') || {};
    const pr = (x.priceRanges || [])[0];
    const code = pick(x, 'dates.status.code');
    return makeEvent(ctx, {
      source: 'ticketmaster', sourceName: 'Ticketmaster', id: x.id, title: x.name, url: x.url,
      startMs: Date.parse(pick(x, 'dates.start.dateTime')), tz: pick(x, 'dates.timezone') || v.timezone,
      venueName: v.name, address: [pick(v, 'address.line1'), pick(v, 'city.name')].filter(Boolean).join(', '),
      lat: num(pick(v, 'location.latitude')), lon: num(pick(v, 'location.longitude')),
      cityName: pick(v, 'city.name'), country: pick(v, 'country.countryCode'), cityHint: x.__city,
      lineup: (pick(x, '_embedded.attractions') || []).map(a => a.name),
      genres: genresFrom(act.tags, x.name), tags: act.tags,
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
        catch (err) { if (err.status === 401 || err.status === 403) throw err; ctx.warn(err.message); break; }
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
      lineup: (it.artists || []).map(a => a.name || a), genres, tags: genreNames, genreText: it.description,
      price: parsePrice(it.entryprice, 'GBP'), status: String(it.ticketsavailable) === '0' ? 'soldout' : 'onsale',
      age: it.minage ? it.minage + '+' : undefined
    });
  }
};
