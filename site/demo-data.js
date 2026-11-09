/* Rave Monitor data engine.
   Demo mode: every event, artist, venue, price and count is fictional and generated
   deterministically in the browser. Cities, coordinates and time zones are real, so
   local times, the club-hours band and "live now" behave like the real thing. */
var RMData = (function () {
  'use strict';
  var HOUR = 3600e3, DAY = 864e5;

  /* ---------- seeded randomness ---------- */
  function hash(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }
  function rngFor(key) {
    var a = hash(key);
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }
  function pickW(r, items, wfn) {
    var tot = 0, i, w = [];
    for (i = 0; i < items.length; i++) { w[i] = Math.max(0, wfn(items[i])); tot += w[i]; }
    if (tot <= 0) return items[Math.floor(r() * items.length)];
    var x = r() * tot;
    for (i = 0; i < items.length; i++) { x -= w[i]; if (x <= 0) return items[i]; }
    return items[items.length - 1];
  }
  function poisson(r, lam) {
    if (lam <= 0) return 0;
    if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal(r)));
    var L = Math.exp(-lam), k = 0, p = 1;
    do { k++; p *= r(); } while (p > L);
    return k - 1;
  }
  function normal(r) {
    var u = 1 - r(), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function shuffle(r, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* ---------- time zones ---------- */
  var dtf = {};
  function tzOffsetMin(tz, utc) {
    var f = dtf[tz] || (dtf[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'
    }));
    var p = f.formatToParts(new Date(utc)), m = {};
    for (var i = 0; i < p.length; i++) m[p[i].type] = p[i].value;
    var asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, (+m.hour) % 24, +m.minute, +m.second);
    return Math.round((asUtc - utc) / 60000);
  }
  var offCache = {};
  /* local wall time on calendar date (y, m0, d) plus dayAdd -> UTC ms */
  function zoned(tz, y, m0, d, dayAdd, hh, mm) {
    var guess = Date.UTC(y, m0, d + dayAdd, hh, mm);
    var key = tz + '|' + Math.floor(guess / (6 * HOUR));
    var off = offCache[key];
    if (off === undefined) off = offCache[key] = tzOffsetMin(tz, guess);
    return guess - off * 60000;
  }
  function dayKeyOf(ms) { return new Date(ms).toISOString().slice(0, 10); }

  /* ---------- reference tables ---------- */
  var GENRES = [
    { id: 'techno', name: 'Techno', bpm: '125–150', color: '#3987e5', subs: ['Peak-time', 'Hypnotic', 'Hard techno', 'Industrial', 'Acid', 'Dub techno', 'Hard groove'] },
    { id: 'house', name: 'House', bpm: '118–128', color: '#d95926', subs: ['Deep house', 'Tech house', 'Minimal', 'Jackin', 'Lo-fi house', 'Progressive house'] },
    { id: 'dnb', name: 'Drum & bass', bpm: '170–176', color: '#199e70', subs: ['Jungle', 'Liquid', 'Neurofunk', 'Jump-up', 'Halftime'] },
    { id: 'afro', name: 'Afro & amapiano', bpm: '110–124', color: '#c98500', subs: ['Amapiano', 'Afro house', 'Gqom', 'Afro tech', 'Baile funk'] },
    { id: 'disco', name: 'Disco & edits', bpm: '105–124', color: '#d55181', subs: ['Nu-disco', 'Italo', 'Balearic', 'Edits', 'Cosmic'] },
    { id: 'garage', name: 'Garage & breaks', bpm: '130–140', color: '#008300', subs: ['UK garage', 'Speed garage', 'Breaks', 'Electro', 'Bassline'] },
    { id: 'trance', name: 'Trance & psy', bpm: '130–145', color: '#9085e9', subs: ['Trance', 'Psytrance', 'Progressive trance', 'Hard trance', 'Goa'] },
    { id: 'bass', name: 'Bass & dubstep', bpm: '140–150', color: '#e66767', subs: ['Dubstep', 'Riddim', 'Wave', 'Bass house', 'Grime'] },
    // For listings none of the families fit: dance and electronic music in general, and everything else.
    { id: 'electronic', name: 'Dance/electronic', bpm: 'varies', color: '#22b8cf', subs: ['EDM', 'Electronica', 'Club', 'Ambient', 'Experimental', 'Big room'] },
    { id: 'misc', name: 'Misc', bpm: 'varies', color: '#8b8fa8', subs: ['Pop', 'Hip-hop', 'R&B', 'Rock', 'Latin', 'Live'] }
  ];
  var GENRE = {}; GENRES.forEach(function (g) { GENRE[g.id] = g; });
  var OTHER = GENRE.misc; GENRE.other = OTHER; // feeds from before the two buckets said 'other'

  var REGIONS = { eu: 'Europe', na: 'North America', la: 'Latin America', ap: 'Asia-Pacific', af: 'Africa & Middle East' };

  var PROFILES = {
    techno: { techno: .46, house: .17, disco: .06, garage: .05, trance: .09, dnb: .05, bass: .04, afro: .08 },
    uk: { house: .21, dnb: .19, garage: .16, techno: .16, bass: .09, afro: .08, disco: .07, trance: .04 },
    house: { house: .40, techno: .22, disco: .12, afro: .10, garage: .05, dnb: .04, trance: .04, bass: .03 },
    latam: { techno: .30, house: .28, afro: .16, disco: .07, trance: .09, bass: .04, dnb: .03, garage: .03 },
    afro: { afro: .52, house: .24, techno: .09, disco: .05, garage: .04, dnb: .03, bass: .02, trance: .01 },
    edm: { house: .30, bass: .26, trance: .14, techno: .14, dnb: .07, garage: .04, afro: .03, disco: .02 },
    asia: { techno: .30, house: .30, disco: .14, garage: .06, trance: .06, dnb: .06, bass: .04, afro: .04 },
    aus: { house: .28, techno: .24, dnb: .14, disco: .12, garage: .08, bass: .06, trance: .04, afro: .04 },
    psy: { trance: .42, techno: .20, house: .20, disco: .06, afro: .06, bass: .03, dnb: .02, garage: .01 },
    mixed: { house: .28, techno: .27, disco: .10, dnb: .09, afro: .08, garage: .07, trance: .06, bass: .05 },
    bassus: { bass: .34, house: .26, techno: .14, dnb: .10, trance: .08, garage: .04, afro: .02, disco: .02 },
    rominimal: { house: .50, techno: .25, disco: .07, trance: .06, garage: .05, afro: .04, dnb: .02, bass: .01 }
  };

  /* id, name, country, lat, lon, tz, scene weight, region, profile, currency */
  var CITY_ROWS = [
    ['berlin', 'Berlin', 'DE', 52.520, 13.405, 'Europe/Berlin', 10, 'eu', 'techno', 'EUR'],
    ['london', 'London', 'GB', 51.507, -0.128, 'Europe/London', 10, 'eu', 'uk', 'GBP'],
    ['amsterdam', 'Amsterdam', 'NL', 52.370, 4.895, 'Europe/Amsterdam', 8, 'eu', 'techno', 'EUR'],
    ['paris', 'Paris', 'FR', 48.857, 2.352, 'Europe/Paris', 7, 'eu', 'house', 'EUR'],
    ['barcelona', 'Barcelona', 'ES', 41.387, 2.170, 'Europe/Madrid', 6, 'eu', 'house', 'EUR'],
    ['madrid', 'Madrid', 'ES', 40.417, -3.704, 'Europe/Madrid', 5, 'eu', 'mixed', 'EUR'],
    ['lisbon', 'Lisbon', 'PT', 38.722, -9.139, 'Europe/Lisbon', 5, 'eu', 'mixed', 'EUR'],
    ['ibiza', 'Ibiza', 'ES', 38.906, 1.421, 'Europe/Madrid', 2, 'eu', 'house', 'EUR'],
    ['brussels', 'Brussels', 'BE', 50.850, 4.352, 'Europe/Brussels', 5, 'eu', 'techno', 'EUR'],
    ['manchester', 'Manchester', 'GB', 53.481, -2.242, 'Europe/London', 6, 'eu', 'uk', 'GBP'],
    ['bristol', 'Bristol', 'GB', 51.455, -2.588, 'Europe/London', 5, 'eu', 'uk', 'GBP'],
    ['glasgow', 'Glasgow', 'GB', 55.864, -4.252, 'Europe/London', 5, 'eu', 'techno', 'GBP'],
    ['leeds', 'Leeds', 'GB', 53.801, -1.549, 'Europe/London', 4, 'eu', 'uk', 'GBP'],
    ['dublin', 'Dublin', 'IE', 53.350, -6.260, 'Europe/Dublin', 4, 'eu', 'mixed', 'EUR'],
    ['hamburg', 'Hamburg', 'DE', 53.551, 9.993, 'Europe/Berlin', 5, 'eu', 'techno', 'EUR'],
    ['cologne', 'Cologne', 'DE', 50.938, 6.960, 'Europe/Berlin', 4, 'eu', 'house', 'EUR'],
    ['munich', 'Munich', 'DE', 48.137, 11.575, 'Europe/Berlin', 4, 'eu', 'techno', 'EUR'],
    ['copenhagen', 'Copenhagen', 'DK', 55.676, 12.568, 'Europe/Copenhagen', 4, 'eu', 'techno', 'DKK'],
    ['stockholm', 'Stockholm', 'SE', 59.329, 18.069, 'Europe/Stockholm', 3, 'eu', 'techno', 'SEK'],
    ['warsaw', 'Warsaw', 'PL', 52.230, 21.012, 'Europe/Warsaw', 4, 'eu', 'techno', 'PLN'],
    ['prague', 'Prague', 'CZ', 50.075, 14.438, 'Europe/Prague', 4, 'eu', 'techno', 'CZK'],
    ['vienna', 'Vienna', 'AT', 48.208, 16.373, 'Europe/Vienna', 4, 'eu', 'techno', 'EUR'],
    ['budapest', 'Budapest', 'HU', 47.498, 19.040, 'Europe/Budapest', 3, 'eu', 'mixed', 'HUF'],
    ['zurich', 'Zurich', 'CH', 47.377, 8.540, 'Europe/Zurich', 4, 'eu', 'house', 'CHF'],
    ['milan', 'Milan', 'IT', 45.464, 9.190, 'Europe/Rome', 4, 'eu', 'house', 'EUR'],
    ['tbilisi', 'Tbilisi', 'GE', 41.716, 44.783, 'Asia/Tbilisi', 5, 'eu', 'techno', 'GEL'],
    ['belgrade', 'Belgrade', 'RS', 44.787, 20.457, 'Europe/Belgrade', 3, 'eu', 'techno', 'RSD'],
    ['bucharest', 'Bucharest', 'RO', 44.426, 26.103, 'Europe/Bucharest', 4, 'eu', 'rominimal', 'RON'],
    ['athens', 'Athens', 'GR', 37.984, 23.728, 'Europe/Athens', 3, 'eu', 'mixed', 'EUR'],
    ['istanbul', 'Istanbul', 'TR', 41.008, 28.978, 'Europe/Istanbul', 3, 'eu', 'house', 'TRY'],
    ['newyork', 'New York', 'US', 40.713, -74.006, 'America/New_York', 9, 'na', 'mixed', 'USD'],
    ['chicago', 'Chicago', 'US', 41.878, -87.630, 'America/Chicago', 6, 'na', 'house', 'USD'],
    ['detroit', 'Detroit', 'US', 42.331, -83.046, 'America/Detroit', 5, 'na', 'techno', 'USD'],
    ['milwaukee', 'Milwaukee', 'US', 43.039, -87.906, 'America/Chicago', 2, 'na', 'house', 'USD'],
    ['losangeles', 'Los Angeles', 'US', 34.052, -118.244, 'America/Los_Angeles', 8, 'na', 'mixed', 'USD'],
    ['sanfrancisco', 'San Francisco', 'US', 37.775, -122.419, 'America/Los_Angeles', 5, 'na', 'house', 'USD'],
    ['lasvegas', 'Las Vegas', 'US', 36.170, -115.140, 'America/Los_Angeles', 4, 'na', 'edm', 'USD'],
    ['miami', 'Miami', 'US', 25.762, -80.192, 'America/New_York', 6, 'na', 'house', 'USD'],
    ['denver', 'Denver', 'US', 39.739, -104.990, 'America/Denver', 5, 'na', 'bassus', 'USD'],
    ['austin', 'Austin', 'US', 30.267, -97.743, 'America/Chicago', 3, 'na', 'mixed', 'USD'],
    ['seattle', 'Seattle', 'US', 47.606, -122.332, 'America/Los_Angeles', 3, 'na', 'mixed', 'USD'],
    ['toronto', 'Toronto', 'CA', 43.653, -79.383, 'America/Toronto', 5, 'na', 'mixed', 'CAD'],
    ['montreal', 'Montréal', 'CA', 45.502, -73.567, 'America/Toronto', 5, 'na', 'techno', 'CAD'],
    ['mexicocity', 'Mexico City', 'MX', 19.433, -99.133, 'America/Mexico_City', 7, 'la', 'latam', 'MXN'],
    ['tulum', 'Tulum', 'MX', 20.211, -87.465, 'America/Cancun', 3, 'la', 'house', 'MXN'],
    ['bogota', 'Bogotá', 'CO', 4.711, -74.072, 'America/Bogota', 5, 'la', 'latam', 'COP'],
    ['medellin', 'Medellín', 'CO', 6.244, -75.581, 'America/Bogota', 4, 'la', 'latam', 'COP'],
    ['saopaulo', 'São Paulo', 'BR', -23.550, -46.633, 'America/Sao_Paulo', 7, 'la', 'latam', 'BRL'],
    ['rio', 'Rio de Janeiro', 'BR', -22.907, -43.173, 'America/Sao_Paulo', 4, 'la', 'latam', 'BRL'],
    ['buenosaires', 'Buenos Aires', 'AR', -34.604, -58.382, 'America/Argentina/Buenos_Aires', 6, 'la', 'latam', 'ARS'],
    ['santiago', 'Santiago', 'CL', -33.449, -70.669, 'America/Santiago', 3, 'la', 'latam', 'CLP'],
    ['tokyo', 'Tokyo', 'JP', 35.676, 139.650, 'Asia/Tokyo', 7, 'ap', 'asia', 'JPY'],
    ['osaka', 'Osaka', 'JP', 34.694, 135.502, 'Asia/Tokyo', 3, 'ap', 'asia', 'JPY'],
    ['seoul', 'Seoul', 'KR', 37.567, 126.978, 'Asia/Seoul', 6, 'ap', 'asia', 'KRW'],
    ['shanghai', 'Shanghai', 'CN', 31.230, 121.474, 'Asia/Shanghai', 4, 'ap', 'asia', 'CNY'],
    ['hongkong', 'Hong Kong', 'HK', 22.320, 114.170, 'Asia/Hong_Kong', 3, 'ap', 'asia', 'HKD'],
    ['taipei', 'Taipei', 'TW', 25.033, 121.565, 'Asia/Taipei', 3, 'ap', 'asia', 'TWD'],
    ['bangkok', 'Bangkok', 'TH', 13.756, 100.502, 'Asia/Bangkok', 4, 'ap', 'mixed', 'THB'],
    ['bali', 'Bali', 'ID', -8.650, 115.137, 'Asia/Makassar', 4, 'ap', 'house', 'IDR'],
    ['singapore', 'Singapore', 'SG', 1.352, 103.820, 'Asia/Singapore', 3, 'ap', 'asia', 'SGD'],
    ['manila', 'Manila', 'PH', 14.600, 120.984, 'Asia/Manila', 2, 'ap', 'asia', 'PHP'],
    ['mumbai', 'Mumbai', 'IN', 19.076, 72.878, 'Asia/Kolkata', 4, 'ap', 'mixed', 'INR'],
    ['bengaluru', 'Bengaluru', 'IN', 12.972, 77.594, 'Asia/Kolkata', 4, 'ap', 'techno', 'INR'],
    ['goa', 'Goa', 'IN', 15.580, 73.740, 'Asia/Kolkata', 3, 'ap', 'psy', 'INR'],
    ['sydney', 'Sydney', 'AU', -33.869, 151.209, 'Australia/Sydney', 6, 'ap', 'aus', 'AUD'],
    ['melbourne', 'Melbourne', 'AU', -37.814, 144.963, 'Australia/Melbourne', 7, 'ap', 'aus', 'AUD'],
    ['auckland', 'Auckland', 'NZ', -36.848, 174.763, 'Pacific/Auckland', 3, 'ap', 'aus', 'NZD'],
    ['dubai', 'Dubai', 'AE', 25.205, 55.270, 'Asia/Dubai', 4, 'af', 'house', 'AED'],
    ['johannesburg', 'Johannesburg', 'ZA', -26.204, 28.047, 'Africa/Johannesburg', 5, 'af', 'afro', 'ZAR'],
    ['capetown', 'Cape Town', 'ZA', -33.925, 18.424, 'Africa/Johannesburg', 4, 'af', 'afro', 'ZAR'],
    ['lagos', 'Lagos', 'NG', 6.524, 3.379, 'Africa/Lagos', 4, 'af', 'afro', 'NGN'],
    ['nairobi', 'Nairobi', 'KE', -1.286, 36.817, 'Africa/Nairobi', 3, 'af', 'afro', 'KES']
  ];

  /* rough local units per euro and a local price level, for believable ticket prices */
  var FX = { EUR: 1, GBP: .86, USD: 1.08, CAD: 1.5, MXN: 20, COP: 4400, BRL: 6, ARS: 1400, CLP: 1000, JPY: 165, KRW: 1500, CNY: 7.8, HKD: 8.4, TWD: 35, THB: 38, IDR: 17500, SGD: 1.45, PHP: 62, INR: 92, AED: 4, AUD: 1.65, NZD: 1.8, ZAR: 19.5, NGN: 1700, KES: 140, DKK: 7.46, SEK: 11.3, PLN: 4.3, CZK: 25, HUF: 395, CHF: .95, RON: 5, GEL: 2.9, RSD: 117, TRY: 40 };
  var PRICE_LEVEL = { CH: 1.4, GB: 1.0, US: 1.25, CA: 1.1, JP: 1.1, AU: 1.2, NZ: 1.1, IN: .5, ID: .6, TH: .6, GE: .5, RS: .5, RO: .6, HU: .7, PL: .7, CZ: .7, TR: .6, MX: .7, BR: .7, AR: .5, CO: .6, CL: .7, ZA: .5, NG: .5, KE: .5, AE: 1.3, KR: 1.0, CN: .9, HK: 1.2, TW: .8, SG: 1.3, PH: .5, DK: 1.2, SE: 1.1 };

  var WARM = { AU: 1, NZ: 1, ZA: 1, BR: 1, AR: 1, CL: 1, ID: 1, TH: 1, IN: 1, AE: 1, NG: 1, KE: 1, SG: 1, PH: 1, CO: 1 };
  var WARM_CITY = { tulum: 1, miami: 1, losangeles: 1, mexicocity: 1 };

  /* doors and close by scene: [doors h, m] options, close hours (next morning) */
  var TIMING = {
    eu: { doors: [[23, 0], [23, 0], [23, 59], [0, 0]], close: [5, 6, 6, 7] },
    uk: { doors: [[22, 0], [22, 30], [23, 0]], close: [3, 4, 5, 6] },
    us: { doors: [[21, 0], [22, 0], [22, 0], [22, 30]], close: [2, 3, 4, 4] },
    la: { doors: [[23, 0], [23, 0], [0, 0]], close: [5, 6, 7] },
    ap: { doors: [[22, 0], [23, 0]], close: [4, 5, 5] },
    au: { doors: [[21, 0], [22, 0]], close: [3, 4] },
    af: { doors: [[21, 0], [22, 0]], close: [3, 4, 5] }
  };
  var CLOSE_OVERRIDE = { berlin: [6, 8, 10, 12], newyork: [4, 4, 5], chicago: [4, 5], losangeles: [2, 2, 4], tokyo: [5, 5], london: [3, 4, 5, 6], tbilisi: [7, 9], amsterdam: [5, 6, 8] };

  var DOW = [0.38, 0.12, 0.14, 0.22, 0.45, 1.0, 1.1]; // Sun..Sat

  var MOMENTUM = { techno: .02, house: 0, dnb: .06, afro: .12, disco: -.03, garage: .09, trance: .1, bass: -.05 };
  var SURGES = [
    { city: 'lisbon', genre: 'techno', x: 4, sub: 'Hard groove' },
    { city: 'mexicocity', genre: 'afro', x: 3.6, sub: 'Afro house' },
    { city: 'seoul', genre: 'garage', x: 4.5, sub: 'UK garage' },
    { city: 'melbourne', genre: 'disco', x: 3.4, sub: 'Balearic' },
    { city: 'bogota', genre: 'techno', x: 2.6, sub: 'Hypnotic' },
    { city: 'manchester', genre: 'dnb', x: 2.8, sub: 'Jungle' }
  ];

  /* ---------- fictional names ---------- */
  var VENUE_NAMES = {
    de: ['Kaltwerk', 'Halle Ost', 'Unterdeck', 'Gleis 9', 'Ziegelei Nord', 'Klangdepot', 'Schaltwerk', 'Rohbau', 'Tiefkeller', 'Lagerhalle 3', 'Hafenkran', 'Nordlicht Halle', 'Blechdach', 'Spreegrund'],
    uk: ['Low Ceiling', 'Signal Hall', 'Undercroft', 'The Cooling Tower', 'Dock 19', 'Saltworks', 'Halyard', 'Copperline', 'Back Room 12', 'Lockkeeper', 'Freightyard', 'The Annex', 'Railway Arch 7', 'Long Room'],
    fr: ['Le Sous-Sol', 'La Chaufferie', 'Le Quai 9', "L'Entrepôt", 'Le Hangar 21', 'La Soute', 'Le Néon', 'La Verrière'],
    es: ['Sala Ámbar', 'Nave 7', 'La Fragua', 'El Sótano', 'Sala Mercurio', 'Muelle 3', 'Patio Nocturno', 'Bodega Sur', 'Terraza Cielo', 'Galpón 9', 'Sala Brasa', 'Cueva Azul'],
    pt: ['Armazém 9', 'Galpão Norte', 'Cais 14', 'Porão', 'Terraço Sul', 'Caixa Preta', 'Doca 5', 'Fábrica Leste'],
    it: ['Officina 21', 'Il Magazzino', 'Darsena Club', 'Sala Nove', 'Cantiere'],
    nl: ['De Ketel', 'Loods 6', 'De Kelder', 'Hal Noord', 'Werkplaats', 'Zuidhal', 'Kade 12'],
    nordic: ['Kælderen', 'Lagret', 'Hallen 3', 'Kraftverket', 'Varvet'],
    east: ['Hala 4', 'Fabrika Nord', 'Podrum', 'Silos', 'Depo', 'Tunel', 'Arsenal 9', 'Kotelnaya', 'Betonarna', 'Skladište'],
    jp: ['Room Kiri', 'Basement Kumo', 'Studio Hoshi', 'Ura Sublevel', 'Kōjō 3', 'Ame Hall', 'Floor Tsuki'],
    kr: ['Cell 404', 'Basement Haneul', 'Room 01', 'Steelworks', 'Hall Byeol'],
    cn: ['Vaultline', 'Ferrous', 'Pylon', 'Northlight', 'Platform 7', 'Kiln'],
    sea: ['Tidewater', 'Nightjar', 'Static Garden', 'Driftwood', 'Fathom', 'Monsoon Room'],
    in: ['Godown 6', 'Mill Compound', 'Terrace 9', 'Basement Monsoon', 'Shed 4', 'Palm Grove Stage'],
    us: ['Vaultline', 'Ferrous', 'Signal Box', 'Undercroft', 'Pylon', 'Meridian Hall', 'Gate 22', 'Pier 4', 'Room Zero', 'Cold Store', 'Arcwerk', 'Echo Basin', 'Glasshouse', 'Ember Room', 'Boilerhouse', 'Stillwater', 'Sixth Floor', 'Foundry 9'],
    au: ['Tidewater', 'Saltworks', 'Southerly', 'Coal Loader', 'Gully Room', 'Basin', 'Northcote Hall'],
    af: ['Kiln Yard', 'Ember Room', 'Shed 4', 'Roof 31', 'Courtyard Nine', 'Red Clay', 'Market Hall'],
    generic: ['Copper Room', 'Fathom', 'Meridian Hall', 'Northlight', 'Kiln', 'Foundry 9', 'Platform 7', 'Studio Nine', 'Glasshouse', 'Second Skin', 'Lumen', 'Palisade']
  };
  var CULTURE = { DE: 'de', AT: 'de', CH: 'de', GB: 'uk', IE: 'uk', FR: 'fr', BE: 'nl', ES: 'es', MX: 'es', CO: 'es', AR: 'es', CL: 'es', PT: 'pt', BR: 'pt', IT: 'it', NL: 'nl', DK: 'nordic', SE: 'nordic', PL: 'east', CZ: 'east', HU: 'east', RO: 'east', RS: 'east', GE: 'east', GR: 'east', TR: 'east', JP: 'jp', KR: 'kr', CN: 'cn', HK: 'cn', TW: 'cn', SG: 'cn', TH: 'sea', ID: 'sea', PH: 'sea', IN: 'in', US: 'us', CA: 'us', AU: 'au', NZ: 'au', ZA: 'af', NG: 'af', KE: 'af', AE: 'af' };

  var SERIES = ['Cold Room', 'Body Heat', 'Second Floor', 'Low Frequency', 'Open Late', 'Machine Hearts', 'Night Shift', 'Daylight Robbery', 'Slow Burn', 'High Rotation', 'Deep End', 'Off Grid', 'No Sleep', 'Soft Focus', 'Late Bloom', 'Hard Shoulder', 'Dawn Patrol', 'Glass Floor', 'Wet Paint', 'Moving Parts', 'Long Weekend', 'Signal Fire', 'Fever Pitch', 'Red Shift', 'Groundwork', 'Heavy Water', 'Black Box', 'Tunnel Vision', 'Half Light', 'Sweat Equity', 'Floor Plan', 'Lost Hours', 'Cosmic Debris', 'Velvet Hours', 'Concrete Garden', 'Static Bloom', 'After Image', 'Deep Cuts', 'Second Wind', 'Bassline Theory', 'Rinse Cycle', 'Pressure Point', 'Ritual Hours', 'Saturday School', 'Sunday Lessons', 'Gravity Well', 'Ghost Notes', 'Night Market', 'Dark Matter', 'Tropical Depression', 'Steam Room', 'Basement Hours'];

  /* name, genre, home city */
  var TIER1 = [
    ['Halvard', 'techno', 'stockholm'], ['Mira Kessel', 'techno', 'berlin'], ['Tarmac Unit', 'techno', 'detroit'], ['Oona Fjell', 'techno', 'copenhagen'],
    ['Kasimir Vane', 'techno', 'tbilisi'], ['Lumen Ridge', 'house', 'london'], ['Marlo Danz', 'house', 'chicago'], ['Teo Valcourt', 'house', 'paris'],
    ['Ines Moraga', 'house', 'barcelona'], ['Deltaform', 'dnb', 'bristol'], ['Rye Calloway', 'dnb', 'london'], ['Kaya Sol', 'afro', 'johannesburg'],
    ['Amaru Sound', 'afro', 'lagos'], ['Coralie Bex', 'disco', 'amsterdam'], ['Velvet Ledger', 'disco', 'newyork'], ['Pell & Quarry', 'garage', 'manchester'],
    ['Ash Ottley', 'garage', 'leeds'], ['Aurorine', 'trance', 'amsterdam'], ['Polaris Nine', 'trance', 'melbourne'], ['Gravel Saint', 'bass', 'denver'],
    ['Heavy Lotus', 'bass', 'losangeles'], ['Yuki Amane', 'techno', 'tokyo'], ['Sol Ibarra', 'house', 'mexicocity'], ['Ilse Varga', 'techno', 'prague']
  ];
  var TIER2 = [
    ['Bruma', 'techno', 'lisbon'], ['Static Saint', 'techno', 'glasgow'], ['Femke Dahl', 'house', 'amsterdam'], ['Noor Saleh', 'house', 'brussels'],
    ['Tomás Lind', 'techno', 'madrid'], ['Juno Price', 'garage', 'london'], ['Mika Arendt', 'techno', 'hamburg'], ['Odile Marchetti', 'disco', 'milan'],
    ['Pim Kroes', 'techno', 'amsterdam'], ['Wren Halloway', 'dnb', 'manchester'], ['Zeno Kraft', 'techno', 'munich'], ['Lia Moreno', 'house', 'madrid'],
    ['Rafa Llorente', 'house', 'ibiza'], ['Kasia Lune', 'techno', 'warsaw'], ['Dorian Pécs', 'house', 'budapest'], ['Anouk Vey', 'disco', 'paris'],
    ['Eero Saari', 'techno', 'stockholm'], ['Nikola Brana', 'techno', 'belgrade'], ['Radu Mirea', 'house', 'bucharest'], ['Sevda Kaya', 'house', 'istanbul'],
    ['Ari Kosta', 'house', 'athens'], ['Niamh Corr', 'techno', 'dublin'], ['Gil Arouca', 'house', 'lisbon'], ['Dani Okoro', 'house', 'newyork'],
    ['Cyra Banks', 'techno', 'detroit'], ['Moe Lattimore', 'house', 'chicago'], ['Jessa Rune', 'techno', 'losangeles'], ['Vance Oro', 'bass', 'lasvegas'],
    ['Tilde Marsh', 'house', 'sanfrancisco'], ['Rico Vela', 'house', 'miami'], ['Wynn Atlas', 'bass', 'denver'], ['Sable Ito', 'techno', 'montreal'],
    ['Kit Rowan', 'house', 'toronto'], ['June Calder', 'dnb', 'seattle'], ['Moss Fielder', 'house', 'austin'], ['Lupe Arrieta', 'techno', 'mexicocity'],
    ['Tavo Rincón', 'house', 'bogota'], ['Caro Lisboa', 'techno', 'saopaulo'], ['Benja Soto', 'house', 'buenosaires'], ['Isla Ventura', 'afro', 'tulum'],
    ['Mateo Brizuela', 'techno', 'medellin'], ['Jae Min', 'garage', 'seoul'], ['Hana Mori', 'house', 'tokyo'], ['Ren Takeda', 'techno', 'osaka'],
    ['Lin Shu', 'techno', 'shanghai'], ['Kai Lam', 'house', 'hongkong'], ['Tavi Chen', 'techno', 'taipei'], ['Ploy Sirin', 'house', 'bangkok'],
    ['Wayan Ray', 'house', 'bali'], ['Arjun Mehra', 'techno', 'bengaluru'], ['Tara Desai', 'house', 'mumbai'], ['Ojas Kumar', 'trance', 'goa'],
    ['Ellis Rowe', 'dnb', 'sydney'], ['Mackenzie Vale', 'house', 'melbourne'], ['Tane Rewi', 'house', 'auckland'], ['Thabo Mokoena', 'afro', 'johannesburg'],
    ['Lerato Dube', 'afro', 'capetown'], ['Tobi Adeyemi', 'afro', 'lagos'], ['Wanjiru K', 'afro', 'nairobi'], ['Rami Haddad', 'house', 'dubai']
  ];
  var FIRST = ['Ada', 'Bex', 'Cato', 'Dara', 'Eli', 'Fen', 'Gia', 'Hugo', 'Ivo', 'Jules', 'Kemi', 'Lou', 'Milo', 'Nia', 'Otto', 'Pia', 'Quin', 'Remy', 'Sami', 'Tova', 'Uma', 'Vik', 'Wes', 'Xan', 'Yara', 'Zed', 'Alba', 'Beni', 'Cleo', 'Dex', 'Esme', 'Fitz', 'Gus', 'Hale', 'Ione', 'Joss', 'Kiko', 'Lior', 'Mags', 'Nico', 'Orla', 'Pax', 'Rafi', 'Suki', 'Teddy', 'Vera'];
  var LAST = ['Arden', 'Brisk', 'Coil', 'Dune', 'Ember', 'Flint', 'Gale', 'Haze', 'Iris', 'Jett', 'Keel', 'Lark', 'Moth', 'North', 'Opal', 'Pike', 'Quarry', 'Rook', 'Sloane', 'Thorne', 'Umber', 'Vesper', 'Wilde', 'Yarrow', 'Zinc', 'Ash', 'Birch', 'Cinder', 'Delta', 'Echo', 'Frost', 'Glint', 'Hollow', 'Indigo', 'Juniper', 'Kestrel', 'Lowe', 'Marlow', 'Nyx', 'Onyx', 'Parish', 'Reed', 'Salt', 'Tide', 'Vale', 'Wren'];
  var FESTIVALS = [
    { id: 'tidal', name: 'Tidal Grounds', city: 'melbourne', off: [-0.42, 0.18], weekend: 0, days: 3, cap: 18000, genres: ['techno', 'house', 'disco'] },
    { id: 'monsoon', name: 'Monsoon Assembly', city: 'goa', off: [0.04, 0.02], weekend: 0, days: 2, cap: 7000, genres: ['trance', 'techno'] },
    { id: 'selva', name: 'Selva Abierta', city: 'tulum', off: [0.05, -0.06], weekend: 1, days: 3, cap: 9000, genres: ['house', 'afro', 'techno'] },
    { id: 'southern', name: 'Southern Lights Weekender', city: 'capetown', off: [0.22, 0.31], weekend: 1, days: 2, cap: 12000, genres: ['afro', 'house'] },
    { id: 'coral', name: 'Coral Nights', city: 'bali', off: [-0.09, 0.04], weekend: 2, days: 2, cap: 8000, genres: ['house', 'techno', 'trance'] },
    { id: 'pampa', name: 'Pampa Electrónica', city: 'buenosaires', off: [-0.18, -0.27], weekend: 2, days: 2, cap: 30000, genres: ['techno', 'house', 'trance'] }
  ];

  function zoneOf(c) {
    if (c.cc === 'GB' || c.cc === 'IE') return 'uk';
    if (c.cc === 'US' || c.cc === 'CA') return 'us';
    if (c.cc === 'AU' || c.cc === 'NZ') return 'au';
    if (c.region === 'la') return 'la';
    if (c.region === 'af') return 'af';
    if (c.region === 'ap') return 'ap';
    return 'eu';
  }
  function niceRound(v) {
    if (v <= 0) return 0;
    var p = Math.pow(10, Math.floor(Math.log10(v)) - 1);
    var step = v < 100 ? Math.max(1, p * 5) : p * 5;
    return Math.max(step, Math.round(v / step) * step);
  }

  /* ---------- generator ---------- */
  function generate(now) {
    var today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    var D0 = -8, D1 = 15;
    var cities = [], cityById = {}, venues = [], venueById = {}, artists = [], artistById = {};

    CITY_ROWS.forEach(function (row) {
      var c = { id: row[0], name: row[1], cc: row[2], lat: row[3], lon: row[4], tz: row[5], weight: row[6], region: row[7], profile: PROFILES[row[8]], cur: row[9] };
      c.zone = zoneOf(c);
      c.warm = !!(WARM[c.cc] || WARM_CITY[c.id]);
      cities.push(c); cityById[c.id] = c;
    });

    function addArtist(name, genre, home, tier) {
      var c = cityById[home];
      var a = { id: 'a' + artists.length, name: name, genre: genre, home: home, region: c.region, tier: tier };
      artists.push(a); artistById[a.id] = a; return a;
    }
    TIER1.forEach(function (t) { addArtist(t[0], t[1], t[2], 1); });
    TIER2.forEach(function (t) { addArtist(t[0], t[1], t[2], 2); });

    /* venues and residents per city */
    var usedNames = {};
    cities.forEach(function (c) {
      var r = rngFor('venues|' + c.id);
      var pool = shuffle(r, (VENUE_NAMES[CULTURE[c.cc]] || VENUE_NAMES.generic).concat(VENUE_NAMES.generic));
      var nV = clamp(Math.round(c.weight * 1.2) + 3, 4, 15);
      var types = ['club', 'club'];
      if (c.weight >= 4) types.push('concert');
      if (c.weight >= 5) types.push('warehouse');
      if (c.weight >= 4 || c.warm) types.push('openair');
      if (c.weight >= 8) types.push('arena');
      while (types.length < nV) types.push(r() < 0.8 ? 'club' : 'warehouse');
      c.venues = [];
      var spreadKm = 2.5 + c.weight * 0.6;
      for (var i = 0; i < types.length; i++) {
        var name = null;
        for (var j = 0; j < pool.length; j++) { if (!usedNames[c.id + pool[j]]) { name = pool[j]; usedNames[c.id + pool[j]] = 1; break; } }
        if (!name) name = 'Room ' + (i + 1);
        var ty = types[i];
        var cap = ty === 'club' ? Math.round((180 + r() * 900 + c.weight * 60) / 10) * 10
          : ty === 'warehouse' ? Math.round((1500 + r() * 3500) / 100) * 100
            : ty === 'concert' ? Math.round((1400 + r() * 2600) / 100) * 100
              : ty === 'openair' ? Math.round((800 + r() * 3200) / 100) * 100
                : Math.round((8000 + r() * 7000) / 500) * 500;
        var ang = r() * Math.PI * 2, dist = Math.sqrt(r()) * spreadKm;
        var v = {
          id: c.id + '-v' + i, cityId: c.id, name: name, type: ty, cap: cap,
          lat: c.lat + (dist * Math.sin(ang)) / 111,
          lon: c.lon + (dist * Math.cos(ang)) / (111 * Math.cos(c.lat * Math.PI / 180))
        };
        if (ty === 'arena' && !/hall|arena/i.test(name)) v.name = name + ' Arena';
        c.venues.push(v); venues.push(v); venueById[v.id] = v;
      }
      /* residents */
      c.residents = [];
      var nr = 6 + Math.round(c.weight * 1.6);
      var gl = Object.keys(c.profile);
      for (var k = 0; k < nr; k++) {
        var nm = pick(r, FIRST) + ' ' + pick(r, LAST);
        if (r() < 0.25) nm = pick(r, LAST) + ' ' + pick(r, ['Unit', 'Club', 'Tapes', 'Society', 'Sound', 'FM', 'Theory']);
        var g = pickW(r, gl, function (x) { return c.profile[x]; });
        var a = addArtist(nm, g, c.id, 3);
        c.residents.push(a);
      }
    });

    /* calendar */
    var days = [];
    for (var d = D0; d <= D1; d++) {
      var ms = today + d * DAY, dt = new Date(ms);
      days.push({ off: d, key: dayKeyOf(ms), y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), dow: dt.getUTCDay() });
    }
    var dayByKey = {}; days.forEach(function (x) { dayByKey[x.key] = x; });
    /* first Friday of the "current" weekend: if today is Fri/Sat/Sun use this one */
    var tdow = new Date(today).getUTCDay();
    var friOff = tdow === 5 ? 0 : tdow === 6 ? -1 : tdow === 0 ? -2 : 5 - tdow;

    var gigs = {}, busy = {};
    function book(a, cityId, key, kind) {
      busy[a.id + '|' + key] = 1;
      (gigs[cityId + '|' + key] = gigs[cityId + '|' + key] || []).push({ a: a, kind: kind || 'club' });
    }

    /* festivals first */
    var festivals = [], festWeek = {};
    FESTIVALS.forEach(function (F) {
      var c = cityById[F.city], r = rngFor('fest|' + F.id + '|' + days[0].key);
      var site = { id: 'fest-' + F.id, cityId: c.id, name: F.name + ' site', type: 'festival', cap: F.cap, lat: c.lat + F.off[0], lon: c.lon + F.off[1] };
      venues.push(site); venueById[site.id] = site;
      var fest = { id: F.id, name: F.name, cityId: c.id, venueId: site.id, genres: F.genres, cap: F.cap, days: [] };
      for (var i = 0; i < F.days; i++) {
        var off = friOff + 7 * F.weekend + i, day = days.filter(function (x) { return x.off === off; })[0];
        if (!day) continue;
        var pool = artists.filter(function (a) { return a.tier < 3 && F.genres.indexOf(a.genre) >= 0 && !busy[a.id + '|' + day.key] && !festWeek[a.id + '|' + F.weekend]; });
        var t1 = shuffle(r, pool.filter(function (a) { return a.tier === 1; })).slice(0, 2 + Math.floor(r() * 2));
        var t2 = shuffle(r, pool.filter(function (a) { return a.tier === 2; })).slice(0, 3 + Math.floor(r() * 2));
        var loc = shuffle(r, c.residents).slice(0, 2);
        var lineup = loc.concat(t2, t1);
        lineup.forEach(function (a) {
          festWeek[a.id + '|' + F.weekend] = 1;
          for (var b = -1; b <= 2; b++) {
            var bd = days.filter(function (x) { return x.off === friOff + 7 * F.weekend + b; })[0];
            if (bd) busy[a.id + '|' + bd.key] = 1;
          }
        });
        fest.days.push({ day: day, lineup: lineup });
      }
      festivals.push(fest);
    });

    /* touring headliners */
    var regionWeight = {};
    cities.forEach(function (c) { regionWeight[c.region] = (regionWeight[c.region] || 0) + c.weight; });
    var regionList = Object.keys(REGIONS);
    artists.forEach(function (a) {
      if (a.tier === 3) return;
      for (var w = -1; w <= 2; w++) {
        if (festWeek[a.id + '|' + w]) continue;
        var fri = friOff + 7 * w;
        var r = rngFor('tour|' + a.id + '|' + fri + '|' + days[0].key);
        var region = a.region;
        if (a.tier === 1 && r() > 0.62) region = pickW(r, regionList, function (x) { return regionWeight[x] || 0; });
        if (a.tier === 2 && r() > 0.88) region = pickW(r, regionList, function (x) { return x === a.region ? 0 : (regionWeight[x] || 0); });
        var cand = cities.filter(function (c) { return c.region === region && c.weight >= (a.tier === 1 ? 3 : 2); });
        if (!cand.length) continue;
        var wfn = function (c) { return c.weight * ((c.profile[a.genre] || 0.02) + 0.05) * (c.id === a.home ? (a.tier === 1 ? 1.5 : 4) : 1); };
        var plan = a.tier === 1
          ? [[0, 0.96], [1, 0.96], [2, 0.35], [-1, 0.15]]
          : [[0, 0.55], [1, 0.7], [2, 0.12]];
        var last = null;
        plan.forEach(function (p) {
          if (r() > p[1]) return;
          var day = days.filter(function (x) { return x.off === fri + p[0]; })[0];
          if (!day || busy[a.id + '|' + day.key]) return;
          var c = pickW(r, cand, function (x) { return x === last ? 0.0001 : wfn(x); });
          book(a, c.id, day.key, p[0] === 2 && r() < 0.6 ? 'day' : 'club');
          last = c;
        });
      }
    });

    /* events */
    var events = [];
    var surgeByCity = {};
    SURGES.forEach(function (s) { (surgeByCity[s.city] = surgeByCity[s.city] || []).push(s); });

    days.forEach(function (day) {
      var usedRes = {};
      cities.forEach(function (c) {
        var r = rngFor('night|' + c.id + '|' + day.key);
        var surges = (day.off >= 0 && day.off <= 7) ? (surgeByCity[c.id] || []) : [];
        var lam = c.weight * DOW[day.dow] * (c.id === 'ibiza' ? 0.6 : 1);
        surges.forEach(function (s) { lam *= 1 + (s.x - 1) * (c.profile[s.genre] || 0.1) * 1.4; });
        var assigned = gigs[c.id + '|' + day.key] || [];
        var n = Math.max(poisson(r, lam * 0.95), assigned.length);
        var freeVenues = c.venues.slice();
        var gweight = function (g) {
          var w = c.profile[g] || 0.01;
          w *= clamp(1 + MOMENTUM[g] * (day.off / 7), 0.6, 1.6);
          surges.forEach(function (s) { if (s.genre === g) w *= s.x; });
          return w;
        };
        var genreIds = Object.keys(c.profile);
        for (var i = 0; i < n; i++) {
          var gig = assigned[i] || null, H = gig ? gig.a : null;
          /* event type */
          var type, dw = day.dow;
          if (gig && gig.kind === 'day') type = 'day';
          else if (dw === 0) type = pickW(r, ['day', 'club', 'after', 'concert'], function (t) { return { day: c.warm ? .5 : .32, club: .42, after: .12, concert: .08 }[t]; });
          else if (dw === 5 || dw === 6) type = pickW(r, ['club', 'warehouse', 'concert', 'day', 'after'], function (t) { return { club: .64, warehouse: .13, concert: H && H.tier === 1 ? .14 : .07, day: dw === 6 && c.warm ? .1 : 0.02, after: .07 }[t]; });
          else type = pickW(r, ['club', 'concert'], function (t) { return { club: .78, concert: .22 }[t]; });
          if (!H && type !== 'day' && r() < 0.28) {
            var reg = artists.filter(function (a) { return a.tier === 2 && a.region === c.region && !busy[a.id + '|' + day.key]; });
            if (reg.length) { H = pickW(r, reg, function (a) { return (c.profile[a.genre] || .02) * (a.home === c.id ? 6 : 1); }); busy[H.id + '|' + day.key] = 1; }
          }
          /* venue */
          var want = type === 'concert' ? (H && H.tier === 1 && r() < 0.5 ? ['arena', 'concert'] : ['concert', 'club']) : type === 'warehouse' ? ['warehouse', 'club'] : type === 'day' ? ['openair', 'club', 'warehouse'] : type === 'after' ? ['club', 'warehouse'] : ['club', 'warehouse'];
          var venue = null;
          for (var w = 0; w < want.length && !venue; w++) {
            for (var vi = 0; vi < freeVenues.length; vi++) { if (freeVenues[vi].type === want[w]) { venue = freeVenues[vi]; freeVenues.splice(vi, 1); break; } }
          }
          if (!venue) continue;
          /* genre and lineup */
          var genre = H ? (r() < 0.86 ? H.genre : pickW(r, genreIds, gweight)) : pickW(r, genreIds, gweight);
          var G = GENRE[genre];
          var surge = surges.filter(function (s) { return s.genre === genre; })[0];
          var sub = surge && r() < 0.7 ? surge.sub : pick(r, G.subs);
          var resPool = c.residents.filter(function (a) { return !usedRes[a.id]; });
          resPool.sort(function (a, b) { return (b.genre === genre) - (a.genre === genre); });
          var nSupport = type === 'concert' ? (r() < 0.6 ? 1 : 0) : type === 'after' ? 1 : type === 'day' ? 2 + Math.floor(r() * 2) : 1 + Math.floor(r() * 2);
          var support = [];
          for (var s2 = 0; s2 < nSupport && resPool.length; s2++) {
            var idx = Math.floor(r() * Math.min(resPool.length, 3));
            support.push(resPool[idx]); usedRes[resPool[idx].id] = 1; resPool.splice(idx, 1);
          }
          if (!H && !support.length) continue;
          var H2 = null;
          if (H && H.tier === 1 && assigned[i + 1] && assigned[i + 1].a.genre === H.genre && r() < 0.35) { H2 = assigned[i + 1].a; assigned.splice(i + 1, 1); }
          /* times */
          var T = TIMING[c.zone], dh, dm, ch, dayAdd = 1;
          if (type === 'day') { dh = pick(r, [13, 14, 15]); dm = 0; ch = pick(r, [22, 23, 23]); dayAdd = 0; }
          else if (type === 'concert') { dh = pick(r, [19, 20]); dm = pick(r, [0, 30]); ch = pick(r, [23, 23, 0]); dayAdd = ch === 0 ? 1 : 0; }
          else if (type === 'after') { dh = pick(r, [5, 6]); dm = 0; ch = pick(r, [11, 12, 14]); }
          else {
            var dd = pick(r, T.doors); dh = dd[0]; dm = dd[1];
            ch = pick(r, CLOSE_OVERRIDE[c.id] || T.close);
            if (type === 'warehouse') ch = Math.min(ch + 2, 10);
          }
          var startDayAdd = (type === 'after' || dh < 12) ? 1 : 0;
          var start = zoned(c.tz, day.y, day.m, day.d, startDayAdd, dh, dm);
          var end = zoned(c.tz, day.y, day.m, day.d, type === 'after' ? 1 : dayAdd, ch, 0);
          var weekender = c.id === 'berlin' && day.dow === 6 && type === 'club' && r() < 0.18;
          if (weekender) end = zoned(c.tz, day.y, day.m, day.d, 2, 6, 0);
          if (end <= start + 2 * HOUR) end = start + (type === 'concert' ? 3.5 : 6) * HOUR;
          /* title */
          var series = pick(r, SERIES), title, anl = false;
          if (H2) title = H.name + ' b2b ' + H2.name;
          else if (type === 'concert' && H) title = H.name + (r() < 0.5 ? ' live' : ' live A/V');
          else if (type === 'day') title = series + (r() < 0.5 ? ' open air' : ' day party');
          else if (type === 'after') title = series + ' afters';
          else if (H) {
            var tv = r();
            if (tv < 0.18 && type !== 'concert') { title = H.name + ' all night long'; anl = true; }
            else if (tv < 0.55) title = series + ' with ' + H.name;
            else if (tv < 0.8) title = series + ': ' + H.name;
            else title = series + ' presents ' + H.name;
          } else title = r() < 0.6 ? series : series + ' ' + (2 + Math.floor(r() * 40));
          if (anl) support = [];
          var heads = H2 ? [H, H2] : H ? [H] : [];
          var headTier = heads.length ? Math.min.apply(null, heads.map(function (a) { return a.tier; })) : 3;
          /* tickets */
          var base = 0.6 + (headTier === 1 ? 0.27 : headTier === 2 ? 0.13 : 0) + 0.02 * c.weight + ((day.dow === 5 || day.dow === 6) ? 0.05 : -0.08) + normal(r) * 0.19;
          if (type === 'concert' && venue.type === 'arena') base -= 0.08;
          if (surge) base += 0.08;
          base = clamp(base, 0.12, 1.4);
          var lvl = PRICE_LEVEL[c.cc] || 1, eur;
          if (type === 'concert') eur = 30 + r() * 35 + (headTier === 1 ? 15 : 0);
          else if (type === 'warehouse') eur = 22 + r() * 22;
          else if (type === 'day') eur = 10 + r() * 18;
          else if (type === 'after') eur = 8 + r() * 12;
          else eur = 10 + r() * 16 + (headTier === 1 ? 10 : headTier === 2 ? 5 : 0);
          var fx = FX[c.cur] * lvl;
          var pMin = niceRound(eur * fx * 0.8), pMax = niceRound(eur * fx * 1.35);
          var door = headTier === 3 && venue.cap < 500 && r() < 0.25;
          var free = headTier === 3 && venue.cap < 400 && r() < 0.06;
          var tags = [];
          if ((genre === 'techno' || c.id === 'berlin' || c.id === 'tbilisi') && r() < 0.45) tags.push('No photos');
          if (r() < 0.3) tags.push('Safer-space policy');
          if (r() < 0.06) tags.push('Vinyl only');
          if (anl || (type === 'club' && r() < 0.08)) tags.push('Open to close');
          if (weekender) tags.push('Weekender');
          var e = {
            id: c.id + '-' + day.key + '-' + i, cityId: c.id, venueId: venue.id, dayKey: day.key, dayOff: day.off,
            type: type, genre: genre, sub: sub, title: title, series: series,
            ldow: (day.dow + startDayAdd) % 7, lh: dh,
            heads: heads.map(function (a) { return a.id; }), support: support.map(function (a) { return a.id; }),
            headTier: headTier, anl: anl, start: start, end: end, cap: venue.cap, base: base,
            priceMin: free ? 0 : pMin, priceMax: free ? 0 : pMax, cur: c.cur, door: door, free: free,
            age: c.cc === 'US' ? (r() < 0.75 ? '21+' : '18+') : '18+', tags: tags,
            streamed: (headTier === 1 && r() < 0.3) || r() < 0.02, festivalId: null,
            seed: r()
          };
          finishTickets(e, r);
          events.push(e);
        }
      });
    });

    /* festival days as events */
    festivals.forEach(function (fest) {
      var c = cityById[fest.cityId];
      fest.days.forEach(function (fd, i) {
        var r = rngFor('festday|' + fest.id + '|' + fd.day.key);
        var start = zoned(c.tz, fd.day.y, fd.day.m, fd.day.d, 0, 13, 0);
        var end = zoned(c.tz, fd.day.y, fd.day.m, fd.day.d, 1, 2, 0);
        var heads = fd.lineup.filter(function (a) { return a.tier === 1; });
        var support = fd.lineup.filter(function (a) { return a.tier !== 1; });
        var e = {
          id: fest.id + '-' + fd.day.key, cityId: c.id, venueId: fest.venueId, dayKey: fd.day.key, dayOff: fd.day.off,
          type: 'festival', ldow: fd.day.dow, lh: 13, genre: fest.genres[0], sub: 'Day ' + (i + 1) + ' of ' + fest.days.length, title: fest.name + ', day ' + (i + 1),
          series: fest.name, heads: heads.map(function (a) { return a.id; }), support: support.map(function (a) { return a.id; }), headTier: 1, anl: false,
          start: start, end: end, cap: fest.cap, base: 0.92 + r() * 0.25, priceMin: niceRound(110 * FX[c.cur] * (PRICE_LEVEL[c.cc] || 1)),
          priceMax: niceRound(240 * FX[c.cur] * (PRICE_LEVEL[c.cc] || 1)), cur: c.cur, door: false, free: false, age: '18+',
          tags: ['Multi-stage', 'Camping'], streamed: r() < 0.5, festivalId: fest.id, festGenres: fest.genres, seed: r()
        };
        finishTickets(e, r);
        events.push(e);
      });
    });

    events.forEach(function (e) { e.src = sourceFor(cityById[e.cityId], e); });
    events.sort(function (a, b) { return a.start - b.start; });
    var eventById = {};
    events.forEach(function (e) { eventById[e.id] = e; buildSetTimes(e, artistById); });
    return {
      source: 'demo', generatedAt: now, cities: cities, cityById: cityById, venues: venues, venueById: venueById,
      artists: artists, artistById: artistById, events: events, eventById: eventById, festivals: festivals
    };
  }

  /* where a listing would come from: platform mix by scene and event type (demo attribution) */
  var SOURCE_MIX = {
    na: [['Posh', 3], ['DICE', 2], ['Resident Advisor', 2], ['Luma', 2], ['Partiful', 1.5], ['Ticketmaster', 1]],
    uk: [['Resident Advisor', 3], ['DICE', 3], ['Skiddle', 2], ['Luma', 0.6], ['Ticketmaster', 0.6]],
    eu: [['Resident Advisor', 4], ['DICE', 2], ['Luma', 1], ['Promoter submission', 1]],
    la: [['Resident Advisor', 2.5], ['Luma', 1.5], ['Promoter submission', 2]],
    ap: [['Resident Advisor', 3], ['Luma', 1.5], ['DICE', 0.6], ['Promoter submission', 2], ['Ticketmaster', 0.4]],
    af: [['Resident Advisor', 2], ['Luma', 1], ['Promoter submission', 3]]
  };
  function sourceFor(c, e) {
    var r = rngFor('src|' + e.id);
    if (e.type === 'festival') return pickW(r, [['Ticketmaster', 2], ['DICE', 1], ['Resident Advisor', 1]], function (x) { return x[1]; })[0];
    if (e.type === 'concert') return pickW(r, [['Ticketmaster', 3], ['DICE', 1.5], ['Resident Advisor', 0.5]], function (x) { return x[1]; })[0];
    if (e.door || e.free) return 'Promoter submission';
    var mix = SOURCE_MIX[(c.cc === 'GB' || c.cc === 'IE') ? 'uk' : c.region] || SOURCE_MIX.eu;
    return pickW(r, mix, function (x) {
      var w = x[1];
      if (x[0] === 'Partiful' && e.cap > 900) w *= 0.2;
      if (x[0] === 'Ticketmaster' && e.cap < 1500) w *= 0.3;
      if (x[0] === 'Luma' && e.type === 'day') w *= 1.8;
      return w;
    })[0];
  }

  /* when an event sells out / hits final release, from its demand curve */
  function finishTickets(e, r) {
    var lead = 18 * DAY;
    if (e.base >= 1) e.soldOutAt = e.start - ((e.base - 1) * 25 + r() * 1.2) * DAY;
    else e.soldOutAt = null;
    var q = 1 - 0.86 / e.base;
    e.finalAt = (q > 0 && q <= 0.6) ? e.start - lead * q : (q > 0.6 ? e.start - lead * 0.6 - r() * 2 * DAY : null);
    if (e.door || e.free) { e.soldOutAt = null; e.finalAt = null; }
  }
  function fillAt(e, t) {
    var f = e.base * (1 - clamp((e.start - t) / (18 * DAY), 0, 0.6));
    return Math.min(1, f);
  }
  function statusAt(e, t) {
    if (e.free) return 'free';
    if (e.door) return 'door';
    if (e.soldOutAt && e.soldOutAt <= t) return 'soldout';
    if (e.finalAt && e.finalAt <= t) return 'final';
    return 'onsale';
  }
  function selloutOdds(e, t) {
    if (statusAt(e, t) === 'soldout') return 1;
    if (e.door || e.free) return 0;
    var days = Math.max(0, (e.start - t) / DAY);
    var x = (e.base - 0.97) * 9 + (days < 2 ? 0.4 : 0);
    return clamp(1 / (1 + Math.exp(-x)), 0.02, 0.97);
  }
  function buildSetTimes(e, artistById) {
    var names = function (ids) { return ids.map(function (id) { return artistById[id]; }).filter(Boolean); };
    var heads = names(e.heads), support = names(e.support), dur = e.end - e.start, slots = [];
    if (e.type === 'festival') {
      var list = support.concat(heads), step = dur / Math.max(1, list.length), half = 1800e3;
      var snap = function (x) { return Math.round(x / half) * half; };
      list.forEach(function (a, i) { slots.push({ who: a.name, start: i === 0 ? e.start : snap(e.start + step * i), end: i === list.length - 1 ? e.end : snap(e.start + step * (i + 1)) }); });
    } else if (e.anl || (!support.length && heads.length)) {
      slots.push({ who: heads.map(function (a) { return a.name; }).join(' b2b ') + (e.anl ? ' (all night long)' : ''), start: e.start, end: e.end });
    } else {
      var seq = [];
      if (support[0]) seq.push(support[0].name);
      if (support[1]) seq.push(support[1].name);
      if (heads.length) seq.push(heads.map(function (a) { return a.name; }).join(' b2b '));
      if (support[2]) seq.push(support[2].name);
      if (!seq.length) return (e.sets = []);
      var weights = seq.map(function (_, i) { return (heads.length && i === seq.length - (support[2] ? 2 : 1)) ? 1.6 : 1; });
      var tot = weights.reduce(function (a, b) { return a + b; }, 0), t = e.start;
      seq.forEach(function (who, i) {
        var len = dur * weights[i] / tot, s = Math.round(t / 1800e3) * 1800e3;
        t += len;
        slots.push({ who: who, start: s, end: i === seq.length - 1 ? e.end : Math.round(t / 1800e3) * 1800e3 });
      });
    }
    e.sets = slots;
  }

  /* ---------- solar geometry ---------- */
  function subsolar(t) {
    var rad = Math.PI / 180, d = (t - Date.UTC(2000, 0, 1, 12)) / DAY;
    var g = (357.529 + 0.98560028 * d) % 360, q = (280.459 + 0.98564736 * d) % 360;
    var L = q + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad);
    var e = 23.439 - 0.00000036 * d;
    var ra = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad)) / rad;
    var dec = Math.asin(Math.sin(e * rad) * Math.sin(L * rad)) / rad;
    var gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    var lon = ((ra - gmst * 15) % 360 + 540) % 360 - 180;
    return [lon, dec];
  }
  /* longitudes where mean solar time is 11pm and 4am */
  function clubBand(t) {
    var u = (t % DAY) / HOUR;
    var a = (23 - u) * 15, b = (28 - u) * 15;
    var norm = function (x) { return ((x % 360) + 540) % 360 - 180; };
    return { west: norm(a), east: norm(b), mid: norm((a + b) / 2), raw: a };
  }

  /* ---------- derived views ---------- */
  function isLive(e, t) { return e.start <= t && t < e.end; }
  function inGenres(e, set) { return !set || !set.size || set.has(e.genre) || (e.festGenres && e.festGenres.some(function (g) { return set.has(g); })); }
  function weekendOk(e, ds, t) {
    var dw = e.ldow, h = e.lh;
    if (dw === undefined) { var parts = localParts(ds.cityById[e.cityId].tz, e.start); dw = parts.dow; h = parts.h; }
    var we = dw === 5 && h >= 12 || dw === 6 || dw === 0 || (dw === 1 && h < 12);
    return we && e.start <= t + 7 * DAY;
  }
  var lpf = {};
  function localParts(tz, t) {
    var f = lpf[tz] || (lpf[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: 'numeric' }));
    var p = f.formatToParts(new Date(t)), m = {};
    for (var i = 0; i < p.length; i++) m[p[i].type] = p[i].value;
    return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(m.weekday), h: +m.hour % 24 };
  }
  function inWindow(e, ds, t, win) {
    if (win === 'live') return isLive(e, t);
    if (e.end <= t) return false;
    if (win === '24h') return e.start < t + DAY;
    if (win === 'weekend') return weekendOk(e, ds, t);
    if (win === '7d') return e.start < t + 7 * DAY;
    if (win === '30d') return e.start < t + 30 * DAY;
    return e.start < t + 14 * DAY;
  }
  function importance(e, t) {
    return Math.sqrt(e.cap) * (e.headTier === 1 ? 1.8 : e.headTier === 2 ? 1.3 : 1) * (isLive(e, t) ? 1.25 : 1) * (e.type === 'festival' ? 1.4 : 1);
  }

  function wire(ds, t, genres) {
    var items = [], from = t - 36 * HOUR;
    ds.events.forEach(function (e) {
      if (e.start < t - 2 * DAY || e.start > t + 15 * DAY || !inGenres(e, genres)) return;
      var r = rngFor('wire|' + e.id);
      var add = function (ts, type) { if (ts > from && ts <= t) items.push({ ts: ts, type: type, e: e, id: e.id + type }); };
      var a1 = r(), a2 = r(), a3 = r(), a4 = r(), a5 = r();
      add(e.start - (6 + a1 * 14) * DAY, 'lineup');
      if (e.headTier <= 2) add(e.start - (4 + a2 * 28) * HOUR, 'sets');
      if (e.soldOutAt) add(e.soldOutAt, 'soldout');
      if (e.finalAt && (!e.soldOutAt || e.soldOutAt - e.finalAt > 3 * HOUR)) add(e.finalAt, 'final');
      if (e.headTier <= 2 || e.cap >= 1500) add(e.start, 'doors');
      if (e.streamed) add(e.start + (1 + a3 * 3) * HOUR, 'stream');
      if (a4 < 0.015) add(e.start - (1 + a5 * 2) * DAY, 'moved');
      if (a4 > 0.965 && e.type !== 'concert') add(e.start + 3 * HOUR, 'extended');
    });
    items.sort(function (a, b) { return b.ts - a.ts; });
    return items.slice(0, 140);
  }

  function regionCounts(list, ds) {
    var m = {};
    list.forEach(function (e) { var rg = ds.cityById[e.cityId].region; m[rg] = (m[rg] || 0) + 1; });
    return Object.keys(m).map(function (k) { return { id: k, name: REGIONS[k], n: m[k] }; }).sort(function (a, b) { return b.n - a.n; });
  }
  function cityCounts(list) {
    var m = {};
    list.forEach(function (e) { m[e.cityId] = (m[e.cityId] || 0) + 1; });
    return Object.keys(m).map(function (k) { return { id: k, n: m[k] }; }).sort(function (a, b) { return b.n - a.n; });
  }
  function liveCountAt(ds, t) {
    var n = 0;
    for (var i = 0; i < ds.events.length; i++) { var e = ds.events[i]; if (e.start > t) break; if (t < e.end) n++; }
    return n;
  }

  function peakcon(ds, t) {
    var live = ds.events.filter(function (e) { return isLive(e, t); });
    if (!ds._peakMax || Math.abs(ds._peakMaxAt - t) > 6 * HOUR) {
      var mx = 1;
      for (var s = t - 2 * DAY; s < t + 7 * DAY; s += 1800e3) mx = Math.max(mx, liveCountAt(ds, s));
      ds._peakMax = mx; ds._peakMaxAt = t;
    }
    var ratio = live.length / ds._peakMax;
    var level = ratio >= 0.8 ? 1 : ratio >= 0.58 ? 2 : ratio >= 0.36 ? 3 : ratio >= 0.16 ? 4 : 5;
    var labels = { 1: 'Global peak', 2: 'Heavy', 3: 'Building', 4: 'Low', 5: 'Quiet' };
    var people = 0;
    live.forEach(function (e) { people += e.cap * fillAt(e, t); });
    var soon = ds.events.filter(function (e) { return e.start > t && e.start <= t + 3 * HOUR; });
    var wave = regionCounts(soon, ds)[0] || null;
    var waveCities = wave ? cityCounts(soon.filter(function (e) { return ds.cityById[e.cityId].region === wave.id; })).slice(0, 3).map(function (x) { return ds.cityById[x.id].name; }) : [];
    var hourly = [];
    for (var h = -12; h <= 24; h++) hourly.push({ t: t + h * HOUR, n: liveCountAt(ds, t + h * HOUR) });
    return { level: level, label: labels[level], live: live.length, max: ds._peakMax, people: people, regions: regionCounts(live, ds), wave: wave, waveCities: waveCities, waveCount: soon.length, hourly: hourly };
  }

  function heatIndex(ds, t, genres) {
    var horizon = t + 72 * HOUR, prevFrom = t - 7 * DAY, prevTo = horizon - 7 * DAY;
    var score = {}, prev = {}, nights = {}, live = {}, nightKey = {};
    ds.cities.forEach(function (c) {
      var off = tzOffsetMin(c.tz, t) * 60000;
      var k = new Date(t + off - 6 * HOUR).toISOString().slice(0, 10);
      nightKey[c.id] = Date.parse(k + 'T00:00:00Z');
    });
    ds.events.forEach(function (e) {
      if (!inGenres(e, genres)) return;
      var w = Math.sqrt(e.cap) * (0.6 + Math.min(1, e.base)) * (e.headTier === 1 ? 1.6 : e.headTier === 2 ? 1.25 : 1);
      if (e.end > t && e.start < horizon) score[e.cityId] = (score[e.cityId] || 0) + w;
      if (e.end > prevFrom && e.start < prevTo) prev[e.cityId] = (prev[e.cityId] || 0) + w;
      if (isLive(e, t)) live[e.cityId] = (live[e.cityId] || 0) + 1;
      var di = Math.round((Date.parse(e.dayKey + 'T00:00:00Z') - nightKey[e.cityId]) / DAY);
      if (di >= 0 && di < 7) { var arr = nights[e.cityId] || (nights[e.cityId] = [0, 0, 0, 0, 0, 0, 0]); arr[di]++; }
    });
    var max = 0; Object.keys(score).forEach(function (k) { max = Math.max(max, score[k]); });
    return ds.cities.map(function (c) {
      var s = score[c.id] || 0, p = prev[c.id] || 0;
      return { city: c, heat: max ? Math.round(100 * s / max) : 0, change: p ? (s - p) / p : null, nights: nights[c.id] || [0, 0, 0, 0, 0, 0, 0], live: live[c.id] || 0 };
    }).filter(function (x) { return x.heat > 0; }).sort(function (a, b) { return b.heat - a.heat; });
  }

  function genreIndex(ds, t) {
    var dayStart = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
    var m = {};
    GENRES.forEach(function (g) { m[g.id] = { genre: g, next: 0, prev: 0, daily: new Array(15).fill(0) }; });
    ds.events.forEach(function (e) {
      var row = m[e.genre]; if (!row) return;
      if (e.start >= t && e.start < t + 7 * DAY) row.next++;
      if (e.start >= t - 7 * DAY && e.start < t) row.prev++;
      var di = Math.floor((e.start - dayStart) / DAY) + 7;
      if (di >= 0 && di < 15) row.daily[di]++;
    });
    var total = 0; GENRES.forEach(function (g) { total += m[g.id].next; });
    return GENRES.map(function (g) {
      var r = m[g.id];
      r.change = r.prev ? (r.next - r.prev) / r.prev : null;
      r.share = total ? r.next / total : 0;
      return r;
    }).sort(function (a, b) { return b.next - a.next; });
  }

  function surges(ds, t) {
    var dayStart = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
    var m = {};
    ds.events.forEach(function (e) {
      if (e.type === 'festival') return;
      var k = e.cityId + '|' + e.genre;
      var row = m[k] || (m[k] = { cityId: e.cityId, genre: e.genre, next: 0, prev: 0, daily: new Array(15).fill(0), subs: {} });
      if (e.start >= t && e.start < t + 7 * DAY) { row.next++; row.subs[e.sub] = (row.subs[e.sub] || 0) + 1; }
      if (e.start >= t - 7 * DAY && e.start < t) row.prev++;
      var di = Math.floor((e.start - dayStart) / DAY) + 7;
      if (di >= 0 && di < 15) row.daily[di]++;
    });
    return Object.keys(m).map(function (k) { return m[k]; })
      .filter(function (r) { return r.next >= 6 && r.next >= Math.max(2, r.prev) * 1.8; })
      .map(function (r) {
        r.ratio = r.next / Math.max(1, r.prev);
        var topSub = Object.keys(r.subs).sort(function (a, b) { return r.subs[b] - r.subs[a]; })[0];
        r.topSub = topSub; r.city = ds.cityById[r.cityId]; r.g = GENRE[r.genre];
        return r;
      })
      .sort(function (a, b) { return (b.next - b.prev) * Math.sqrt(b.ratio) - (a.next - a.prev) * Math.sqrt(a.ratio); })
      .slice(0, 8);
  }

  function cityNightIndex(ds, c, t) {
    var off = tzOffsetMin(c.tz, t) * 60000;
    return new Date(t + off - 6 * HOUR).toISOString().slice(0, 10);
  }
  return {
    cityNightIndex: cityNightIndex,
    HOUR: HOUR, DAY: DAY, GENRES: GENRES, GENRE: GENRE, OTHER: OTHER, REGIONS: REGIONS,
    generate: generate, statusAt: statusAt, fillAt: fillAt, selloutOdds: selloutOdds, isLive: isLive,
    inGenres: inGenres, inWindow: inWindow, importance: importance, wire: wire, peakcon: peakcon,
    heatIndex: heatIndex, genreIndex: genreIndex, surges: surges, regionCounts: regionCounts, cityCounts: cityCounts,
    subsolar: subsolar, clubBand: clubBand, localParts: localParts, tzOffsetMin: tzOffsetMin, buildSetTimes: buildSetTimes,
    rngFor: rngFor, clamp: clamp
  };
})();
if (typeof module !== 'undefined') module.exports = RMData;
