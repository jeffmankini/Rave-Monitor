(function () {
  'use strict';
  const RM = RMData;
  const HOUR = RM.HOUR, DAY = RM.DAY;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FONT = '"Archivo", "Helvetica Neue", Arial, sans-serif';
  // Google Analytics events, only when the build added the tag (config/site.json). Consent is the
  // consent tool's job; the tag holds events back until it allows them.
  function track(name, params) {
    try { if (window.RM_GA && typeof window.gtag === 'function') window.gtag('event', name, params || {}); } catch (err) { /* analytics must never break the page */ }
  }
  const cut = (str, n) => String(str == null ? '' : str).slice(0, n || 100);
  // What an event-related hit says about the event (all public listing details, nothing about the visitor).
  function eventParams(e) {
    return { event_title: cut(e.title), city: cut(S.ds.cityById[e.cityId].name), listing_source: cut(e.src || ''), genre: (RM.GENRE[e.genre] || RM.OTHER).name,
      event_type: e.type || 'club', days_ahead: Math.max(0, Math.floor((e.start - Date.now()) / 864e5)) };
  }

  /* ---------- state ---------- */
  const S = {
    now: Date.now(), win: '24h', genres: new Set(), view: 'map',
    layers: { belt: true, heat: true, fest: true, tours: false, labels: true, streets: true },
    sel: null, route: null, mode: null, tab: { right: 'listings', single: 'listings' }, liveAll: false, listAll: false, ds: null,
    // Lists follow the map once you zoom in: area is the set of venue ids in view, or null.
    area: null, areaOn: false,
    // A record label or promoter to filter by: { key, name, kind: 'label' | 'promoter' }, or null.
    label: null,
    // The visitor's position, only after they press Near me (or allowed it before): { lat, lon }. Never sent anywhere.
    me: null,
    streams: [], streamFile: null, streamsAt: 0, ntsLive: null, streamsTried: false
  };
  const D = {};

  const city = e => S.ds.cityById[e.cityId];
  const venue = e => S.ds.venueById[e.venueId];
  const gen = e => RM.GENRE[e.genre] || RM.OTHER;
  const artist = id => S.ds.artistById[id];
  // Label and promoter names compare without case, accents, apostrophes or punctuation, & as 'and'.
  const lkey = s => norm(s).replace(/['’‘`´]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const labelsOf = e => (e.labels || []).concat(e.promoters || []);
  const hasLabel = e => labelsOf(e).some(n => lkey(n) === S.label.key);

  /* ---------- formatting ---------- */
  const fmtCache = {};
  function F(tz, o) {
    const k = (tz || '') + JSON.stringify(o);
    if (!fmtCache[k]) { const opts = Object.assign({}, o); if (tz) opts.timeZone = tz; fmtCache[k] = new Intl.DateTimeFormat(undefined, opts); }
    return fmtCache[k];
  }
  const tTime = (ms, tz) => F(tz, { hour: 'numeric', minute: '2-digit' }).format(ms);
  const tDay = (ms, tz) => F(tz, { weekday: 'short' }).format(ms);
  const tDate = (ms, tz) => F(tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
  const nf = new Intl.NumberFormat();
  const fmtN = n => nf.format(Math.round(n));
  const curCache = {};
  function money(v, cur) {
    try { return (curCache[cur] || (curCache[cur] = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }))).format(v); }
    catch (err) { return Math.round(v) + ' ' + cur; }
  }
  function dur(ms) {
    const m = Math.max(0, Math.round(Math.abs(ms) / 60000));
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return h + 'h' + (mm ? ' ' + mm + 'm' : '');
    const d = Math.floor(h / 24);
    return d + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
  }
  function ago(ts) { const m = Math.round((S.now - ts) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm ago' : Math.floor(m / 60) + 'h ago'; }
  function rel(e) {
    const t = S.now;
    if (RM.isLive(e, t)) return 'ends in ' + dur(e.end - t);
    if (e.start > t) return 'in ' + dur(e.start - t);
    return 'ended';
  }
  function priceText(e) {
    if (e.free) return 'Free entry';
    if (e.door) return 'Pay on the door';
    if (!e.priceMax) return 'See ticket site';
    return e.priceMin === e.priceMax ? money(e.priceMin, e.cur) : money(e.priceMin, e.cur) + ' to ' + money(e.priceMax, e.cur);
  }
  const plural = (n, one, many) => fmtN(n) + ' ' + (n === 1 ? one : many);
  const WIN_LABEL = { live: 'live now', '24h': 'in the next 24 hours', weekend: 'this weekend', '7d': 'in the next 7 days', '14d': 'in the next 14 days', '30d': 'in the next 30 days' };
  function lineupNames(e, max) {
    const ids = e.heads.concat(e.support);
    const names = ids.map(id => artist(id)).filter(Boolean).map(a => a.name);
    const shown = names.slice(0, max || 3);
    return shown.join(', ') + (names.length > shown.length ? ' +' + (names.length - shown.length) : '');
  }
  function statusChip(e) {
    const t = S.now;
    if (e.extStatus === 'cancelled') return '<span class="st st-crit"><i></i>Cancelled</span>';
    if (e.extStatus === 'postponed') return '<span class="st st-warn"><i></i>Postponed</span>';
    if (RM.isLive(e, t)) return '<span class="st st-live"><i></i>Live</span>';
    if (e.extStatus === 'unknown') return '';
    if (e.extStatus === 'offsale') return '<span class="st"><i></i>Off sale</span>';
    const st = RM.statusAt(e, t);
    const m = { soldout: ['st-crit', 'Sold out'], final: ['st-warn', 'Final release'], onsale: ['st-good', 'On sale'], door: ['', 'Door only'], free: ['', 'Free entry'] }[st];
    return '<span class="st ' + m[0] + '"><i></i>' + m[1] + '</span>';
  }
  function statusWord(e) {
    if (e.extStatus === 'unknown') return 'See listing';
    if (e.extStatus === 'cancelled') return 'Cancelled';
    if (e.extStatus === 'postponed') return 'Postponed';
    if (e.extStatus === 'offsale') return 'Off sale';
    const st = RM.statusAt(e, S.now);
    return { soldout: 'Sold out', final: 'Final release', onsale: 'On sale', door: 'Door only', free: 'Free entry' }[st];
  }

  /* ---------- derived data ---------- */
  function derive() {
    // A label filter narrows everything to that label's nights; Peakcon stays the whole scene's.
    const ds = S.label ? Object.assign({}, S.ds, { events: S.ds.events.filter(hasLabel) }) : S.ds, t = S.now, g = S.genres;
    D.ds = ds;
    D.win = ds.events.filter(e => RM.inWindow(e, ds, t, S.win) && RM.inGenres(e, g));
    D.live = ds.events.filter(e => RM.isLive(e, t) && RM.inGenres(e, g));
    D.byCity = new Map();
    D.win.slice().sort((a, b) => (RM.isLive(b, t) - RM.isLive(a, t)) || (RM.importance(b, t) - RM.importance(a, t))).forEach(e => {
      if (!D.byCity.has(e.cityId)) D.byCity.set(e.cityId, []);
      D.byCity.get(e.cityId).push(e);
    });
    D.peak = RM.peakcon(S.ds, t);
    D.wire = RM.wire(ds, t, g);
    if (ds.source !== 'demo') D.wire = D.wire.filter(w => w.type === 'doors');
    D.heat = RM.heatIndex(ds, t, g);
    D.genres = RM.genreIndex(ds, t);
    D.surges = ds.source === 'demo' ? RM.surges(ds, t) : [];
    D.soon = ds.events.filter(e => e.start > t && e.start <= t + 3 * HOUR && RM.inGenres(e, g));
    const tours = [];
    ds.artists.forEach(a => {
      if (a.tier !== 1) return;
      const gigs = D.win.filter(e => e.heads.indexOf(a.id) >= 0).sort((x, y) => x.start - y.start);
      for (let i = 1; i < gigs.length; i++) {
        if (gigs[i].cityId === gigs[i - 1].cityId) continue;
        const v1 = venue(gigs[i - 1]), v2 = venue(gigs[i]);
        tours.push([[v1.lon, v1.lat], [v2.lon, v2.lat]]);
      }
    });
    D.tours = tours;
    deriveLists();
  }
  // What the lists show: everything, or only what's inside the map once you've zoomed in.
  // The map itself always draws everything (D.*); the lists read D.L.
  function deriveLists() {
    const ds = D.ds, t = S.now, A = S.area;
    if (!A) { D.L = { area: false, live: D.live, soon: D.soon, win: D.win, wire: D.wire, heat: D.heat, genres: D.genres, surges: D.surges, events: ds.events, cities: D.byCity.size }; return; }
    const inA = e => A.has(e.venueId);
    const events = ds.events.filter(inA), view = Object.assign({}, ds, { events: events });
    const win = D.win.filter(inA);
    D.L = {
      area: true, live: D.live.filter(inA), soon: D.soon.filter(inA), win: win, wire: D.wire.filter(w => inA(w.e)),
      heat: RM.heatIndex(view, t, S.genres), genres: RM.genreIndex(view, t), surges: ds.source === 'demo' ? RM.surges(view, t) : [],
      events: events, cities: new Set(win.map(e => e.cityId)).size
    };
  }
  function areaBar() {
    if (!D.L.area) return '';
    return '<div class="areabar"><span>Showing the map area only</span><button type="button" data-act="area-all" aria-label="Zoom out and show listings everywhere">Show everywhere</button></div>';
  }
  /** Called by the map when the area in view changes (null: not zoomed in, so lists show everything). */
  function areaChanged(ids) {
    const entering = ids && !S.area;
    S.area = ids; S.listAll = false;
    deriveLists();
    renderAll();
    if (entering && D.L.win.length) {
      const top = RM.cityCounts(D.L.win)[0];
      track('view_map_area', { city: cut(top ? S.ds.cityById[top.id].name : ''), listings: D.L.win.length });
    }
  }
  // The consent tool's settings (Usercentrics: version 3 API, or version 2's UC_UI).
  function privacySettings() {
    const d = $('#about');
    if (d && d.open) { if (d.close) d.close(); else d.removeAttribute('open'); } // a modal dialog would sit on top of it
    try {
      if (window.__ucCmp && typeof window.__ucCmp.showSecondLayer === 'function') window.__ucCmp.showSecondLayer();
      else if (window.UC_UI && typeof window.UC_UI.showSecondLayer === 'function') window.UC_UI.showSecondLayer();
    } catch (err) { /* the consent tool isn't loaded */ }
  }
  function routeGigs(aid) {
    return S.ds.events.filter(e => e.end > S.now && (e.heads.indexOf(aid) >= 0 || e.support.indexOf(aid) >= 0)).sort((a, b) => a.start - b.start).slice(0, 12);
  }

  /* ---------- panels ---------- */
  const PANELS = {
    live: { label: 'Live now', render: renderLive },
    heat: { label: 'Scene heat', render: renderHeat },
    listings: { label: 'Listings', render: renderListings },
    wire: { label: 'Wire', render: renderWire },
    genres: { label: 'Genres', render: renderGenres },
    streams: { label: 'Streams', render: renderStreams },
    sellouts: { label: 'Sellouts', render: renderSellouts },
    peakcon: { label: 'Peakcon', render: renderPeakcon },
    surges: { label: 'Surges', render: renderSurges }
  };
  function buildPanels() {
    Object.keys(PANELS).forEach(id => {
      const sec = document.createElement('section');
      sec.className = 'panel'; sec.id = 'p-' + id;
      sec.innerHTML = '<header class="ph"><h2 id="h-' + id + '">' + PANELS[id].label + '</h2><span class="meta" id="m-' + id + '"></span></header><div class="pb" id="b-' + id + '"></div>';
      PANELS[id].el = sec;
    });
  }
  const body = id => PANELS[id].el.querySelector('.pb');
  const meta = (id, txt) => { const m = PANELS[id].el.querySelector('.meta'); if (m) m.textContent = txt || ''; };

  function eventRow(e) {
    const c = city(e), v = venue(e), G = gen(e);
    const names = lineupNames(e, 3);
    return '<li class="erow" data-ev="' + esc(e.id) + '" tabindex="0" role="button">' +
      '<div class="when"><b>' + tTime(e.start, c.tz) + '</b><span>' + tDay(e.start, c.tz) + '</span></div>' +
      '<div class="what"><span class="title">' + esc(e.title) + '</span>' +
      '<div class="sub"><span>' + esc(v.name) + ', ' + esc(c.name) + '</span></div>' +
      '<div class="sub2">' + (names ? '<span>' + esc(names) + '</span>' : '') + '<span>' + rel(e) + '</span></div></div>' +
      '<div class="side">' + statusChip(e) + '<i class="gdot" style="--c:' + G.color + '" title="' + esc(G.name) + '"></i></div></li>';
  }

  /* ---------- listings: every listing in the time window (the map area once zoomed in), by night ---------- */
  // A night runs 6 am to 6 am local time, so a party starting at 1 am Sunday belongs to Saturday night.
  const NIGHT_SHIFT = 6 * HOUR;
  function nightKey(ms, tz) {
    const p = {};
    F(tz, { year: 'numeric', month: '2-digit', day: '2-digit', numberingSystem: 'latn' }).formatToParts(ms - NIGHT_SHIFT).forEach(x => { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day;
  }
  function nightLabel(ms, tz) {
    const k = nightKey(ms, tz), now = S.now;
    const name = F(tz, { weekday: 'long', day: 'numeric', month: 'long' }).format(ms - NIGHT_SHIFT);
    return k === nightKey(now, tz) ? 'Tonight · ' + name : k === nightKey(now + DAY, tz) ? 'Tomorrow · ' + name : name;
  }
  // Lineup entries that aren't artists: 'TBA', 'SECRET DJ LINE UP', 'special guests', 'residents'.
  const NOT_NAMES = /\b(tba|tbc|tbd|to be announced|line ?-?up|secret|special guests?|surprise|various artists|more acts|and more|residents?|guest djs?)\b|^\+ ?more$|^(guests?|various)$/i;
  function genreText(e) {
    const tags = (e.tags || []).filter(x => x && x.length < 24).slice(0, 2);
    if (tags.length) return tags.join(', ');
    return [e.genre].concat(e.festGenres || []).filter((g, i, a) => RM.GENRE[g] && a.indexOf(g) === i).slice(0, 2).map(g => RM.GENRE[g].name).join(', ');
  }
  function listRow(e) {
    const c = city(e), v = venue(e), G = gen(e), names = lineupNames(e, 4), gt = genreText(e);
    const price = e.free ? 'Free' : e.priceMax ? (e.priceMin && e.priceMin !== e.priceMax ? money(e.priceMin, e.cur) + '+' : money(e.priceMax, e.cur)) : '';
    return '<li class="erow lrow" data-ev="' + esc(e.id) + '" tabindex="0" role="button">' +
      '<div class="when"><b>' + tTime(e.start, c.tz) + '</b><span>' + tDay(e.start, c.tz) + '</span></div>' +
      '<div class="what"><span class="title">' + esc(e.title) + '</span>' +
      '<div class="sub"><span>' + esc(v.name) + ', ' + esc(c.name) + '</span></div>' +
      (names ? '<div class="sub2 lineup"><span>' + esc(names) + '</span></div>' : '') +
      '<div class="sub2">' + (gt ? '<span class="gtag" style="--c:' + G.color + '">' + esc(gt) + '</span>' : '') + (e.labels && e.labels.length ? '<span class="ltag">' + esc(e.labels[0]) + '</span>' : '') + (price ? '<span>' + esc(price) + '</span>' : '') + '</div></div>' +
      '<div class="side">' + statusChip(e) + '</div></li>';
  }
  function listingsBrief(list) {
    const nights = {}, fam = {}, who = {};
    list.forEach(e => {
      const c = city(e), k = nightKey(e.start, c.tz);
      (nights[k] || (nights[k] = { n: 0, ms: e.start, tz: c.tz })).n++;
      fam[e.genre] = (fam[e.genre] || 0) + 1;
      new Set(e.heads.concat(e.support).map(id => artist(id)).filter(a => a && !NOT_NAMES.test(a.name.trim())).map(a => a.name)).forEach(n => { who[n] = (who[n] || 0) + 1; });
    });
    const top = (obj, n) => Object.keys(obj).sort((a, b) => obj[b] - obj[a]).slice(0, n);
    const txt = '<b>' + plural(list.length, 'listing', 'listings') + '</b>' + (S.label ? ' for ' + esc(S.label.name) : '') + ' ' + WIN_LABEL[S.win] + (D.L.area ? ' in this area' : '') + '.' +
      (D.L.area && S.mode === 'narrow' ? ' <button type="button" class="linkish" data-act="area-all">Show everywhere</button>' : '');
    let more = '';
    const busiest = top(Object.fromEntries(Object.entries(nights).map(([k, v]) => [k, v.n])), 2);
    if (Object.keys(nights).length > 2) more += ' Busiest nights: ' + busiest.map(k => F(nights[k].tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(nights[k].ms - NIGHT_SHIFT) + ' (' + nights[k].n + ')').join(', ') + '.';
    const artists = top(who, 3).filter(n => who[n] > 1);
    if (artists.length) more += ' Playing more than once: ' + artists.map(n => esc(n) + ' (' + who[n] + ')').join(', ') + '.';
    const genres = top(fam, 4).filter(g => RM.GENRE[g]);
    if (genres.length) more += '<span class="gline">' + genres.map(g => '<span class="gtag" style="--c:' + RM.GENRE[g].color + '">' + esc(RM.GENRE[g].name) + ' ' + fmtN(fam[g]) + '</span>').join('') + '</span>';
    if (!more) return txt;
    // Phones: the busiest nights, repeat names and genres fold away under one line.
    return S.mode === 'narrow' ? txt + '<details class="brief-more"' + (S.briefOpen ? ' open' : '') + '><summary>Busiest nights and genres</summary>' + more + '</details>' : txt + more;
  }
  function renderListings() {
    const list = D.L.win.slice().sort((a, b) => {
      const ka = nightKey(a.start, city(a).tz), kb = nightKey(b.start, city(b).tz);
      return ka < kb ? -1 : ka > kb ? 1 : a.start - b.start;
    });
    if (!list.length) {
      body('listings').innerHTML = areaBar() + '<p class="fine">No listings ' + (S.label ? 'for ' + esc(S.label.name) + ' ' : '') + WIN_LABEL[S.win] + (D.L.area ? ' in this area' : '') + (S.genres.size ? ' for this genre filter' : '') + '. Try a longer time window' + (D.L.area ? ' or zoom out' : '') + '.' +
        (S.label ? ' Past nights may be in the <a href="' + archiveLabelUrl(S.label.name) + '" style="color:inherit">archive</a>.' : '') + '</p>';
      meta('listings', ''); return;
    }
    const n = S.listAll ? list.length : Math.min(list.length, 120);
    let html = (S.mode === 'narrow' ? '' : areaBar()) + '<div class="brief">' + listingsBrief(list) + '</div>', night = '';
    list.slice(0, n).forEach(e => {
      const c = city(e), k = nightKey(e.start, c.tz);
      if (k !== night) { html += (night ? '</ol>' : '') + '<h3 class="nighthead">' + esc(nightLabel(e.start, c.tz)) + '</h3><ol class="rows">'; night = k; }
      html += listRow(e);
    });
    body('listings').innerHTML = html + '</ol>' + (list.length > n ? '<button class="more" type="button" data-act="list-all">Show all ' + fmtN(list.length) + '</button>' : '') +
      '<p class="fine">Looking for nights that already happened? <a href="/archive/" style="color:inherit">Search the archive</a>.</p>';
    meta('listings', fmtN(list.length) + (D.L.area ? ' in view' : ''));
  }

  function briefHTML() {
    const t = S.now, live = D.L.live, ds = S.ds, area = D.L.area, here = area ? ' in this area' : '';
    const gl = S.genres.size ? ' ' + Array.from(S.genres).map(g => RM.GENRE[g].name.toLowerCase()).join(' and ') : '';
    if (!live.length) {
      const next = D.L.events.filter(e => e.start > t && RM.inGenres(e, S.genres))[0];
      return 'No' + gl + ' parties are live' + here + ' right now.' + (next ? ' Next doors: <b>' + esc(next.title) + '</b> in ' + esc(city(next).name) + ' at ' + tTime(next.start, city(next).tz) + ' local time.' : '');
    }
    const regions = RM.regionCounts(live, ds), top = regions[0];
    const cities = RM.cityCounts(area ? live : live.filter(e => ds.cityById[e.cityId].region === top.id)).slice(0, 2).map(x => esc(ds.cityById[x.id].name) + ' (' + x.n + ')');
    let s = '<b>' + plural(live.length, gl.trim() ? gl.trim() + ' party is' : 'party is', (gl ? gl.trim() + ' ' : '') + 'parties are').replace(/^(\d[\d,]*) /, '$1</b> ') + ' live' + here + ' right now. ' +
      (area ? 'Busiest: ' + cities.join(' and ') + '.' : esc(top.name) + ' is carrying the night, led by ' + cities.join(' and ') + '.');
    const soonReg = area ? null : RM.regionCounts(D.soon, ds)[0];
    if (area && D.L.soon.length) s += ' ' + plural(D.L.soon.length, 'more party opens', 'more parties open') + ' here in the next three hours.';
    if (soonReg && soonReg.id !== top.id) {
      const sc = RM.cityCounts(D.soon.filter(e => ds.cityById[e.cityId].region === soonReg.id)).slice(0, 2).map(x => esc(ds.cityById[x.id].name));
      s += ' Next wave: ' + esc(soonReg.name) + ', where ' + plural(soonReg.n, 'party opens', 'parties open') + ' in the next three hours, led by ' + sc.join(' and ') + '.';
    }
    const big = live.reduce((a, b) => (b.cap * RM.fillAt(b, t) > a.cap * RM.fillAt(a, t) ? b : a));
    s += ' Biggest room: <b>' + esc(big.title) + '</b> at ' + esc(venue(big).name) + ', ' + esc(city(big).name) + '.';
    return s;
  }

  function renderLive() {
    const t = S.now, live = D.L.live.slice().sort((a, b) => RM.importance(b, t) - RM.importance(a, t));
    const n = S.liveAll ? live.length : Math.min(live.length, 25);
    body('live').innerHTML = areaBar() + '<p class="brief">' + briefHTML() + '</p>' +
      (live.length ? '<ol class="rows">' + live.slice(0, n).map(eventRow).join('') + '</ol>' : '') +
      (live.length > n ? '<button class="more" type="button" data-act="live-all">Show all ' + fmtN(live.length) + '</button>' : '');
    meta('live', fmtN(live.length) + ' live' + (D.L.area ? ' here' : ''));
  }

  function renderHeat() {
    const rows = D.L.heat.slice(0, 30);
    const fmtChg = c => c == null ? 'new' : (c >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(c * 100)) + '%';
    if (!rows.length) { body('heat').innerHTML = areaBar() + '<p class="fine">No events in the next 72 hours ' + (D.L.area ? 'in this area' : 'for this filter') + '.</p>'; meta('heat', 'next 72 hours'); return; }
    body('heat').innerHTML = areaBar() + '<div class="hhead" aria-hidden="true"><span></span><span>City</span><span>Heat</span><span>vs last wk</span><span>7 nights</span></div><ol class="rows">' +
      rows.map((h, i) => {
        const mx = Math.max(1, Math.max.apply(null, h.nights));
        const bars = h.nights.map((v, j) => '<i class="' + (j === 0 ? 'tonight' : '') + '" style="height:' + Math.max(6, Math.round(v / mx * 100)) + '%"></i>').join('');
        return '<li class="hrow" data-city="' + h.city.id + '" tabindex="0" role="button" aria-label="' + esc(h.city.name) + ', heat ' + h.heat + '">' +
          '<span class="rank">' + (i + 1) + '</span>' +
          '<span class="hname"><b>' + esc(h.city.name) + '</b><small>' + (h.live ? h.live + ' live now' : esc(RM.REGIONS[h.city.region] || '')) + '</small></span>' +
          '<span class="hbar"><i style="width:' + h.heat + '%"></i><em>' + h.heat + '</em></span>' +
          '<span class="chg">' + fmtChg(h.change) + '</span>' +
          '<span class="nights" title="Events per night, starting tonight: ' + h.nights.join(', ') + '">' + bars + '</span></li>';
      }).join('') + '</ol><p class="fine">Heat scores the next 72 hours by room size, demand and headliner pull. 100 is the busiest city' + (D.L.area ? ' in view' : '') + '.</p>';
    meta('heat', 'next 72 hours');
  }

  const WIRE_TYPE = {
    lineup: 'Lineup', sets: 'Set times', soldout: 'Sold out', final: 'Final release', doors: 'Doors open',
    stream: 'Livestream', moved: 'Venue change', extended: 'Extended'
  };
  function wireText(w) {
    const e = w.e, c = city(e), v = venue(e);
    switch (w.type) {
      case 'lineup': return 'Lineup out for ' + e.title + ', ' + tDate(e.start, c.tz);
      case 'sets': return 'Set times posted for ' + e.title;
      case 'soldout': return e.title + ' sold out';
      case 'final': return 'Final release tickets on sale for ' + e.title;
      case 'doors': return 'Doors open: ' + e.title;
      case 'stream': return 'Livestream running from ' + e.title;
      case 'moved': return e.title + ' moved to ' + v.name;
      case 'extended': return e.title + ' extended until ' + tTime(e.end, c.tz);
    }
    return e.title;
  }
  function renderWire() {
    const items = D.L.wire.slice(0, 90);
    body('wire').innerHTML = areaBar() + (items.length ? '<ol class="rows">' + items.map(w => {
      const c = city(w.e), v = venue(w.e);
      return '<li class="wrow" data-ev="' + esc(w.e.id) + '" tabindex="0" role="button"><time>' + ago(w.ts) + '</time><div>' +
        '<span class="wtype t-' + w.type + '"><i></i>' + WIRE_TYPE[w.type] + '</span><p>' + esc(wireText(w)) + '</p><small>' + esc(v.name) + ', ' + esc(c.name) + '</small></div></li>';
    }).join('') + '</ol>' : '<p class="fine">Nothing on the wire ' + (D.L.area ? 'in this area' : 'for this filter') + ' yet.</p>');
    meta('wire', S.ds.source === 'demo' ? 'last 36 hours' : 'doors from live listings');
  }

  function spark(vals, iNow) {
    const w = 96, h = 28, max = Math.max(1, Math.max.apply(null, vals));
    const x = i => 2 + (i / (vals.length - 1)) * (w - 4), y = v => h - 3 - (v / max) * (h - 8);
    const pts = (a, off) => a.map((v, i) => (i ? 'L' : 'M') + x(i + off).toFixed(1) + ',' + y(v).toFixed(1)).join('');
    const past = pts(vals.slice(0, iNow + 1), 0), fut = pts(vals.slice(iNow), iNow);
    const area = past + 'L' + x(iNow).toFixed(1) + ',' + (h - 3) + 'L2,' + (h - 3) + 'Z';
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><path d="M2,' + (h - 2.5) + 'H' + (w - 2) + '" stroke="#1f2547" stroke-width="1"/>' +
      '<path d="' + area + '" fill="#a9abcb" opacity=".16"/><path d="' + past + '" fill="none" stroke="#a9abcb" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="' + fut + '" fill="none" stroke="#a9abcb" stroke-width="1.5" stroke-dasharray="2 2.5"/>' +
      '<circle cx="' + x(iNow).toFixed(1) + '" cy="' + y(vals[iNow]).toFixed(1) + '" r="2.6" fill="#f6ecd8" stroke="#0c0f22" stroke-width="1.5"/></svg>';
  }
  function renderGenres() {
    const fmtChg = c => c == null ? '' : (c >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(c * 100)) + '%';
    body('genres').innerHTML = areaBar() + '<div class="ghead" aria-hidden="true"><span>Genre</span><span>Next 7d</span><span>vs last</span><span>Daily, past and coming week</span></div><ol class="rows">' +
      D.L.genres.map(r => '<li class="grow" data-genre="' + r.genre.id + '" tabindex="0" role="button" aria-pressed="' + S.genres.has(r.genre.id) + '" aria-label="Filter to ' + esc(r.genre.name) + '">' +
        '<span class="gname"><i class="gdot" style="--c:' + r.genre.color + '"></i><b>' + esc(r.genre.name) + '</b><small>' + (r.genre.bpm !== 'varies' ? r.genre.bpm + ' BPM, ' : '') + Math.round(r.share * 100) + '% of listings</small></span>' +
        '<span class="gnum"><b>' + fmtN(r.next) + '</b><small>events</small></span>' +
        '<span class="chg">' + fmtChg(r.change) + '</span>' + spark(r.daily, 7) + '</li>').join('') +
      '</ol><p class="fine">Solid line: listings from the past 7 days. Dashed: what is booked for the next 7. Select a genre to filter the map.</p>';
    meta('genres', 'like a ticker, for scenes');
  }

  /* ---------- livestreams: streams.json from the pipeline, plus NTS's live list read in the browser ---------- */
  // The pipeline's genre rules (pipeline/lib/normalize.js), for NTS shows the browser reads itself.
  const FAM_RULES = [
    ['afro', /\b(amapiano|afro ?house|afro ?tech|gqom|baile funk|3 ?step)\b/],
    ['bass', /\b(dubstep|riddim|bass house|bass music|future bass|grime|wave music|halftime)\b/],
    ['dnb', /\b(drum ?(?:&|and|n) ?bass|dnb|d&b|d ?n ?b|jungle|liquid funk|neurofunk|jump ?up)\b/],
    ['garage', /\b(uk ?g(?:arage)?|ukg|speed garage|2[- ]?step|garage|breakbeat|breaks|electro|bassline)\b/],
    ['trance', /\b(psytrance|psy[- ]?trance|goa trance|trance|hard ?style|hard ?dance|hardcore|gabber)\b/],
    ['disco', /\b(nu[- ]?disco|disco|italo|balearic|edits|cosmic)\b/],
    ['techno', /\b(techno|hard groove|acid|industrial|ebm|hypnotic|peak[- ]?time)\b/],
    ['house', /\b(tech ?house|deep house|house music|house|minimal|lo-?fi house|progressive house|jackin)\b/]
  ];
  function famsFrom(texts) {
    let rest = norm(texts.join(' | '));
    const out = [];
    FAM_RULES.forEach(r => { if (r[1].test(rest)) { out.push(r[0]); rest = rest.replace(new RegExp(r[1].source, 'g'), ' '); } });
    return out;
  }
  const NTS_CLUB = ['housetechno', 'ukdance', 'newclub', 'discoboogie', 'electronicadowntempo'];
  const unent = str => { const d = document.createElement('textarea'); d.innerHTML = String(str || ''); return d.value; };
  function ntsSlot(ch, b) {
    const raw = unent(b.broadcast_title).trim(), d = b.embeds && b.embeds.details;
    const href = (b.links || []).map(l => l && l.href).find(h => /\/shows\/[^/]+\/episodes\//.test(h || ''));
    const m = href && href.match(/\/shows\/([^/?#]+)\/episodes\/([^/?#]+)/);
    const known = !!(d && d.genres && d.genres.length);
    const club = known ? d.genres.filter(x => NTS_CLUB.indexOf(String(x.id).replace(/^genres-/, '').split('-')[0]) >= 0) : [];
    return {
      id: 'nts:' + ch + ':' + b.start_timestamp, platform: 'NTS', kind: 'radio', channel: 'NTS ' + ch,
      title: raw.replace(/\s*\(R\)\s*$/i, ''), rerun: /\(R\)\s*$/i.test(raw), start: b.start_timestamp, end: b.end_timestamp,
      url: m ? 'https://www.nts.live/shows/' + m[1] + '/episodes/' + m[2] : 'https://www.nts.live/',
      genres: known ? famsFrom(club.map(x => unent(x.value))) : null, club: known ? club.length > 0 : null,
      tags: known ? d.genres.map(x => unent(x.value).trim()).slice(0, 4) : [], location: d && d.location_long ? unent(d.location_long) : null
    };
  }
  async function getJson(url, ms) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    try { const res = await fetch(url, { cache: 'no-store', signal: ctl.signal }); return res.ok ? await res.json() : null; }
    finally { clearTimeout(timer); }
  }
  async function loadStreamFile() {
    try { const j = await getJson('streams.json', 5000); if (j && Array.isArray(j.streams)) { S.streamFile = j; S.streamsAt = Date.parse(j.generatedAt) || 0; } }
    catch (err) { /* no streams file yet */ }
  }
  async function loadNtsLive() {
    try {
      const j = await getJson('https://www.nts.live/api/v2/live', 6000), out = [];
      ((j && j.results) || []).forEach(ch => Object.keys(ch).forEach(k => {
        const b = ch[k];
        if (/^(now|next\d*)$/.test(k) && b && b.start_timestamp && b.end_timestamp) out.push(ntsSlot(String(ch.channel_name), b));
      }));
      if (out.length) S.ntsLive = out;
    } catch (err) { /* NTS unreachable: the pipeline's copy of the schedule stands */ }
  }
  function mergeStreams() {
    const map = new Map();
    ((S.streamFile && S.streamFile.streams) || []).forEach(x => map.set(x.id, x));
    if (S.ntsLive) {
      // The browser's copy of NTS is newer, so it decides which shows exist in the hours it covers.
      // Later shows keep the genres the pipeline looked up.
      const starts = S.ntsLive.map(x => Date.parse(x.start)), from = Math.min.apply(null, starts), to = Math.max.apply(null, starts);
      const fresh = new Set(S.ntsLive.map(x => x.id));
      map.forEach((x, id) => { const t0 = Date.parse(x.start); if (x.platform === 'NTS' && t0 >= from && t0 <= to && !fresh.has(id)) map.delete(id); });
      S.ntsLive.forEach(x => {
        const old = map.get(x.id);
        map.set(x.id, old && x.genres == null ? Object.assign({}, x, { genres: old.genres, club: old.club, tags: old.tags, location: x.location || old.location }) : x);
      });
    }
    S.streams = Array.from(map.values()).map(x => Object.assign({}, x, { t0: Date.parse(x.start), t1: x.end ? Date.parse(x.end) : NaN }))
      .filter(x => isFinite(x.t0)).sort((a, b) => a.t0 - b.t0);
  }
  async function refreshStreams(withFile) {
    await Promise.all([withFile ? loadStreamFile() : null, loadNtsLive()]);
    S.streamsTried = true;
    mergeStreams();
    renderStreams();
  }
  function streamState(x, t) {
    if (x.kind === 'radio') return t >= x.t1 ? 'past' : x.t0 <= t ? 'live' : 'soon';
    // YouTube: live when last checked (a few hours ago at most). A scheduled stream past its start
    // time is 'due': it may well be live by now, but the last check didn't see it start.
    if (x.status === 'live') return t - S.streamsAt < 4 * HOUR ? 'live' : 'past';
    if (x.t0 > t) return 'soon';
    return t - x.t0 < 12 * HOUR ? 'due' : 'past';
  }
  function streamRow(x, st) {
    const radio = x.kind === 'radio', G = x.genres && x.genres.length ? RM.GENRE[x.genres[0]] : null;
    const bits = [];
    if (x.tags && x.tags.length) bits.push(x.tags.slice(0, 3).join(', '));
    if (x.rerun) bits.push('Repeat');
    if (st === 'live') bits.push(radio ? 'until ' + tTime(x.t1) : x.viewers ? fmtN(x.viewers) + ' watching' : 'since ' + tTime(x.t0));
    else if (st === 'due') bits.push('scheduled for ' + tTime(x.t0));
    else bits.push('in ' + dur(x.t0 - S.now));
    const chip = st === 'live' ? '<span class="st st-live"><i></i>' + (radio ? 'On air' : 'Live') + '</span>' : st === 'due' ? '<span class="st st-warn"><i></i>Due</span>' : '';
    return '<li><a class="erow strow" href="' + esc(x.url) + '" target="_blank" rel="noopener" data-track="stream_click" data-p-platform="' + esc(x.platform) + '" data-p-channel="' + esc(cut(x.channel)) + '" data-p-stream_status="' + esc(st) + '">' +
      '<div class="when"><b>' + tTime(x.t0) + '</b><span>' + tDay(x.t0) + '</span></div>' +
      '<div class="what"><span class="title">' + esc(x.title) + '</span><div class="sub"><span>' + esc([x.channel, x.location || x.city].filter(Boolean).join(', ')) + '</span></div>' +
      '<div class="sub2">' + bits.map(b => '<span>' + esc(b) + '</span>').join('') + '</div></div>' +
      '<div class="side">' + chip + (G ? '<i class="gdot" style="--c:' + G.color + '" title="' + esc(G.name) + '"></i>' : '') +
      '<span class="viewers">' + (radio ? (st === 'live' ? 'Listen' : 'Details') : 'Watch') + ' &#8599;</span></div></a></li>';
  }
  function renderStreams() {
    const t = S.now, list = S.streams;
    if (!list.length) {
      if (S.ds.source === 'demo' && S.streamsTried) return renderDemoStreams();
      body('streams').innerHTML = '<p class="fine">' + (S.streamsTried ? 'Livestream listings couldn\'t be loaded just now.' : 'Loading livestreams…') + '</p>'; meta('streams', ''); return;
    }
    const gOK = x => !S.genres.size || (x.genres || []).some(g => S.genres.has(g));
    const live = [], soon = [];
    list.forEach(x => {
      const st = streamState(x, t);
      if (!gOK(x)) return;
      if (st === 'live' || st === 'due') live.push(Object.assign({ st: st }, x));
      // Coming up: club shows on NTS (repeats and unknowns left out) and every scheduled YouTube stream.
      else if (st === 'soon' && (x.kind !== 'radio' || (!x.rerun && x.club === true))) soon.push(x);
    });
    live.sort((a, b) => (a.st === 'due') - (b.st === 'due') || (b.kind === 'video') - (a.kind === 'video') || (b.viewers || 0) - (a.viewers || 0) || (b.club === true) - (a.club === true) || a.channel.localeCompare(b.channel));
    const yt = S.streamFile && (S.streamFile.sources || []).find(x => x.id === 'youtube');
    body('streams').innerHTML = '<h3 class="subhead first">Live now</h3>' +
      (live.length ? '<ol class="rows">' + live.map(x => streamRow(x, x.st)).join('') + '</ol>' : '<p class="fine">Nothing streaming live for this filter.</p>') +
      '<h3 class="subhead">Coming up</h3>' +
      (soon.length ? '<ol class="rows">' + soon.slice(0, 30).map(x => streamRow(x, 'soon')).join('') + '</ol>' : '<p class="fine">No club shows or streams scheduled for this filter yet.</p>') +
      '<p class="fine">NTS shows follow the station\'s schedule; repeats are marked. ' +
      (yt && (yt.ok || yt.stale) ? 'YouTube streams from Boiler Room, Cercle, HÖR and others are checked every few hours. ' : '') + 'Times are in your time zone.</p>';
    meta('streams', live.filter(x => x.st === 'live').length + ' live');
  }
  function viewers(e) { return Math.round((e.headTier === 1 ? 1800 : 300) + e.seed * (e.headTier === 1 ? 22000 : 4000)); }
  function renderDemoStreams() {
    const t = S.now;
    const live = D.live.filter(e => e.streamed).sort((a, b) => viewers(b) - viewers(a));
    const soon = S.ds.events.filter(e => e.streamed && e.start > t && e.start < t + DAY && RM.inGenres(e, S.genres)).slice(0, 12);
    const row = (e, isLive) => {
      const c = city(e);
      return '<li class="erow" data-ev="' + esc(e.id) + '" tabindex="0" role="button"><div class="when"><b>' + tTime(e.start, c.tz) + '</b><span>' + tDay(e.start, c.tz) + '</span></div>' +
        '<div class="what"><span class="title">' + esc(e.title) + '</span><div class="sub"><span>' + esc(venue(e).name) + ', ' + esc(c.name) + '</span></div>' +
        '<div class="sub2"><span>' + esc(lineupNames(e, 2)) + '</span></div></div><div class="side">' + (isLive ? '<span class="st st-live"><i></i>Live</span><span class="viewers">' + fmtN(viewers(e)) + ' watching</span>' : '<span class="viewers">' + rel(e) + '</span>') + '</div></li>';
    };
    body('streams').innerHTML = (live.length ? '<ol class="rows">' + live.map(e => row(e, true)).join('') + '</ol>' : '<p class="fine">No streams live for this filter.</p>') +
      (soon.length ? '<h3 class="subhead">Streaming in the next 24 hours</h3><ol class="rows">' + soon.map(e => row(e, false)).join('') + '</ol>' : '');
    meta('streams', live.length + ' live');
  }

  function renderSellouts() {
    const t = S.now;
    if (S.ds.source !== 'demo') { body('sellouts').innerHTML = '<p class="fine">Sell-out odds need ticket sales over time. The feed records each listing\'s current status, so sold-out events are marked on the map and in lists; odds need a few weeks of history first.</p>'; meta('sellouts', ''); return; }
    const list = D.L.events.filter(e => e.start > t && e.start < t + 7 * DAY && RM.inGenres(e, S.genres) && RM.statusAt(e, t) !== 'soldout' && !e.door && !e.free)
      .map(e => ({ e: e, p: RM.selloutOdds(e, t) })).sort((a, b) => b.p - a.p).slice(0, 15);
    const gone = D.L.wire.filter(w => w.type === 'soldout').slice(0, 8);
    body('sellouts').innerHTML = areaBar() + '<ol class="rows">' + list.map(x => {
      const e = x.e, c = city(e);
      return '<li class="orow" data-ev="' + esc(e.id) + '" tabindex="0" role="button"><div class="what"><span class="title" style="font-weight:620;font-size:13px">' + esc(e.title) + '</span>' +
        '<div class="sub2" style="display:flex;gap:10px;flex-wrap:wrap;color:var(--ink-3);font-size:12px"><span>' + esc(c.name) + '</span><span>' + tDate(e.start, c.tz) + '</span><span>' + statusWord(e) + '</span></div></div>' +
        '<div class="odds"><b>' + Math.round(x.p * 100) + '%</b><div class="bar"><i style="width:' + Math.round(x.p * 100) + '%"></i></div></div></li>';
    }).join('') + '</ol>' +
      (gone.length ? '<h3 class="subhead">Sold out in the last 36 hours</h3><ol class="rows">' + gone.map(w => eventRow(w.e)).join('') + '</ol>' : '') +
      '<p class="fine">Odds blend how fast tickets are going with headliner pull and days left. In demo mode the sales curves are simulated.</p>';
    meta('sellouts', 'next 7 days');
  }

  function hourlyChart(series) {
    const Wc = 340, Hc = 150, pl = 30, pr = 10, pt = 12, pb = 22;
    const max = Math.max(10, Math.ceil(Math.max.apply(null, series.map(d => d.n)) * 1.1 / 10) * 10);
    const x = i => pl + i / (series.length - 1) * (Wc - pl - pr), y = v => pt + (1 - v / max) * (Hc - pt - pb);
    const line = series.map((d, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(d.n).toFixed(1)).join('');
    const iNow = 12;
    const past = series.slice(0, iNow + 1).map((d, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(d.n).toFixed(1)).join('');
    const area = line + 'L' + x(series.length - 1) + ',' + y(0) + 'L' + x(0) + ',' + y(0) + 'Z';
    let g = '';
    [0, max / 2, max].forEach(v => { g += '<path d="M' + pl + ',' + y(v).toFixed(1) + 'H' + (Wc - pr) + '" stroke="#1f2547" stroke-width="1"/><text x="' + (pl - 6) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end" fill="#7c7fa3" font-size="10">' + Math.round(v) + '</text>'; });
    let xt = '';
    for (let i = 0; i < series.length; i += 6) xt += '<text x="' + x(i).toFixed(1) + '" y="' + (Hc - 6) + '" text-anchor="' + (i === 0 ? 'start' : i >= series.length - 1 ? 'end' : 'middle') + '" fill="#7c7fa3" font-size="10">' + (i === iNow ? 'Now' : F(null, { hour: 'numeric' }).format(series[i].t)) + '</text>';
    return '<svg viewBox="0 0 ' + Wc + ' ' + Hc + '" role="img" aria-label="Parties live worldwide each hour, from 12 hours ago to 24 hours ahead. Now: ' + series[iNow].n + '." data-chart="hourly">' + g +
      '<path d="' + area + '" fill="#f6ecd8" opacity=".07"/><path d="' + line + '" fill="none" stroke="#a9abcb" stroke-width="1.5" stroke-dasharray="3 3"/>' +
      '<path d="' + past + '" fill="none" stroke="#f6ecd8" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M' + x(iNow).toFixed(1) + ',' + pt + 'V' + y(0) + '" stroke="#f6ecd8" stroke-width="1" opacity=".5"/>' +
      '<circle cx="' + x(iNow).toFixed(1) + '" cy="' + y(series[iNow].n).toFixed(1) + '" r="4" fill="#f6ecd8" stroke="#0c0f22" stroke-width="2"/>' + xt +
      '<line class="hover-x" x1="0" x2="0" y1="' + pt + '" y2="' + y(0) + '" stroke="#eceaf6" stroke-width="1" opacity="0"/>' +
      '<rect x="' + pl + '" y="' + pt + '" width="' + (Wc - pl - pr) + '" height="' + (Hc - pt - pb) + '" fill="transparent" class="hover-zone"/></svg>';
  }
  function renderPeakcon() {
    const pk = D.peak;
    const steps = [5, 4, 3, 2, 1].map(l => '<span class="' + (l === pk.level ? 'on' : '') + '">' + l + '</span>').join('');
    const maxR = pk.regions.length ? pk.regions[0].n : 1;
    body('peakcon').innerHTML = '<div class="pc-hero"><div class="pc-num">' + pk.level + '</div><div><p class="pc-label">' + pk.label + '</p><div class="pc-steps" aria-label="Level ' + pk.level + ' of 5, 1 is the global peak">' + steps + '</div></div></div>' +
      '<dl class="pc-stats"><div><dt>Parties live</dt><dd>' + fmtN(pk.live) + '</dd></div><div><dt>On dance floors, est.</dt><dd>' + fmtN(Math.round(pk.people / 100) * 100) + '</dd></div><div><dt>Busiest region</dt><dd>' + esc(pk.regions[0] ? pk.regions[0].name : 'None') + '</dd></div></dl>' +
      (pk.wave ? '<p class="pc-wave">Next wave: <b>' + esc(pk.wave.name) + '</b>, where ' + plural(pk.wave.n, 'party opens', 'parties open') + ' in the next three hours, led by ' + esc(pk.waveCities.join(', ')) + '. Worldwide, ' + plural(pk.waveCount, 'party opens', 'parties open') + ' in that time.</p>' : '') +
      '<figure class="chart"><figcaption>Parties live worldwide, 12 hours back to 24 ahead</figcaption>' + hourlyChart(pk.hourly) + '<div class="readout" id="pc-readout" aria-live="polite"></div></figure>' +
      '<ul class="regions">' + pk.regions.map(r => '<li><span>' + esc(r.name) + '</span><span class="bar"><i style="width:' + Math.round(r.n / maxR * 100) + '%"></i></span><b>' + r.n + '</b></li>').join('') + '</ul>' +
      '<p class="fine">Peakcon compares parties live now with the busiest moment of the coming week. Level 1 means within 20% of that peak; level 5 means under 16% of it.</p>';
    meta('peakcon', 'global intensity');
    const svg = body('peakcon').querySelector('svg[data-chart]');
    if (svg) {
      const zone = svg.querySelector('.hover-zone'), hx = svg.querySelector('.hover-x'), out = body('peakcon').querySelector('.readout');
      const handle = ev => {
        const r = svg.getBoundingClientRect(), vx = (ev.clientX - r.left) / r.width * 340;
        const i = Math.max(0, Math.min(pk.hourly.length - 1, Math.round((vx - 30) / (300) * (pk.hourly.length - 1))));
        const xx = 30 + i / (pk.hourly.length - 1) * 300;
        hx.setAttribute('x1', xx); hx.setAttribute('x2', xx); hx.setAttribute('opacity', '.6');
        out.textContent = (i === 12 ? 'Now' : tDate(pk.hourly[i].t) + ', ' + tTime(pk.hourly[i].t)) + ': ' + plural(pk.hourly[i].n, 'party', 'parties') + ' live';
      };
      zone.addEventListener('pointermove', handle);
      zone.addEventListener('pointerdown', handle);
      zone.addEventListener('pointerleave', () => { hx.setAttribute('opacity', '0'); out.textContent = ''; });
    }
  }

  function renderSurges() {
    if (S.ds.source !== 'demo') { body('surges').innerHTML = '<p class="fine">Surges compare this week with the last, so they need at least two weeks of listings history.</p>'; meta('surges', ''); return; }
    body('surges').innerHTML = areaBar() + (D.L.surges.length ? '<ol class="rows">' + D.L.surges.map(r => '<li class="srow" data-city="' + r.cityId + '" data-sgenre="' + r.genre + '" tabindex="0" role="button">' +
      '<span class="sx">' + r.ratio.toFixed(1) + '×</span><div><b><i class="gdot" style="--c:' + r.g.color + '"></i>' + esc(r.g.name) + ' in ' + esc(r.city.name) + '</b>' +
      '<small>' + r.next + ' events this week against ' + r.prev + ' last week. Mostly ' + esc((r.topSub || '').toLowerCase()) + '.</small></div>' + spark(r.daily, 7) + '</li>').join('') + '</ol>' +
      '<p class="fine">A surge is a city and genre pair booking at least 1.8 times last week\'s count. Select one to see it on the map.</p>' : '<p class="fine">No surges this week' + (D.L.area ? ' in this area' : '') + '.</p>');
    meta('surges', 'this week vs last');
  }

  /* ---------- layout and tabs ---------- */
  function tabIdsFor(mode) {
    if (mode === 'wide') return ['listings', 'wire', 'genres', 'streams', 'sellouts', 'peakcon', 'surges'];
    // Phones: planning first, then what's on now.
    if (mode === 'narrow') return ['listings', 'live', 'streams', 'genres', 'wire', 'heat', 'sellouts', 'peakcon', 'surges'];
    return ['live', 'listings', 'wire', 'heat', 'genres', 'streams', 'sellouts', 'peakcon', 'surges'];
  }
  function layout() {
    const w = window.innerWidth, h = window.innerHeight;
    // Phones held sideways (short screens) get the phone layout too; the CSS uses the same test.
    const mode = w >= 1100 ? 'wide' : w >= 760 && h >= 500 ? 'mid' : 'narrow';
    if (mode === S.mode) return;
    S.mode = mode;
    document.body.classList.remove('wide', 'mid', 'narrow');
    document.body.classList.add(mode);
    $('#q').placeholder = mode === 'narrow' ? 'Search DJs, venues, cities…' : 'Search events, DJs, labels, venues, cities';
    const left = $('#rail-left'), tp = $('#tabpanels');
    const ids = tabIdsFor(mode);
    if (mode === 'wide') ['live', 'heat'].forEach(id => { const el = PANELS[id].el; el.hidden = false; el.removeAttribute('role'); el.removeAttribute('aria-labelledby'); left.appendChild(el); });
    ids.forEach(id => tp.appendChild(PANELS[id].el));
    $('#tabbar').innerHTML = ids.map((id, i) => '<button class="tab" role="tab" type="button" id="t-' + id + '" aria-controls="p-' + id + '" aria-selected="false" tabindex="-1" data-tab="' + id + '">' + PANELS[id].label + (mode !== 'narrow' ? '<kbd aria-hidden="true">' + (i + 1) + '</kbd>' : '') + '</button>').join('');
    const want = mode === 'wide' ? S.tab.right : S.tab.single;
    selectTab(ids.indexOf(want) >= 0 ? want : ids[0]);
    if (S.sel) $('#scrim').hidden = mode !== 'narrow';
  }
  function selectTab(id, focus) {
    const ids = tabIdsFor(S.mode);
    ids.forEach(t => {
      const b = $('#t-' + t), el = PANELS[t].el, on = t === id;
      if (b) { b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; }
      el.hidden = !on; el.setAttribute('role', 'tabpanel'); el.setAttribute('aria-labelledby', 't-' + t);
    });
    if (S.mode === 'wide') S.tab.right = id; else S.tab.single = id;
    PANELS[id].render();
    const b = $('#t-' + id);
    if (b) {
      // Bring the tab into view sideways only: scrollIntoView would also scroll the page down to the tabs.
      const bar = $('#tabbar');
      if (b.offsetLeft < bar.scrollLeft || b.offsetLeft + b.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = Math.max(0, b.offsetLeft - 16);
      if (focus) b.focus({ preventScroll: true });
    }
  }
  function renderAll() {
    renderHeader();
    Object.keys(PANELS).forEach(id => { if (!PANELS[id].el.hidden || S.mode === 'wide' && (id === 'live' || id === 'heat')) PANELS[id].render(); });
    $('#count').textContent = plural(D.L.win.length, 'event', 'events') + (D.L.area ? ' in view' : ' in ' + plural(D.L.cities, 'city', 'cities'));
    // Zoomed in, the legend says which colour is which genre, for what's in view.
    const lg = $('#lg-genres');
    if (D.L.area && D.L.win.length) {
      const fam = {};
      D.L.win.forEach(e => { if (RM.GENRE[e.genre]) fam[e.genre] = (fam[e.genre] || 0) + 1; });
      const top = Object.keys(fam).sort((a, b) => fam[b] - fam[a]).slice(0, 5);
      lg.innerHTML = top.map(g => '<span class="gkey"><i class="gdot" style="--c:' + RM.GENRE[g].color + '"></i>' + esc(RM.GENRE[g].name) + '</span>').join('');
      lg.hidden = !top.length;
    } else lg.hidden = true;
    $$('#gchips .gchip').forEach(b => b.setAttribute('aria-pressed', b.dataset.genre === 'all' ? String(!S.genres.size) : String(S.genres.has(b.dataset.genre))));
    $$('#win button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.win === S.win)));
    const ws = $('#win-select'); if (ws && ws.value !== S.win) ws.value = S.win;
    if (S.label) renderLabelChip();
  }
  function renderHeader() {
    const pk = D.peak;
    $('#peak-num').textContent = pk.level;
    $('#peak-meter').innerHTML = [5, 4, 3, 2, 1].map(l => '<i class="' + (l >= pk.level ? 'on' : '') + '"></i>').join('');
    $('#peak-pill').setAttribute('aria-label', 'Peakcon ' + pk.level + ', ' + pk.label + '. Open the Peakcon panel.');
    const dn = $('.demo-note');
    if (dn) dn.textContent = S.ds.source === 'demo' ? 'Demo listings, fictional' : S.feed && S.feed.sample ? 'Sample feed, fictional' : 'Live listings, ' + feedAge();
    $('#demo-chip').textContent = S.ds.source === 'demo' ? 'Demo data' : (S.feed && S.feed.sample ? 'Sample feed' : 'Live listings') + ', ' + feedAge();
  }
  function updateClock() {
    const t = Date.now();
    $('#clock-local').textContent = tTime(t);
    $('#clock-utc').textContent = 'UTC ' + F('UTC', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
  }

  /* ---------- filters ---------- */
  function buildGenreChips() {
    $('#gchips').innerHTML = '<button class="gchip all" type="button" data-genre="all" aria-pressed="true">All genres</button>' +
      RM.GENRES.map(g => '<button class="gchip" type="button" data-genre="' + g.id + '" aria-pressed="false"><i class="gdot" style="--c:' + g.color + '"></i>' + esc(g.name) + '</button>').join('');
  }
  function setGenre(id, only) {
    if (id === 'all') S.genres.clear();
    else if (only) { S.genres.clear(); S.genres.add(id); }
    else if (S.genres.has(id)) S.genres.delete(id); else S.genres.add(id);
    refresh();
  }
  function setWindow(w) { S.win = w; refresh(); }
  function refresh() { S.listAll = false; derive(); renderAll(); MapView.changed(false); }

  /* ---------- drawer ---------- */
  let lastFocus = null;
  function openEvent(id, opt) {
    const e = S.ds.eventById[id]; if (!e) return;
    opt = opt || {};
    if (!S.sel) lastFocus = document.activeElement;
    S.sel = id;
    renderDrawer(e);
    track('open_event', eventParams(e));
    const dr = $('#drawer');
    dr.classList.add('open'); dr.setAttribute('aria-hidden', 'false');
    $('#scrim').hidden = S.mode !== 'narrow';
    dr.style.transform = '';
    if (S.showFab) S.showFab();
    const close = $('.dr-close', dr); if (close) close.focus({ preventScroll: true });
    dr.scrollTop = 0;
    if (opt.fly !== false) MapView.flyToEvent(e);
    MapView.changed(false);
  }
  function closeDrawer() {
    const dr = $('#drawer');
    dr.classList.remove('open'); dr.setAttribute('aria-hidden', 'true');
    $('#scrim').hidden = true;
    S.sel = null; MapView.changed(false);
    if (S.showFab) S.showFab();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }
  // Phones: drag the event sheet down by its handle or header to close it. Dragging up there scrolls it.
  function sheetDrag() {
    const dr = $('#drawer');
    let armed = false, mode = '', pid = null, y0 = 0, st0 = 0, dy = 0, lastY = 0, lastT = 0, vel = 0;
    dr.addEventListener('pointerdown', ev => {
      if (S.mode !== 'narrow' || !dr.classList.contains('open') || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      if (!ev.target.closest('.dr-grip, .dr-head') || ev.target.closest('button, a')) return;
      armed = true; mode = ''; pid = ev.pointerId; y0 = lastY = ev.clientY; lastT = ev.timeStamp; st0 = dr.scrollTop; dy = 0; vel = 0;
    });
    dr.addEventListener('pointermove', ev => {
      if (!armed || ev.pointerId !== pid) return;
      const d = ev.clientY - y0;
      if (!mode) {
        if (Math.abs(d) < 6) return;
        mode = d > 0 && st0 <= 0 ? 'drag' : 'scroll';
        try { dr.setPointerCapture(pid); } catch (err) { /* already released */ }
        if (mode === 'drag') dr.classList.add('dragging');
      }
      if (mode === 'scroll') { dr.scrollTop = st0 - d; return; }
      dy = Math.max(0, d);
      const dt = ev.timeStamp - lastT;
      if (dt > 0) vel = (ev.clientY - lastY) / dt;
      lastY = ev.clientY; lastT = ev.timeStamp;
      dr.style.transform = 'translateY(' + dy + 'px)';
    });
    const end = ev => {
      if (!armed || ev.pointerId !== pid) return;
      armed = false;
      if (mode !== 'drag') return;
      dr.classList.remove('dragging');
      const h = dr.getBoundingClientRect().height;
      dr.style.transform = '';
      if (dy > Math.min(140, h * 0.28) || vel > 0.55) closeDrawer();
    };
    dr.addEventListener('pointerup', end);
    dr.addEventListener('pointercancel', end);
  }
  function renderDrawer(e) {
    const c = city(e), v = venue(e), G = gen(e), t = S.now, live = RM.isLive(e, t), st = RM.statusAt(e, t);
    const demo = S.ds.source === 'demo';
    const timed = e.setsTimed !== false;
    const sets = (e.sets || []).map(s => {
      const on = timed && t >= s.start && t < s.end;
      return '<li class="' + (on ? 'now' : '') + '">' + (timed ? '<time>' + tTime(s.start, c.tz) + '–' + tTime(s.end, c.tz) + '</time>' : '<time></time>') + '<span><b>' + esc(s.who) + '</b>' + (on ? '<span class="tag">Playing now</span>' : '') + '</span></li>';
    }).join('');
    const tourer = e.heads.map(artist).filter(a => a && a.tier <= 2)[0];
    const when = live ? 'Started ' + dur(t - e.start) + ' ago, ends in ' + dur(e.end - t) + '.' : e.start > t ? 'Doors in ' + dur(e.start - t) + '.' : 'This event has ended.';
    const facts = [['Price', priceText(e)], ['Tickets', live ? 'Live now' : statusWord(e)]];
    if (demo) {
      const fill = RM.fillAt(e, t), odds = RM.selloutOdds(e, t);
      facts.push(['Capacity', fmtN(e.cap)]);
      facts.push([live || e.end < t ? 'Attendance, est.' : 'Sold so far, est.', Math.round(fill * 100) + '%<div class="fillbar"><i style="width:' + Math.round(fill * 100) + '%"></i></div>']);
      if (!live && e.start > t && st !== 'soldout' && !e.door && !e.free) facts.push(['Sell-out odds', Math.round(odds * 100) + '%']);
    } else if (Number.isFinite(e.popularity)) facts.push(['Interested or going', fmtN(e.popularity)]);
    if (e.age) facts.push(['Entry', e.age]);
    const pick = (names, kind) => names.map(n => '<button type="button" class="linkish" data-act="label" data-kind="' + kind + '" data-name="' + esc(n) + '">' + esc(n) + '</button>').join(', ');
    if (e.labels && e.labels.length) facts.push([e.labels.length > 1 ? 'Labels' : 'Label', pick(e.labels, 'label')]);
    const pr = (e.promoters || []).filter(n => !(e.labels || []).some(l => lkey(l) === lkey(n)));
    if (pr.length) facts.push(['Presented by', pick(pr, 'promoter')]);
    // One link per platform, even when a platform listed the same night twice.
    const srcs = (e.sources && e.sources.length ? e.sources : (e.src ? [{ name: e.src }] : [])).filter((x, i, a) => a.findIndex(y => y.name === x.name) === i);
    if (srcs.length) facts.push(['Listed on', srcs.map(x => x.url && !demo ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener" style="color:inherit">' + esc(x.name) + '</a>' : esc(x.name)).join(', ') + (demo ? ', demo' : '')]);
    const note = demo ? 'Demo event: the ticket link appears with live listings.'
      : v.approx ? 'This listing gives an address but no map position, so it is placed near the city center.'
        : 'Details come from the listing and can change. Check the source before you go.';
    $('#drawer').innerHTML = '<div class="dr-grip" aria-hidden="true"></div><div class="dr-head">' +
      '<button class="dr-close" type="button" data-act="close" aria-label="Close event details">&times;</button>' +
      '<div class="dr-kicker"><i class="gdot" style="--c:' + G.color + '"></i><span>' + esc(G.name) + (e.sub && e.sub.toLowerCase() !== G.name.toLowerCase() ? ', ' + esc(e.sub) : '') + '</span>' + (G.bpm && G.bpm !== 'varies' ? '<span>' + G.bpm + ' BPM</span>' : '') + statusChip(e) + '</div>' +
      '<h2 id="dr-title">' + esc(e.title) + '</h2><p class="dr-venue">' + esc(v.name) + ', ' + esc(c.name) + '</p></div>' +
      '<div class="dr-when"><div class="big">' + tTime(e.start, c.tz) + '<small>to ' + tTime(e.end, c.tz) + ', ' + esc(c.name) + ' time</small></div>' +
      '<p>' + tDate(e.start, c.tz).replace(/\.$/, '') + '. ' + when + '</p><p>Your time: ' + tDate(e.start) + ', ' + tTime(e.start) + '</p></div>' +
      (sets ? '<section class="dr-sec"><h3>' + (timed ? 'Set times' : 'Lineup') + '</h3><ol class="sets' + (timed ? '' : ' untimed') + '">' + sets + '</ol></section>' : '') +
      '<section class="dr-sec"><h3>Tickets and listing</h3><dl class="facts">' + facts.map(f => '<div><dt>' + f[0] + '</dt><dd>' + f[1] + '</dd></div>').join('') + '</dl></section>' +
      (e.tags && e.tags.length ? '<section class="dr-sec"><h3>' + (demo ? 'Door and floor' : 'Tags') + '</h3><div class="tags">' + e.tags.map(x => '<span>' + esc(x) + '</span>').join('') + '</div></section>' : '') +
      // On phones the route button sits above, so the bar pinned to the bottom holds tickets and share.
      (tourer ? '<div class="dr-route"><button class="btn" type="button" data-act="route" data-artist="' + tourer.id + '">Show ' + esc(tourer.name) + '\'s dates on the map</button></div>' : '') +
      '<div class="dr-actions">' +
      (e.url && !demo ? '<a class="btn primary" href="' + esc(e.url) + '" target="_blank" rel="noopener" data-track="ticket_click"' + Object.entries(eventParams(e)).map(([k, v]) => ' data-p-' + k + '="' + esc(String(v)) + '"').join('') + '>' + esc(ticketLabel(e)) + '</a>' : '<span class="btn primary" aria-disabled="true">' + esc(ticketLabel(e)) + '</span>') +
      (tourer ? '<button class="btn route" type="button" data-act="route" data-artist="' + tourer.id + '">Show ' + esc(tourer.name) + '\'s dates</button>' : '') +
      (canShare ? '<button class="btn" type="button" data-act="share">Share</button>' : '<button class="btn" type="button" data-act="copy">Copy details</button>') + '</div>' +
      '<p class="dr-note" id="dr-note">' + note + '</p>' +
      // Promoters and venues can ask for a fix or removal.
      (window.RM_CONTACT && !demo ? '<p class="dr-note"><a href="' + window.RM_CONTACT + '?topic=listing&amp;about=' + encodeURIComponent(e.title + ', ' + v.name + ', ' + c.name + ', ' + tDate(e.start, c.tz)) + '" style="color:inherit">Report a problem with this listing</a></p>' : '');
  }
  const canShare = typeof navigator.share === 'function';
  // The phone's own share sheet: the listing's text and its ticket page.
  async function shareEvent() {
    const e = S.ds.eventById[S.sel]; if (!e) return;
    const c = city(e), v = venue(e);
    const text = e.title + ', ' + v.name + ', ' + c.name + ', ' + tDate(e.start, c.tz) + ' ' + tTime(e.start, c.tz);
    try {
      await navigator.share({ title: e.title, text: text, url: e.url || location.origin + '/' });
      track('share_event', eventParams(e));
    } catch (err) {
      if (err && err.name === 'AbortError') return; // closed the share sheet
      copyDetails();
    }
  }
  function ticketLabel(e) { return !e.src ? 'Get tickets' : e.src === 'Promoter submission' ? 'Promoter link' : 'Tickets on ' + e.src; }
  async function copyDetails() {
    const e = S.ds.eventById[S.sel]; if (!e) return;
    const c = city(e), v = venue(e);
    const text = [e.title, v.name + ', ' + c.name, tDate(e.start, c.tz) + ', ' + tTime(e.start, c.tz) + ' to ' + tTime(e.end, c.tz) + ' local time', lineupNames(e, 12), priceText(e), e.url || ''].filter(Boolean).join('\n');
    const note = $('#dr-note');
    try { await navigator.clipboard.writeText(text); note.textContent = 'Copied to your clipboard.'; }
    catch (err) { note.innerHTML = 'Copying is blocked here. Select the text below to copy it.<textarea readonly rows="5" style="width:100%;margin-top:8px;background:var(--void);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:8px">' + esc(text) + '</textarea>'; }
  }

  /* ---------- route (an artist's upcoming dates) ---------- */
  function setRoute(aid) {
    S.route = aid || null;
    const chip = $('#route-chip');
    if (!aid) { chip.hidden = true; MapView.changed(false); return; }
    const a = artist(aid), gigs = routeGigs(aid);
    chip.innerHTML = '<span>' + esc(a.name) + ': ' + plural(gigs.length, 'upcoming date', 'upcoming dates') + '</span><button type="button" data-act="route-clear">Clear</button>';
    chip.hidden = false;
    if (S.sel && S.mode === 'narrow') closeDrawer();
    MapView.fitEvents(gigs);
    MapView.changed(false);
  }

  /* ---------- record labels and promoters ---------- */
  // Every label and promoter in the feed with its upcoming nights, plus the curated labels
  // (built into the page) so a search for one with nothing coming up can point to the archive.
  let labelIdx = null;
  function labelIndex() {
    if (labelIdx && labelIdx.ds === S.ds) return labelIdx.list;
    const m = new Map(), t = S.now;
    const add = (name, kind, e) => {
      const k = lkey(name); if (!k) return;
      let x = m.get(k);
      if (!x) { x = { key: k, name: name, kind: kind, n: 0 }; m.set(k, x); }
      if (kind === 'label') x.kind = 'label';
      if (e && e.end > t) x.n++;
    };
    S.ds.events.forEach(e => { (e.labels || []).forEach(n => add(n, 'label', e)); (e.promoters || []).forEach(n => add(n, 'promoter', e)); });
    (window.RM_LABELS || []).forEach(n => add(n, 'label', null));
    labelIdx = { ds: S.ds, list: Array.from(m.values()) };
    return labelIdx.list;
  }
  const archiveLabelUrl = name => '/archive/?label=' + encodeURIComponent(name);
  function setLabel(x) {
    S.label = x ? { key: x.key, name: x.name, kind: x.kind } : null;
    S.listAll = false;
    if (S.label) {
      // Widen the time window when the label's next night is further out than it shows.
      const t = S.now, next = S.ds.events.filter(e => e.end > t && hasLabel(e)).sort((a, b) => a.start - b.start);
      if (next.length && !next.some(e => RM.inWindow(e, S.ds, t, S.win))) S.win = next.some(e => RM.inWindow(e, S.ds, t, '7d')) ? '7d' : next.some(e => RM.inWindow(e, S.ds, t, '14d')) ? '14d' : '30d';
      track('set_filter', { filter: S.label.kind, value: cut(S.label.name) });
    }
    derive(); renderAll();
    renderLabelChip();
    if (S.label && D.win.length) { if (S.sel && S.mode === 'narrow') closeDrawer(); MapView.fitEvents(D.win); }
    MapView.changed(false);
  }
  function renderLabelChip() {
    const chip = $('#label-chip');
    if (!S.label) { chip.hidden = true; return; }
    const n = D.win.length;
    chip.innerHTML = '<span>' + (S.label.kind === 'promoter' ? 'Promoter: ' : 'Label: ') + esc(S.label.name) + ' · ' + (n ? plural(n, 'night', 'nights') + ' ' + WIN_LABEL[S.win] : 'nothing coming up') + '</span>' +
      (n ? '' : '<a href="' + archiveLabelUrl(S.label.name) + '">Archive</a>') + '<button type="button" data-act="label-clear">Clear</button>';
    chip.hidden = false;
  }

  /* ---------- near me ---------- */
  function kmBetween(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  let toastTimer = 0;
  function toast(msg) {
    const el = $('#maptoast');
    el.textContent = msg; el.hidden = !msg;
    clearTimeout(toastTimer);
    if (msg) toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }
  // The browser's time zone, as a rough place to start (site/tz.json, built into the page).
  function tzGuess() {
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (err) { return null; }
    const c = S.ds.cities.find(x => x.tz === tz && x.lat != null);
    if (c) return [c.lat, c.lon];
    const p = (window.RM_TZ || {})[tz];
    return p ? p : null;
  }
  let movedSinceStart = false;
  function goNear(lat, lon, precise, how) {
    const best = MapView.focusNear(lat, lon, precise, how !== 'start');
    if (precise) { S.me = { lat: lat, lon: lon }; MapView.changed(false); }
    if (how !== 'start' || precise) track('locate', { method: precise ? 'gps' : 'timezone', city: cut(best ? best.c.name : ''), nearby: !!(best && best.d <= 120) });
    if (how === 'start') return best;
    if (!best) toast('No listings coming up anywhere near you yet.');
    else if (best.d > 120) toast('Nearest listings: ' + best.c.name + ', about ' + fmtN(Math.round(best.d / 10) * 10) + ' km away.');
    else toast('Showing listings near you. Zoom out to see everywhere.');
    return best;
  }
  function locateMe() {
    const btn = $('#locate');
    if (!navigator.geolocation) { toast('Your browser doesn\'t share a location.'); return; }
    btn.setAttribute('aria-busy', 'true'); toast('Finding you…');
    navigator.geolocation.getCurrentPosition(pos => {
      btn.removeAttribute('aria-busy');
      goNear(pos.coords.latitude, pos.coords.longitude, true, 'button');
    }, err => {
      btn.removeAttribute('aria-busy');
      const guess = tzGuess();
      if (guess && MapView.focusNear(guess[0], guess[1], false, true)) toast(err.code === 1 ? 'Location is off for this site, so this is a guess from your time zone.' : 'Couldn\'t get your location, so this is a guess from your time zone.');
      else toast(err.code === 1 ? 'Location is off for this site. You can allow it in your browser settings.' : 'Couldn\'t get your location. Try again in a moment.');
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
  }
  // On load: near the visitor right away from their time zone, then, if they've already allowed this
  // site their location, on their own position. No permission prompt until they press Near me.
  function startNear() {
    const guess = tzGuess();
    if (guess) goNear(guess[0], guess[1], false, 'start');
    try {
      if (!navigator.permissions || !navigator.geolocation) return;
      navigator.permissions.query({ name: 'geolocation' }).then(st => {
        if (st.state !== 'granted') return;
        navigator.geolocation.getCurrentPosition(pos => { if (!movedSinceStart) goNear(pos.coords.latitude, pos.coords.longitude, true, 'start'); }, () => {}, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
      }, () => {});
    } catch (err) { /* no permissions API */ }
  }

  /* ---------- search ---------- */
  let results = [], activeIdx = -1;
  function searchItems(q) {
    const s = norm(q).trim(); if (s.length < 2) return [];
    const ds = S.ds, t = S.now, out = [];
    ds.cities.filter(c => norm(c.name).indexOf(s) >= 0).slice(0, 4).forEach(c => out.push({ g: 'Cities', kind: 'city', id: c.id, label: c.name, hint: plural((D.byCity.get(c.id) || []).length, 'event', 'events') + ' ' + WIN_LABEL[S.win] }));
    RM.GENRES.filter(g => norm(g.name).indexOf(s) >= 0 || g.subs.some(x => norm(x).indexOf(s) >= 0)).slice(0, 3).forEach(g => out.push({ g: 'Genres', kind: 'genre', id: g.id, label: g.name, hint: 'Filter the map' }));
    ds.artists.filter(a => norm(a.name).indexOf(s) >= 0).sort((a, b) => a.tier - b.tier).slice(0, 5).forEach(a => { const n = routeGigs(a.id).length; out.push({ g: 'DJs and artists', kind: 'artist', id: a.id, label: a.name, hint: plural(n, 'upcoming date', 'upcoming dates') }); });
    const ls = lkey(q);
    if (ls.length >= 2) {
      const hits = labelIndex().filter(x => (' ' + x.key).indexOf(' ' + ls) >= 0).sort((a, b) => b.n - a.n || a.name.length - b.name.length);
      hits.filter(x => x.kind === 'label').slice(0, 4).forEach(x => out.push({ g: 'Record labels', kind: x.n ? 'label' : 'label-archive', id: x.key, label: x.name, hint: x.n ? plural(x.n, 'upcoming night', 'upcoming nights') : 'Nothing coming up · search the archive' }));
      hits.filter(x => x.kind === 'promoter' && x.n).slice(0, 3).forEach(x => out.push({ g: 'Promoters', kind: 'label', id: x.key, label: x.name, hint: plural(x.n, 'upcoming night', 'upcoming nights') }));
    }
    ds.events.filter(e => e.end > t && norm(e.title).indexOf(s) >= 0).slice(0, 6).forEach(e => out.push({ g: 'Events', kind: 'event', id: e.id, label: e.title, hint: city(e).name + ', ' + tDate(e.start, city(e).tz) }));
    ds.venues.filter(v => norm(v.name).indexOf(s) >= 0).slice(0, 4).forEach(v => out.push({ g: 'Venues', kind: 'venue', id: v.id, label: v.name, hint: ds.cityById[v.cityId].name }));
    return out;
  }
  function renderResults(q) {
    const box = $('#results'), input = $('#q');
    results = searchItems(q); activeIdx = results.length ? 0 : -1;
    if (norm(q).trim().length < 2) { hideResults(); return; }
    let html = '', lastG = null;
    if (!results.length) html = '<div class="empty">No matches. Try a city, a genre, a DJ or a record label.</div>';
    results.forEach((r, i) => {
      if (r.g !== lastG) { html += '<h4>' + r.g + '</h4>'; lastG = r.g; }
      html += '<div role="option" id="opt-' + i + '" data-i="' + i + '" aria-selected="' + (i === activeIdx) + '"><span>' + esc(r.label) + '</span><small>' + esc(r.hint) + '</small></div>';
    });
    box.innerHTML = html; box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', activeIdx >= 0 ? 'opt-' + activeIdx : '');
  }
  function hideResults() { const box = $('#results'); box.hidden = true; $('#q').setAttribute('aria-expanded', 'false'); $('#q').removeAttribute('aria-activedescendant'); }
  function moveActive(d) {
    if (!results.length) return;
    activeIdx = (activeIdx + d + results.length) % results.length;
    $$('#results [role="option"]').forEach(o => o.setAttribute('aria-selected', String(+o.dataset.i === activeIdx)));
    const el = $('#opt-' + activeIdx); if (el) el.scrollIntoView({ block: 'nearest' });
    $('#q').setAttribute('aria-activedescendant', 'opt-' + activeIdx);
  }
  function chooseResult(i) {
    const r = results[i]; if (!r) return;
    hideResults(); $('#q').blur();
    track('select_search_result', { result_type: r.kind, result: cut(r.label) });
    const ds = S.ds;
    if (r.kind === 'city') MapView.flyToCity(ds.cityById[r.id]);
    else if (r.kind === 'genre') setGenre(r.id, true);
    else if (r.kind === 'artist') setRoute(r.id);
    else if (r.kind === 'label') setLabel(labelIndex().find(x => x.key === r.id));
    else if (r.kind === 'label-archive') location.href = archiveLabelUrl(r.label);
    else if (r.kind === 'event') openEvent(r.id);
    else if (r.kind === 'venue') MapView.flyToVenue(ds.venueById[r.id]);
  }

  /* ---------- map ---------- */
  const MapView = (function () {
    const stage = $('#stage'), cb = $('#map-base'), co = $('#map-over'), tip = $('#tip');
    const bx = cb.getContext('2d'), ox = co.getContext('2d');
    let geo = null;
    try {
      const g = JSON.parse($('#geo').textContent);
      const lo = topojson.feature(g.lo, g.lo.objects.land);
      geo = {
        landLo: lo,
        borders: topojson.mesh(g.lo, g.lo.objects.countries, (a, b) => a !== b),
        // The detailed coastline (about 0.5 MB) loads after the page, from geo-hi.json; until then the coarse one stands in.
        landHi: g.hi ? topojson.feature(g.hi, g.hi.objects.land) : lo,
        lakes: topojson.feature(g.lakes, g.lakes.objects.lakes)
      };
      if (!g.hi) {
        fetch('geo-hi.json').then(r => r.ok ? r.json() : null).then(hi => {
          if (!hi || !hi.objects || !hi.objects.land) return;
          geo.landHi = topojson.feature(hi, hi.objects.land);
          if (inited) changed(true);
        }).catch(() => { /* keep the coarse coastline */ });
      }
    } catch (err) { console.error('map data failed to load', err); }
    const grat = d3.geoGraticule10(), sphere = { type: 'Sphere' };
    const C = { sea: '#070814', land: '#171c3a', grat: 'rgba(150,160,230,0.055)', border: 'rgba(160,170,230,0.14)', now: '#f6ecd8', ink: '#eceaf6', ink2: '#a9abcb', ink3: '#7c7fa3' };
    let W = 0, H = 0, DPR = 1, base = 1, kMin = 1, kMax = 500, lon0 = 10;
    let mapT = d3.zoomIdentity;
    const globe = { rot: [0, -26, 0], k: 1 };
    let proj = null, ppd = 1, inited = false, venueMode = false;
    let baseDirty = true, posDirty = true, overDirty = true, rafId = 0, lastDraw = 0, lastPointer = 'mouse';
    let marks = [], cityMarks = [], festMarks = [], stopMarks = [], venueLabels = [], liveMarks = 0;
    let areaTimer = 0, areaSig = 'all';
    const sel = d3.select(co);
    const zMap = d3.zoom().on('zoom', ev => { mapT = ev.transform; if (ev.sourceEvent) userMoved(); changed(true); hideTip(); });
    let gPrev = null;
    const zGlobe = d3.zoom().scaleExtent([0.7, 500])
      .on('start', ev => { gPrev = ev.transform; })
      .on('zoom', ev => {
        const t = ev.transform;
        if (gPrev && ev.sourceEvent && Math.abs(t.k - gPrev.k) < 1e-9) {
          const sens = 57.2958 / globeR();
          globe.rot[0] += (t.x - gPrev.x) * sens;
          globe.rot[1] = Math.max(-85, Math.min(85, globe.rot[1] - (t.y - gPrev.y) * sens));
        }
        globe.k = t.k; gPrev = t; if (ev.sourceEvent) userMoved(); changed(true); hideTip();
      });

    const globeR = () => Math.min(W, H) * 0.43 * globe.k;
    const homeK = () => W < 760 ? kMin * 1.45 : Math.max(kMin, W < 1100 ? 1.2 : 1.06);
    const unitPpd = () => base * Math.PI / 180; // pixels per degree at zoom 1
    // The lists follow the map once you zoom in yourself; zooming back out to the world lets them go.
    // Opening an event from a list moves the map without narrowing the list.
    const zoomedIn = () => S.view === 'map' ? mapT.k > homeK() * 1.2 : globe.k > 1.3;
    function userMoved() { S.areaOn = zoomedIn(); movedSinceStart = true; }
    const baseProj = () => d3.geoMercator().rotate([-lon0, 0]).scale(base).translate([0, 0]);
    function setProj() {
      if (S.view === 'map') {
        proj = d3.geoMercator().rotate([-lon0, 0]).scale(base * mapT.k).translate([mapT.x, mapT.y]).clipExtent([[-20, -20], [W + 20, H + 20]]);
        ppd = base * mapT.k * Math.PI / 180;
      } else {
        const R = globeR();
        proj = d3.geoOrthographic().rotate(globe.rot).scale(R).translate([W / 2, H / 2]).clipAngle(90).precision(0.5);
        ppd = R * Math.PI / 180;
      }
    }
    function vis(lon, lat) {
      if (S.view === 'map') return true;
      return d3.geoDistance([lon, lat], [-globe.rot[0], -globe.rot[1]]) < Math.PI / 2 - 0.02;
    }

    function init() {
      const band = RM.clubBand(S.now);
      lon0 = (band.mid > 50 || band.mid < -130) ? 150 : 10;
      globe.rot = [-band.mid, -26, 0];
      sel.call(zMap).on('dblclick.zoom', null);
      co.addEventListener('pointerdown', ev => { lastPointer = ev.pointerType || 'mouse'; });
      co.addEventListener('pointermove', ev => {
        if (ev.pointerType !== 'mouse' || ev.buttons) return;
        const r = co.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, h = hit(x, y);
        co.style.cursor = h ? 'pointer' : 'grab';
        showTip(h, x, y);
      });
      co.addEventListener('pointerleave', hideTip);
      co.addEventListener('click', ev => {
        const r = co.getBoundingClientRect(), h = hit(ev.clientX - r.left, ev.clientY - r.top);
        if (!h) return;
        if (h.kind === 'event') openEvent(h.e.id, { fly: ppd < 60 });
        else if (h.kind === 'city') flyToCity(h.c);
      });
      co.addEventListener('keydown', ev => {
        const step = 60;
        if (S.view !== 'map') return;
        const m = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[ev.key];
        if (m) { ev.preventDefault(); sel.call(zMap.translateBy, m[0] / mapT.k, m[1] / mapT.k); userMoved(); }
        if (ev.key === '+' || ev.key === '=') zoomBy(2);
        if (ev.key === '-') zoomBy(0.5);
      });
      new ResizeObserver(() => resize()).observe(stage);
      resize();
    }
    function resize() {
      const r = stage.getBoundingClientRect();
      const nw = Math.max(50, Math.round(r.width)), nh = Math.max(50, Math.round(r.height));
      if (nw === W && nh === H && inited) return;
      let keep = null;
      if (inited && proj) keep = { c: proj.invert([W / 2, H / 2]), ppd: ppd };
      W = nw; H = nh; DPR = Math.min(2, window.devicePixelRatio || 1);
      [cb, co].forEach(c => { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); c.style.width = W + 'px'; c.style.height = H + 'px'; });
      base = W / (2 * Math.PI);
      const p0 = baseProj();
      const yTop = p0([lon0, 82])[1], yBot = p0([lon0, -60])[1];
      kMin = Math.max(1, H / (yBot - yTop));
      zMap.extent([[0, 0], [W, H]]).translateExtent([[-Math.PI * base, yTop], [Math.PI * base, yBot]]);
      setZoomLimit();
      zGlobe.extent([[0, 0], [W, H]]);
      if (streets.map) streets.map.resize();
      if (!inited) { inited = true; home(false); }
      else if (keep && keep.c && S.view === 'map') flyTo(keep.c[0], keep.c[1], keep.ppd, false);
      changed(true);
    }
    function home(animate) {
      const band = RM.clubBand(S.now);
      S.areaOn = false;
      if (S.view === 'map') {
        const k = homeK();
        const p = baseProj()([band.mid, 28]);
        const t = d3.zoomIdentity.translate(W / 2 - k * p[0], H / 2 - k * p[1]).scale(k);
        (animate && !reduceMotion ? sel.transition().duration(700) : sel).call(zMap.transform, t);
      } else animateGlobe([-band.mid, -26, 0], 1, animate);
    }
    function flyTo(lon, lat, targetPpd, animate) {
      if (animate === undefined) animate = true;
      if (S.view === 'map') {
        const k = Math.max(kMin, Math.min(kMax, targetPpd / (base * Math.PI / 180)));
        const p = baseProj()([lon, lat]);
        const t = d3.zoomIdentity.translate(W / 2 - k * p[0], H / 2 - k * p[1]).scale(k);
        (animate && !reduceMotion ? sel.transition().duration(900) : sel).call(zMap.transform, t);
      } else {
        const k = targetPpd * 180 / Math.PI / (Math.min(W, H) * 0.43);
        animateGlobe([-lon, -lat, 0], Math.max(0.7, Math.min(500, k)), animate);
      }
    }
    function animateGlobe(rot, k, animate) {
      const r0 = globe.rot.slice(), k0 = globe.k;
      const dl = ((rot[0] - r0[0]) % 360 + 540) % 360 - 180;
      const target = [r0[0] + dl, rot[1], 0];
      const ir = d3.interpolate(r0, target), ik = d3.interpolateNumber(Math.log(k0), Math.log(k));
      const done = () => sel.call(zGlobe.transform, d3.zoomIdentity.scale(globe.k));
      if (!animate || reduceMotion) { globe.rot = target; globe.k = k; done(); changed(true); return; }
      const t0 = performance.now(), dur = 1000;
      const step = now => {
        const u = Math.min(1, (now - t0) / dur), e = d3.easeCubicInOut(u);
        globe.rot = ir(e); globe.k = Math.exp(ik(e)); changed(true);
        if (u < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    }
    function zoomBy(f) {
      if (S.view === 'map') {
        S.areaOn = Math.max(kMin, Math.min(kMax, mapT.k * f)) > homeK() * 1.2;
        (reduceMotion ? sel : sel.transition().duration(350)).call(zMap.scaleBy, f);
      } else {
        const k = Math.max(0.7, Math.min(500, globe.k * f));
        S.areaOn = k > 1.3;
        animateGlobe(globe.rot.slice(), k, true);
      }
    }
    function setView(v) {
      if (v === S.view) return;
      const c = proj ? proj.invert([W / 2, H / 2]) : null, cur = ppd;
      S.view = v;
      sel.on('.zoom', null);
      if (v === 'map') {
        sel.call(zMap).on('dblclick.zoom', null);
        if (c && isFinite(c[0])) flyTo(c[0], Math.max(-55, Math.min(75, c[1])), cur, false); else home(false);
      } else {
        sel.call(zGlobe).on('dblclick.zoom', null);
        const center = c && isFinite(c[0]) ? c : [RM.clubBand(S.now).mid, 26];
        globe.rot = [-center[0], -Math.max(-60, Math.min(70, center[1])), 0];
        globe.k = Math.max(1, Math.min(500, cur * 180 / Math.PI / (Math.min(W, H) * 0.43)));
        sel.call(zGlobe.transform, d3.zoomIdentity.scale(globe.k));
      }
      $$('#viewtoggle button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.view === v)));
      changed(true);
    }
    // Choosing a city frames its venues (the middle 90% of them, so one far-off listing can't
    // zoom the map out); with the street map on, that can go down to neighbourhood level.
    function flyToCity(c) {
      S.areaOn = true;
      track('select_city', { city: cut(c.name) });
      if (S.view !== 'map' || !streetsOn()) return flyTo(c.lon, c.lat, 260);
      const vs = (D.byCity.get(c.id) || []).map(venue).filter(v => v && !v.approx);
      const lons = vs.map(v => v.lon).sort((a, b) => a - b), lats = vs.map(v => v.lat).sort((a, b) => a - b);
      const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * f)))];
      const trim = vs.length >= 10 ? 0.05 : 0;
      const box = vs.length ? [[q(lons, trim), q(lats, trim)], [q(lons, 1 - trim), q(lats, 1 - trim)]] : [[c.lon, c.lat], [c.lon, c.lat]];
      fitBox(box, 260, 1500);
    }
    function flyToVenue(v) { S.areaOn = true; flyTo(v.lon, v.lat, streetsOn() ? 2900 : 360); }
    function flyToEvent(e) { const v = venue(e); flyTo(v.lon, v.lat, Math.max(ppd, streetsOn() ? 1400 : 300)); }
    function fitBox(box, minPpd, maxPpd) {
      const p0 = baseProj(), a = p0(box[0]), b = p0(box[1]);
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      const kFit = Math.min(W * 0.7 / Math.max(1e-6, x1 - x0), H * 0.62 / Math.max(1e-6, y1 - y0));
      const k = Math.max(kMin, Math.min(kMax, Math.max(minPpd / unitPpd(), Math.min(kFit, maxPpd / unitPpd()))));
      const t = d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
      (reduceMotion ? sel : sel.transition().duration(900)).call(zMap.transform, t);
    }
    // Near me: frame the closest city with listings coming up. precise is the visitor's own position,
    // otherwise a guess from their time zone, which gets a regional view rather than a street-level one.
    function focusNear(lat, lon, precise, animate) {
      const t = S.now, ahead = t + 31 * DAY, n = {};
      S.ds.events.forEach(e => { if (e.end > t && e.start < ahead) n[e.cityId] = (n[e.cityId] || 0) + 1; });
      let best = null;
      Object.keys(n).forEach(id => { const c = S.ds.cityById[id]; if (!c) return; const d = kmBetween(lat, lon, c.lat, c.lon); if (!best || d < best.d) best = { c: c, d: d }; });
      if (!best || best.d > (precise ? 20000 : 1500)) return null;
      if (S.view !== 'map') setView('map');
      S.areaOn = true;
      if (!precise) flyTo(best.c.lon, best.c.lat, W < 760 ? 45 : 60, animate);
      else if (best.d <= 120) {
        // Their city's venues (the middle 90%) with them in the frame.
        const vs = S.ds.events.filter(e => e.cityId === best.c.id && e.end > t).map(venue).filter(v => v && !v.approx);
        const lons = vs.map(v => v.lon).concat(lon).sort((a, b) => a - b), lats = vs.map(v => v.lat).concat(lat).sort((a, b) => a - b);
        const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * f)))];
        const trim = vs.length >= 10 ? 0.05 : 0;
        const box = [[Math.min(lon, q(lons, trim)), Math.min(lat, q(lats, trim))], [Math.max(lon, q(lons, 1 - trim)), Math.max(lat, q(lats, 1 - trim))]];
        fitBox(box, 150, 1500);
      } else fitBox([[Math.min(lon, best.c.lon), Math.min(lat, best.c.lat)], [Math.max(lon, best.c.lon), Math.max(lat, best.c.lat)]], 2, 260);
      changed(true);
      return best;
    }
    function fitEvents(list) {
      if (!list.length) return;
      const pts = list.map(e => { const v = venue(e); return [v.lon, v.lat]; });
      if (S.view === 'map') {
        const p0 = baseProj(), xy = pts.map(p => p0(p));
        const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
        const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
        const kFit = Math.min(W * 0.7 / Math.max(1e-6, x1 - x0), H * 0.62 / Math.max(1e-6, y1 - y0));
        const k = Math.max(kMin, Math.min(kFit, 90 / (base * Math.PI / 180)));
        const t = d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
        (reduceMotion ? sel : sel.transition().duration(900)).call(zMap.transform, t);
      } else {
        const cen = d3.geoCentroid({ type: 'MultiPoint', coordinates: pts });
        const th = Math.max.apply(null, pts.map(p => d3.geoDistance(p, cen)));
        animateGlobe([-cen[0], -cen[1], 0], Math.max(1, Math.min(8, 0.93 / Math.max(0.12, Math.sin(Math.min(th, 1.4))))), true);
      }
    }


    /* ---------- street map ----------
       MapLibre draws OpenFreeMap's vector tiles (OpenStreetMap data, no key) between the base
       canvas and the event canvas. It's loaded the first time you zoom in, fades in from regional
       zoom, and follows the d3 camera: same Web Mercator, so zoom = log2(360 * ppd / 512). */
    const ML = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl';
    // MapLibre (about 220 KB) loads only once the view gets close to street level, so the regional
    // view a phone opens on doesn't pay for it.
    const ST = { load: 70, preload: 85, from: 110, to: 240, maxPpd: 93000, flatMaxPpd: 1600, detailPpd: 2400 };
    const LABEL_LAYERS = ['water-name', 'street-name', 'neighbourhood', 'suburb', 'town'];
    const streets = { el: $('#streets'), map: null, state: 'off', t: 0, labels: true };
    const streetsOn = () => S.layers.streets && streets.state !== 'failed';
    function streetStyle() {
      const name = ['coalesce', ['get', 'name:latin'], ['get', 'name']];
      const width = stops => ['interpolate', ['exponential', 1.4], ['zoom']].concat(stops);
      const isLine = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
      const isArea = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
      const road = (id, classes, color, stops, minzoom) => ({
        id: id, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: minzoom,
        filter: ['all', isLine, ['match', ['get', 'class'], classes, true, false]],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': width(stops) }
      });
      const label = (id, layer, filter, size, color, minzoom, maxzoom, layout) => ({
        id: id, type: 'symbol', source: 'omt', 'source-layer': layer, minzoom: minzoom, maxzoom: maxzoom, filter: filter,
        layout: Object.assign({ 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': size, 'text-max-width': 8 }, layout || {}),
        paint: { 'text-color': color, 'text-halo-color': 'rgba(7,8,20,0.92)', 'text-halo-width': 1.4 }
      });
      const caps = { 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 };
      return {
        version: 8,
        sources: { omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        layers: [
          { id: 'land', type: 'background', paint: { 'background-color': C.land } },
          { id: 'green', type: 'fill', source: 'omt', 'source-layer': 'landcover', minzoom: 9, filter: ['all', isArea, ['match', ['get', 'class'], ['wood', 'grass'], true, false]], paint: { 'fill-color': '#15283d', 'fill-opacity': 0.6 } },
          { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', minzoom: 9, filter: isArea, paint: { 'fill-color': '#15293f', 'fill-opacity': 0.8 } },
          { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['all', isArea, ['!=', ['get', 'brunnel'], 'tunnel']], paint: { 'fill-color': C.sea } },
          { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 9, filter: isLine, paint: { 'line-color': C.sea, 'line-width': width([9, 0.6, 14, 2, 18, 6]) } },
          { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': '#1f2650', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, 0.9] } },
          { id: 'runway', type: 'line', source: 'omt', 'source-layer': 'aeroway', minzoom: 11, filter: ['all', isLine, ['match', ['get', 'class'], ['runway', 'taxiway'], true, false]], paint: { 'line-color': '#262e5c', 'line-width': width([11, 1, 16, 12]) } },
          road('path', ['path', 'track'], 'rgba(169,171,203,0.10)', [14, 0.5, 18, 2], 14),
          road('minor', ['minor', 'service'], 'rgba(169,171,203,0.15)', [12, 0.3, 14, 1.2, 18, 9], 12),
          road('secondary', ['secondary', 'tertiary'], 'rgba(169,171,203,0.22)', [9, 0.4, 12, 1, 14, 2.4, 18, 12], 9),
          road('primary', ['primary', 'trunk'], 'rgba(169,171,203,0.30)', [7, 0.4, 10, 1, 14, 3.2, 18, 15], 7),
          road('motorway', ['motorway'], 'rgba(184,188,228,0.38)', [5, 0.4, 8, 1, 12, 2.4, 14, 4, 18, 18], 5),
          { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12, filter: ['all', isLine, ['match', ['get', 'class'], ['rail', 'transit'], true, false]], paint: { 'line-color': 'rgba(169,171,203,0.18)', 'line-width': width([12, 0.6, 18, 2.5]), 'line-dasharray': [3, 3] } },
          { id: 'border', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': 'rgba(160,170,230,0.3)', 'line-width': 1, 'line-dasharray': [3, 2] } },
          label('water-name', 'water_name', ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false], 11, '#555d93', 8, 24, { 'text-font': ['Noto Sans Italic'] }),
          label('street-name', 'transportation_name', ['all', isLine, ['!=', ['get', 'class'], 'motorway']], ['interpolate', ['linear'], ['zoom'], 13, 9.5, 17, 12], '#8d90b5', 13, 24,
            { 'symbol-placement': 'line', 'symbol-spacing': 320, 'text-max-angle': 30, 'text-rotation-alignment': 'map', 'text-field': ['coalesce', ['get', 'name'], ''] }),
          label('neighbourhood', 'place', ['match', ['get', 'class'], ['neighbourhood', 'quarter'], true, false], ['interpolate', ['linear'], ['zoom'], 12, 9.5, 16, 12], '#8d90b5', 12, 17, caps),
          label('suburb', 'place', ['==', ['get', 'class'], 'suburb'], ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 13], '#a9abcb', 10, 16, caps),
          label('town', 'place', ['match', ['get', 'class'], ['town', 'village'], true, false], ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13], '#a9abcb', 8, 15)
        ]
      };
    }
    function loadStreets() {
      if (streets.state !== 'off') return;
      streets.state = 'loading';
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = ML + '.css'; document.head.appendChild(css);
      const js = document.createElement('script'); js.src = ML + '.js'; js.async = true;
      js.onload = createStreets;
      js.onerror = () => streetsFailed('the map library did not load');
      document.head.appendChild(js);
    }
    function createStreets() {
      try {
        const c = proj && proj.invert([W / 2, H / 2]);
        const m = streets.map = new window.maplibregl.Map({
          container: streets.el, style: streetStyle(), interactive: false, attributionControl: false, trackResize: false,
          pixelRatio: DPR, center: c && isFinite(c[0]) ? c : [0, 0], zoom: zoomFor(ppd), maxZoom: 19, fadeDuration: 150
        });
        const ready = () => { if (streets.state === 'ready') { streets.state = 'live'; changed(true); } };
        m.once('load', ready);
        m.once('idle', ready);
        m.on('error', ev => { if (ev && ev.error) console.warn('street map:', ev.error.message || ev.error); });
        streets.state = 'ready';
        changed(true);
      } catch (err) { streetsFailed(err && err.message); }
    }
    function streetsFailed(why) {
      console.warn('Street map unavailable' + (why ? ': ' + why : ''));
      streets.state = 'failed'; streets.t = 0;
      streets.el.style.visibility = 'hidden';
      $('#attrib').hidden = true;
      setZoomLimit();
    }
    const zoomFor = p => Math.max(0, Math.min(19, Math.log2(360 * p / 512)));
    function syncStreets() {
      const want = streetsOn() && S.view === 'map';
      if (want && ppd >= ST.load) loadStreets();
      const m = streets.map;
      const t = want && streets.state === 'live' ? Math.max(0, Math.min(1, (ppd - ST.from) / (ST.to - ST.from))) : 0;
      if (m && want && streets.state !== 'loading' && (t > 0 || ppd >= ST.preload)) {
        // Tiles load just before the fade starts, so the streets don't pop in.
        const c = proj.invert([W / 2, H / 2]);
        if (c && isFinite(c[0]) && isFinite(c[1])) {
          m.jumpTo({ center: c, zoom: zoomFor(ppd) });
          if (t > 0) { try { m.redraw(); } catch (err) { /* draws on its next frame instead */ } }
        }
      }
      if (m && streets.state === 'live' && streets.labels !== S.layers.labels) {
        streets.labels = S.layers.labels;
        LABEL_LAYERS.forEach(id => { try { m.setLayoutProperty(id, 'visibility', S.layers.labels ? 'visible' : 'none'); } catch (err) { /* style not ready */ } });
      }
      if (t !== streets.t) {
        streets.t = t;
        streets.el.style.opacity = t < 1 ? t.toFixed(3) : '';
        streets.el.style.visibility = t > 0 ? 'visible' : 'hidden';
        $('#attrib').hidden = !(t > 0);
      }
    }
    function setZoomLimit() {
      kMax = (streetsOn() ? ST.maxPpd : ST.flatMaxPpd) / unitPpd();
      zMap.scaleExtent([kMin, kMax]);
      if (inited && S.view === 'map' && mapT.k > kMax) sel.call(zMap.scaleTo, kMax);
    }
    function setStreets(on) { S.layers.streets = on; setZoomLimit(); changed(true); }

    /* ---------- the map area, for the lists ---------- */
    function updateArea() {
      if (!inited || !S.ds) return;
      setProj();
      if (!zoomedIn()) S.areaOn = false;
      let ids = null, sig = 'all';
      if (S.areaOn) {
        ids = new Set();
        let h = 0;
        S.ds.venues.forEach((v, i) => {
          if (!vis(v.lon, v.lat)) return;
          const p = proj([v.lon, v.lat]);
          if (p && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H) { ids.add(v.id); h = (Math.imul(h, 31) + i + 1) | 0; }
        });
        sig = ids.size + ':' + h;
      }
      if (sig === areaSig) return;
      areaSig = sig;
      areaChanged(ids);
    }

    function changed(baseToo) {
      if (baseToo) { baseDirty = true; clearTimeout(areaTimer); areaTimer = setTimeout(updateArea, 160); }
      posDirty = true; overDirty = true;
      if (!rafId) rafId = requestAnimationFrame(frame);
    }
    function frame(time) {
      rafId = 0;
      const anim = !reduceMotion && !document.hidden && (liveMarks > 0 || (S.layers.tours && D.tours.length) || S.route || S.me);
      if (baseDirty || overDirty || posDirty || (anim && time - lastDraw > 33)) {
        if (baseDirty || posDirty) setProj();
        if (baseDirty) { syncStreets(); drawBase(); baseDirty = false; }
        drawOver(time); overDirty = false; lastDraw = time;
      }
      if (anim) rafId = requestAnimationFrame(frame);
    }

    function bandRing(rawWest) {
      const w0 = rawWest, e0 = rawWest + 75, pts = [];
      for (let lat = -60; lat <= 80; lat += 4) pts.push([w0, lat]);
      for (let lon = w0; lon <= e0; lon += 5) pts.push([lon, 80]);
      for (let lat = 80; lat >= -60; lat -= 4) pts.push([e0, lat]);
      for (let lon = e0; lon >= w0; lon -= 5) pts.push([lon, -60]);
      const ring = pts.map(p => [((p[0] % 360) + 540) % 360 - 180, p[1]]);
      ring.push(ring[0]);
      let poly = { type: 'Polygon', coordinates: [ring] };
      if (d3.geoArea(poly) > 2 * Math.PI) poly = { type: 'Polygon', coordinates: [ring.slice().reverse()] };
      return poly;
    }
    function drawBase() {
      const ctx = bx;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const path = d3.geoPath(proj, ctx);
      ctx.fillStyle = C.sea; ctx.fillRect(0, 0, W, H);
      if (streets.t >= 1) return; // the street map covers it all
      if (S.view === 'globe') {
        const R = globeR();
        const g = ctx.createRadialGradient(W / 2, H / 2, R * 0.92, W / 2, H / 2, R * 1.14);
        g.addColorStop(0, 'rgba(150,160,255,0.14)'); g.addColorStop(1, 'rgba(150,160,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(W / 2, H / 2, R * 1.14, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); path(sphere); ctx.fillStyle = '#0a0c1d'; ctx.fill();
      }
      ctx.beginPath(); path(grat); ctx.strokeStyle = C.grat; ctx.lineWidth = 0.6; ctx.stroke();
      if (geo) {
        ctx.beginPath(); path(ppd > 6 ? geo.landHi : geo.landLo); ctx.fillStyle = C.land; ctx.fill();
        ctx.beginPath(); path(geo.lakes); ctx.fillStyle = S.view === 'globe' ? '#0a0c1d' : C.sea; ctx.fill();
        ctx.beginPath(); path(geo.borders); ctx.strokeStyle = C.border; ctx.lineWidth = 0.6; ctx.stroke();
      }
      if (S.layers.belt) {
        const sun = RM.subsolar(S.now), anti = [sun[0] + 180, -sun[1]];
        ctx.fillStyle = 'rgba(2,3,12,0.22)';
        [90, 84, 78].forEach(r => { ctx.beginPath(); path(d3.geoCircle().center(anti).radius(r).precision(3)()); ctx.fill(); });
        const band = RM.clubBand(S.now);
        ctx.beginPath(); path(bandRing(band.raw)); ctx.fillStyle = 'rgba(246,236,216,0.065)'; ctx.fill();
        ctx.setLineDash([2, 5]); ctx.strokeStyle = 'rgba(246,236,216,0.38)'; ctx.lineWidth = 1;
        [band.west, band.east].forEach(lon => { ctx.beginPath(); path({ type: 'LineString', coordinates: d3.range(-60, 80.1, 2).map(lat => [lon, lat]) }); ctx.stroke(); });
        ctx.setLineDash([]);
      }
    }

    function computeMarks() {
      marks = []; cityMarks = []; festMarks = []; stopMarks = []; venueLabels = []; liveMarks = 0;
      const t = S.now, ds = S.ds;
      venueMode = ppd >= 150;
      const r0 = venueMode ? Math.min(5.2, 3 + Math.log2(ppd / 150) * 0.7) : Math.min(3.4, 2.1 + Math.max(0, Math.log2(ppd / 2.2)) * 0.3);
      const spread = venueMode ? 1.6 : 1.32 * (1 + Math.min(1.4, Math.max(0, Math.log2(ppd / 4)) * 0.3));
      const heatBy = {};
      D.heat.forEach(h => { heatBy[h.city.id] = h.heat; });
      const pad = 160;
      const onScreen = p => p && p[0] >= -pad && p[0] <= W + pad && p[1] >= -pad && p[1] <= H + pad;
      D.byCity.forEach((list, cid) => {
        const c = ds.cityById[cid];
        const pc = vis(c.lon, c.lat) ? proj([c.lon, c.lat]) : null, cityIn = onScreen(pc);
        // Zoomed out, a city is one spiral at its center. Zoomed in, each venue is checked on its own:
        // at street level the city center is often far off-screen while its venues are in view.
        if (!cityIn && !venueMode) return;
        const regular = list.filter(e => e.type !== 'festival');
        const liveN = list.filter(e => RM.isLive(e, t)).length;
        if (venueMode) {
          const byV = new Map();
          regular.forEach(e => { if (!byV.has(e.venueId)) byV.set(e.venueId, []); byV.get(e.venueId).push(e); });
          byV.forEach((evs, vid) => {
            const v = ds.venueById[vid];
            if (!vis(v.lon, v.lat)) return;
            const pv = proj([v.lon, v.lat]); if (!onScreen(pv)) return;
            const sp = r0 * spread;
            evs.forEach((e, i) => { const a = i * 2.39996, rr = sp * Math.sqrt(i), live = RM.isLive(e, t); if (live) liveMarks++; marks.push({ e: e, x: pv[0] + rr * Math.cos(a), y: pv[1] + rr * Math.sin(a), r: r0, live: live, so: RM.statusAt(e, t) === 'soldout', seed: e.seed }); });
            const next = evs.filter(e => e.end > t).sort((a, b) => a.start - b.start)[0] || evs[0];
            venueLabels.push({ v: v, x: pv[0], y: pv[1], n: evs.length, R: sp * Math.sqrt(Math.max(0, evs.length - 1)) + r0, next: next });
          });
          if (cityIn) cityMarks.push({ c: c, x: pc[0], y: pc[1], R: 0, n: list.length, live: liveN, heat: heatBy[cid] || 0 });
        } else {
          const N = Math.min(regular.length, 110), sp = r0 * spread;
          for (let i = 0; i < N; i++) {
            const e = regular[i], a = i * 2.39996, rr = sp * Math.sqrt(i), live = RM.isLive(e, t);
            if (live) liveMarks++;
            marks.push({ e: e, x: pc[0] + rr * Math.cos(a), y: pc[1] + rr * Math.sin(a), r: r0, live: live, so: RM.statusAt(e, t) === 'soldout', seed: e.seed });
          }
          cityMarks.push({ c: c, x: pc[0], y: pc[1], R: sp * Math.sqrt(Math.max(0, N - 1)) + r0 + 2, n: list.length, live: liveN, heat: heatBy[cid] || 0 });
        }
      });
      if (S.layers.fest) {
        const seen = {};
        D.win.filter(e => e.type === 'festival').sort((a, b) => RM.isLive(b, t) - RM.isLive(a, t) || a.start - b.start).forEach(e => {
          if (seen[e.festivalId]) return; seen[e.festivalId] = 1;
          const v = venue(e); if (!vis(v.lon, v.lat)) return;
          const p = proj([v.lon, v.lat]); if (!p) return;
          festMarks.push({ e: e, x: p[0], y: p[1], r: venueMode ? 8 : 5.5, live: RM.isLive(e, t) });
          if (RM.isLive(e, t)) liveMarks++;
        });
      }
      if (S.route) routeGigs(S.route).forEach((e, i) => { const v = venue(e); if (!vis(v.lon, v.lat)) return; const p = proj([v.lon, v.lat]); if (p) stopMarks.push({ e: e, i: i, x: p[0], y: p[1] }); });
    }

    function drawOver(time) {
      const ctx = ox, t = S.now, ds = S.ds;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (posDirty) { computeMarks(); posDirty = false; }
      const path = d3.geoPath(proj, ctx);
      if (S.layers.heat && !venueMode) {
        const boost = Math.min(3, Math.max(1, Math.sqrt(ppd / 2.2)));
        cityMarks.forEach(cm => {
          if (!cm.heat) return;
          const rad = (8 + cm.heat * 0.42) * boost;
          const g = ctx.createRadialGradient(cm.x, cm.y, 0, cm.x, cm.y, rad);
          g.addColorStop(0, 'rgba(246,236,216,0.14)'); g.addColorStop(0.45, 'rgba(246,236,216,0.05)'); g.addColorStop(1, 'rgba(246,236,216,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cm.x, cm.y, rad, 0, Math.PI * 2); ctx.fill();
        });
      }
      const flow = reduceMotion ? 0 : -(time / 45) % 18;
      if (S.layers.tours && D.tours.length) {
        ctx.save(); ctx.setLineDash([3, 6]); ctx.lineDashOffset = flow; ctx.strokeStyle = 'rgba(246,236,216,0.26)'; ctx.lineWidth = 1;
        D.tours.forEach(seg => { ctx.beginPath(); path({ type: 'LineString', coordinates: seg }); ctx.stroke(); });
        ctx.restore();
      }
      if (S.route) {
        const gigs = routeGigs(S.route);
        if (gigs.length > 1) {
          ctx.save(); ctx.setLineDash([7, 5]); ctx.lineDashOffset = flow * 1.4; ctx.strokeStyle = 'rgba(246,236,216,0.9)'; ctx.lineWidth = 1.6;
          ctx.beginPath(); path({ type: 'LineString', coordinates: gigs.map(e => [venue(e).lon, venue(e).lat]) }); ctx.stroke();
          ctx.restore();
        }
      }
      marks.forEach(m => {
        const col = gen(m.e).color;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        if (m.so) { ctx.fillStyle = C.sea; ctx.fill(); ctx.lineWidth = 1.3; ctx.strokeStyle = col; ctx.stroke(); }
        else { ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(7,8,20,0.85)'; ctx.stroke(); }
      });
      marks.forEach(m => {
        if (!m.live) return;
        const ph = reduceMotion ? 0.3 : ((time / 1900) + m.seed) % 1;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r + 1.4 + ph * 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(246,236,216,' + (reduceMotion ? 0.7 : (1 - ph) * 0.75).toFixed(3) + ')'; ctx.lineWidth = 1.1; ctx.stroke();
      });
      festMarks.forEach(f => {
        const col = gen(f.e).color, r = f.r;
        ctx.beginPath(); ctx.moveTo(f.x, f.y - r * 1.25); ctx.lineTo(f.x + r * 1.25, f.y); ctx.lineTo(f.x, f.y + r * 1.25); ctx.lineTo(f.x - r * 1.25, f.y); ctx.closePath();
        ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = C.ink; ctx.stroke();
        if (f.live) { const ph = reduceMotion ? 0.3 : ((time / 1900)) % 1; ctx.beginPath(); ctx.arc(f.x, f.y, r * 1.6 + ph * 8, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(246,236,216,' + (reduceMotion ? 0.7 : (1 - ph) * 0.8).toFixed(3) + ')'; ctx.lineWidth = 1.2; ctx.stroke(); }
      });
      if (stopMarks.length) {
        ctx.font = '700 11px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        stopMarks.forEach(s => {
          ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, Math.PI * 2); ctx.fillStyle = C.now; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = C.sea; ctx.stroke();
          ctx.fillStyle = '#15131f'; ctx.fillText(String(s.i + 1), s.x, s.y + 0.5);
        });
        ctx.textAlign = 'left';
      }
      // You are here (Near me): a light dot with a slow pulse, under the labels.
      let meP = null;
      if (S.me && vis(S.me.lon, S.me.lat)) {
        meP = proj([S.me.lon, S.me.lat]);
        if (meP) {
          const ph = reduceMotion ? 0.5 : (time / 2400) % 1;
          ctx.beginPath(); ctx.arc(meP[0], meP[1], 7 + ph * 12, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(120,200,255,' + ((1 - ph) * 0.7).toFixed(3) + ')'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.beginPath(); ctx.arc(meP[0], meP[1], 5.5, 0, Math.PI * 2); ctx.fillStyle = '#78c8ff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#f6f8ff'; ctx.stroke();
        }
      }
      /* labels */
      const boxes = [];
      const put = (text, x, y, color, font, align) => {
        ctx.font = font || ('600 11px ' + FONT);
        const w = ctx.measureText(text).width, x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
        const box = [x0 - 3, y - 8, x0 + w + 3, y + 8];
        if (box[0] < 4 || box[2] > W - 4 || box[1] < 4 || box[3] > H - 4) return false;
        for (let i = 0; i < boxes.length; i++) { const b = boxes[i]; if (!(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3])) return false; }
        boxes.push(box);
        ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(7,8,20,0.92)';
        ctx.strokeText(text, x0, y); ctx.fillStyle = color; ctx.fillText(text, x0, y);
        return true;
      };
      boxes.push([0, 0, 260, 50], [W - 220, 0, W, 50]);
      if (meP) put('You are here', meP[0] + 11, meP[1], '#9fd8ff', '650 11px ' + FONT);
      if (S.layers.belt && streets.t < 1) { // the band itself is under the street map
        const band = RM.clubBand(S.now);
        const edge = (lon, text, align) => {
          let p = null;
          if (S.view === 'map') { const q = proj([lon, 0]); if (q) p = [q[0], 66]; }
          else { for (let lat = 60; lat >= -40; lat -= 10) { if (vis(lon, lat)) { const q = proj([lon, lat]); if (q) { p = q; break; } } } }
          if (p) put(text, p[0] + (align === 'right' ? -6 : 6), p[1], C.now, '600 11px ' + FONT, align);
        };
        edge(band.west, '11 pm, club hours start', 'left');
        edge(band.east, '4 am', 'right');
      }
      if (stopMarks.length) {
        stopMarks.forEach(s => { const c = city(s.e); put(c.name + ', ' + tDate(s.e.start, c.tz), s.x + 13, s.y, C.ink, '650 11px ' + FONT); });
      }
      if (S.layers.labels) {
        if (!venueMode) {
          const limit = ppd < 3 ? 14 : ppd < 8 ? 28 : ppd < 30 ? 60 : 200;
          cityMarks.slice().sort((a, b) => b.n - a.n).slice(0, limit).forEach(cm => put(cm.c.name, cm.x + cm.R + 4, cm.y, C.ink2));
        } else {
          cityMarks.forEach(cm => put(cm.c.name, cm.x, cm.y - 22, C.ink, '700 13px ' + FONT, 'center'));
          // Venues without a real position sit near the city center; at street level that would look exact.
          venueLabels.sort((a, b) => b.n - a.n).forEach(vl => {
            if (!put(vl.v.approx ? vl.v.name + ' (location approximate)' : vl.v.name, vl.x + vl.R + 5, vl.y, vl.v.approx ? C.ink3 : C.ink2)) return;
            // At street level, for planning: when the next party there is and who's on, in its genre's colour.
            const e = vl.next;
            if (ppd < ST.detailPpd || !e) return;
            const c = city(e), who = lineupNames(e, 2) || e.title;
            let line = (RM.isLive(e, t) ? 'Now' : tDay(e.start, c.tz) + ' ' + tTime(e.start, c.tz)) + ' · ' + who;
            if (line.length > 46) line = line.slice(0, 45) + '…';
            put(line + (vl.n > 1 ? '  +' + (vl.n - 1) : ''), vl.x + vl.R + 5, vl.y + 17, gen(e).color, '500 10.5px ' + FONT);
          });
        }
        if (ppd >= 2.4) festMarks.forEach(f => put(f.e.series, f.x + f.r * 1.4 + 5, f.y, C.ink, '650 11px ' + FONT));
      }
      /* selection */
      if (S.sel) {
        const e = ds.eventById[S.sel];
        if (e) {
          const m = marks.find(mm => mm.e === e) || festMarks.find(f => f.e === e);
          let p = m ? [m.x, m.y] : null;
          if (!p) { const v = venue(e); if (vis(v.lon, v.lat)) p = proj([v.lon, v.lat]); }
          if (p) {
            ctx.strokeStyle = C.now; ctx.lineWidth = 1.6;
            ctx.beginPath(); ctx.arc(p[0], p[1], 10, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath();
            [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(d => { ctx.moveTo(p[0] + d[0] * 13, p[1] + d[1] * 13); ctx.lineTo(p[0] + d[0] * 19, p[1] + d[1] * 19); });
            ctx.stroke();
          }
        }
      }
    }

    function hit(x, y) {
      const touch = lastPointer !== 'mouse', grow = touch ? 1.7 : 1;
      let best = null, bd = Infinity;
      const near = (px, py, rad, val) => { const d = (px - x) * (px - x) + (py - y) * (py - y); if (d < rad * rad && d < bd) { bd = d; best = val; } };
      festMarks.forEach(f => near(f.x, f.y, (f.r + 7) * grow, { kind: 'event', e: f.e }));
      stopMarks.forEach(s => near(s.x, s.y, 12 * grow, { kind: 'event', e: s.e }));
      if (best) return best;
      if (ppd >= 25) { marks.forEach(m => near(m.x, m.y, Math.max(m.r + 4, 8) * grow, { kind: 'event', e: m.e })); if (best) return best; }
      cityMarks.forEach(cm => near(cm.x, cm.y, (Math.max(cm.R, 6) + 6) * grow, { kind: 'city', c: cm.c, cm: cm }));
      return best;
    }
    function showTip(h, x, y) {
      if (!h) return hideTip();
      let html;
      if (h.kind === 'city') {
        html = '<b>' + esc(h.c.name) + '</b>' + plural(h.cm.n, 'event', 'events') + ' ' + WIN_LABEL[S.win] + (h.cm.live && S.win !== 'live' ? ', ' + h.cm.live + ' live now' : '') + '<div class="tline">Select to zoom in</div>';
      } else {
        const e = h.e, c = city(e), v = venue(e), G = gen(e);
        html = '<b>' + esc(e.title) + '</b>' + esc(v.name) + ', ' + esc(c.name) +
          '<div class="tline">' + tDay(e.start, c.tz) + ' ' + tTime(e.start, c.tz) + ' to ' + tTime(e.end, c.tz) + ' local</div>' +
          '<div class="tline"><i class="gdot" style="--c:' + G.color + '"></i>' + esc(G.name) + ', ' + esc(e.sub) + '</div><div class="tline">' + statusChip(e) + '</div>';
      }
      tip.innerHTML = html; tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let tx = x + 14, ty = y + 14;
      if (tx + tw > W - 8) tx = x - tw - 14;
      if (ty + th > H - 8) ty = y - th - 14;
      tip.style.left = Math.max(8, tx) + 'px'; tip.style.top = Math.max(8, ty) + 'px';
    }
    function hideTip() { tip.hidden = true; }

    return { init: init, changed: changed, setView: setView, home: home, flyTo: flyTo, flyToCity: flyToCity, flyToVenue: flyToVenue, flyToEvent: flyToEvent, fitEvents: fitEvents, focusNear: focusNear, zoomBy: zoomBy, resize: resize, setStreets: setStreets };
  })();

  /* ---------- live feed (events.json written by the pipeline) ---------- */
  function feedAge() {
    if (!S.feed) return '';
    const m = Math.round((Date.now() - Date.parse(S.feed.generatedAt)) / 60000);
    return m < 60 ? 'updated ' + Math.max(1, m) + 'm ago' : m < 48 * 60 ? 'updated ' + Math.round(m / 60) + 'h ago' : 'updated ' + Math.round(m / 1440) + 'd ago';
  }
  // Some listings give 0,0 or whole-degree positions for venues with no real one (older feeds
  // still have them): place those near the city center, one spot per venue, like the pipeline does.
  function venuePos(x, c) {
    const lat = x.venue.lat, lon = x.venue.lon;
    const none = !isFinite(lat) || !isFinite(lon) || (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) || (Number.isInteger(lat) && Number.isInteger(lon));
    if (!none || !c || !isFinite(c.lat)) return { lat: lat, lon: lon, approx: !!x.venue.approx };
    let h = 0;
    for (const ch of c.id + ':' + norm(x.venue.name)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    const a = ((h >>> 0) % 360) * Math.PI / 180, r = 0.012 + ((h >>> 8) % 100) / 100 * 0.02;
    return { lat: c.lat + r * Math.sin(a), lon: c.lon + r * Math.cos(a) / Math.cos(c.lat * Math.PI / 180), approx: true };
  }
  function hashSeed(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; }
  function fromFeed(feed) {
    const ds = { source: 'feed', cities: [], cityById: {}, venues: [], venueById: {}, artists: [], artistById: {}, events: [], eventById: {}, festivals: [] };
    (feed.cities || []).forEach(c => { const cc = { id: c.id, name: c.name, cc: c.country, lat: c.lat, lon: c.lon, tz: c.tz || 'UTC', region: c.region || 'eu', cur: c.currency || 'USD', weight: 3, venues: [], residents: [] }; ds.cities.push(cc); ds.cityById[cc.id] = cc; });
    const appearances = {};
    (feed.events || []).forEach(x => (x.lineup || []).forEach(n => { const k = norm(n); appearances[k] = (appearances[k] || 0) + 1; }));
    const artistId = name => {
      const k = norm(name), id = 'n:' + k;
      if (!ds.artistById[id]) { const a = { id: id, name: name, genre: 'misc', tier: appearances[k] > 1 ? 2 : 3 }; ds.artists.push(a); ds.artistById[id] = a; }
      return id;
    };
    (feed.events || []).forEach(x => {
      const start = Date.parse(x.start), end = Date.parse(x.end);
      if (!isFinite(start) || !isFinite(end)) return;
      let c = ds.cityById[x.cityId];
      if (!c) { c = { id: x.cityId, name: x.cityId, cc: '', lat: x.venue.lat, lon: x.venue.lon, tz: x.tz || 'UTC', region: 'eu', cur: 'USD', weight: 1, venues: [], residents: [] }; ds.cities.push(c); ds.cityById[c.id] = c; }
      const pos = venuePos(x, c);
      const vkey = 'v:' + x.cityId + ':' + norm(x.venue.name) + ':' + pos.lat.toFixed(3) + ':' + pos.lon.toFixed(3);
      if (!ds.venueById[vkey]) { const v = { id: vkey, cityId: c.id, name: x.venue.name, type: 'club', cap: 0, lat: pos.lat, lon: pos.lon, approx: pos.approx }; ds.venues.push(v); ds.venueById[vkey] = v; c.venues.push(v); }
      const ids = (x.lineup || []).map(artistId);
      const genres = (x.genres || []).map(g => g === 'other' ? 'misc' : g).filter(g => RM.GENRE[g]);
      const lp = RM.localParts(x.tz || c.tz, start);
      const pop = Number.isFinite(x.popularity) ? x.popularity : null;
      const e = {
        id: x.id, cityId: c.id, venueId: vkey, dayKey: new Date(start).toISOString().slice(0, 10), type: x.type || 'club',
        genre: genres[0] || 'misc', festGenres: genres.length > 1 ? genres : undefined, sub: (x.tags && x.tags[0]) || (RM.GENRE[genres[0]] || RM.OTHER).name,
        title: x.title, series: x.title, heads: ids.slice(0, 1), support: ids.slice(1), headTier: ids.length && ds.artistById[ids[0]].tier === 2 ? 2 : 3, anl: false,
        start: start, end: end, cap: pop ? Math.max(150, Math.min(6000, pop * 1.6)) : 400, base: x.status === 'soldout' ? 1.05 : 0.75,
        priceMin: x.price ? x.price.min : 0, priceMax: x.price ? x.price.max : 0, cur: (x.price && x.price.currency) || c.cur || 'USD',
        free: !!(x.price && x.price.free), door: false, age: x.age || '', tags: x.tags || [], streamed: false, festivalId: null,
        labels: x.labels || [], promoters: x.promoters || [],
        url: x.sources && x.sources[0] && x.sources[0].url, sources: x.sources || [], src: x.sources && x.sources[0] && x.sources[0].name,
        extStatus: x.status || 'unknown', soldOutAt: x.status === 'soldout' ? start - DAY : null, finalAt: null, popularity: pop,
        ldow: lp.dow, lh: lp.h, seed: hashSeed(x.id)
      };
      if (x.sets && x.sets.length) {
        const timed = x.sets.map(st => ({ who: st.name, start: Date.parse(st.start) })).filter(st => isFinite(st.start)).sort((p, q) => p.start - q.start);
        e.sets = timed.map((st, i) => ({ who: st.who, start: st.start, end: i < timed.length - 1 ? timed[i + 1].start : end }));
        e.setsTimed = true;
      } else {
        e.sets = (x.lineup || []).map(n => ({ who: n, start: start, end: end }));
        e.setsTimed = false;
      }
      ds.events.push(e);
    });
    ds.events.sort((a, b) => a.start - b.start);
    ds.events.forEach(e => { ds.eventById[e.id] = e; });
    return ds;
  }
  function renderAboutData() {
    const box = $('#about-data'); if (!box) return;
    if (S.ds.source === 'demo') {
      box.innerHTML = '<h3>What\'s real</h3><p>The 72 cities, their time zones, the day and night line and the club-hours band are real and move with the clock.</p>' +
        '<h3>What\'s demo</h3><p>Every event, artist, venue, price, ticket status, listing source and count is fictional. It\'s generated in your browser so there is always a believable night to show, wherever the clock is.</p>' +
        '<p>Once the scraper job has run, this page reads its events.json file and switches to real listings.</p>';
      return;
    }
    const f = S.feed, nCities = new Set(S.ds.events.map(e => e.cityId)).size;
    const from = r => r.scrapedAt ? ' from ' + new Date(r.scrapedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    const status = r => r.error ? r.error : r.stale ? 'New scrape failed; showing the one' + from(r) : r.cached ? 'Saved scrape' + from(r)
      : r.ok ? (!r.kept && r.warnings && r.warnings.length ? r.warnings[0] : 'OK') : '';
    const rows = (f.sources || []).map(r => '<tr><td>' + esc(r.label) + '</td><td class="n">' + fmtN(r.kept || 0) + '</td><td>' + esc(status(r)) + '</td></tr>').join('');
    box.innerHTML = '<h3>' + (f.sample ? 'Sample feed' : 'Live listings') + '</h3>' +
      '<p>' + plural(S.ds.events.length, 'event', 'events') + ' in ' + plural(nCities, 'city', 'cities') + ', ' + feedAge() + ' (' + esc(new Date(f.generatedAt).toLocaleString()) + '). ' + plural(f.merged || 0, 'duplicate was', 'duplicates were') + ' merged across platforms.</p>' +
      (f.sample ? '<p>This is the built-in sample feed: fictional events in each platform\'s format, for trying the pipeline without API keys.</p>' : '') +
      '<table class="srctable"><thead><tr><th>Source</th><th class="n">Events</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p>Every listing links back to its source page. Sell-out odds and surges need history and stay off until the feed has some.</p>' + streamsAbout();
  }
  function streamsAbout() {
    const src = (S.streamFile && S.streamFile.sources) || [], yt = src.find(x => x.id === 'youtube');
    if (!src.length && !S.ntsLive) return '';
    return '<p>Livestreams come from NTS Radio\'s public schedule' + (yt && (yt.ok || yt.stale) ? ' and from YouTube, which lists live and scheduled streams on channels such as Boiler Room, Cercle and HÖR' : '') + '. The street map uses OpenStreetMap data, drawn from OpenFreeMap\'s tiles.</p>';
  }
  async function loadArchiveCount() {
    const el = $('#about-archive-count'); if (!el || el.dataset.done) return;
    el.dataset.done = '1';
    try {
      const res = await fetch('archive/summary.json', { cache: 'no-store' });
      if (!res.ok) return;
      const s = await res.json();
      if (s.events) el.textContent = plural(s.events, 'listing', 'listings') + ' so far, from ' + new Date(s.firstEvent).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' on. ';
    } catch (err) { /* no archive yet */ }
  }
  async function loadFeed() {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch('events.json', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const feed = await res.json();
      return feed && Array.isArray(feed.events) && feed.events.length ? feed : null;
    } catch (err) { return null; }
  }

  /* ---------- wiring ---------- */
  function onActivate(ev) {
    const t = ev.target;
    const act = t.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'close') return closeDrawer();
      if (a === 'copy') return copyDetails();
      if (a === 'share') return shareEvent();
      if (a === 'route') { setRoute(act.dataset.artist); return; }
      if (a === 'route-clear') return setRoute(null);
      if (a === 'label-clear') return setLabel(null);
      if (a === 'label') return setLabel({ key: lkey(act.dataset.name), name: act.dataset.name, kind: act.dataset.kind === 'promoter' ? 'promoter' : 'label' });
      if (a === 'live-all') { S.liveAll = true; renderLive(); return; }
      if (a === 'list-all') { S.listAll = true; renderListings(); return; }
      if (a === 'privacy-settings') { ev.preventDefault(); privacySettings(); return; }
      if (a === 'area-all') { MapView.home(true); return; }
    }
    const opt = t.closest('#results [role="option"]');
    if (opt) return chooseResult(+opt.dataset.i);
    const tab = t.closest('[data-tab]');
    if (tab) { track('open_tab', { tab: tab.dataset.tab }); return selectTab(tab.dataset.tab); }
    const evRow = t.closest('[data-ev]');
    if (evRow) return openEvent(evRow.dataset.ev);
    const sg = t.closest('[data-sgenre]');
    if (sg) { setGenre(sg.dataset.sgenre, true); MapView.flyToCity(S.ds.cityById[sg.dataset.city]); return; }
    const cityEl = t.closest('[data-city]');
    if (cityEl) return MapView.flyToCity(S.ds.cityById[cityEl.dataset.city]);
    const gEl = t.closest('.grow[data-genre]');
    if (gEl) return setGenre(gEl.dataset.genre, false);
  }
  function wire() {
    document.addEventListener('click', onActivate);
    document.addEventListener('keydown', ev => {
      const tag = (ev.target.tagName || '').toLowerCase(), typing = tag === 'input' || tag === 'textarea';
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.getAttribute && ev.target.getAttribute('role') === 'button' && ev.target.tagName !== 'BUTTON') { ev.preventDefault(); onActivate(ev); return; }
      if (ev.key === 'Escape') {
        if (!$('#results').hidden) return hideResults();
        if (S.sel) return closeDrawer();
        if (!$('#layers').hidden) return toggleLayers(false);
        if (S.route) return setRoute(null);
        if (S.label) return setLabel(null);
        return;
      }
      if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === '/') { ev.preventDefault(); $('#q').focus(); }
      else if (ev.key === 'g') MapView.setView(S.view === 'map' ? 'globe' : 'map');
      else if (/^[1-9]$/.test(ev.key) && S.mode !== 'narrow') { const id = tabIdsFor(S.mode)[+ev.key - 1]; if (id) selectTab(id, true); }
    });
    $('#tabbar').addEventListener('keydown', ev => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const ids = tabIdsFor(S.mode), cur = ids.indexOf(S.mode === 'wide' ? S.tab.right : S.tab.single);
      selectTab(ids[(cur + (ev.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length], true);
    });
    $('#win').addEventListener('click', ev => { const b = ev.target.closest('button[data-win]'); if (b) { track('set_filter', { filter: 'time', value: b.dataset.win }); setWindow(b.dataset.win); } });
    $('#win-select').addEventListener('change', ev => { track('set_filter', { filter: 'time', value: ev.target.value }); setWindow(ev.target.value); });
    // Phones: the map key folds away.
    $('#lg-toggle').addEventListener('click', () => { const lg = $('#legend'), open = !lg.classList.contains('open'); lg.classList.toggle('open', open); $('#lg-toggle').setAttribute('aria-expanded', String(open)); $('#lg-toggle').textContent = open ? 'Hide key' : 'Key'; });
    // Phones: a Map button appears once the map has scrolled out of view.
    const fab = $('#mapfab');
    if ('IntersectionObserver' in window) {
      let mapGone = false;
      const showFab = () => { fab.hidden = !(S.mode === 'narrow' && mapGone && !S.sel); };
      new IntersectionObserver(es => { mapGone = !es[es.length - 1].isIntersecting; showFab(); }, { threshold: 0, rootMargin: '-35% 0px 0px 0px' }).observe($('#stage'));
      S.showFab = showFab;
    }
    fab.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); fab.hidden = true; });
    document.addEventListener('toggle', ev => { if (ev.target.classList && ev.target.classList.contains('brief-more')) S.briefOpen = ev.target.open; }, true);
    sheetDrag();
    $('#gchips').addEventListener('click', ev => { const b = ev.target.closest('button[data-genre]'); if (b) { track('set_filter', { filter: 'genre', value: b.dataset.genre }); setGenre(b.dataset.genre, false); } });
    $('#viewtoggle').addEventListener('click', ev => { const b = ev.target.closest('button[data-view]'); if (b) { track('set_view', { view: b.dataset.view }); MapView.setView(b.dataset.view); } });
    // Outbound links that say what to report (tickets, streams): data-track names the event, data-p-* are its details.
    document.addEventListener('click', ev => {
      const a = ev.target.closest && ev.target.closest('a[data-track]');
      if (!a) return;
      const params = {};
      Object.keys(a.dataset).forEach(k => { if (/^p[A-Z]/.test(k)) params[k.slice(1).replace(/^[A-Z]/, ch => ch.toLowerCase())] = a.dataset[k]; });
      track(a.dataset.track, params);
    }, true);
    $('#zoom-in').addEventListener('click', () => MapView.zoomBy(2));
    $('#zoom-out').addEventListener('click', () => MapView.zoomBy(0.5));
    $('#zoom-home').addEventListener('click', () => MapView.home(true));
    $('#locate').addEventListener('click', () => { movedSinceStart = true; locateMe(); });
    // Once the visitor moves the map or searches, a late position from startNear() stays out of the way.
    ['pointerdown', 'wheel', 'keydown'].forEach(type => $('#stage').addEventListener(type, () => { movedSinceStart = true; }, { capture: true, passive: true }));
    $('#q').addEventListener('focus', () => { movedSinceStart = true; });
    $('#brand').addEventListener('click', ev => { ev.preventDefault(); setRoute(null); if (S.label) setLabel(null); if (S.sel) closeDrawer(); MapView.home(true); });
    $('#layers-btn').addEventListener('click', () => toggleLayers($('#layers').hidden));
    const lyMap = { 'ly-belt': 'belt', 'ly-heat': 'heat', 'ly-fest': 'fest', 'ly-tours': 'tours', 'ly-labels': 'labels' };
    Object.keys(lyMap).forEach(id => $('#' + id).addEventListener('change', ev => { S.layers[lyMap[id]] = ev.target.checked; MapView.changed(true); }));
    $('#ly-streets').addEventListener('change', ev => MapView.setStreets(ev.target.checked));
    $('#peak-pill').addEventListener('click', () => selectTab('peakcon', true));
    $('#demo-chip').addEventListener('click', openAbout);
    $('.demo-note').addEventListener('click', openAbout);
    $('.demo-note').style.cursor = 'pointer';
    $('#scrim').addEventListener('click', closeDrawer);
    const q = $('#q');
    q.addEventListener('input', () => renderResults(q.value));
    q.addEventListener('focus', () => { if (q.value) renderResults(q.value); });
    q.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); moveActive(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveActive(-1); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (activeIdx >= 0) chooseResult(activeIdx); }
    });
    document.addEventListener('pointerdown', ev => { if (!ev.target.closest('.search')) hideResults(); if (!ev.target.closest('#layers') && !ev.target.closest('#layers-btn')) toggleLayers(false); });
    window.addEventListener('resize', () => layout());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { S.now = Date.now(); refresh(); MapView.changed(true); } });
  }
  function toggleLayers(open) { $('#layers').hidden = !open; $('#layers-btn').setAttribute('aria-expanded', String(open)); }
  function openAbout() { renderAboutData(); loadArchiveCount(); $('#about-analytics').hidden = !window.RM_GA; const d = $('#about'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }

  /* ---------- start ---------- */
  async function boot() {
    const streamsP = Promise.all([loadStreamFile(), loadNtsLive()]);
    const feed = await loadFeed();
    if (feed) { S.feed = feed; S.ds = fromFeed(feed); S.win = '7d'; }
    else S.ds = RM.generate(S.now);
    derive();
    buildPanels();
    buildGenreChips();
    layout();
    wire();
    renderAll();
    MapView.init();
    startNear();
    updateClock();
    setInterval(updateClock, 10000);
    setInterval(() => { S.now = Date.now(); derive(); renderAll(); MapView.changed(true); }, 30000);
    streamsP.then(() => { S.streamsTried = true; mergeStreams(); renderStreams(); });
    setInterval(() => refreshStreams(true), 15 * 60000);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => MapView.changed(false));
  }
  boot();
})();
