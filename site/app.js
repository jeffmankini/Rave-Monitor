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
  // Color themes (config/themes.json, from the build). The page's colors are CSS variables that the
  // head already set from the visitor's pick; the canvas map and the street map take theirs from here.
  const THEMES = window.RM_THEMES && Array.isArray(window.RM_THEMES.list) && window.RM_THEMES.list.length ? window.RM_THEMES : null;
  const themeById = id => (THEMES && THEMES.list.find(t => t.id === id)) || null;
  // Your own colors (site/themekit.js works out the rest from a background and an accent),
  // as the head applied them from local storage.
  const KIT = window.RM_THEMEKIT || null;
  const ownFrom = (bg, accent) => KIT ? { id: 'custom', name: 'Your own', bg, accent, c: KIT.custom(bg, accent) } : null;
  let OWN = (() => { try { const x = JSON.parse(localStorage.getItem('rm_theme_custom') || 'null'); return x ? ownFrom(x.bg, x.accent) : null; } catch (err) { return null; } })();
  const currentTheme = () => {
    const id = document.documentElement.getAttribute('data-theme');
    return (id === 'custom' && OWN) || themeById(id) || themeById(THEMES && THEMES.def);
  };
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
    layers: { belt: true, heat: true, fest: true, tours: false, venues: true, labels: true, streets: true },
    sel: null, route: null, mode: null, tab: { right: 'listings', single: 'listings' }, liveAll: false, listAll: false, venAll: false, ds: null,
    crewKind: 'promoter', crewAll: false, // the Promoters tab: promoters and groups, or record labels
    // Lists follow the map once you zoom in: area is the set of venue ids in view, or null.
    area: null, areaOn: false,
    // A record label, promoter or venue to filter by: { key, name, kind: 'label' | 'promoter' | 'venue' }, or null.
    // A venue also carries its directory entry (venue) and the feed's venue ids that are it (vids).
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
  // Artists compare the same way, except that letters in any script count (as worker/api/src/keys.js).
  const akey = s => norm(s).replace(/['’‘`´]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const labelsOf = e => (e.labels || []).concat(e.promoters || []);
  const hasLabel = e => S.label.kind === 'venue' ? S.label.vids.has(e.venueId) : labelsOf(e).some(n => lkey(n) === S.label.key);

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
    // A label or venue filter narrows everything to its nights; Peakcon stays the whole scene's.
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
    venues: { label: 'Venues', render: renderVenues },
    promoters: { label: 'Promoters', render: renderPromoters },
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
  // Follow and Save buttons, when the site has accounts (window.RM_ACCOUNTS). site/account.js keeps them
  // in step with what the visitor follows and has saved; there are none for demo data.
  const ACCOUNTS = !!(window.RM_ACCOUNTS && window.RM_ACCOUNTS.api);
  const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/></svg>';
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>';
  function followBtn(kind, key, name, cityId, mini) {
    if (!ACCOUNTS || !key || S.ds.source === 'demo') return '';
    return '<button type="button" class="fbtn' + (mini ? ' mini' : ' btn') + '" data-follow="' + kind + '" data-key="' + esc(key) + '" data-name="' + esc(name) + '"' + (cityId ? ' data-city="' + esc(cityId) + '"' : '') +
      ' aria-pressed="false" aria-label="' + esc('Follow ' + name) + '">' + (mini ? STAR : 'Follow') + '</button>';
  }
  const saveBtn = e => ACCOUNTS && S.ds.source !== 'demo' ? '<button class="btn sbtn" type="button" data-save="' + esc(e.id) + '" aria-pressed="false">' + HEART + '<span>Save</span></button>' : '';
  // A venue nobody has listed yet (from OpenStreetMap) is followed by the id it will have once listed.
  const venueFollowKey = x => x.osmOnly ? x.cityId + '-' + (slugify(vkey(x.name, x.city.name)) || 'venue') : x.id;
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
    const area = D.L.area && !(S.label && S.label.kind === 'venue'); // a venue's nights are all in one place
    const txt = '<b>' + plural(list.length, 'listing', 'listings') + '</b>' + (S.label ? ' for ' + esc(S.label.name) : '') + ' ' + WIN_LABEL[S.win] + (area ? ' in this area' : '') + '.' +
      (area && S.mode === 'narrow' ? ' <button type="button" class="linkish" data-act="area-all">Show everywhere</button>' : '');
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
    // A venue, promoter or label in focus: its card first.
    const card = !S.label ? '' : S.label.kind === 'venue' ? venueCard(S.label.venue, null, false) : crewCard(crewOf(S.label.kind === 'label' ? 'label' : 'promoter', S.label.key, S.label.name), null, false);
    if (!list.length && card && S.label.kind === 'venue' && S.label.venue.unlisted) {
      body('listings').innerHTML = card + '<p class="fine">No listings for ' + esc(S.label.name) + ' yet. When a night there is listed, it shows up here and on the map.</p>';
      meta('listings', ''); return;
    }
    if (!list.length) {
      body('listings').innerHTML = card + (card ? '' : areaBar()) + '<p class="fine">No listings ' + (S.label ? 'for ' + esc(S.label.name) + ' ' : '') + WIN_LABEL[S.win] + (D.L.area && !card ? ' in this area' : '') + (S.genres.size ? ' for this genre filter' : '') + '. Try a longer time window' + (D.L.area && !card ? ' or zoom out' : '') + '.' +
        (S.label ? ' Past nights may be in the <a href="' + esc(S.label.kind === 'venue' ? venueArchiveUrl(S.label.venue) : archiveLabelUrl(S.label.name)) + '" style="color:inherit">archive</a>.' : '') + '</p>';
      meta('listings', ''); return;
    }
    const n = S.listAll ? list.length : Math.min(list.length, 120);
    let html = card + (S.mode === 'narrow' || card ? '' : areaBar()) + '<div class="brief">' + listingsBrief(list) + '</div>', night = '';
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
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><path d="M2,' + (h - 2.5) + 'H' + (w - 2) + '" style="stroke:var(--line)" stroke-width="1"/>' +
      '<path d="' + area + '" style="fill:var(--ink-2)" opacity=".16"/><path d="' + past + '" fill="none" style="stroke:var(--ink-2)" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<path d="' + fut + '" fill="none" style="stroke:var(--ink-2)" stroke-width="1.5" stroke-dasharray="2 2.5"/>' +
      '<circle cx="' + x(iNow).toFixed(1) + '" cy="' + y(vals[iNow]).toFixed(1) + '" r="2.6" style="fill:var(--now);stroke:var(--deck)" stroke-width="1.5"/></svg>';
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
  // What the mini player (site/player.js) can play here: YouTube streams that allow embedding, and the
  // NTS channel a show is on while it's on air. Anything else opens on its own site.
  function playId(x, st) {
    if (x.kind === 'video') return x.embed === false ? '' : x.id;
    const ch = String(x.channel || '').match(/^NTS ([12])$/);
    return st === 'live' && ch ? 'nts:' + ch[1] : '';
  }
  function streamRow(x, st) {
    const radio = x.kind === 'radio', G = x.genres && x.genres.length ? RM.GENRE[x.genres[0]] : null;
    const pid = playId(x, st), P = window.RM_PLAYER, on = !!(pid && P && P.current() === pid);
    const bits = [];
    if (x.tags && x.tags.length) bits.push(x.tags.slice(0, 3).join(', '));
    if (x.rerun) bits.push('Repeat');
    if (st === 'live') bits.push(radio ? 'until ' + tTime(x.t1) : x.viewers ? fmtN(x.viewers) + ' watching' : 'since ' + tTime(x.t0));
    else if (st === 'due') bits.push('scheduled for ' + tTime(x.t0));
    else bits.push('in ' + dur(x.t0 - S.now));
    const chip = st === 'live' ? '<span class="st st-live"><i></i>' + (radio ? 'On air' : 'Live') + '</span>' : st === 'due' ? '<span class="st st-warn"><i></i>Due</span>' : '';
    const play = pid ? ' data-play="' + esc(pid) + '" data-play-title="' + esc(x.title) + '" data-play-channel="' + esc(x.channel) + '" data-play-status="' + esc(st) + '" data-play-start="' + x.t0 + '"' + (radio && isFinite(x.t1) ? ' data-play-until="' + x.t1 + '"' : '') : '';
    return '<li><a class="erow strow' + (on ? ' playing' : '') + '" href="' + esc(x.url) + '" target="_blank" rel="noopener"' + play + ' data-track="' + (pid ? 'stream_play' : 'stream_click') + '" data-p-platform="' + esc(x.platform) + '" data-p-channel="' + esc(cut(x.channel)) + '" data-p-stream_status="' + esc(st) + '">' +
      '<div class="when"><b>' + tTime(x.t0) + '</b><span>' + tDay(x.t0) + '</span></div>' +
      '<div class="what"><span class="title">' + esc(x.title) + '</span><div class="sub"><span>' + esc([x.channel, x.location || x.city].filter(Boolean).join(', ')) + '</span></div>' +
      '<div class="sub2">' + bits.map(b => '<span>' + esc(b) + '</span>').join('') + '</div></div>' +
      '<div class="side">' + chip + (G ? '<i class="gdot" style="--c:' + G.color + '" title="' + esc(G.name) + '"></i>' : '') +
      (pid ? '<span class="viewers play"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10 6z" fill="currentColor"/></svg><span class="pl-l">' + (on ? 'Playing' : radio ? 'Listen' : 'Watch') + '</span></span>'
        : '<span class="viewers">' + (radio ? (st === 'live' ? 'Listen' : 'Details') : 'Watch') + ' &#8599;</span>') + '</div></a></li>';
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
      '<p class="fine">Live NTS shows and YouTube streams play here, in a small player that stays open while you look around. NTS shows follow the station\'s schedule; repeats are marked. ' +
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
    [0, max / 2, max].forEach(v => { g += '<path d="M' + pl + ',' + y(v).toFixed(1) + 'H' + (Wc - pr) + '" style="stroke:var(--line)" stroke-width="1"/><text x="' + (pl - 6) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end" style="fill:var(--ink-3)" font-size="10">' + Math.round(v) + '</text>'; });
    let xt = '';
    for (let i = 0; i < series.length; i += 6) xt += '<text x="' + x(i).toFixed(1) + '" y="' + (Hc - 6) + '" text-anchor="' + (i === 0 ? 'start' : i >= series.length - 1 ? 'end' : 'middle') + '" style="fill:var(--ink-3)" font-size="10">' + (i === iNow ? 'Now' : F(null, { hour: 'numeric' }).format(series[i].t)) + '</text>';
    return '<svg viewBox="0 0 ' + Wc + ' ' + Hc + '" role="img" aria-label="Parties live worldwide each hour, from 12 hours ago to 24 hours ahead. Now: ' + series[iNow].n + '." data-chart="hourly">' + g +
      '<path d="' + area + '" style="fill:var(--now)" opacity=".07"/><path d="' + line + '" fill="none" style="stroke:var(--ink-2)" stroke-width="1.5" stroke-dasharray="3 3"/>' +
      '<path d="' + past + '" fill="none" style="stroke:var(--now)" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M' + x(iNow).toFixed(1) + ',' + pt + 'V' + y(0) + '" style="stroke:var(--now)" stroke-width="1" opacity=".5"/>' +
      '<circle cx="' + x(iNow).toFixed(1) + '" cy="' + y(series[iNow].n).toFixed(1) + '" r="4" style="fill:var(--now);stroke:var(--deck)" stroke-width="2"/>' + xt +
      '<line class="hover-x" x1="0" x2="0" y1="' + pt + '" y2="' + y(0) + '" style="stroke:var(--ink)" stroke-width="1" opacity="0"/>' +
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
    if (mode === 'wide') return ['listings', 'venues', 'promoters', 'wire', 'genres', 'streams', 'sellouts', 'peakcon', 'surges'];
    // Phones: planning first, then what's on now.
    if (mode === 'narrow') return ['listings', 'venues', 'promoters', 'live', 'streams', 'genres', 'wire', 'heat', 'sellouts', 'peakcon', 'surges'];
    return ['live', 'listings', 'venues', 'promoters', 'wire', 'heat', 'genres', 'streams', 'sellouts', 'peakcon', 'surges'];
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
    $('#tabbar').innerHTML = ids.map((id, i) => '<button class="tab" role="tab" type="button" id="t-' + id + '" aria-controls="p-' + id + '" aria-selected="false" tabindex="-1" data-tab="' + id + '"' + (mode !== 'narrow' && i < 9 ? ' title="' + PANELS[id].label + ' (press ' + (i + 1) + ')" aria-keyshortcuts="' + (i + 1) + '"' : '') + '>' + PANELS[id].label + '</button>').join('');
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
  // Genres with the most events in the next 7 days first (the Genres tab's order); Misc, the catch-all, last.
  function buildGenreChips() {
    const rank = new Map(D.genres.map((r, i) => [r.genre.id, i]));
    const order = RM.GENRES.slice().sort((a, b) => (a.id === 'misc') - (b.id === 'misc') || (rank.has(a.id) ? rank.get(a.id) : 99) - (rank.has(b.id) ? rank.get(b.id) : 99));
    $('#gchips').innerHTML = '<button class="gchip all" type="button" data-genre="all" aria-pressed="true">All genres</button>' +
      order.map(g => '<button class="gchip" type="button" data-genre="' + g.id + '" aria-pressed="false"><i class="gdot" style="--c:' + g.color + '"></i>' + esc(g.name) + '</button>').join('');
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
    const c = city(e), v = venue(e), G = gen(e), t = S.now, live = RM.isLive(e, t), st = RM.statusAt(e, t), ve = vdir().byVenue[v.id];
    const demo = S.ds.source === 'demo';
    const timed = e.setsTimed !== false;
    const sets = (e.sets || []).map(s => {
      const on = timed && t >= s.start && t < s.end;
      return '<li class="' + (on ? 'now' : '') + '">' + (timed ? '<time>' + tTime(s.start, c.tz) + '–' + tTime(s.end, c.tz) + '</time>' : '<time></time>') + '<span><b>' + esc(s.who) + '</b>' + (on ? '<span class="tag">Playing now</span>' : '') + (NOT_NAMES.test(s.who) ? '' : followBtn('artist', akey(s.who), s.who, null, true)) + '</span></li>';
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
      : ve && ve.osmPos ? 'This listing gives no map position, so the venue is placed where OpenStreetMap has it.'
        : v.approx ? 'This listing gives an address but no map position, so it is placed near the city center.'
        : 'Details come from the listing and can change. Check the source before you go.';
    $('#drawer').innerHTML = '<div class="dr-grip" aria-hidden="true"></div><div class="dr-head">' +
      '<button class="dr-close" type="button" data-act="close" aria-label="Close event details">&times;</button>' +
      '<div class="dr-kicker"><i class="gdot" style="--c:' + G.color + '"></i><span>' + esc(G.name) + (e.sub && e.sub.toLowerCase() !== G.name.toLowerCase() ? ', ' + esc(e.sub) : '') + '</span>' + (G.bpm && G.bpm !== 'varies' ? '<span>' + G.bpm + ' BPM</span>' : '') + statusChip(e) + '</div>' +
      '<h2 id="dr-title">' + esc(e.title) + '</h2><p class="dr-venue">' + (ve ? '<button type="button" class="linkish" data-act="venue" data-vid="' + esc(v.id) + '" aria-label="' + esc('Venue: ' + v.name + '. Show its nights') + '">' + esc(v.name) + '</button>' : esc(v.name)) + ', ' + esc(c.name) + '</p></div>' +
      '<div class="dr-when"><div class="big">' + tTime(e.start, c.tz) + '<small>to ' + tTime(e.end, c.tz) + ', ' + esc(c.name) + ' time</small></div>' +
      '<p>' + tDate(e.start, c.tz).replace(/\.$/, '') + '. ' + when + '</p><p>Your time: ' + tDate(e.start) + ', ' + tTime(e.start) + '</p></div>' +
      (sets ? '<section class="dr-sec"><h3>' + (timed ? 'Set times' : 'Lineup') + '</h3><ol class="sets' + (timed ? '' : ' untimed') + '">' + sets + '</ol></section>' : '') +
      '<section class="dr-sec"><h3>Tickets and listing</h3><dl class="facts">' + facts.map(f => '<div><dt>' + f[0] + '</dt><dd>' + f[1] + '</dd></div>').join('') + '</dl></section>' +
      (e.tags && e.tags.length ? '<section class="dr-sec"><h3>' + (demo ? 'Door and floor' : 'Tags') + '</h3><div class="tags">' + e.tags.map(x => '<span>' + esc(x) + '</span>').join('') + '</div></section>' : '') +
      // On phones the route button sits above, so the bar pinned to the bottom holds tickets and share.
      (tourer ? '<div class="dr-route"><button class="btn" type="button" data-act="route" data-artist="' + tourer.id + '">Show ' + esc(tourer.name) + '\'s dates on the map</button></div>' : '') +
      '<div class="dr-actions">' +
      (e.url && !demo ? '<a class="btn primary" href="' + esc(e.url) + '" target="_blank" rel="noopener" data-track="ticket_click"' + Object.entries(eventParams(e)).map(([k, v]) => ' data-p-' + k + '="' + esc(String(v)) + '"').join('') + '>' + esc(ticketLabel(e)) + '</a>' : '<span class="btn primary" aria-disabled="true">' + esc(ticketLabel(e)) + '</span>') +
      saveBtn(e) +
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
    // Artists from config/artists.json bring their links, and say so when nothing is listed.
    // The links go on a second line, so the name, Follow and Clear keep the first.
    const links = (a.links || []).map(l => '<a href="' + esc(l[1]) + '" target="_blank" rel="noopener">' + l[0] + '</a>').join('');
    chip.classList.toggle('has-links', !!links);
    chip.innerHTML = '<span>' + esc(a.name) + ': ' + (gigs.length ? plural(gigs.length, 'upcoming date', 'upcoming dates') : 'nothing listed right now') + '</span>' + followBtn('artist', akey(a.name), a.name, a.home) + '<button type="button" data-act="route-clear">Clear</button>' + (links ? '<div class="rc-links">' + links + '</div>' : '');
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
    if (labelIdx && labelIdx.ds === S.ds) return labelIdx.list; // reset when the archive's names arrive
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
    if (CR.rows) { CR.rows.labels.forEach(r => add(r[0], 'label', null)); CR.rows.promoters.forEach(r => add(r[0], 'promoter', null)); }
    // A curated group is found as a promoter first, even when it's a label too (split/shift).
    CURATED().forEach(c => { add(c.name, 'promoter', null); const x = m.get(lkey(c.name)); if (x) { x.kind = 'promoter'; x.name = c.name; } });
    labelIdx = { ds: S.ds, list: Array.from(m.values()) };
    return labelIdx.list;
  }
  const archiveLabelUrl = name => '/archive/?label=' + encodeURIComponent(name);
  function setLabel(x) {
    S.label = x ? { key: x.key, name: x.name, kind: x.kind, venue: x.venue || null, vids: x.vids || null } : null;
    S.listAll = false; S.venAll = false; S.crewAll = false;
    const isVenue = S.label && S.label.kind === 'venue';
    if (S.label) {
      const t = S.now, next = S.ds.events.filter(e => e.end > t && hasLabel(e));
      // A venue's nights show whatever their sound: a genre filter none of them fit comes off.
      if (isVenue && S.genres.size && next.length && !next.some(e => RM.inGenres(e, S.genres))) S.genres.clear();
      // Widen the time window when the next night is further out than it shows.
      const want = next.filter(e => RM.inGenres(e, S.genres)), within = w => want.some(e => RM.inWindow(e, S.ds, t, w));
      if (want.length && !within(S.win)) S.win = within('7d') ? '7d' : within('14d') ? '14d' : '30d';
      track('set_filter', { filter: S.label.kind, value: cut(S.label.name) });
    }
    derive(); renderAll();
    renderLabelChip();
    if (S.label && S.sel && S.mode === 'narrow' && (isVenue || D.win.length)) closeDrawer();
    if (isVenue) MapView.flyToVenue(S.label.venue);
    else if (S.label && D.win.length) MapView.fitEvents(D.win);
    else if (S.label) { const home = crewOf(S.label.kind === 'label' ? 'label' : 'promoter', S.label.key, S.label.name).home; if (home) MapView.flyToCity(home); } // nothing coming up: its home city
    MapView.changed(false);
  }
  function renderLabelChip() {
    const chip = $('#label-chip');
    if (!S.label) { chip.hidden = true; return; }
    const n = D.win.length;
    if (S.label.kind === 'venue') {
      const k = new Set(D.win.map(e => nightKey(e.start, city(e).tz))).size;
      chip.innerHTML = '<span>' + esc(S.label.name) + ' · ' + (k ? plural(k, 'night', 'nights') + ' ' + WIN_LABEL[S.win] : S.label.venue.unlisted ? 'no listings yet' : 'nothing ' + WIN_LABEL[S.win]) + '</span>' +
        '<button type="button" data-act="venue-more">Details</button><button type="button" data-act="label-clear">Clear</button>';
    } else {
      chip.innerHTML = '<span>' + (S.label.kind === 'promoter' ? 'Promoter: ' : 'Label: ') + esc(S.label.name) + ' · ' + (n ? plural(n, 'night', 'nights') + ' ' + WIN_LABEL[S.win] : 'nothing coming up') + '</span>' +
        '<button type="button" data-act="crew-more">Details</button><button type="button" data-act="label-clear">Clear</button>';
    }
    chip.hidden = false;
  }

  /* ---------- venues ---------- */
  // The venue directory (archive/data/venues.json, written by pipeline/venues.js) has every place that has
  // hosted a night since the archive began, each platform's spelling merged into one venue. The feed's
  // venues are matched to it by name within their city. Without it (demo data, a site with no archive
  // yet, or before it has loaded) the directory is the feed's own venues.
  // A venue's name as a matching key, as in pipeline/venues.js: no case, accents, rooms in brackets or
  // punctuation, & as 'and', without the city's name at either end or a leading 'the'.
  function vkey(name, cityName) {
    let s = norm(String(name || '').replace(/\([^)]*\)|\[[^\]]*\]|\([^)]*$/g, ' ')).replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const c = norm(cityName).replace(/[^a-z0-9]+/g, ' ').trim();
    if (c && s !== c) {
      if (s.endsWith(' ' + c)) s = s.slice(0, -c.length - 1);
      if (s.startsWith(c + ' ')) s = s.slice(c.length + 1);
    }
    return s.replace(/^the /, '').trim();
  }
  const slugify = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Arenas, theatres and the like (also in pipeline/venues.js); a club in a casino is still a club.
  const CONCERT_RE = /\b(arena|stadium|stadion|amphitheat(?:er|re)|autodromo|raceway|racetrack|speedway|fairgrounds?|showgrounds?|expo|exhibition cent(?:er|re)|convention cent(?:er|re)|casino|theat(?:er|re)|hippodrome|velodrome|o2 academy|o2|forum|bowl)\b/i;
  const CLUB_RE = /\b(night ?club|day ?club|beach club|club|lounge|bar|discoth[eè]que|disco|warehouse|basement)\b/i;
  const isConcert = n => CONCERT_RE.test(n) && !CLUB_RE.test(n);
  // Not places, by name key: "TBA", "Secret location", "Venue to be announced" (also in pipeline/venues.js).
  const NOT_A_VENUE = /^(?:(?:venue|location|address|place)\s+)?(?:tba|tbc|tbd|to be (?:announced|confirmed|revealed))(?:\s|$)|^(?:secret|undisclosed|private|hidden)\s+(?:location|venue|address|spot)(?:\s|$)|^(?:secret|undisclosed)$|^(?:various|multiple|several)\s+(?:venues|locations)(?:\s|$)|^(?:online|livestream|live stream|virtual|streaming)$/;
  const V = { rows: null, state: 'off', built: null };
  function loadVenues() {
    if (V.state !== 'off' || !S.ds) return;
    if (S.ds.source === 'demo') { V.state = 'none'; return; } // demo venues are fictional; the real directory isn't theirs
    V.state = 'loading';
    fetch('archive/data/venues.json').then(r => r.ok ? r.json() : null).then(j => { V.rows = j && Array.isArray(j.venues) ? j.venues : null; }, () => { V.rows = null; })
      .then(() => { V.state = V.rows ? 'ready' : 'none'; venuesArrived(); });
  }
  function venuesArrived() { if (V.rows) venueDataChanged(); }
  function venueDataChanged() {
    V.built = null;
    vdir();
    if (S.label && S.label.kind === 'venue') { derive(); renderLabelChip(); } // the focus may now cover more of the feed's venues
    renderAll(); MapView.changed(false);
    if (!$('#results').hidden) renderResults($('#q').value);
  }
  // OpenStreetMap's clubs and music venues (archive/data/osm/, refreshed weekly by pipeline/osm.js), a city
  // at a time as the map or the lists get there. They add the places that haven't had a listing yet, plus
  // a website, and a real position for a listed venue that came without one. © OpenStreetMap contributors.
  const O = { cities: {}, ver: 0, names: null, namesState: 'off' };
  function loadOsmCity(id) {
    if (!id || !S.ds || S.ds.source === 'demo' || !S.ds.cityById[id]) return Promise.resolve();
    const st = O.cities[id] || (O.cities[id] = { rows: null, p: null });
    if (!st.p) {
      st.p = fetch('archive/data/osm/' + encodeURIComponent(id) + '.json').then(r => r.ok ? r.json() : null).then(j => j, () => null).then(j => {
        st.rows = j && Array.isArray(j.clubs) ? j.clubs : [];
        if (st.rows.length) { O.ver++; venueDataChanged(); }
      });
    }
    return st.p;
  }
  // Every OpenStreetMap club's name, for search (osm/index.json).
  function loadOsmNames() {
    if (O.namesState !== 'off' || !S.ds || S.ds.source === 'demo') return;
    O.namesState = 'loading';
    fetch('archive/data/osm/index.json').then(r => r.ok ? r.json() : null).then(j => j, () => null).then(j => {
      O.names = j && Array.isArray(j.clubs) ? j.clubs : [];
      O.namesState = 'ready';
      if (O.names.length && !$('#results').hidden) renderResults($('#q').value);
    });
  }
  const osmUrl = id => 'https://www.openstreetmap.org/' + ({ n: 'node', w: 'way', r: 'relation' }[String(id)[0]] || 'node') + '/' + String(id).slice(1);
  const OSM_LINK = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" style="color:inherit">OpenStreetMap</a> (© OpenStreetMap contributors)';
  // Words that don't tell venues apart, left out when one name has to contain the other.
  const GENERIC_WORD = /^(club|bar|nightclub|lounge|room|hall|and|disco|discotheque|music|live|venue|house|de|la|le|el|der|die|das)$/;
  const distinctWords = k => new Set(k.split(' ').filter(w => w && !GENERIC_WORD.test(w)));
  const allIn = (a, b) => a.size > 0 && Array.from(a).every(w => b.has(w));
  // Two addresses that share no telling word (a street name, say) are different places.
  const ADDR_WORD = /^(street|road|avenue|lane|place|square|drive|boulevard|blvd|calle|carrer|avenida|rua|rue|avenue|via|viale|strasse|str|straat|gracht|platz|weg|england|scotland|united|kingdom|states|america|germany|deutschland|france|spain|espana)$/;
  const addrWords = a => new Set(norm(a).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !/^\d+$/.test(w) && !ADDR_WORD.test(w)));
  function addrClash(a, b) {
    if (!a || !b) return false;
    const A = addrWords(a), B = addrWords(b);
    return A.size > 0 && B.size > 0 && !Array.from(A).some(w => B.has(w));
  }
  // Built once per feed, directory and set of OpenStreetMap cities, and again every 15 minutes so what's
  // "coming up" stays current.
  function vdir() {
    const ds = S.ds;
    if (V.built && V.built.ds === ds && V.built.rows === V.rows && V.built.ov === O.ver && S.now - V.built.t < 15 * 60000) return V.built;
    const list = [], byId = {}, byKey = new Map(), byVenue = {};
    const cname = id => (ds.cityById[id] || {}).name || '';
    const add = x => { if (byId[x.id]) x.id += '-' + list.length; list.push(x); byId[x.id] = x; };
    (V.rows || []).forEach(r => {
      const c = Array.isArray(r) && r[0] && ds.cityById[r[2]];
      if (!c || NOT_A_VENUE.test(vkey(r[1], c.name))) return; // a city the page doesn't know, or not a place
      const has = Number.isFinite(r[3]) && Number.isFinite(r[4]);
      const x = {
        id: String(r[0]), name: String(r[1]), cityId: r[2], city: c, lat: has ? r[3] : c.lat, lon: has ? r[4] : c.lon, approx: !has || !!(r[5] & 1), concert: !!(r[5] & 2),
        address: r[6] || '', nights: r[7] || 0, first: r[9] || null, last: r[10] || null, genres: r[12] || {}, regulars: r[13] || [], vids: new Set(), evs: []
      };
      add(x);
      [vkey(x.name, c.name)].concat(r[14] || []).forEach(k => { const kk = x.cityId + '|' + k; if (k && !byKey.has(kk)) byKey.set(kk, x); });
    });
    // Curated venues (config/venues.json): their exact spot, address and website, even before a listing
    // names them. A venue in the directory or the feed joins one when it has one of its names, or has one
    // inside its own name (spaces aside) at the same spot.
    const curated = [];
    const curOf = (cityId, k, lat, lon, approx) => {
      const t = k.replace(/ /g, '');
      return curated.find(y => y.cityId === cityId && (approx || !Number.isFinite(lat) || kmBetween(lat, lon, y.lat, y.lon) < 0.15) && y.cur.tight.some(c => t.indexOf(c) >= 0)) || null;
    };
    (window.RM_VENUES || []).forEach(cv => {
      const c = cv && ds.cityById[cv.city];
      if (!c || !cv.name || !Number.isFinite(cv.lat) || !Number.isFinite(cv.lon)) return;
      const keys = [cv.name].concat(cv.match || []).map(n => vkey(n, c.name)).filter(Boolean);
      if (!keys.length) return;
      const tight = keys.map(k => k.replace(/ /g, ''));
      let x = keys.map(k => byKey.get(c.id + '|' + k)).find(Boolean) ||
        list.find(y => y.cityId === c.id && !y.cur && (y.approx || kmBetween(y.lat, y.lon, cv.lat, cv.lon) < 0.15) && tight.some(t => vkey(y.name, c.name).replace(/ /g, '').indexOf(t) >= 0));
      if (!x) {
        x = { id: c.id + '-' + (slugify(keys[0]) || 'venue'), name: cv.name, cityId: c.id, city: c, lat: cv.lat, lon: cv.lon, approx: false, concert: false,
          address: '', nights: 0, first: null, last: null, genres: null, regulars: [], vids: new Set(), evs: [], feedOnly: true };
        add(x);
      }
      Object.assign(x, { name: cv.name, lat: cv.lat, lon: cv.lon, approx: false, osmPos: false, address: cv.address || x.address, cur: { url: cv.url || '', tight: tight } });
      keys.forEach(k => byKey.set(c.id + '|' + k, x));
      curated.push(x);
    });
    ds.venues.forEach(v => {
      const c = ds.cityById[v.cityId]; if (!c) return;
      const k = vkey(v.name, c.name) || norm(v.name).trim(), kk = v.cityId + '|' + k;
      if (NOT_A_VENUE.test(k)) return;
      let x = byKey.get(kk) || curOf(v.cityId, k, v.lat, v.lon, v.approx);
      if (!x) {
        x = { id: v.cityId + '-' + (slugify(k) || 'venue'), name: v.name, cityId: v.cityId, city: c, lat: v.lat, lon: v.lon, approx: !!v.approx, concert: isConcert(v.name),
          address: '', nights: 0, first: null, last: null, genres: null, regulars: [], vids: new Set(), evs: [], feedOnly: true };
        add(x); byKey.set(kk, x);
      }
      x.vids.add(v.id); byVenue[v.id] = x;
    });
    // OpenStreetMap: a place with the same name within 1 km of a venue, or whose name's words are all in a
    // venue's within 250 m, adds to that venue. A venue with no position of its own takes the place's when
    // the name is the only one of its kind in the city and the addresses don't disagree. The rest are
    // venues with no listings yet.
    Object.keys(O.cities).forEach(cid => {
      const rows = O.cities[cid].rows, c = ds.cityById[cid];
      if (!rows || !rows.length || !c) return;
      const local = list.filter(x => x.cityId === cid && !x.osmOnly && !x.approx);
      // A name that more than one place in the city has (a chain, say) can't place a venue without a position.
      const named = {};
      rows.forEach(r => { const k = r[1] ? vkey(r[1], c.name) : ''; if (k) named[k] = (named[k] || 0) + 1; });
      rows.forEach(r => {
        const oid = r[0], name = r[1], lat = r[2], lon = r[3];
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const keys = [vkey(name, c.name), r[7] ? vkey(r[7], c.name) : ''].filter(Boolean);
        if (!keys.length || keys.some(k => NOT_A_VENUE.test(k))) return;
        let x = null, dupe = false;
        keys.forEach(k => {
          const y = byKey.get(cid + '|' + k);
          if (!y || x) return;
          if (y.osmOnly) { if (kmBetween(lat, lon, y.lat, y.lon) < 0.3) dupe = true; } // mapped twice (a point and a building)
          else if (y.approx ? named[k] === 1 && !addrClash(y.address, r[5]) : kmBetween(lat, lon, y.lat, y.lon) < 1) x = y;
        });
        if (!x && !dupe) {
          const ws = keys.map(distinctWords);
          x = local.find(y => kmBetween(lat, lon, y.lat, y.lon) < 0.25 && ws.some(w => { const yw = distinctWords(vkey(y.name, c.name)); return allIn(w, yw) || allIn(yw, w); })) || null;
        }
        if (dupe && !x) return;
        const osm = { id: oid, kind: r[4] || 0, website: r[6] || '' };
        if (x) {
          if (x.osm) return; // it has its OpenStreetMap place already
          x.osm = osm;
          if (!x.address && r[5]) x.address = r[5];
          if (x.approx) { x.lat = lat; x.lon = lon; x.approx = false; x.osmPos = true; }
          return;
        }
        const nx = { id: 'osm-' + oid, name: name, cityId: cid, city: c, lat: lat, lon: lon, approx: false, concert: false, address: r[5] || '',
          nights: 0, first: null, last: null, genres: {}, regulars: [], vids: new Set(), evs: [], osmOnly: true, osm: osm };
        add(nx);
        keys.forEach(k => { if (!byKey.has(cid + '|' + k)) byKey.set(cid + '|' + k, nx); });
      });
    });
    const t = S.now;
    ds.events.forEach(e => { if (e.end > t) { const x = byVenue[e.venueId]; if (x) x.evs.push(e); } });
    list.forEach(x => {
      x.soon = new Set(x.evs.map(e => nightKey(e.start, x.city.tz))).size; // nights coming up in the feed
      if (x.feedOnly) { const g = {}; x.evs.forEach(e => { g[e.genre] = (g[e.genre] || 0) + 1; }); x.genres = g; x.nights = x.soon; }
      x.main = mainGenre(x.genres);
      x.unlisted = !!x.osmOnly || (!!x.cur && !x.nights && !x.evs.length); // no listings yet
    });
    V.built = { ds: ds, rows: V.rows, ov: O.ver, t: S.now, list: list, byId: byId, byVenue: byVenue, byKey: byKey };
    // A venue in focus moves to its entry in the new directory (from the feed's venue to the merged one).
    if (S.label && S.label.kind === 'venue') {
      const old = S.label.venue, nx = byId[old.id] || Array.from(old.vids).map(id => byVenue[id]).find(Boolean);
      if (nx && nx !== old) Object.assign(S.label, { key: nx.id, name: nx.name, venue: nx, vids: nx.vids });
    }
    return V.built;
  }
  // An address to show beside the venue and its city: "Dear Darling, 91 Jermyn St, London, England" is
  // "91 Jermyn St" (no venue name in front, nothing from the city on), semicolons as commas.
  function shortAddress(a, cityName, venueName) {
    let s = String(a || '').replace(/\s*;\s*/g, ', ').trim();
    const n = String(venueName || '').trim().toLowerCase();
    if (n && s.toLowerCase().startsWith(n + ',')) s = s.slice(n.length + 1).trim();
    const c = String(cityName || '').trim().toLowerCase();
    if (c) {
      const i = s.toLowerCase().indexOf(', ' + c);
      if (i > 0) s = s.slice(0, i);
      else if (s.toLowerCase().endsWith(' ' + c)) s = s.slice(0, -c.length).replace(/[\s,]+$/, '');
    }
    return s.trim();
  }
  // The sound a venue is known for: its most common family, passing over the catch-alls (Dance/electronic,
  // Misc) when a real family has at least a quarter of its nights.
  function mainGenre(g) {
    const ids = Object.keys(g || {}).filter(id => RM.GENRE[id]).sort((a, b) => g[b] - g[a]);
    if (!ids.length) return null;
    const total = ids.reduce((s, id) => s + g[id], 0), real = ids.find(id => id !== 'electronic' && id !== 'misc');
    return real && g[real] >= total * 0.25 ? real : ids[0];
  }
  function genreShares(g) {
    const ids = Object.keys(g || {}).filter(id => RM.GENRE[id]).sort((a, b) => g[b] - g[a]);
    const total = ids.reduce((s, id) => s + g[id], 0);
    return ids.map(id => ({ id: id, n: g[id], p: total ? g[id] / total : 0 }));
  }
  function genreBar(g, cls) {
    const sh = genreShares(g);
    if (!sh.length) return '<span class="vbar' + (cls ? ' ' + cls : '') + '" aria-hidden="true"></span>';
    const label = sh.slice(0, 3).map(s => RM.GENRE[s.id].name + ' ' + Math.round(s.p * 100) + '%').join(', ');
    return '<span class="vbar' + (cls ? ' ' + cls : '') + '" role="img" aria-label="' + esc('Sound: ' + label) + '" title="' + esc(label) + '">' +
      sh.slice(0, 6).map(s => '<i style="--c:' + RM.GENRE[s.id].color + ';flex-grow:' + s.n + '"></i>').join('') + '</span>';
  }
  // Nights in the time window at each venue: { id: { nights, evs } }. A label or promoter in focus
  // counts only its nights; a venue in focus doesn't narrow it (the tab shows the venues around it).
  function venueWindow(dir) {
    const t = S.now, out = new Map(), lab = S.label && S.label.kind !== 'venue';
    S.ds.events.forEach(e => {
      if (!RM.inWindow(e, S.ds, t, S.win) || !RM.inGenres(e, S.genres) || (lab && !hasLabel(e))) return;
      const x = dir.byVenue[e.venueId]; if (!x) return;
      let w = out.get(x.id);
      if (!w) out.set(x.id, w = { nights: new Set(), evs: [] });
      w.nights.add(nightKey(e.start, x.city.tz)); w.evs.push(e);
    });
    return out;
  }
  const WIN_SHORT = { live: 'live now', '24h': 'next 24h', weekend: 'this weekend', '7d': 'next 7 days', '14d': 'next 14 days', '30d': 'next 30 days' };
  // A YYYY-MM-DD night as "Sat 1 Nov" (the date itself, so no time zone shifts it).
  const fmtNight = (d, year) => d ? F('UTC', year ? { day: 'numeric', month: 'short', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short' }).format(Date.parse(d + 'T12:00:00Z')) : '';
  const venueArchiveUrl = x => '/archive/?venue=' + encodeURIComponent(x.name.replace(/^the\s+/i, '')) + '&city=' + encodeURIComponent(x.cityId);
  const nextOf = (x, w) => (w && w.evs.length ? w.evs : x.evs.filter(e => e.end > S.now)).slice().sort((a, b) => a.start - b.start)[0];
  function venueRow(x, w) {
    if (x.unlisted) {
      return '<li class="vrow quiet" data-venue="' + esc(x.id) + '" tabindex="0" role="button"><div class="what"><span class="title">' + esc(x.name) + '</span>' +
        '<div class="sub"><span>' + esc(x.city.name) + '</span>' + (x.osm && x.osm.kind === 1 ? '<span class="vtag">Music venue</span>' : '') + '</div>' +
        (x.address ? '<div class="sub2">' + esc(shortAddress(x.address, x.city.name)) + '</div>' : '') + '</div>' +
        '<div class="vside"><b class="none">–</b><span class="vbar" aria-hidden="true"></span></div></li>';
    }
    const c = x.city, k = w ? w.nights.size : 0, next = nextOf(x, w);
    const line = next ? 'Next: ' + (RM.isLive(next, S.now) ? 'live now' : tDay(next.start, c.tz) + ' ' + tTime(next.start, c.tz)) + ' · ' + (lineupNames(next, 2) || next.title)
      : x.last ? 'Last listed ' + fmtNight(x.last) : '';
    return '<li class="vrow' + (k ? '' : ' quiet') + '" data-venue="' + esc(x.id) + '" tabindex="0" role="button">' +
      '<div class="what"><span class="title">' + esc(x.name) + '</span>' +
      '<div class="sub"><span>' + esc(c.name) + '</span>' + (x.concert ? '<span class="vtag">Concert venue</span>' : '') + '</div>' +
      (line ? '<div class="sub2">' + esc(line) + '</div>' : '') + '</div>' +
      '<div class="vside"><b' + (k ? '' : ' class="none"') + '>' + (k ? fmtN(k) : '0') + '</b>' + genreBar(x.genres) + '</div></li>';
  }
  // The venue a focus is on: where it is, its sound, how often it's listed, its regulars, and links.
  function venueCard(x, w, full) {
    const c = x.city, k = w ? w.nights.size : 0, demo = S.ds.source === 'demo', sh = genreShares(x.genres);
    // Regulars with dates coming up open their route; each name keeps its comma on its line.
    const reg = full && x.regulars.length ? '<p class="vc-reg"><span>Regulars</span>' + x.regulars.map((n, i, all) => {
      const aid = 'n:' + norm(n), comma = i < all.length - 1 ? ',' : '';
      return '<span class="nw">' + (artist(aid) && routeGigs(aid).length ? '<button type="button" class="linkish" data-act="route" data-artist="' + esc(aid) + '">' + esc(n) + '</button>' : esc(n)) + comma + '</span>';
    }).join(' ') + '</p>' : '';
    const stats = full ? '<dl class="vc-stats"><div><dt>Coming up</dt><dd>' + (k ? plural(k, 'night', 'nights') + ' ' + WIN_LABEL[S.win] : 'Nothing ' + WIN_LABEL[S.win]) + '</dd></div>' +
      '<div><dt>Nights listed</dt><dd>' + (x.nights ? fmtN(x.nights) + (x.first ? ' since ' + fmtNight(x.first, true) : '') : 'None yet') + '</dd></div></dl>' : '';
    const q = x.name + ', ' + (x.address || c.name), addr = shortAddress(x.address, c.name, x.name), web = (x.cur && x.cur.url) || (x.osm && x.osm.website);
    return '<div class="vcard"><div class="vc-head"><div><h3>' + esc(x.name) + '</h3><p>' + esc(c.name) + (addr ? ' · ' + esc(addr) : '') + '</p></div>' +
      (x.concert ? '<span class="vtag">Concert venue</span>' : x.osmOnly && x.osm.kind === 1 ? '<span class="vtag">Music venue</span>' : '') + '</div>' +
      (sh.length ? genreBar(x.genres, 'big') + '<p class="vc-mix">' + sh.slice(0, 4).map(s => '<span class="gtag" style="--c:' + RM.GENRE[s.id].color + '">' + esc(RM.GENRE[s.id].name) + ' ' + Math.round(s.p * 100) + '%</span>').join('') + '</p>' : '') +
      stats + reg +
      '<div class="vc-actions">' + followBtn('venue', venueFollowKey(x), x.name, x.cityId) +
      (web ? '<a class="btn" href="' + esc(web) + '" target="_blank" rel="noopener nofollow">Website</a>' : '') +
      (demo ? '' : '<a class="btn" href="https://www.google.com/maps/search/?api=1&amp;query=' + encodeURIComponent(q) + '" target="_blank" rel="noopener">Directions</a>' +
        (x.osmOnly ? '<a class="btn" href="' + esc(osmUrl(x.osm.id)) + '" target="_blank" rel="noopener">OpenStreetMap</a>' : '<a class="btn" href="' + esc(venueArchiveUrl(x)) + '">Past nights</a>')) +
      (full ? '' : '<button class="btn" type="button" data-act="venue-more">About the venue</button>') +
      '<button class="btn" type="button" data-act="label-clear">' + (full ? 'All venues' : 'Show all listings') + '</button></div>' +
      (x.osmOnly ? '<p class="fine">On OpenStreetMap, with no listings here yet. Place details © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" style="color:inherit">OpenStreetMap contributors</a>.</p>'
        : x.osmPos ? '<p class="fine">The listings give no exact address, so the map uses where OpenStreetMap has it.</p>'
          : x.approx ? '<p class="fine">The listings give no exact address, so the map shows it near the city center.</p>' : '') + '</div>';
  }
  function renderVenues() {
    loadVenues();
    const dir = vdir(), win = venueWindow(dir), focus = S.label && S.label.kind === 'venue' ? S.label.venue : null;
    const k = x => { const w = win.get(x.id); return w ? w.nights.size : 0; };
    let pool, html = '';
    if (focus) {
      html += venueCard(focus, win.get(focus.id), true);
      pool = dir.list.filter(x => x !== focus && x.cityId === focus.cityId);
    } else if (D.L.area) pool = dir.list.filter(x => MapView.inView(x.lon, x.lat) || Array.from(x.vids).some(id => S.area.has(id)));
    else pool = dir.list.filter(x => !x.unlisted);
    // A label or promoter keeps the venues with its nights; a genre filter, those with nights of that
    // sound coming up or known for it.
    const lab = S.label && S.label.kind !== 'venue';
    if (lab) pool = pool.filter(x => k(x) > 0);
    else if (S.genres.size) pool = pool.filter(x => k(x) > 0 || (x.main && S.genres.has(x.main)));
    // Places with no listings yet (from OpenStreetMap), for a venue's city or the area in view: their
    // cities' lists load here when the area holds four cities or fewer.
    const unlisted = pool.filter(x => x.unlisted).sort((a, b) => !!a.osmOnly - !!b.osmOnly || a.name.localeCompare(b.name));
    pool = pool.filter(x => !x.unlisted);
    if (S.ds.source !== 'demo' && !lab && !S.genres.size && (focus || D.L.area)) {
      const ids = new Set(focus ? [focus.cityId] : pool.map(x => x.cityId));
      const mid = !focus && MapView.center(), near = mid && S.ds.cities.filter(c => Number.isFinite(c.lat)).map(c => ({ c: c, d: kmBetween(mid[1], mid[0], c.lat, c.lon) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d < 60) ids.add(near.c.id);
      if (ids.size <= 4) ids.forEach(loadOsmCity);
    }
    pool.sort((a, b) => k(b) - k(a) || b.soon - a.soon || b.nights - a.nights || a.name.localeCompare(b.name));
    const clubs = pool.filter(x => !x.concert), big = pool.filter(x => x.concert), active = pool.filter(x => k(x) > 0).length;
    const cap = S.venAll ? Infinity : 60, capBig = S.venAll ? Infinity : 12, capOsm = S.venAll ? Infinity : 25;
    const rows = list => '<ol class="rows">' + list.map(x => venueRow(x, win.get(x.id))).join('') + '</ol>';
    if (!focus) {
      html += (S.mode === 'narrow' ? '' : areaBar()) + '<div class="brief"><b>' + plural(pool.length, 'venue', 'venues') + '</b>' +
        (lab ? ' with ' + esc(S.label.name) + ' nights ' + WIN_LABEL[S.win] + (D.L.area ? ' in this area' : '') + '.' :
          (D.L.area ? ' in this area' : ' in the listings so far') + (S.genres.size ? ' for this genre filter' : '') + ', ' + fmtN(active) + ' with nights ' + WIN_LABEL[S.win] +
          (unlisted.length ? ', and ' + fmtN(unlisted.length) + ' more with no listings yet' : '') + '.') +
        (D.L.area ? (S.mode === 'narrow' ? ' <button type="button" class="linkish" data-act="area-all">Show everywhere</button>' : '') : ' Zoom the map in to see the venues in an area.') + '</div>';
    }
    if (!pool.length && !unlisted.length) html += '<p class="fine">' + (focus ? 'No other venues in ' + esc(focus.city.name) + ' yet.' : 'No venues ' + (D.L.area ? 'in this area' : 'yet') + (lab ? ' with ' + esc(S.label.name) + ' nights ' + WIN_LABEL[S.win] : S.genres.size ? ' for this genre filter' : '') + '.') + '</p>';
    else if (pool.length) {
      if (focus) html += '<h3 class="subhead">More venues in ' + esc(focus.city.name) + '</h3>';
      html += '<div class="vhead" aria-hidden="true"><span>Venue</span><span>Nights ' + WIN_SHORT[S.win] + '</span></div>';
      if (clubs.length) html += rows(clubs.slice(0, cap));
      if (big.length) html += '<h3 class="subhead">Concert venues and theatres</h3>' + rows(big.slice(0, capBig));
    }
    if (unlisted.length) html += '<h3 class="subhead">No listings yet</h3>' + rows(unlisted.slice(0, capOsm));
    if (clubs.length > cap || big.length > capBig || unlisted.length > capOsm) html += '<button class="more" type="button" data-act="ven-all">Show all ' + fmtN(pool.length + unlisted.length) + ' venues</button>';
    html += '<p class="fine">' + (S.ds.source === 'demo' ? 'Demo venues, fictional. ' : '') + 'Venues come from the listings: ' + (V.rows ? 'every place that has hosted a night since the archive began, with each platform\'s spelling merged' : 'every place with a night coming up') + '. Select one to see it on the map with its nights.' +
      (V.state === 'none' && S.ds.source !== 'demo' ? ' The venue history didn\'t load, so this shows venues with listings coming up.' : '') +
      (unlisted.some(x => x.osmOnly) ? ' ' + (unlisted.every(x => x.osmOnly) ? 'Places' : 'Most places') + ' with no listings yet, and some addresses and websites, come from ' + OSM_LINK + '.'
        : dir.list.some(x => x.osm) ? ' Some addresses and websites come from ' + OSM_LINK + '.' : '') + '</p>';
    body('venues').innerHTML = html;
    meta('venues', focus ? '' : fmtN(pool.length + unlisted.length) + (D.L.area ? ' in view' : ''));
  }
  function focusVenue(x) {
    if (!x) return;
    setLabel({ key: x.id, name: x.name, kind: 'venue', venue: x, vids: x.vids });
    loadOsmCity(x.cityId);
  }
  // The chip's Details: the venue card in the Venues tab, scrolled into view on phones.
  function venueDetails() {
    setMapFull(false); // the card is in the lists, under the map
    selectTab('venues');
    if (S.mode !== 'wide') { const bar = $('#tabbar'); window.scrollTo({ top: bar.getBoundingClientRect().top + window.scrollY - 4, behavior: reduceMotion ? 'auto' : 'smooth' }); }
  }

  /* ---------- promoters and labels ---------- */
  // Who throws the nights: promoters, collectives and event series, and record labels. From the feed's
  // listings, the archive's history (archive/data/promoters.json, from pipeline/promoters.js) and the
  // curated list (config/promoters.json: home city, website, kind), so split/shift shows even between nights.
  const CR = { rows: null, state: 'off', built: {} };
  function loadCrews() {
    if (CR.state !== 'off' || !S.ds) return;
    if (S.ds.source === 'demo') { CR.state = 'none'; return; }
    CR.state = 'loading';
    fetch('archive/data/promoters.json').then(r => r.ok ? r.json() : null).then(j => j, () => null).then(j => {
      CR.rows = j && Array.isArray(j.promoters) ? j : null;
      CR.state = CR.rows ? 'ready' : 'none';
      if (!CR.rows) return;
      CR.built = {}; labelIdx = null;
      renderAll();
      if (!$('#results').hidden) renderResults($('#q').value);
    });
  }
  const CURATED = () => window.RM_PROMOTERS || [];
  // A venue's own nights ("fabric" at fabric, "clubspacemiami" across Club Space's rooms) belong to the
  // Venues tab: one name inside the other (spaces aside), at the venue of at least half its nights.
  function venueRun(name, venues, nights) {
    const a = lkey(name).replace(/ /g, '');
    if (a.length < 3) return false;
    const sums = new Map();
    (venues || []).forEach(v => { const ve = venueNamed(v[0], v[1]), nm = ve ? ve.name : v[0]; sums.set(nm, (sums.get(nm) || 0) + v[2]); });
    for (const [nm, n] of sums) {
      const b = lkey(nm).replace(/ /g, '');
      if (n * 2 >= nights && b.length >= 3 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) return true;
    }
    return false;
  }
  function crewDir(kind) {
    const memo = CR.built[kind];
    if (memo && memo.ds === S.ds && memo.rows === CR.rows && memo.vrows === V.rows && S.now - memo.t < 15 * 60000) return memo; // the venue list decides which are a venue's own
    const byKey = new Map(), t = S.now;
    const get = name => {
      const k = lkey(name); if (!k) return null;
      let x = byKey.get(k);
      if (!x) byKey.set(k, x = { key: k, name: name, kind: kind, evs: [], nights: 0, first: null, last: null, cities: {}, genres: {}, venues: [], cur: null, fromArchive: false });
      return x;
    };
    ((CR.rows && CR.rows[kind === 'label' ? 'labels' : 'promoters']) || []).forEach(r => {
      const x = get(r[0]); if (!x) return;
      Object.assign(x, { nights: r[1] || 0, first: r[3] || null, last: r[4] || null, cities: r[5] || {}, genres: r[6] || {}, venues: r[7] || [], fromArchive: true });
    });
    S.ds.events.forEach(e => { if (e.end > t) (kind === 'label' ? e.labels : e.promoters || []).forEach(n => { const x = get(n); if (x) x.evs.push(e); }); });
    CURATED().forEach(c => {
      if (!c.city && !c.url) return;
      const x = kind === 'promoter' ? get(c.name) : byKey.get(lkey(c.name)); // a label only when it is one
      if (x) { x.cur = c; x.name = c.name; }
    });
    const list = [];
    byKey.forEach(x => {
      // From the feed alone: its cities, sounds and venues from what's coming up.
      if (!x.fromArchive) {
        const vs = {};
        x.evs.forEach(e => {
          x.cities[e.cityId] = (x.cities[e.cityId] || 0) + 1;
          x.genres[e.genre] = (x.genres[e.genre] || 0) + 1;
          const vk = e.cityId + '|' + venue(e).name; vs[vk] = (vs[vk] || 0) + 1;
        });
        x.venues = Object.keys(vs).sort((a, b) => vs[b] - vs[a]).slice(0, 3).map(vk => { const i = vk.indexOf('|'); return [vk.slice(i + 1), vk.slice(0, i), vs[vk]]; });
      }
      x.soon = new Set(x.evs.map(e => e.cityId + '|' + nightKey(e.start, city(e).tz))).size;
      if (!x.fromArchive) x.nights = x.soon;
      x.main = mainGenre(x.genres);
      const home = x.cur && x.cur.city && S.ds.cityById[x.cur.city];
      x.home = home || S.ds.cityById[Object.keys(x.cities).sort((a, b) => x.cities[b] - x.cities[a])[0]] || null;
      if (kind === 'promoter' && !x.cur && venueRun(x.name, x.venues, Math.max(1, x.nights))) return;
      if (!x.home && !x.evs.length && !x.cur) return;
      list.push(x);
    });
    CR.built[kind] = { ds: S.ds, rows: CR.rows, vrows: V.rows, t: S.now, list: list, byKey: byKey };
    return CR.built[kind];
  }
  // Nights in the time window per promoter or label, in the area when the lists follow the map.
  function crewWindow(kind, areaOnly) {
    const t = S.now, out = new Map();
    S.ds.events.forEach(e => {
      if (!RM.inWindow(e, S.ds, t, S.win) || !RM.inGenres(e, S.genres) || (areaOnly && !S.area.has(e.venueId))) return;
      (kind === 'label' ? e.labels : e.promoters || []).forEach(n => {
        const k = lkey(n); let w = out.get(k);
        if (!w) out.set(k, w = { nights: new Set(), evs: [] });
        w.nights.add(e.cityId + '|' + nightKey(e.start, city(e).tz)); w.evs.push(e);
      });
    });
    return out;
  }
  const cityList = (cities, n) => {
    const ids = Object.keys(cities || {}).filter(id => S.ds.cityById[id]).sort((a, b) => cities[b] - cities[a]);
    return ids.slice(0, n).map(id => S.ds.cityById[id].name).join(' · ') + (ids.length > n ? ' +' + (ids.length - n) : '');
  };
  function crewRow(x, w) {
    const k = w ? w.nights.size : 0, evs = (w && w.evs.length ? w.evs : x.evs.filter(e => e.end > S.now)).slice().sort((a, b) => a.start - b.start), next = evs[0];
    const where = cityList(x.cities, 2) || (x.home ? x.home.name : '');
    const line = next ? 'Next: ' + (RM.isLive(next, S.now) ? 'live now' : tDay(next.start, city(next).tz) + ' ' + tTime(next.start, city(next).tz)) + ' · ' + venue(next).name + ', ' + city(next).name
      : x.last ? 'Last night listed ' + fmtNight(x.last) : x.cur ? 'No nights listed yet' : '';
    const tag = x.cur && x.cur.kind ? x.cur.kind : x.kind === 'label' ? '' : '';
    return '<li class="vrow' + (k ? '' : ' quiet') + '" data-crew="' + esc(x.key) + '" data-kind="' + x.kind + '" tabindex="0" role="button">' +
      '<div class="what"><span class="title">' + esc(x.name) + '</span>' +
      '<div class="sub">' + (where ? '<span>' + esc(where) + '</span>' : '') + (tag ? '<span class="vtag">' + esc(tag) + '</span>' : '') + '</div>' +
      (line ? '<div class="sub2">' + esc(line) + '</div>' : '') + '</div>' +
      '<div class="vside"><b' + (k ? '' : ' class="none"') + '>' + (k ? fmtN(k) : '0') + '</b>' + genreBar(x.genres) + '</div></li>';
  }
  // A promoter or label in focus: where it's based, where and in what sound it throws nights, its venues and links.
  function crewCard(x, w, full) {
    const k = w ? w.nights.size : 0, sh = genreShares(x.genres), demo = S.ds.source === 'demo';
    const based = x.cur && x.cur.city && S.ds.cityById[x.cur.city] ? 'Based in ' + S.ds.cityById[x.cur.city].name : '';
    const where = cityList(x.cities, 4);
    const venues = full && x.venues.length ? '<p class="vc-reg"><span>Venues</span>' + x.venues.map((v, i, all) => {
      const ve = venueNamed(v[0], v[1]), comma = i < all.length - 1 ? ',' : '';
      return '<span class="nw">' + (ve ? '<button type="button" class="linkish" data-venue="' + esc(ve.id) + '">' + esc(ve.name) + '</button>' : esc(v[0])) + comma + '</span>';
    }).join(' ') + '</p>' : '';
    const stats = full ? '<dl class="vc-stats"><div><dt>Coming up</dt><dd>' + (k ? plural(k, 'night', 'nights') + ' ' + WIN_LABEL[S.win] : 'Nothing ' + WIN_LABEL[S.win]) + '</dd></div>' +
      '<div><dt>Nights listed</dt><dd>' + (x.nights ? fmtN(x.nights) + (x.first ? ' since ' + fmtNight(x.first, true) : '') : 'None yet') + '</dd></div></dl>' : '';
    const about = [based, where && (based ? 'nights in ' : 'Nights in ') + where].filter(Boolean).join(' · ');
    return '<div class="vcard"><div class="vc-head"><div><h3>' + esc(x.name) + '</h3>' + (about ? '<p>' + esc(about) + '</p>' : '') + '</div>' +
      '<span class="vtag">' + esc(x.cur && x.cur.kind ? x.cur.kind : x.kind === 'label' ? 'Record label' : 'Promoter') + '</span></div>' +
      (sh.length ? genreBar(x.genres, 'big') + '<p class="vc-mix">' + sh.slice(0, 4).map(s => '<span class="gtag" style="--c:' + RM.GENRE[s.id].color + '">' + esc(RM.GENRE[s.id].name) + ' ' + Math.round(s.p * 100) + '%</span>').join('') + '</p>' : '') +
      stats + venues +
      '<div class="vc-actions">' + followBtn(x.kind === 'label' ? 'label' : 'promoter', x.key, x.name) +
      (x.cur && x.cur.url ? '<a class="btn" href="' + esc(x.cur.url) + '" target="_blank" rel="noopener">Website</a>' : '') +
      (demo ? '' : '<a class="btn" href="' + esc(archiveLabelUrl(x.name)) + '">Past nights</a>') +
      (full ? '' : '<button class="btn" type="button" data-act="crew-more">About ' + (x.kind === 'label' ? 'the label' : 'them') + '</button>') +
      '<button class="btn" type="button" data-act="label-clear">' + (full ? (x.kind === 'label' ? 'All labels' : 'All promoters') : 'Show all listings') + '</button></div></div>';
  }
  // The directory's venue for a name in a city, if it has one.
  function venueNamed(name, cityId) {
    const d = vdir(), c = S.ds.cityById[cityId];
    return c ? d.byKey.get(cityId + '|' + (vkey(name, c.name) || norm(name).trim())) || null : null;
  }
  // The entry a focus points at, made up from its name when no list has it yet.
  function crewOf(kind, key, name) {
    const d = crewDir(kind);
    return d.byKey.get(key) || { key: key, name: name, kind: kind, evs: [], nights: 0, first: null, last: null, cities: {}, genres: {}, venues: [], cur: null, soon: 0, main: null, home: null };
  }
  function renderPromoters() {
    loadCrews(); loadVenues();
    const kind = S.crewKind, d = crewDir(kind), areaOn = D.L.area;
    const focus = S.label && S.label.kind !== 'venue' ? S.label : null;
    const winAll = crewWindow(kind, false), win = areaOn ? crewWindow(kind, true) : winAll;
    const k = x => { const w = win.get(x.key); return w ? w.nights.size : 0; };
    let html = '<div class="crewbar"><div class="seg" role="radiogroup" aria-label="Show">' +
      ['promoter', 'label'].map(v => '<button type="button" role="radio" data-act="crew-kind" data-kind="' + v + '" aria-checked="' + (kind === v) + '">' + (v === 'label' ? 'Record labels' : 'Promoters & groups') + '</button>').join('') + '</div></div>';
    if (focus) {
      const fk = focus.kind === 'label' && kind === 'label' ? 'label' : focus.kind === 'promoter' && kind === 'promoter' ? 'promoter' : null;
      if (fk) html += crewCard(crewOf(fk, focus.key, focus.name), winAll.get(focus.key), true);
    }
    let pool;
    if (areaOn) {
      // Nights in the area, or based in or known in a city on the map.
      const inView = new Set(S.ds.cities.filter(c => MapView.inView(c.lon, c.lat)).map(c => c.id));
      pool = d.list.filter(x => k(x) > 0 || (x.cur && inView.has(x.cur.city)) || Object.keys(x.cities).some(id => inView.has(id)));
    } else pool = d.list.filter(x => k(x) > 0 || x.cur);
    if (S.genres.size) pool = pool.filter(x => k(x) > 0 || (x.main && S.genres.has(x.main)));
    pool.sort((a, b) => k(b) - k(a) || b.soon - a.soon || b.nights - a.nights || a.name.localeCompare(b.name));
    const active = pool.filter(x => k(x) > 0).length, cap = S.crewAll ? Infinity : 60;
    const noun = kind === 'label' ? ['label', 'labels'] : ['promoter or group', 'promoters and groups'];
    html += (S.mode === 'narrow' ? '' : areaBar()) + '<div class="brief"><b>' + plural(active, noun[0], noun[1]) + '</b> with nights ' + WIN_LABEL[S.win] + (areaOn ? ' in this area' : '') + (S.genres.size ? ' for this genre filter' : '') +
      (pool.length > active ? ', and ' + fmtN(pool.length - active) + ' more with nothing coming up' : '') + '.' +
      (areaOn && S.mode === 'narrow' ? ' <button type="button" class="linkish" data-act="area-all">Show everywhere</button>' : '') + '</div>';
    if (!pool.length) html += '<p class="fine">No ' + noun[1] + (areaOn ? ' in this area' : '') + ' yet.</p>';
    else {
      html += '<div class="vhead" aria-hidden="true"><span>' + (kind === 'label' ? 'Label' : 'Promoter or group') + '</span><span>Nights ' + WIN_SHORT[S.win] + '</span></div><ol class="rows">' +
        pool.slice(0, cap).map(x => crewRow(x, win.get(x.key))).join('') + '</ol>';
      if (pool.length > cap) html += '<button class="more" type="button" data-act="crew-all">Show all ' + fmtN(pool.length) + '</button>';
    }
    html += '<p class="fine">' + (kind === 'label'
      ? 'Labels come from their names in a listing\'s title, promoters or lineup credits (a curated list, plus any promoter called “… Records”).'
      : 'Promoters are the ones listings name, plus collectives and event series found in titles. A venue\'s own nights are under Venues.') +
      ' Select one to see its nights on the map.</p>';
    body('promoters').innerHTML = html;
    meta('promoters', fmtN(pool.length) + (areaOn ? ' in view' : ''));
  }
  // The chip's Details for a promoter or label: its card in the Promoters tab, scrolled to on phones.
  function crewDetails() {
    if (S.label && S.label.kind !== 'venue') S.crewKind = S.label.kind === 'label' ? 'label' : 'promoter';
    setMapFull(false);
    selectTab('promoters');
    renderPromoters();
    if (S.mode !== 'wide') { const bar = $('#tabbar'); window.scrollTo({ top: bar.getBoundingClientRect().top + window.scrollY - 4, behavior: reduceMotion ? 'auto' : 'smooth' }); }
  }

  /* ---------- full-screen map ---------- */
  // The map over the whole window, and the whole screen where the browser allows it (not on iPhones,
  // where it fills the window). The button, Esc or F leave it.
  let realFull = false;
  function setMapFull(on) {
    on = !!on;
    if (on === document.body.classList.contains('mapfull')) return;
    document.body.classList.toggle('mapfull', on);
    document.body.classList.remove('ui-idle');
    const b = $('#fullscreen');
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Leave the full-screen map' : 'Full-screen map');
    b.title = on ? 'Leave full screen (F)' : 'Full-screen map (F)';
    const root = document.documentElement;
    try {
      if (on && root.requestFullscreen && !document.fullscreenElement) root.requestFullscreen({ navigationUI: 'hide' }).then(() => { realFull = true; }, () => {});
      else if (!on && document.fullscreenElement && document.exitFullscreen) { realFull = false; document.exitFullscreen().catch(() => {}); }
    } catch (err) { /* the window-sized map is enough */ }
    if (S.showFab) S.showFab();
    MapView.resize();
    track('fullscreen_map', { state: on ? 'on' : 'off' });
  }
  const mapFull = () => document.body.classList.contains('mapfull');

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
    ds.cities.filter(c => norm(c.name).indexOf(s) >= 0 || (c.aka || []).some(a => norm(a).indexOf(s) >= 0)).slice(0, 4).forEach(c => out.push({ g: 'Cities', kind: 'city', id: c.id, label: c.name, hint: plural((D.byCity.get(c.id) || []).length, 'event', 'events') + ' ' + WIN_LABEL[S.win] }));
    RM.GENRES.filter(g => norm(g.name).indexOf(s) >= 0 || g.subs.some(x => norm(x).indexOf(s) >= 0)).slice(0, 3).forEach(g => out.push({ g: 'Genres', kind: 'genre', id: g.id, label: g.name, hint: 'Filter the map' }));
    ds.artists.filter(a => norm(a.name).indexOf(s) >= 0).sort((a, b) => !!b.curated - !!a.curated || a.tier - b.tier).slice(0, 5).forEach(a => {
      const n = routeGigs(a.id).length;
      out.push({ g: 'DJs and artists', kind: 'artist', id: a.id, label: a.name, hint: n ? plural(n, 'upcoming date', 'upcoming dates') : 'Nothing listed right now' + (a.curated && ACCOUNTS ? ' · follow for alerts' : '') });
    });
    const ls = lkey(q);
    if (ls.length >= 2) {
      const hits = labelIndex().filter(x => (' ' + x.key).indexOf(' ' + ls) >= 0).sort((a, b) => b.n - a.n || a.name.length - b.name.length);
      loadCrews();
      hits.filter(x => x.kind === 'label').slice(0, 4).forEach(x => out.push({ g: 'Record labels', kind: 'label', id: x.key, label: x.name, hint: x.n ? plural(x.n, 'upcoming night', 'upcoming nights') : 'Nothing coming up' }));
      hits.filter(x => x.kind === 'promoter').slice(0, 4).forEach(x => out.push({ g: 'Promoters & groups', kind: 'label', id: x.key, label: x.name, hint: x.n ? plural(x.n, 'upcoming night', 'upcoming nights') : 'Nothing coming up' }));
    }
    ds.events.filter(e => e.end > t && norm(e.title).indexOf(s) >= 0).slice(0, 6).forEach(e => out.push({ g: 'Events', kind: 'event', id: e.id, label: e.title, hint: city(e).name + ', ' + tDate(e.start, city(e).tz) }));
    // Venues: the directory (with places that have nothing coming up), matched from the start of a word.
    if (ls.length >= 2) {
      loadVenues();
      const word = k => (' ' + k).indexOf(' ' + ls) >= 0;
      const d = vdir(), hits = d.list.filter(x => word(lkey(x.name)))
        .sort((a, b) => !!a.osmOnly - !!b.osmOnly || (b.soon > 0) - (a.soon > 0) || b.nights - a.nights || a.name.length - b.name.length).slice(0, 5);
      hits.forEach(x => out.push({ g: 'Venues', kind: 'venue', id: x.id, label: x.name, hint: x.city.name + ' · ' + (x.unlisted ? 'no listings yet' : x.soon ? plural(x.soon, 'night', 'nights') + ' coming up' : 'nothing coming up') }));
      // OpenStreetMap's clubs in cities whose lists haven't loaded yet, by name.
      loadOsmNames();
      if (O.names && hits.length < 5) {
        const have = new Set(d.list.map(x => x.cityId + '|' + vkey(x.name, x.city.name)));
        O.names.filter(n => !(O.cities[n[0]] && O.cities[n[0]].rows) && S.ds.cityById[n[0]] && (word(lkey(n[2])) || (n[3] && word(lkey(n[3])))))
          .filter(n => !have.has(n[0] + '|' + vkey(n[2], S.ds.cityById[n[0]].name)))
          .slice(0, 5 - hits.length)
          .forEach(n => out.push({ g: 'Venues', kind: 'osm', id: n[0] + '|' + n[1], label: n[2], hint: S.ds.cityById[n[0]].name + ' · no listings yet' }));
      }
    }
    return out;
  }
  /* ---------- search counts: what people look for, counted for Rave Monitor's own dashboard ---------- */
  // What was typed, the kind and name of the result picked, and the city in view, sent without cookies
  // to the accounts API, which keeps only daily counts (worker/api/src/insights.js): nothing about who
  // searched. Off for demo data and in browsers that send Global Privacy Control.
  const SEARCH_LOG = window.RM_ACCOUNTS && window.RM_ACCOUNTS.api ? window.RM_ACCOUNTS.api + '/log/search' : '';
  const searchesSent = new Set();
  let missTimer = 0;
  function areaCity() {
    if (!S.area || !D.L || !D.L.win || !D.L.win.length) return '';
    const top = RM.cityCounts(D.L.win)[0];
    return top ? top.id : '';
  }
  function countSearch(q, r, n) {
    if (!SEARCH_LOG || S.ds.source === 'demo' || navigator.globalPrivacyControl) return;
    const term = String(q || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 80);
    if (term.length < 2) return;
    const sig = term + '|' + (r ? r.kind + '|' + r.label : '');
    if (searchesSent.has(sig)) return;
    searchesSent.add(sig);
    const body = JSON.stringify({ q: term, kind: r ? r.kind : '', pick: r ? cut(r.label, 80) : '', city: areaCity(), results: n });
    try { fetch(SEARCH_LOG, { method: 'POST', body, credentials: 'omit', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }).catch(() => {}); } catch (err) { /* counting must never get in the way */ }
  }
  function renderResults(q) {
    const box = $('#results'), input = $('#q');
    results = searchItems(q); activeIdx = results.length ? 0 : -1;
    // A search that finds nothing is counted once the typing stops, so the misses show what people want that isn't listed.
    clearTimeout(missTimer);
    if (!results.length && norm(q).trim().length >= 2) missTimer = setTimeout(() => { if (!results.length && $('#q').value === q) countSearch(q, null, 0); }, 1500);
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
    countSearch($('#q').value, r, results.length);
    hideResults(); $('#q').blur();
    track('select_search_result', { result_type: r.kind, result: cut(r.label) });
    const ds = S.ds;
    if (r.kind === 'city') MapView.flyToCity(ds.cityById[r.id]);
    else if (r.kind === 'genre') setGenre(r.id, true);
    else if (r.kind === 'artist') setRoute(r.id);
    else if (r.kind === 'label') setLabel(labelIndex().find(x => x.key === r.id));
    else if (r.kind === 'event') openEvent(r.id);
    else if (r.kind === 'venue') focusVenue(vdir().byId[r.id]);
    else if (r.kind === 'osm') {
      // Its city's list first; it may turn out to be a venue with listings under another spelling.
      const [cid, oid] = r.id.split('|');
      loadOsmCity(cid).then(() => { const d = vdir(); focusVenue(d.byId['osm-' + oid] || d.list.find(x => x.osm && x.osm.id === oid)); });
    }
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
    // The map's colors: the theme's, or Midnight's when the build gave none.
    const MIDNIGHT = { void: '#070814', land: '#171c3a', sphere: '#0a0c1d', shade: '#02030c', tint: '#a0aae6', now: '#f6ecd8', nowInk: '#15131f', ink: '#eceaf6', ink2: '#a9abcb', ink3: '#7c7fa3',
      green: '#15283d', park: '#15293f', building: '#1f2650', runway: '#262e5c', motorway: '#b8bce4', waterLabel: '#555d93', streetLabel: '#8d90b5', venueLabel: '#6f7398', ring: '#8b8fa8' };
    function palette() {
      const c = Object.assign({}, MIDNIGHT, (currentTheme() || {}).c || {});
      const n = parseInt(c.now.slice(1), 16);
      c.sea = c.void; c.nowRgb = (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255); // for the pulses, whose opacity changes every frame
      return c;
    }
    const C = palette();
    let W = 0, H = 0, DPR = 1, base = 1, kMin = 1, kMax = 500, lon0 = 10;
    let mapT = d3.zoomIdentity;
    const globe = { rot: [0, -26, 0], k: 1 };
    let proj = null, ppd = 1, inited = false, venueMode = false;
    let baseDirty = true, posDirty = true, overDirty = true, rafId = 0, lastDraw = 0, lastPointer = 'mouse';
    let marks = [], cityMarks = [], festMarks = [], stopMarks = [], venueLabels = [], ringMarks = [], labelHits = [], liveMarks = 0, osmShown = false;
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
        globe.k = t.k; gPrev = t;
        if (ev.sourceEvent) { userMoved(); spinHeld(); }
        changed(true); hideTip();
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
      co.addEventListener('pointerdown', ev => { lastPointer = ev.pointerType || 'mouse'; if (spin.on) spin.pauseUntil = performance.now() + SPIN.resumeMs; });
      co.addEventListener('pointermove', ev => {
        if (ev.pointerType !== 'mouse' || ev.buttons || spinActive()) return;
        const r = co.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, h = hit(x, y);
        co.style.cursor = h ? 'pointer' : 'grab';
        showTip(h, x, y);
      });
      co.addEventListener('pointerleave', hideTip);
      co.addEventListener('click', ev => {
        const r = co.getBoundingClientRect(), h = hit(ev.clientX - r.left, ev.clientY - r.top);
        if (!h) return;
        if (h.kind === 'event') openEvent(h.e.id, { fly: ppd < 60 });
        else if (h.kind === 'venue') focusVenue(h.ve);
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
      if (spin.on) setSpin(false); // going somewhere ends the screensaver
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
      if (spin.on) setSpin(false);
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
      if (v !== 'globe' && spin.on) setSpin(false);
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
      $('#spin').hidden = v !== 'globe';
      changed(true);
    }

    /* ---------- spinning globe ----------
       The globe turns on its own like a screensaver, about once every 80 seconds, after easing to a whole-earth
       view tilted north, where most listings are. Dragging or zooming holds it for a few seconds and keeps
       the view you chose; zooming right in, going to a place or the flat map stops it. */
    const SPIN = { degPerSec: 4.5, tilt: -24, k: 1.05, resumeMs: 6000 };
    const spin = { on: false, t: 0, pauseUntil: 0, tilt: SPIN.tilt, k: SPIN.k, capT: 0 };
    const spinActive = () => spin.on && S.view === 'globe' && performance.now() >= spin.pauseUntil;
    function setSpin(on) {
      on = !!on;
      if (on === spin.on) return;
      spin.on = on; spin.t = 0; spin.pauseUntil = 0;
      if (on) {
        if (S.view !== 'globe') setView('globe');
        spin.tilt = SPIN.tilt;
        spin.k = globe.k > 1.6 || globe.k < 0.85 ? SPIN.k : globe.k;
        S.areaOn = false;
        hideTip();
      } else {
        co.__zoom = d3.zoomIdentity.scale(globe.k); // drag and zoom carry on from where it turned to
        $('#spincap').hidden = true;
        document.body.classList.remove('ui-idle');
      }
      const b = $('#spin');
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? 'Stop spinning the globe' : 'Spin the globe');
      b.title = on ? 'Stop spinning (S)' : 'Spin the globe (S)';
      document.body.classList.toggle('spinning', on);
      track('spin_globe', { state: on ? 'on' : 'off' });
      changed(true);
    }
    // A drag or zoom while it spins: hold for a few seconds, keep the tilt and zoom chosen, or stop when zoomed right in.
    function spinHeld() {
      if (!spin.on) return;
      if (globe.k > 2.2) { setSpin(false); return; }
      spin.pauseUntil = performance.now() + SPIN.resumeMs;
      spin.tilt = globe.rot[1]; spin.k = Math.max(0.8, globe.k);
    }
    function spinStep(time) {
      const dt = spin.t ? Math.min(250, time - spin.t) : 0;
      spin.t = time;
      globe.rot[0] = ((globe.rot[0] + SPIN.degPerSec * dt / 1000) % 360 + 540) % 360 - 180;
      globe.rot[1] += (spin.tilt - globe.rot[1]) * Math.min(1, dt / 2000);
      // Out to the whole earth in a second or two, however far in it started (eased on a log scale).
      if (Math.abs(spin.k - globe.k) > 1e-4) {
        const lk = Math.log(globe.k);
        globe.k = Math.exp(lk + (Math.log(spin.k) - lk) * Math.min(1, dt / 1000));
        co.__zoom = d3.zoomIdentity.scale(globe.k);
      }
      baseDirty = true; posDirty = true; overDirty = true;
      hideTip();
      // The caption: the city it's passing over, its time and what's on.
      if (time - spin.capT < 700) return;
      spin.capT = time;
      const at = [-globe.rot[0], -globe.rot[1]];
      let best = null;
      D.byCity.forEach((list, cid) => {
        const c = S.ds.cityById[cid];
        if (!c || !Number.isFinite(c.lat)) return;
        const d = d3.geoDistance([c.lon, c.lat], at);
        if (d > 0.5) return;
        const score = list.length / (1 + d * 6);
        if (!best || score > best.score) best = { c: c, list: list, score: score };
      });
      const el = $('#spincap');
      if (!best) { el.hidden = true; return; }
      const live = best.list.filter(e => RM.isLive(e, S.now)).length;
      const html = '<b>' + esc(best.c.name) + '</b> ' + esc(tTime(S.now, best.c.tz)) + (live ? ' · ' + live + ' live now' : '') + ' · ' + plural(best.list.length, 'event', 'events') + ' ' + WIN_LABEL[S.win];
      if (el.innerHTML !== html) el.innerHTML = html;
      el.hidden = false;
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
    // A venue with no exact position gets a view of the city around it rather than a street-level one.
    function flyToVenue(v) { S.areaOn = true; flyTo(v.lon, v.lat, v.approx ? 300 : streetsOn() ? 2900 : 360); }
    function inView(lon, lat) {
      if (!proj || !Number.isFinite(lon) || !Number.isFinite(lat) || !vis(lon, lat)) return false;
      const p = proj([lon, lat]);
      return !!p && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H;
    }
    function flyToEvent(e) {
      const x = V.built && V.built.byVenue[e.venueId], v = x && !x.approx ? x : venue(e); // the venue's best-known spot
      flyTo(v.lon, v.lat, Math.max(ppd, streetsOn() ? 1400 : 300));
    }
    function center() { const c = proj && proj.invert([W / 2, H / 2]); return c && isFinite(c[0]) && isFinite(c[1]) ? c : null; }
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
        paint: { 'text-color': color, 'text-halo-color': rgba(C.sea, 0.92), 'text-halo-width': 1.4 }
      });
      const caps = { 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 };
      return {
        version: 8,
        sources: { omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        layers: [
          { id: 'land', type: 'background', paint: { 'background-color': C.land } },
          { id: 'green', type: 'fill', source: 'omt', 'source-layer': 'landcover', minzoom: 9, filter: ['all', isArea, ['match', ['get', 'class'], ['wood', 'grass'], true, false]], paint: { 'fill-color': C.green, 'fill-opacity': 0.6 } },
          { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', minzoom: 9, filter: isArea, paint: { 'fill-color': C.park, 'fill-opacity': 0.8 } },
          { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['all', isArea, ['!=', ['get', 'brunnel'], 'tunnel']], paint: { 'fill-color': C.sea } },
          { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 9, filter: isLine, paint: { 'line-color': C.sea, 'line-width': width([9, 0.6, 14, 2, 18, 6]) } },
          { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': C.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, 0.9] } },
          { id: 'runway', type: 'line', source: 'omt', 'source-layer': 'aeroway', minzoom: 11, filter: ['all', isLine, ['match', ['get', 'class'], ['runway', 'taxiway'], true, false]], paint: { 'line-color': C.runway, 'line-width': width([11, 1, 16, 12]) } },
          road('path', ['path', 'track'], rgba(C.ink2, 0.10), [14, 0.5, 18, 2], 14),
          road('minor', ['minor', 'service'], rgba(C.ink2, 0.15), [12, 0.3, 14, 1.2, 18, 9], 12),
          road('secondary', ['secondary', 'tertiary'], rgba(C.ink2, 0.22), [9, 0.4, 12, 1, 14, 2.4, 18, 12], 9),
          road('primary', ['primary', 'trunk'], rgba(C.ink2, 0.30), [7, 0.4, 10, 1, 14, 3.2, 18, 15], 7),
          road('motorway', ['motorway'], rgba(C.motorway, 0.38), [5, 0.4, 8, 1, 12, 2.4, 14, 4, 18, 18], 5),
          { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12, filter: ['all', isLine, ['match', ['get', 'class'], ['rail', 'transit'], true, false]], paint: { 'line-color': rgba(C.ink2, 0.18), 'line-width': width([12, 0.6, 18, 2.5]), 'line-dasharray': [3, 3] } },
          { id: 'border', type: 'line', source: 'omt', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': rgba(C.tint, 0.3), 'line-width': 1, 'line-dasharray': [3, 2] } },
          label('water-name', 'water_name', ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false], 11, C.waterLabel, 8, 24, { 'text-font': ['Noto Sans Italic'] }),
          label('street-name', 'transportation_name', ['all', isLine, ['!=', ['get', 'class'], 'motorway']], ['interpolate', ['linear'], ['zoom'], 13, 9.5, 17, 12], C.streetLabel, 13, 24,
            { 'symbol-placement': 'line', 'symbol-spacing': 320, 'text-max-angle': 30, 'text-rotation-alignment': 'map', 'text-field': ['coalesce', ['get', 'name'], ''] }),
          label('neighbourhood', 'place', ['match', ['get', 'class'], ['neighbourhood', 'quarter'], true, false], ['interpolate', ['linear'], ['zoom'], 12, 9.5, 16, 12], C.streetLabel, 12, 17, caps),
          label('suburb', 'place', ['==', ['get', 'class'], 'suburb'], ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 13], C.ink2, 10, 16, caps),
          label('town', 'place', ['match', ['get', 'class'], ['town', 'village'], true, false], ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13], C.ink2, 8, 15)
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
      setAttrib();
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
        setAttrib();
      }
    }
    // The map credits: with the street map, or with OpenStreetMap's clubs on the map.
    function setAttrib() { const el = $('#attrib'), on = streets.t > 0 || osmShown; if (el.hidden === on) el.hidden = !on; }
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
        const dir = V.built && V.built.ds === S.ds ? V.built : null;
        S.ds.venues.forEach((v, i) => {
          const x = dir && dir.byVenue[v.id], at = x && !x.approx ? x : v; // e.g. a position from OpenStreetMap
          if (!vis(at.lon, at.lat)) return;
          const p = proj([at.lon, at.lat]);
          if (p && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H) { ids.add(v.id); h = (Math.imul(h, 31) + i + 1) | 0; }
        });
        sig = ids.size + ':' + h;
      }
      if (sig === areaSig) return;
      areaSig = sig;
      areaChanged(ids);
    }

    // A new color theme: the map's colors, the street map's style, then a redraw.
    function restyle() {
      Object.assign(C, palette());
      if (streets.map) { try { streets.map.setStyle(streetStyle(), { diff: true }); } catch (err) { console.warn('street map restyle:', err && err.message); } }
      changed(true);
    }
    function changed(baseToo) {
      if (baseToo) { baseDirty = true; clearTimeout(areaTimer); areaTimer = setTimeout(updateArea, 160); }
      posDirty = true; overDirty = true;
      if (!rafId) rafId = requestAnimationFrame(frame);
    }
    function frame(time) {
      rafId = 0;
      const spinning = spin.on && S.view === 'globe' && !document.hidden;
      if (spinning && time >= spin.pauseUntil) { if (time - lastDraw > 33) spinStep(time); } // about 30 frames a second
      else spin.t = 0; // so it picks up smoothly after a pause
      const anim = spinning || (!reduceMotion && !document.hidden && (liveMarks > 0 || (S.layers.tours && D.tours.length) || S.route || S.me));
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
        g.addColorStop(0, rgba(C.tint, 0.14)); g.addColorStop(1, rgba(C.tint, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(W / 2, H / 2, R * 1.14, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); path(sphere); ctx.fillStyle = C.sphere; ctx.fill();
      }
      ctx.beginPath(); path(grat); ctx.strokeStyle = rgba(C.tint, 0.055); ctx.lineWidth = 0.6; ctx.stroke();
      if (geo) {
        ctx.beginPath(); path(ppd > 6 && !spinActive() ? geo.landHi : geo.landLo); ctx.fillStyle = C.land; ctx.fill();
        ctx.beginPath(); path(geo.lakes); ctx.fillStyle = S.view === 'globe' ? C.sphere : C.sea; ctx.fill();
        ctx.beginPath(); path(geo.borders); ctx.strokeStyle = rgba(C.tint, 0.14); ctx.lineWidth = 0.6; ctx.stroke();
      }
      if (S.layers.belt) {
        const sun = RM.subsolar(S.now), anti = [sun[0] + 180, -sun[1]];
        ctx.fillStyle = rgba(C.shade, 0.22);
        [90, 84, 78].forEach(r => { ctx.beginPath(); path(d3.geoCircle().center(anti).radius(r).precision(3)()); ctx.fill(); });
        const band = RM.clubBand(S.now);
        ctx.beginPath(); path(bandRing(band.raw)); ctx.fillStyle = rgba(C.now, 0.065); ctx.fill();
        ctx.setLineDash([2, 5]); ctx.strokeStyle = rgba(C.now, 0.38); ctx.lineWidth = 1;
        [band.west, band.east].forEach(lon => { ctx.beginPath(); path({ type: 'LineString', coordinates: d3.range(-60, 80.1, 2).map(lat => [lon, lat]) }); ctx.stroke(); });
        ctx.setLineDash([]);
      }
    }

    function computeMarks() {
      marks = []; cityMarks = []; festMarks = []; stopMarks = []; venueLabels = []; ringMarks = []; liveMarks = 0;
      const t = S.now, ds = S.ds;
      venueMode = ppd >= 150;
      // The venue directory loads as the view nears street level, like the street map.
      if (S.layers.venues && ppd >= ST.preload) loadVenues();
      const dir = venueMode ? vdir() : null;
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
          // One cluster per venue in the directory, so a venue's rooms and spellings share one spot and name.
          const byV = new Map();
          regular.forEach(e => {
            const x = dir.byVenue[e.venueId], k = x ? x.id : e.venueId;
            let g = byV.get(k);
            if (!g) byV.set(k, g = { ve: x || null, v: ds.venueById[e.venueId], evs: [] });
            g.evs.push(e);
          });
          byV.forEach(g => {
            const at = g.ve && !g.ve.approx ? g.ve : g.v, evs = g.evs;
            if (!vis(at.lon, at.lat)) return;
            const pv = proj([at.lon, at.lat]); if (!onScreen(pv)) return;
            const sp = r0 * spread;
            evs.forEach((e, i) => { const a = i * 2.39996, rr = sp * Math.sqrt(i), live = RM.isLive(e, t); if (live) liveMarks++; marks.push({ e: e, x: pv[0] + rr * Math.cos(a), y: pv[1] + rr * Math.sin(a), r: r0, live: live, so: RM.statusAt(e, t) === 'soldout', seed: e.seed }); });
            const next = evs.filter(e => e.end > t).sort((a, b) => a.start - b.start)[0] || evs[0];
            venueLabels.push({ v: g.v, ve: g.ve, name: g.ve ? g.ve.name : g.v.name, approx: g.ve ? g.ve.approx : g.v.approx, x: pv[0], y: pv[1], n: evs.length, R: sp * Math.sqrt(Math.max(0, evs.length - 1)) + r0, next: next });
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
      // The venues layer: every venue with a real position as a pool in the colour of its main sound,
      // sized by how many nights it has been listed. With nights in the window it sits under their dots.
      if (venueMode && S.layers.venues) {
        // OpenStreetMap's clubs for the cities around: any whose centre is within half a screen of it,
        // and the nearest one (at street level the centre can be far off-screen).
        const mid = proj.invert([W / 2, H / 2]);
        let near = null;
        ds.cities.forEach(c => {
          if (!Number.isFinite(c.lat) || !vis(c.lon, c.lat)) return;
          const p = proj([c.lon, c.lat]);
          if (p && p[0] > -W / 2 && p[0] < W * 1.5 && p[1] > -H / 2 && p[1] < H * 1.5) loadOsmCity(c.id);
          if (mid && isFinite(mid[0])) { const d = kmBetween(mid[1], mid[0], c.lat, c.lon); if (!near || d < near.d) near = { c: c, d: d }; }
        });
        if (near && near.d < 60) loadOsmCity(near.c.id);
        const active = new Map();
        venueLabels.forEach(vl => { if (vl.ve) active.set(vl.ve.id, vl); });
        const k = Math.max(0.45, Math.min(1.25, Math.sqrt(ppd / 600)));
        dir.list.forEach(x => {
          if (x.approx) return;
          const vl = active.get(x.id);
          let px, py;
          if (vl) { px = vl.x; py = vl.y; }
          else { if (!vis(x.lon, x.lat)) return; const p = proj([x.lon, x.lat]); if (!onScreen(p)) return; px = p[0]; py = p[1]; }
          if (x.unlisted) { ringMarks.push({ ve: x, x: px, y: py, r: 2.2 * k + 0.8, active: false, quiet: true, osm: !!x.osmOnly, col: C.ink2 }); return; }
          const r = (2.6 + Math.sqrt(Math.max(1, x.nights)) * 0.85) * k;
          ringMarks.push({ ve: x, x: px, y: py, r: vl ? Math.max(vl.R + 3.5, r) : r, active: !!vl, col: x.main ? RM.GENRE[x.main].color : C.ring });
        });
      }
      const osm = ringMarks.some(rm => rm.osm || rm.ve.osm);
      if (osm !== osmShown) { osmShown = osm; setAttrib(); }
    }
    // '#rrggbb' at an opacity.
    const rgbaCache = {};
    function rgba(hex, a) {
      const k = hex + a;
      if (!rgbaCache[k]) { const n = parseInt(hex.slice(1), 16); rgbaCache[k] = 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; }
      return rgbaCache[k];
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
          g.addColorStop(0, rgba(C.now, 0.14)); g.addColorStop(0.45, rgba(C.now, 0.05)); g.addColorStop(1, rgba(C.now, 0));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cm.x, cm.y, rad, 0, Math.PI * 2); ctx.fill();
        });
      }
      const flow = reduceMotion ? 0 : -(time / 45) % 18;
      if (S.layers.tours && D.tours.length) {
        ctx.save(); ctx.setLineDash([3, 6]); ctx.lineDashOffset = flow; ctx.strokeStyle = rgba(C.now, 0.26); ctx.lineWidth = 1;
        D.tours.forEach(seg => { ctx.beginPath(); path({ type: 'LineString', coordinates: seg }); ctx.stroke(); });
        ctx.restore();
      }
      if (S.route) {
        const gigs = routeGigs(S.route);
        if (gigs.length > 1) {
          ctx.save(); ctx.setLineDash([7, 5]); ctx.lineDashOffset = flow * 1.4; ctx.strokeStyle = rgba(C.now, 0.9); ctx.lineWidth = 1.6;
          ctx.beginPath(); path({ type: 'LineString', coordinates: gigs.map(e => [venue(e).lon, venue(e).lat]) }); ctx.stroke();
          ctx.restore();
        }
      }
      const fvId = S.label && S.label.kind === 'venue' ? S.label.venue.id : null, isF = ve => !!ve && ve.id === fvId;
      ringMarks.forEach(rm => {
        const on = isF(rm.ve);
        ctx.beginPath(); ctx.arc(rm.x, rm.y, rm.r, 0, Math.PI * 2);
        if (rm.quiet) {
          // No listings yet: a faint dashed ring.
          ctx.fillStyle = rgba(rm.col, 0.06); ctx.fill();
          ctx.setLineDash(on ? [] : [2, 2]); ctx.lineWidth = on ? 2 : 1; ctx.strokeStyle = on ? C.now : rgba(rm.col, 0.6); ctx.stroke(); ctx.setLineDash([]);
          return;
        }
        ctx.fillStyle = rgba(rm.col, rm.active ? 0.12 : 0.18); ctx.fill();
        ctx.lineWidth = on ? 2 : 1; ctx.strokeStyle = on ? C.now : rgba(rm.col, rm.active ? 0.42 : 0.75); ctx.stroke();
      });
      marks.forEach(m => {
        const col = gen(m.e).color;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        if (m.so) { ctx.fillStyle = C.sea; ctx.fill(); ctx.lineWidth = 1.3; ctx.strokeStyle = col; ctx.stroke(); }
        else { ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 0.8; ctx.strokeStyle = rgba(C.sea, 0.85); ctx.stroke(); }
      });
      marks.forEach(m => {
        if (!m.live) return;
        const ph = reduceMotion ? 0.3 : ((time / 1900) + m.seed) % 1;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r + 1.4 + ph * 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(' + C.nowRgb + ',' + (reduceMotion ? 0.7 : (1 - ph) * 0.75).toFixed(3) + ')'; ctx.lineWidth = 1.1; ctx.stroke();
      });
      festMarks.forEach(f => {
        const col = gen(f.e).color, r = f.r;
        ctx.beginPath(); ctx.moveTo(f.x, f.y - r * 1.25); ctx.lineTo(f.x + r * 1.25, f.y); ctx.lineTo(f.x, f.y + r * 1.25); ctx.lineTo(f.x - r * 1.25, f.y); ctx.closePath();
        ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = C.ink; ctx.stroke();
        if (f.live) { const ph = reduceMotion ? 0.3 : ((time / 1900)) % 1; ctx.beginPath(); ctx.arc(f.x, f.y, r * 1.6 + ph * 8, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(' + C.nowRgb + ',' + (reduceMotion ? 0.7 : (1 - ph) * 0.8).toFixed(3) + ')'; ctx.lineWidth = 1.2; ctx.stroke(); }
      });
      if (stopMarks.length) {
        ctx.font = '700 11px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        stopMarks.forEach(s => {
          ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, Math.PI * 2); ctx.fillStyle = C.now; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = C.sea; ctx.stroke();
          ctx.fillStyle = C.nowInk; ctx.fillText(String(s.i + 1), s.x, s.y + 0.5);
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
        ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = 3.2; ctx.strokeStyle = rgba(C.sea, 0.92);
        ctx.strokeText(text, x0, y); ctx.fillStyle = color; ctx.fillText(text, x0, y);
        return box;
      };
      labelHits = [];
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
          // The venue in focus gets its name placed first, even with nothing coming up. Names are tappable:
          // they open the venue.
          const fr = fvId ? ringMarks.find(rm => isF(rm.ve) && !rm.active) : null;
          if (fr) { const box = put(fr.ve.name, fr.x + fr.r + 4, fr.y, C.now, '700 12px ' + FONT); if (box) labelHits.push({ box: box, ve: fr.ve }); }
          venueLabels.sort((a, b) => isF(b.ve) - isF(a.ve) || b.n - a.n).forEach(vl => {
            const on = isF(vl.ve);
            const box = put(vl.approx ? vl.name + ' (location approximate)' : vl.name, vl.x + vl.R + 5, vl.y, on ? C.now : vl.approx ? C.ink3 : C.ink2, on ? '700 12px ' + FONT : undefined);
            if (!box) return;
            if (vl.ve) labelHits.push({ box: box, ve: vl.ve });
            // At street level, for planning: when the next party there is and who's on, in its genre's colour.
            const e = vl.next;
            if (ppd < ST.detailPpd || !e) return;
            const c = city(e), who = lineupNames(e, 2) || e.title;
            let line = (RM.isLive(e, t) ? 'Now' : tDay(e.start, c.tz) + ' ' + tTime(e.start, c.tz)) + ' · ' + who;
            if (line.length > 46) line = line.slice(0, 45) + '…';
            put(line + (vl.n > 1 ? '  +' + (vl.n - 1) : ''), vl.x + vl.R + 5, vl.y + 17, gen(e).color, '500 10.5px ' + FONT);
          });
          // Closer in, the quiet venues' names too, where there's room.
          if (ppd >= 420) ringMarks.filter(rm => !rm.active && !rm.quiet && rm !== fr).sort((a, b) => isF(b.ve) - isF(a.ve) || b.ve.nights - a.ve.nights).forEach(rm => {
            const on = isF(rm.ve), box = put(rm.ve.name, rm.x + rm.r + 4, rm.y, on ? C.now : C.ink3, on ? '700 12px ' + FONT : '500 10.5px ' + FONT);
            if (box) labelHits.push({ box: box, ve: rm.ve });
          });
          // Closer still, the places with no listings yet.
          ringMarks.filter(rm => rm.quiet && rm !== fr && ppd >= 900).sort((a, b) => isF(b.ve) - isF(a.ve)).forEach(rm => {
            const on = isF(rm.ve), box = put(rm.ve.name, rm.x + rm.r + 4, rm.y, on ? C.now : C.venueLabel, on ? '700 12px ' + FONT : '500 10px ' + FONT);
            if (box) labelHits.push({ box: box, ve: rm.ve });
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
      const pad = touch ? 7 : 2;
      for (let i = 0; i < labelHits.length; i++) {
        const b = labelHits[i].box;
        if (x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad) return { kind: 'venue', ve: labelHits[i].ve };
      }
      ringMarks.forEach(rm => near(rm.x, rm.y, (rm.r + 5) * grow, { kind: 'venue', ve: rm.ve }));
      if (best) return best;
      cityMarks.forEach(cm => near(cm.x, cm.y, (Math.max(cm.R, 6) + 6) * grow, { kind: 'city', c: cm.c, cm: cm }));
      return best;
    }
    function showTip(h, x, y) {
      if (!h) return hideTip();
      let html;
      if (h.kind === 'city') {
        html = '<b>' + esc(h.c.name) + '</b>' + plural(h.cm.n, 'event', 'events') + ' ' + WIN_LABEL[S.win] + (h.cm.live && S.win !== 'live' ? ', ' + h.cm.live + ' live now' : '') + '<div class="tline">Select to zoom in</div>';
      } else if (h.kind === 'venue' && h.ve.unlisted) {
        const x = h.ve;
        html = '<b>' + esc(x.name) + '</b>' + esc(x.city.name) + (x.osm && x.osm.kind === 1 ? ', music venue' : '') +
          '<div class="tline">No listings yet</div><div class="tline">' + (x.osmOnly ? 'From OpenStreetMap · select to see it' : 'Select to see it') + '</div>';
      } else if (h.kind === 'venue') {
        const x = h.ve, k = new Set(x.evs.filter(e => RM.inWindow(e, S.ds, S.now, S.win) && RM.inGenres(e, S.genres)).map(e => nightKey(e.start, x.city.tz))).size;
        html = '<b>' + esc(x.name) + '</b>' + esc(x.city.name) + (x.concert ? ', concert venue' : '') +
          '<div class="tline">' + (k ? plural(k, 'night', 'nights') + ' ' + WIN_LABEL[S.win] : 'Nothing ' + WIN_LABEL[S.win]) + '</div>' +
          (x.nights ? '<div class="tline">' + (x.main ? '<i class="gdot" style="--c:' + RM.GENRE[x.main].color + '"></i>' : '') + plural(x.nights, 'night', 'nights') + ' listed' + (x.main ? ', mostly ' + esc(RM.GENRE[x.main].name.toLowerCase()) : '') + '</div>' : '') +
          '<div class="tline">Select to see the venue</div>';
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

    return { init: init, changed: changed, setView: setView, home: home, flyTo: flyTo, flyToCity: flyToCity, flyToVenue: flyToVenue, flyToEvent: flyToEvent, fitEvents: fitEvents, focusNear: focusNear, zoomBy: zoomBy, resize: resize, setStreets: setStreets, restyle: restyle, inView: inView, center: center, setSpin: setSpin, spinning: () => spin.on };
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
    (feed.cities || []).forEach(c => { const cc = { id: c.id, name: c.name, aka: c.aka || [], cc: c.country, lat: c.lat, lon: c.lon, tz: c.tz || 'UTC', region: c.region || 'eu', cur: c.currency || 'USD', weight: 3, venues: [], residents: [] }; ds.cities.push(cc); ds.cityById[cc.id] = cc; });
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
    // Artists to find and follow even with nothing listed (config/artists.json), with their links.
    (window.RM_ARTISTS || []).forEach(c => {
      if (!c || !c.name) return;
      const a = ds.artistById[artistId(c.name)];
      a.curated = true; a.home = c.city || null;
      a.links = [['Website', c.url], ['RA', c.ra], ['YouTube', c.youtube], ['Spotify', c.spotify], ['SoundCloud', c.soundcloud], ['Instagram', c.instagram], ['Facebook', c.facebook]].filter(l => /^https:\/\//.test(l[1] || ''));
    });
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
      '<p>Every listing links back to its source page. Sell-out odds and surges need history and stay off until the feed has some.</p>' + streamsAbout() +
      '<p>Venues come from the listings. The places with no listings yet, and some venue addresses and websites, come from OpenStreetMap (© OpenStreetMap contributors, under the Open Database License).</p>';
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
      if (a === 'venue') return focusVenue(vdir().byVenue[act.dataset.vid]);
      if (a === 'venue-more') return venueDetails();
      if (a === 'ven-all') { S.venAll = true; renderVenues(); return; }
      if (a === 'crew-kind') { S.crewKind = act.dataset.kind === 'label' ? 'label' : 'promoter'; S.crewAll = false; renderPromoters(); return; }
      if (a === 'crew-all') { S.crewAll = true; renderPromoters(); return; }
      if (a === 'crew-more') return crewDetails();
      if (a === 'live-all') { S.liveAll = true; renderLive(); return; }
      if (a === 'list-all') { S.listAll = true; renderListings(); return; }
      if (a === 'privacy-settings') { ev.preventDefault(); privacySettings(); return; }
      if (a === 'about') { ev.preventDefault(); openAbout(); return; }
      if (a === 'updates') { ev.preventDefault(); openUpdates(); return; }
      if (a === 'area-all') { MapView.home(true); return; }
    }
    const opt = t.closest('#results [role="option"]');
    if (opt) return chooseResult(+opt.dataset.i);
    const tab = t.closest('[data-tab]');
    if (tab) { track('open_tab', { tab: tab.dataset.tab }); return selectTab(tab.dataset.tab); }
    const evRow = t.closest('[data-ev]');
    if (evRow) return openEvent(evRow.dataset.ev);
    const vRow = t.closest('[data-venue]');
    if (vRow) return focusVenue(vdir().byId[vRow.dataset.venue]);
    const cRow = t.closest('[data-crew]');
    if (cRow) { const x = crewDir(cRow.dataset.kind).byKey.get(cRow.dataset.crew); if (x) setLabel({ key: x.key, name: x.name, kind: x.kind }); return; }
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
        if (themeOpen()) return; // the colors popover closes itself
        if (!$('#results').hidden) return hideResults();
        if (S.sel) return closeDrawer();
        if (!$('#layers').hidden) return toggleLayers(false);
        if (mapFull()) return setMapFull(false);
        if (S.route) return setRoute(null);
        if (S.label) return setLabel(null);
        return;
      }
      if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === '/') { ev.preventDefault(); $('#q').focus(); }
      else if (ev.key === 'g') MapView.setView(S.view === 'map' ? 'globe' : 'map');
      else if (ev.key === 'f') setMapFull(!mapFull());
      else if (ev.key === 's') MapView.setSpin(!MapView.spinning());
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
      const showFab = () => { fab.hidden = !(S.mode === 'narrow' && mapGone && !S.sel && !mapFull()); };
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
    $('#fullscreen').addEventListener('click', () => setMapFull(!mapFull()));
    $('#spin').addEventListener('click', () => MapView.setSpin(!MapView.spinning()));
    // Screensaver: in full screen with the globe spinning, the controls fade after three still seconds.
    let idleTimer = 0;
    const uiActive = () => {
      document.body.classList.remove('ui-idle');
      clearTimeout(idleTimer);
      if (mapFull() && MapView.spinning()) idleTimer = setTimeout(() => { if (mapFull() && MapView.spinning() && $('#layers').hidden && !S.sel) document.body.classList.add('ui-idle'); }, 3000);
    };
    ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(type => document.addEventListener(type, uiActive, { capture: true, passive: true }));
    ['#spin', '#fullscreen'].forEach(id => $(id).addEventListener('click', uiActive));
    // Leaving the browser's full screen (Esc, a swipe) leaves the full-screen map too.
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && realFull) { realFull = false; setMapFull(false); } });
    // Once the visitor moves the map or searches, a late position from startNear() stays out of the way.
    ['pointerdown', 'wheel', 'keydown'].forEach(type => $('#stage').addEventListener(type, () => { movedSinceStart = true; }, { capture: true, passive: true }));
    $('#q').addEventListener('focus', () => { movedSinceStart = true; loadVenues(); loadOsmNames(); });
    $('#brand').addEventListener('click', ev => { ev.preventDefault(); setRoute(null); if (S.label) setLabel(null); if (S.sel) closeDrawer(); MapView.home(true); });
    $('#layers-btn').addEventListener('click', () => toggleLayers($('#layers').hidden));
    const lyMap = { 'ly-belt': 'belt', 'ly-heat': 'heat', 'ly-fest': 'fest', 'ly-tours': 'tours', 'ly-venues': 'venues', 'ly-labels': 'labels' };
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

  /* ---------- colors: the theme picker under the palette button ---------- */
  // A popover (light dismiss, Esc, above everything) placed under its button. Browsers without
  // popovers get the same panel, opened and closed here.
  const POP = typeof HTMLElement !== 'undefined' && Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover');
  function themeOpen() {
    const pop = $('#theme-pop');
    if (!pop) return false;
    try { return POP ? pop.matches(':popover-open') : !pop.hidden; } catch (err) { return false; }
  }
  function placeThemePop() {
    const btn = $('#theme-btn'), pop = $('#theme-pop');
    const r = btn.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 20);
    pop.style.top = Math.round(r.bottom + 8) + 'px';
    pop.style.left = Math.round(Math.max(10, Math.min(window.innerWidth - w - 10, r.right - w))) + 'px';
  }
  function setTheme(t, save) {
    if (!t) return;
    document.documentElement.setAttribute('data-theme', t.id);
    const m = $('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t.c.void);
    if (save) { try { localStorage.setItem('rm_theme', t.id); } catch (err) { /* private browsing: for this visit only */ } }
    const box = $('#theme-opts'), r = box && box.querySelector('input[value="' + t.id + '"]');
    if (r) r.checked = true;
    const edit = $('#theme-edit');
    if (edit) edit.hidden = true;
    MapView.restyle();
  }
  const swatch = c => '--sv:' + c.void + ';--sl:' + c.land + ';--sn:' + c.now + ';--sk:' + c.line;
  const DEFAULT_OWN = ['#3b0a1e', '#ffffff'];
  // The six presets, then "Your own": a background and an accent of the visitor's choosing.
  function themeOptions() {
    const box = $('#theme-opts');
    if (!box || !THEMES) return;
    const cur = currentTheme();
    box.innerHTML = THEMES.list.map(t => '<label class="topt"><input type="radio" name="rm-theme" value="' + esc(t.id) + '"' + (t === cur ? ' checked' : '') + '>' +
      '<span class="tsw" aria-hidden="true" style="' + swatch(t.c) + '"></span><span class="tn">' + esc(t.name) + '</span></label>').join('') +
      '<label class="topt"><input type="radio" name="rm-theme" value="custom"' + (cur && cur.id === 'custom' ? ' checked' : '') + '>' +
        '<span class="tsw' + (OWN ? '' : ' blank') + '" id="tsw-own" aria-hidden="true" style="' + (OWN ? swatch(OWN.c) : '') + '"></span><span class="tn">Your own</span></label>';
    const edit = $('#theme-edit');
    if (edit) {
      edit.hidden = !(cur && cur.id === 'custom');
      $('#tc-bg').value = (OWN && OWN.bg) || DEFAULT_OWN[0];
      $('#tc-accent').value = (OWN && OWN.accent) || DEFAULT_OWN[1];
    }
  }
  function paintOwnSwatch() {
    const sw = $('#tsw-own');
    if (sw && OWN) { sw.classList.remove('blank'); sw.setAttribute('style', swatch(OWN.c)); }
  }
  function setOwnColors(bg, accent, save) {
    const own = ownFrom(bg, accent);
    if (!own) return;
    OWN = own;
    const css = KIT.css(own.c);
    let st = document.getElementById('rm-custom');
    if (!st) { st = document.createElement('style'); st.id = 'rm-custom'; document.head.appendChild(st); }
    st.textContent = ':root[data-theme="custom"]{' + css + '}';
    document.documentElement.setAttribute('data-theme', 'custom');
    const m = $('meta[name="theme-color"]');
    if (m) m.setAttribute('content', own.c.void);
    if (save) { try { localStorage.setItem('rm_theme', 'custom'); localStorage.setItem('rm_theme_custom', JSON.stringify({ bg, accent, void: own.c.void, css })); } catch (err) { /* private browsing: for this visit only */ } }
    const r = $('#theme-opts input[value="custom"]');
    if (r) r.checked = true;
    paintOwnSwatch();
    MapView.restyle();
  }
  function openColors() {
    const btn = $('#theme-btn'), pop = $('#theme-pop');
    if (!btn || btn.hidden || themeOpen()) return;
    if (POP) { try { pop.showPopover(); } catch (err) { /* already open */ } } else btn.click();
  }
  function buildThemePicker() {
    const btn = $('#theme-btn'), pop = $('#theme-pop'), box = $('#theme-opts');
    if (!btn || !pop || !box || !THEMES || THEMES.list.length < 2) return;
    themeOptions();
    const opened = open => {
      btn.setAttribute('aria-expanded', String(open));
      if (open) { const r = box.querySelector('input:checked') || box.querySelector('input'); if (r) r.focus(); track('open_colors', {}); }
    };
    if (POP) {
      pop.addEventListener('beforetoggle', ev => { if (ev.newState === 'open') placeThemePop(); });
      pop.addEventListener('toggle', ev => opened(ev.newState === 'open'));
    } else {
      // No popovers: a panel this script opens and closes (outside click and Esc close it too).
      btn.removeAttribute('popovertarget'); pop.removeAttribute('popover'); pop.hidden = true;
      const shut = () => { if (!pop.hidden) { pop.hidden = true; opened(false); } };
      btn.addEventListener('click', () => { if (pop.hidden) { placeThemePop(); pop.hidden = false; opened(true); } else shut(); });
      document.addEventListener('pointerdown', ev => { if (!ev.target.closest('#theme-pop') && !ev.target.closest('#theme-btn')) shut(); });
      document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !pop.hidden) { shut(); btn.focus(); } });
    }
    box.addEventListener('change', ev => {
      const edit = $('#theme-edit');
      if (ev.target.value === 'custom') {
        // Your own colors: the last ones picked here, or a starting point, then the two pickers below.
        const bg = (OWN && OWN.bg) || DEFAULT_OWN[0], accent = (OWN && OWN.accent) || DEFAULT_OWN[1];
        setOwnColors(bg, accent, true);
        if (edit) { edit.hidden = false; $('#tc-bg').value = bg; $('#tc-accent').value = accent; }
        document.dispatchEvent(new CustomEvent('rm:custom-colors', { detail: { bg, accent } }));
        track('set_colors', { theme: 'custom' });
        return;
      }
      const t = themeById(ev.target.value);
      if (!t) return;
      if (edit) edit.hidden = true;
      setTheme(t, true);
      document.dispatchEvent(new CustomEvent('rm:theme', { detail: { id: t.id } }));
      track('set_colors', { theme: t.id });
    });
    // The background and accent pickers: the page follows as they move, and keeps the pick when they let go.
    let rafOwn = 0;
    const own = save => {
      // Read the pickers when it runs, so a frame queued while dragging can't undo a later pick.
      cancelAnimationFrame(rafOwn);
      if (!save) { rafOwn = requestAnimationFrame(() => setOwnColors($('#tc-bg').value, $('#tc-accent').value, false)); return; }
      const bg = $('#tc-bg').value, accent = $('#tc-accent').value;
      setOwnColors(bg, accent, true);
      document.dispatchEvent(new CustomEvent('rm:custom-colors', { detail: { bg, accent } }));
    };
    ['#tc-bg', '#tc-accent'].forEach(id => { const i = $(id); if (i) { i.addEventListener('input', () => own(false)); i.addEventListener('change', () => own(true)); } });
    window.addEventListener('resize', () => { if (themeOpen()) placeThemePop(); });
    // A pick in another tab follows here.
    window.addEventListener('storage', ev => {
      if (ev.key !== 'rm_theme' && ev.key !== 'rm_theme_custom') return;
      let id = null, x = null;
      try { id = localStorage.getItem('rm_theme'); x = JSON.parse(localStorage.getItem('rm_theme_custom') || 'null'); } catch (err) { return; }
      if (id === 'custom' && x) setOwnColors(x.bg, x.accent, false);
      else if (ev.key === 'rm_theme') setTheme(themeById(id) || themeById(THEMES.def), false);
    });
    document.addEventListener('rm:open-colors', openColors);
    // Signed in, the choice is kept on the account too (site/account.js), so it follows people around.
    const note = $('.theme-note');
    const sayWhere = () => { if (note) note.textContent = (window.RM_ACCT || {}).signedIn ? 'Saved to your account, so your colors follow you to every device.' : 'Saved in this browser, for every page.'; };
    document.addEventListener('rm:account', sayWhere);
    sayWhere();
    btn.hidden = false;
  }

  /* ---------- what's new (config/updates.json), from the footer ---------- */
  // A dot by the footer link while the latest change is under three weeks old and unseen here.
  const UPD_SEEN = 'rm_updates_seen';
  function markUpdates() {
    const latest = window.RM_UPDATES_LATEST, link = $('.sitefoot a[data-act="updates"]');
    if (!latest || !link) return;
    let seen = null;
    try { seen = localStorage.getItem(UPD_SEEN); } catch (err) { /* private browsing */ }
    const fresh = Date.now() - Date.parse(latest + 'T00:00:00Z') < 21 * DAY;
    const unseen = fresh && (!seen || seen < latest);
    link.classList.toggle('has-new', unseen);
    link.setAttribute('aria-label', unseen ? 'What\'s new (something you haven\'t seen)' : 'What\'s new');
  }
  function openUpdates() {
    const d = $('#updates');
    if (!d) { location.href = '/updates/'; return; }
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    try { localStorage.setItem(UPD_SEEN, window.RM_UPDATES_LATEST || ''); } catch (err) { /* private browsing */ }
    markUpdates();
    track('open_updates', {});
  }

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
    buildThemePicker();
    markUpdates();
    renderAll();
    MapView.init();
    startNear();
    updateClock();
    setInterval(updateClock, 10000);
    setInterval(() => { S.now = Date.now(); derive(); renderAll(); MapView.changed(true); }, 30000);
    streamsP.then(() => { S.streamsTried = true; mergeStreams(); renderStreams(); });
    window.RM_APP = {
      events: () => S.ds.source === 'demo' ? [] : S.ds.events,
      event: id => S.ds.source === 'demo' ? null : S.ds.eventById[id] || null,
      cities: () => S.ds.cities.map(c => ({ id: c.id, name: c.name, aka: c.aka || [], cc: c.cc || '' })),
      city: id => S.ds.cityById[id] || null,
      cityName: id => (S.ds.cityById[id] || {}).name || id,
      genres: () => RM.GENRES.map(g => ({ id: g.id, name: g.name, color: g.color })),
      venueOf: e => { const v = vdir().byVenue[e.venueId]; return v ? { id: v.id, name: v.name, cityId: v.cityId } : null; },
      venueName: e => (venue(e) || {}).name || '',
      artistNames: e => e.heads.concat(e.support).map(artist).filter(Boolean).map(a => a.name).filter(n => !NOT_NAMES.test(n)),
      lkey, akey, track,
      theme: {
        current: () => (currentTheme() || {}).id || null,
        set: id => setTheme(themeById(id) || themeById(THEMES && THEMES.def), true),
        custom: (bg, accent, save) => setOwnColors(bg, accent, save),
        own: () => (OWN ? { bg: OWN.bg, accent: OWN.accent } : null),
        has: id => !!themeById(id)
      },
      when: (ms, tz) => tDate(ms, tz) + ', ' + tTime(ms, tz),
      // The show on air now on an NTS channel ('NTS 1'), for the mini player (site/player.js).
      onAir: ch => { const t = Date.now(), x = S.streams.find(s => s.kind === 'radio' && s.channel === ch && s.t0 <= t && t < s.t1); return x ? { title: x.title, until: x.t1, url: x.url } : null; },
      openEvent: id => { if (!S.ds.eventById[id] || S.ds.source === 'demo') return false; openEvent(id); return true; }
    };
    document.dispatchEvent(new CustomEvent('rm:ready'));
    const link = new URL(location.href), want = link.searchParams.get('event');
    if (want) {
      link.searchParams.delete('event');
      history.replaceState(history.state, '', link.pathname + link.search + link.hash);
      if (!window.RM_APP.openEvent(want)) toast('That listing has ended or isn\'t listed any more.');
    }
    setInterval(() => refreshStreams(true), 15 * 60000);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => MapView.changed(false));
  }
  boot();
})();
