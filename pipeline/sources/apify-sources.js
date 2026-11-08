// Sources scraped through third-party Apify actors. Each one: collect() runs the actor(s),
// normalize() maps one raw item to the shared event shape (or null to drop it).
import { pick, num, isoDay, localToUtc, pool } from '../lib/util.js';
import { makeEvent, genresFrom, electronicScore, parsePrice, fromMinor } from '../lib/normalize.js';

const citiesFor = (ctx, key) => {
  const want = ctx.settings.cities;
  return ctx.cities.filter(c => c.sources && c.sources[key] && (!Array.isArray(want) || want.includes(c.id)));
};
const titleCase = s => String(s).replace(/(^|[\s-])\w/g, m => m.toUpperCase());
const DICE_TAGS = { ukgarage: 'UK Garage', drumandbass: 'Drum & Bass', dnb: 'Drum & Bass', deephouse: 'Deep House', techhouse: 'Tech House', hardtechno: 'Hard Techno', afrohouse: 'Afro House', edm: 'EDM', rnb: 'R&B', hiphop: 'Hip-Hop' };
const diceTag = raw => { const k = String(raw).split(':').pop().toLowerCase(); return DICE_TAGS[k] || titleCase(k); };

/* ---------------- Resident Advisor ---------------- */
export const ra = {
  id: 'ra', label: 'Resident Advisor', needs: ['APIFY_TOKEN'],
  async collect(ctx) {
    const cities = citiesFor(ctx, 'ra');
    if (!cities.length) return [];
    const s = ctx.settings;
    const { items } = await ctx.apify(s.actor, {
      startUrls: cities.map(c => ({ url: c.sources.ra })),
      dateRangeFrom: isoDay(ctx.from), dateRangeTo: isoDay(ctx.to),
      maxItems: s.maxItemsPerCity * cities.length, enforceMaxItems: true, downloadDelay: 1200,
      proxyConfiguration: { useApifyProxy: !!s.useProxy }
    }, { maxItems: s.maxItemsPerCity * cities.length, maxChargeUsd: s.maxChargeUsdPerRun });
    return items;
  },
  normalize(it, ctx) {
    const tz = pick(it, 'area.ianaTimeZone', 'venue.area.ianaTimeZone');
    const lineup = (it.artists || []).map(a => a.name);
    if (!lineup.length && it.lineup) lineup.push(...String(it.lineup).replace(/<[^>]+>/g, '').split(/\n|,/).map(x => x.trim()));
    const genreNames = (it.genres || []).map(g => g.name);
    return makeEvent(ctx, {
      source: 'ra', sourceName: 'Resident Advisor', id: it.id, title: it.title,
      url: it.contentUrl ? 'https://ra.co' + it.contentUrl : undefined,
      startMs: localToUtc(it.startTime || it.date, tz), endMs: localToUtc(it.endTime, tz), tz,
      venueName: it.hasSecretVenue ? 'Secret location' : pick(it, 'venue.name'), address: pick(it, 'venue.address'),
      lat: num(pick(it, 'venue.location.latitude')), lon: num(pick(it, 'venue.location.longitude')),
      cityName: pick(it, 'venue.area.name'), country: pick(it, 'venue.area.country.urlCode'),
      lineup, genres: genresFrom(genreNames, it.title), tags: genreNames,
      price: parsePrice(it.cost), status: 'unknown', popularity: num(it.interestedCount),
      age: it.minimumAge ? it.minimumAge + '+' : undefined, isFestival: !!it.isFestival
    });
  }
};

/* ---------------- DICE ---------------- */
const DICE_ELECTRONIC = /techno|house|electronic|dance|drum|dnb|jungle|garage|disco|trance|dubstep|bass|club|dj|rave|edm|amapiano|afro|breaks|electro|ambient|hardcore/;
export const dice = {
  id: 'dice', label: 'DICE', needs: ['APIFY_TOKEN'],
  async collect(ctx) {
    const s = ctx.settings;
    const runs = await pool(citiesFor(ctx, 'dice'), s.concurrency || 3, async c => {
      try {
        const { items } = await ctx.apify(s.actor, {
          queryType: 'browse', city: c.sources.dice, dateFrom: isoDay(ctx.from), dateTo: isoDay(ctx.to),
          limit: s.maxItemsPerCity, sort: 'date', ...(s.genreTag ? { genreTag: s.genreTag } : {})
        }, { maxItems: s.maxItemsPerCity, maxChargeUsd: s.maxChargeUsdPerRun });
        return items.map(x => ({ ...x, __city: c.id }));
      } catch (err) { ctx.warn(`DICE ${c.name}: ${err.message}`); return []; }
    });
    return runs.flat();
  },
  normalize(it, ctx) {
    const tagText = [...(it.genre_tags || []), ...(it.type_tags || [])].map(t => String(t).split(':').pop()).join(' ').toLowerCase();
    const isElectronic = DICE_ELECTRONIC.test(tagText) || electronicScore(it.name, it.description) >= 1;
    if (!isElectronic) return null;
    const lineupEntries = Array.isArray(it.lineup) ? it.lineup : [];
    const lineup = [...lineupEntries.map(l => typeof l === 'string' ? l : pick(l, 'details', 'name', 'artist')), ...(it.artists || []).map(a => typeof a === 'string' ? a : a.name)].filter(Boolean);
    const sets = lineupEntries
      .map(l => ({ name: pick(l, 'details', 'name', 'artist'), start: pick(l, 'time', 'start') }))
      .filter(x => x.name && x.start && !Number.isNaN(Date.parse(x.start)))
      .map(x => ({ name: x.name, start: new Date(Date.parse(x.start)).toISOString() }));
    let price = null;
    const cur = it.currency;
    if (num(it.price) !== undefined) price = { min: fromMinor(num(it.price), cur), max: fromMinor(num(it.price), cur), currency: cur };
    else if (Array.isArray(it.ticket_types) && it.ticket_types.length) {
      const vals = it.ticket_types.map(t => num(pick(t, 'price.total', 'price.face_value', 'total', 'face_value', 'price'))).filter(v => v !== undefined);
      if (vals.length) price = { min: fromMinor(Math.min(...vals), cur), max: fromMinor(Math.max(...vals), cur), currency: cur };
    }
    const status = it.status === 'cancelled' ? 'cancelled' : it.sold_out ? 'soldout' : it.status === 'off-sale' ? 'offsale' : it.status === 'on-sale' ? 'onsale' : 'unknown';
    const loc = it.location || {};
    const tags = (it.genre_tags || []).map(diceTag);
    return makeEvent(ctx, {
      source: 'dice', sourceName: 'DICE', id: it.id, title: it.name, url: it.url,
      startMs: Date.parse(it.date), endMs: it.date_end ? Date.parse(it.date_end) : undefined, tz: it.timezone,
      venueName: it.venue || pick(it, 'venues.0.name'), address: [loc.street, loc.city].filter(Boolean).join(', '),
      lat: num(pick(loc, 'lat', 'latitude')), lon: num(pick(loc, 'lng', 'long', 'longitude')),
      cityName: loc.city || pick(it, 'cities.0.name'), country: loc.country, cityHint: it.__city,
      lineup, sets, genres: genresFrom(tagText, it.name), tags, price, status, age: it.age_limit
    });
  }
};

/* ---------------- Posh ---------------- */
export const posh = {
  id: 'posh', label: 'Posh', needs: ['APIFY_TOKEN'],
  async collect(ctx) {
    const s = ctx.settings, cities = citiesFor(ctx, 'posh');
    if (!cities.length) return [];
    const { items } = await ctx.apify(s.actor, {
      startUrls: cities.map(c => ({ url: `https://posh.vip/explore?location=${encodeURIComponent(c.sources.posh)}&lat=${c.lat}&lng=${c.lon}&when=This+Month` })),
      maxEvents: s.maxItemsPerCity * cities.length, scrapeEventDetails: true, eventTimeFilter: 'upcoming', sortBy: 'startDateAsc',
      startsAfter: isoDay(ctx.from), startsBefore: isoDay(ctx.to), proxyConfiguration: { useApifyProxy: true }
    }, { maxItems: s.maxItemsPerCity * cities.length, maxChargeUsd: s.maxChargeUsdPerRun });
    return items;
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
      cityName: it.city, country: it.country,
      lineup: (it.lineup || []).map(l => l.name), lineupText,
      genres: genresFrom(it.name, it.description, lineupText),
      price: it.isFree ? { min: 0, max: 0, currency: it.currency, free: true } : (num(it.lowestPrice) !== undefined ? { min: num(it.lowestPrice), max: num(it.highestPrice) ?? num(it.lowestPrice), currency: it.currency } : null),
      status: soldOut ? 'soldout' : 'onsale', popularity: num(it.attendingCount)
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
  id: 'luma', label: 'Luma', needs: ['APIFY_TOKEN'],
  async collect(ctx) {
    const s = ctx.settings;
    const runs = await pool(citiesFor(ctx, 'luma'), s.concurrency || 3, async c => {
      try {
        const { items } = await ctx.apify(s.actor, {
          discoverCity: c.sources.luma, searchQueries: s.queries, category: 'all',
          dateFrom: isoDay(ctx.from), dateTo: isoDay(ctx.to), eventType: 'in_person',
          scrapeEventDetails: true, includeFeaturedGuests: false,
          maxEventsPerUrl: s.maxItemsPerCity, maxResults: s.maxItemsPerCity
        }, { maxItems: s.maxItemsPerCity, maxChargeUsd: s.maxChargeUsdPerRun });
        return items.map(x => ({ ...x, __city: c.id }));
      } catch (err) { ctx.warn(`Luma ${c.name}: ${err.message}`); return []; }
    });
    return runs.flat();
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
