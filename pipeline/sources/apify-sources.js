// Sources scraped through third-party Apify actors. Each one: collect() runs the actor(s),
// normalize() maps one raw item to the shared event shape (or null to drop it).
import { pick, num, isoDay, localToUtc, pool, localDays, shareCap } from '../lib/util.js';
import { makeEvent, genresFrom, electronicScore, parsePrice, fromMinor } from '../lib/normalize.js';

const citiesFor = (ctx, key) => {
  const want = ctx.settings.cities;
  return ctx.cities.filter(c => c.sources && c.sources[key] && (!Array.isArray(want) || want.includes(c.id)));
};
/**
 * One scrape per city, a few at a time, so every city gets its own cap and a busy city can't use up
 * the others' share. A city that fails is reported and skipped; if every city fails, the source fails.
 */
async function perCity(ctx, key, scrape) {
  const cities = citiesFor(ctx, key), errors = [];
  const cached = ctx.cachedCity || ((c, pull) => pull()); // run.js adds per-city saved scrapes
  const results = await pool(cities, ctx.settings.concurrency || 3, async c => {
    try { return (await cached(c, () => scrape(c))).map(x => ({ ...x, __city: c.id })); }
    catch (err) { errors.push(err); ctx.warn(`${c.name}: ${err.message}`); return []; }
  });
  if (cities.length && errors.length === cities.length) throw errors[0];
  return results.flat();
}
/** Run several pulls for one city, two at a time. A pull that fails is reported; if all fail, the city fails. */
async function pullEach(jobs, ctx) {
  const errors = [];
  const results = await pool(jobs, 2, async j => {
    try { return await j.run(); } catch (err) { errors.push(err); ctx.warn(`${j.label}: ${err.message}`); return []; }
  });
  if (jobs.length && errors.length === jobs.length) throw errors[0];
  return results.flat();
}
const titleCase = s => String(s).replace(/(^|[\s-])\w/g, m => m.toUpperCase());
const DICE_TAGS = { ukgarage: 'UK Garage', drumandbass: 'Drum & Bass', dnb: 'Drum & Bass', deephouse: 'Deep House', techhouse: 'Tech House', hardtechno: 'Hard Techno', afrohouse: 'Afro House', edm: 'EDM', rnb: 'R&B', hiphop: 'Hip-Hop' };
const diceTag = raw => { const k = String(raw).split(':').pop().toLowerCase(); return DICE_TAGS[k] || titleCase(k); };

/* ---------------- Resident Advisor ---------------- */
export const ra = {
  id: 'ra', label: 'Resident Advisor', needs: ['APIFY_TOKEN'], perCity: true,
  async collect(ctx) {
    const s = ctx.settings, spread = new Set(s.spreadCities || []);
    return perCity(ctx, 'ra', async c => {
      // A city can list more than one area page (when unsure which one RA uses); a wrong one just returns nothing.
      const pull = async (from, to, cap) => (await ctx.apify(s.actor, {
        startUrls: [].concat(c.sources.ra).map(url => ({ url })),
        dateRangeFrom: from, dateRangeTo: to,
        maxItems: cap, enforceMaxItems: true, downloadDelay: 1200,
        proxyConfiguration: { useApifyProxy: !!s.useProxy }
      }, { maxItems: cap, maxChargeUsd: s.maxChargeUsdPerRun })).items;
      let items;
      if (spread.has(c.id)) {
        // RA lists events date by date, so in a busy city one pull's cap fills up with the first few
        // nights. Share the cap across every chosen night (Fridays and Saturdays) in the window instead.
        const nights = localDays(ctx.from, ctx.to, c.tz).filter(d => (s.spreadNights || ['Fri', 'Sat']).includes(d.weekday));
        const caps = shareCap(s.maxItemsPerCity, nights.length);
        items = await pullEach(nights.map((d, i) => ({ label: `${c.name} ${d.weekday} ${d.date}`, run: () => pull(d.date, d.date, caps[i]) })).filter((_, i) => caps[i] > 0), ctx);
      } else {
        items = await pull(isoDay(ctx.from), isoDay(ctx.to), s.maxItemsPerCity);
      }
      const seen = new Set();
      return items.filter(it => !it.id || (!seen.has(it.id) && seen.add(it.id)));
    });
  },
  normalize(it, ctx) {
    // RA gives local wall-clock times; fall back to the scraped city's zone if the item has none.
    const tz = pick(it, 'area.ianaTimeZone', 'venue.area.ianaTimeZone') || ctx.cityById?.[it.__city]?.tz;
    const lineup = (it.artists || []).map(a => a.name);
    if (!lineup.length && it.lineup) lineup.push(...String(it.lineup).replace(/<[^>]+>/g, '').split(/\n|,/).map(x => x.trim()));
    const genreNames = (it.genres || []).map(g => g.name);
    return makeEvent(ctx, {
      source: 'ra', sourceName: 'Resident Advisor', id: it.id, title: it.title,
      url: it.contentUrl ? 'https://ra.co' + it.contentUrl : undefined,
      startMs: localToUtc(it.startTime || it.date, tz), endMs: localToUtc(it.endTime, tz), tz,
      venueName: it.hasSecretVenue ? 'Secret location' : pick(it, 'venue.name'), address: pick(it, 'venue.address'),
      lat: num(pick(it, 'venue.location.latitude')), lon: num(pick(it, 'venue.location.longitude')),
      cityName: pick(it, 'venue.area.name'), country: pick(it, 'venue.area.country.urlCode'), cityHint: it.__city,
      lineup, genres: genresFrom(genreNames, it.title), tags: genreNames,
      price: parsePrice(it.cost), status: 'unknown', popularity: num(it.interestedCount),
      age: it.minimumAge ? it.minimumAge + '+' : undefined, isFestival: !!it.isFestival,
      promoters: it.promoters || it.promoterNames
    });
  }
};

/* ---------------- DICE ---------------- */
// Reads both DICE scraper formats: the flat one (date, venue, genre_tags) and DICE's own event
// objects (dates.event_start_date, venues[], tags_types), which the default scraper returns.
const DICE_ELECTRONIC = /techno|house|electronic|dance|drum|dnb|jungle|garage|disco|trance|dubstep|bass|club|dj|rave|edm|amapiano|afro|breaks|electro|ambient|hardcore/;
const DICE_GENRE_ELECTRONIC = /techno|house|electronic|drum|dnb|jungle|garage|disco|trance|dubstep|bass|edm|amapiano|afro|breaks|electro|ambient|hardcore|ukg|grime|minimal|acid|italo/;
const DICE_OFF_GENRE = /hip ?hop|rnb|reggaeton|rock|indie|emo|punk|metal|country|folk|jazz|latin|karaoke|comedy|trivia/;
const tagValues = (...lists) => lists.flatMap(l => l || []).map(t => String(typeof t === 'string' ? t : t.value || t.name || '').split(':').pop().toLowerCase()).filter(Boolean);
export const dice = {
  id: 'dice', label: 'DICE', needs: ['APIFY_TOKEN'], perCity: true,
  async collect(ctx) {
    const s = ctx.settings;
    // DICE browse pages per city: each category (music/dj by default) within the window, then the
    // same without dates, then the whole city as a fallback. The cap stops the run once it's full,
    // so later pages only fill in when the earlier ones come back empty.
    const range = `from=${isoDay(ctx.from)}&until=${isoDay(ctx.to)}`;
    return perCity(ctx, 'dice', async c => {
      const base = `https://dice.fm/browse/${c.sources.dice}`;
      const pages = (s.categories || ['music/dj']).flatMap(cat => [`${base}/${cat}?${range}`, `${base}/${cat}`]).concat(base);
      const { items } = await ctx.apify(s.actor, {
        startUrls: pages.map(url => ({ url })),
        maxItems: s.maxItemsPerCity, enforceMaxItems: true, downloadDelay: 800,
        proxyConfiguration: { useApifyProxy: !!s.useProxy }
      }, { maxItems: s.maxItemsPerCity, maxChargeUsd: s.maxChargeUsdPerRun });
      const seen = new Set();
      return items.filter(it => !it.id || (!seen.has(it.id) && seen.add(it.id)));
    });
  },
  normalize(it, ctx) {
    const desc = it.description || pick(it, 'about.description');
    const genreTags = tagValues(it.genre_tags, it.tags_genres), typeTags = tagValues(it.type_tags, it.tags_types);
    const genreText = genreTags.join(' '), tagText = [...genreTags, ...typeTags].join(' ');
    // A DJ night tagged only with other genres (hip-hop, R&B, rock...) isn't an electronic event.
    const offGenre = genreTags.length > 0 && !DICE_GENRE_ELECTRONIC.test(genreText) && DICE_OFF_GENRE.test(genreText);
    if (offGenre || !(DICE_ELECTRONIC.test(tagText) || electronicScore(it.name, desc) >= 1)) return null;
    const lineupEntries = Array.isArray(it.lineup) ? it.lineup : [];
    const lineup = [
      ...lineupEntries.map(l => typeof l === 'string' ? l : pick(l, 'details', 'name', 'artist')),
      ...(it.artists || []).map(a => typeof a === 'string' ? a : a.name),
      ...(pick(it, 'summary_lineup.top_artists') || []).map(a => a.name)
    ].filter((n, i, a) => n && a.indexOf(n) === i);
    const sets = lineupEntries
      .map(l => ({ name: pick(l, 'details', 'name', 'artist'), start: pick(l, 'time', 'start') }))
      .filter(x => x.name && x.start && !Number.isNaN(Date.parse(x.start)))
      .map(x => ({ name: x.name, start: new Date(Date.parse(x.start)).toISOString() }));
    let price = null;
    const priceObj = it.price && typeof it.price === 'object' ? it.price : null;
    const cur = it.currency || priceObj?.currency;
    const base = num(priceObj ? (priceObj.amount ?? priceObj.amount_from) : it.price);
    if (base !== undefined) price = { min: fromMinor(base, cur), max: fromMinor(base, cur), currency: cur };
    else if (Array.isArray(it.ticket_types) && it.ticket_types.length) {
      const vals = it.ticket_types.map(t => num(pick(t, 'price.total', 'price.face_value', 'total', 'face_value', 'price'))).filter(v => v !== undefined);
      if (vals.length) price = { min: fromMinor(Math.min(...vals), cur), max: fromMinor(Math.max(...vals), cur), currency: cur };
    }
    const st = String(it.status || '').toLowerCase();
    const status = st === 'cancelled' ? 'cancelled' : it.sold_out || st === 'sold-out' || st === 'sold_out' ? 'soldout'
      : st === 'off-sale' ? 'offsale' : st === 'on-sale' || st === 'active' ? 'onsale' : 'unknown';
    const loc = it.location || {}, v = (it.venues || [])[0] || {};
    return makeEvent(ctx, {
      source: 'dice', sourceName: 'DICE', id: it.id, title: it.name,
      url: it.url || (it.perm_name ? `https://dice.fm/event/${it.perm_name}` : undefined),
      startMs: Date.parse(it.date || pick(it, 'dates.event_start_date')),
      endMs: Date.parse(it.date_end || pick(it, 'dates.event_end_date')) || undefined,
      tz: it.timezone || pick(it, 'dates.timezone') || pick(v, 'city.location.place'),
      venueName: (typeof it.venue === 'string' ? it.venue : undefined) || v.name,
      address: [loc.street, loc.city].filter(Boolean).join(', ') || v.address,
      lat: num(pick(loc, 'lat', 'latitude') ?? pick(v, 'location.lat')), lon: num(pick(loc, 'lng', 'long', 'longitude') ?? pick(v, 'location.lng')),
      cityName: loc.city || pick(v, 'city.name') || pick(it, 'cities.0.name'), country: loc.country || pick(v, 'city.country_code'), cityHint: it.__city,
      lineup, sets, genres: genresFrom(tagText, it.name), tags: genreTags.map(diceTag), price, status, age: it.age_limit
    });
  }
};

/* ---------------- Posh ---------------- */
export const posh = {
  id: 'posh', label: 'Posh', needs: ['APIFY_TOKEN'], perCity: true,
  async collect(ctx) {
    const s = ctx.settings;
    // Posh's explore filter takes named time frames; widen to the year when the window runs into next month.
    const when = isoDay(ctx.from).slice(0, 7) === isoDay(ctx.to).slice(0, 7) ? 'This+Month' : 'This+Year';
    return perCity(ctx, 'posh', async c => (await ctx.apify(s.actor, {
      startUrls: [{ url: `https://posh.vip/explore?location=${encodeURIComponent(c.sources.posh)}&lat=${c.lat}&lng=${c.lon}&when=${when}` }],
      maxEvents: s.maxItemsPerCity, scrapeEventDetails: true, eventTimeFilter: 'upcoming', sortBy: 'startDateAsc',
      startsAfter: isoDay(ctx.from), startsBefore: isoDay(ctx.to), proxyConfiguration: { useApifyProxy: true }
    }, { maxItems: s.maxItemsPerCity, maxChargeUsd: s.maxChargeUsdPerRun })).items);
  },
  normalize(it, ctx) {
    // Respect organizers who opted out of third-party listings, and skip drafts and locked events.
    if (it.displayOnThirdPartySites === false || it.isDraft || it.isPasswordProtected) return null;
    const lineupText = (it.lineup || []).map(l => [l.name, l.description].filter(Boolean).join(' ')).join(' | ');
    if (electronicScore(it.name, it.description, lineupText) < 1) return null;
    const open = (it.tickets || []).filter(t => !t.isHidden);
    const soldOut = open.length > 0 && open.every(t => t.closed || t.quantityAvailable === 0);
    return makeEvent(ctx, {
      source: 'posh', sourceName: 'Posh', id: it.eventId || it.url, title: it.name, url: it.url,
      startMs: Date.parse(it.startUtc || it.start), endMs: Date.parse(it.endUtc || it.end), tz: it.timezone,
      venueName: it.venueName, address: it.venueAddress, lat: num(it.latitude), lon: num(it.longitude),
      cityName: it.city, country: it.country, cityHint: it.__city,
      lineup: (it.lineup || []).map(l => l.name), lineupText,
      genres: genresFrom(it.name, it.description, lineupText),
      price: it.isFree ? { min: 0, max: 0, currency: it.currency, free: true } : (num(it.lowestPrice) !== undefined ? { min: num(it.lowestPrice), max: num(it.highestPrice) ?? num(it.lowestPrice), currency: it.currency } : null),
      status: soldOut ? 'soldout' : 'onsale', popularity: num(it.attendingCount),
      promoters: it.organizerName
    });
  }
};

/* ---------------- Partiful ---------------- */
export const partiful = {
  id: 'partiful', label: 'Partiful', needs: ['APIFY_TOKEN'],
  async collect(ctx) {
    const s = ctx.settings, cities = citiesFor(ctx, 'partiful');
    if (!cities.length) return [];
    const { items } = await ctx.apify(s.actor, {
      cities: cities.map(c => c.sources.partiful), maxEventsPerCity: s.maxItemsPerCity, fetchEventDetails: true
    }, { maxItems: s.maxItemsPerCity * cities.length, maxChargeUsd: s.maxChargeUsdPerRun });
    return items;
  },
  normalize(it, ctx) {
    if (it.isPublic === false || (it.visibility && it.visibility !== 'public')) return null;
    if (electronicScore(it.title, it.description) < 1) return null;
    const address = typeof it.location === 'string' ? it.location : pick(it, 'location.address', 'location.name');
    return makeEvent(ctx, {
      source: 'partiful', sourceName: 'Partiful', id: it.id, title: it.title, url: it.url,
      startMs: Date.parse(it.startDate), endMs: Date.parse(it.endDate), tz: it.timezone,
      venueName: address ? String(address).split(',')[0] : undefined, address,
      lat: num(pick(it, 'location.latitude', 'latitude')), lon: num(pick(it, 'location.longitude', 'longitude')),
      cityName: it.city, genres: genresFrom(it.title, it.description),
      status: 'unknown', popularity: num(it.goingCount ?? it.guestCount)
    });
  }
};

/* ---------------- Luma ---------------- */
export const luma = {
  id: 'luma', label: 'Luma', needs: ['APIFY_TOKEN'], perCity: true,
  async collect(ctx) {
    const s = ctx.settings;
    return perCity(ctx, 'luma', async c => (await ctx.apify(s.actor, {
      discoverCity: c.sources.luma, searchQueries: s.queries, category: 'all',
      dateFrom: isoDay(ctx.from), dateTo: isoDay(ctx.to), eventType: 'in_person',
      scrapeEventDetails: true, includeFeaturedGuests: false,
      maxEventsPerUrl: s.maxItemsPerCity, maxResults: s.maxItemsPerCity
    }, { maxItems: s.maxItemsPerCity, maxChargeUsd: s.maxChargeUsdPerRun })).items);
  },
  normalize(it, ctx) {
    const loc = it.location || {};
    if (it.eventType === 'virtual' || loc.isVirtual) return null;
    if (electronicScore(it.name, it.description, (it.categoryNames || []).join(' ')) < 1) return null;
    const t = it.ticketing || {};
    return makeEvent(ctx, {
      source: 'luma', sourceName: 'Luma', id: it.eventId || it.eventUrl, title: it.name, url: it.eventUrl,
      startMs: Date.parse(it.startAt), endMs: Date.parse(it.endAt), tz: it.timezone,
      venueName: loc.name, address: loc.address, lat: num(loc.latitude), lon: num(loc.longitude),
      cityName: loc.city, country: loc.country, cityHint: it.__city,
      genres: genresFrom(it.name, it.description),
      price: t.isFree ? { min: 0, max: 0, currency: t.currency, free: true } : (num(t.minPrice) !== undefined ? { min: num(t.minPrice), max: num(t.maxPrice) ?? num(t.minPrice), currency: t.currency } : null),
      status: t.isSoldOut ? 'soldout' : 'onsale', popularity: num(it.guestCount ?? t.guestCount)
    });
  }
};
