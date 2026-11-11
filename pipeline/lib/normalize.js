// Turns each source's raw item into one shared event shape, decides whether it is
// electronic music, maps genres to the map's eight families (or 'electronic' and 'misc' when none
// fits) and assigns a city.
import { km, norm, slug, localHour } from './util.js';
import { detectLabels, detectPromoters, mergePromoters, promoterNames } from './labels.js';

export const FAMILIES = ['techno', 'house', 'dnb', 'afro', 'disco', 'garage', 'trance', 'bass'];
// When no family fits: 'electronic' (dance and electronic music in general: EDM, electronica, club,
// ambient) or 'misc' (everything else: pop, rock, hip-hop, R&B, Latin, live shows, or no clue at all).
export const FALLBACKS = ['electronic', 'misc'];

// Order matters: the more specific phrase wins (afro house before house).
const GENRE_RULES = [
  ['afro', /\b(amapiano|afro ?house|afro ?tech|gqom|baile funk|3 ?step)\b/],
  ['bass', /\b(dubstep|riddim|bass house|bass music|future bass|grime|wave music|halftime)\b/],
  ['dnb', /\b(drum ?(?:&|and|'?n'?) ?bass|dnb|d&b|d ?n ?b|jungle|liquid funk|neurofunk|jump ?up)\b/],
  ['garage', /\b(uk ?g(?:arage)?|ukg|speed garage|2[- ]?step|garage|breakbeat|breaks|electro|bassline)\b/],
  ['trance', /\b(psytrance|psy[- ]?trance|goa ?trance|psy|trance|hard ?style|hard ?dance|hardcore|gabber)\b/],
  ['disco', /\b(nu[- ]?disco|disco|italo|balearic|edits|cosmic)\b/],
  ['techno', /\b(techno|hard groove|acid|industrial|ebm|hypnotic|peak[- ]?time)\b/],
  ['house', /\b(tech ?house|deep house|house music|house|minimal|lo-?fi house|progressive house|jackin)\b/]
];

// Strong signals that an event is electronic music; weak ones need help.
const STRONG = /\b(techno|house music|deep house|tech ?house|afro ?house|amapiano|drum ?(?:&|and|n) ?bass|dnb|jungle|dubstep|riddim|uk ?garage|ukg|trance|psytrance|edm|rave|warehouse party|electronic music|b2b|all night long|open to close|extended set|dj set|boiler room|disco|italo|breakbeat|hard groove|hardstyle|gabber|minimal techno)\b/g;
const WEAK = /\b(dj|djs|dance ?floor|dance party|club night|afters|after ?hours|bpm|sound ?system|selectors?|vinyl)\b/g;
const NEGATIVE = /\b(indie disco|school disco|sample sale|networking|hackathon|founders?|startup|pitch|webinar|workshop|panel|book club|run club|yoga|brunch|comedy|stand-?up|trivia|karaoke|open mic|wine tasting|career|investor|demo day|meetup)\b/g;

// UK 'indie disco' and similar nights are not electronic music.
const NOT_DISCO = /\b(indie|school|80s|90s|silent) disco\b/g;

export function genresFrom(...texts) {
  const t = norm(texts.flat().filter(Boolean).join(' | ')).replace(NOT_DISCO, ' ');
  const found = [];
  let rest = t;
  for (const [fam, re] of GENRE_RULES) {
    if (!re.test(rest)) continue;
    if (!found.includes(fam)) found.push(fam);
    rest = rest.replace(new RegExp(re.source, 'g'), ' '); // 'afro house' should not also count as house
  }
  return found;
}

// For listings no family fits. Tags decide first: a genre tag is the listing's own word for it.
// 'DJ' isn't one of them: Ticketmaster files reggae sound systems under Reggae > DJ.
const ELECTRONIC_TAG = /\b(dance\s*\/\s*electronic|electronic|electronica|edm|club dance|dance pop|dance music|club classics|club|electro ?pop|synth ?pop|synthwave|ambient|downtempo|experimental|idm|intelligent dance music|trip ?hop|big room|big beat|hi-?nrg|eurodance|hyperpop|bass|rave|footwork|juke|ghetto ?tech|broken beat|jersey club)\b/;
const ELECTRONIC_TEXT = /\b(electronic|electronica|edm|rave|ambient|downtempo|synthwave|idm|dance music|club night|dj set|warehouse)\b/;
const NOT_ELECTRONIC = /\b(pop(?!-? ?up)|rock|hip ?-?hop|rap|r ?& ?b|rnb|jazz|blues|reggae|reggaeton|perreo|dancehall|latin|latino|salsa|bachata|cumbia|merengue|country|folk|metal|punk|emo|indie|alternative|soul|funk|gospel|k-?pop|afrobeats?|drag|comedy|performance art|motorsports?|racing|ska|new wave|karaoke)\b/;
// In the title of a listing from a source that only lists electronic music, only a genre named outright
// counts against it: 'Alternative School presents…' or 'Soul Clap' are names, 'Hip-Hop Night' is a genre.
const NAMED_OTHER_GENRE = /\b(hip ?-?hop|r ?& ?b|rnb|reggaeton|perreo|dancehall|salsa|bachata|cumbia|banda|merengue|jazz|blues|country|metal|(?<!daft )punk|emo|k-?pop|afrobeats?|karaoke|comedy|gospel|pop (?:hits|party|night|anthems|bangers))\b/;
const ELECTRONIC_SOURCES = new Set(['ra', 'dice', 'ticketmaster']);

/**
 * 'electronic' or 'misc' for a listing no family fits. Genre tags win (Ticketmaster's 'Dance/Electronic'
 * is electronic, its 'Pop/Rock' is misc); without tags, the title and listing text, and whether the
 * source only lists electronic music (RA, DICE's electronic tags, Ticketmaster's Dance/Electronic).
 */
export function fallbackGenre({ title = '', tags = [], text = '', source = '' } = {}) {
  const tagText = norm(tags.join(' | '));
  if (tags.length) {
    if (ELECTRONIC_TAG.test(tagText)) return 'electronic';
    if (NOT_ELECTRONIC.test(tagText)) return 'misc';
  }
  const all = norm([title, text].filter(Boolean).join(' | '));
  const strong = (all.replace(NOT_DISCO, ' ').match(STRONG) || []).length > 0;
  const electronicSource = ELECTRONIC_SOURCES.has(source);
  if ((electronicSource ? NAMED_OTHER_GENRE : NOT_ELECTRONIC).test(all) && !strong) return 'misc';
  if (electronicSource || strong || ELECTRONIC_TEXT.test(all)) return 'electronic';
  return 'misc';
}

// Rave Monitor lists electronic music only. These tags mark a listing as something else.
const OTHER_TAG = /\b(pop(?!-? ?up)|rock|hip ?-?hop|rap|trap|r ?& ?b|rnb|jazz|blues|reggae|reggaeton|perreo|dancehall|latin|latino|salsa|bachata|cumbia|merengue|country|folk|metal|punk|emo|indie|alternative|soul|funk|gospel|k-?pop|afrobeats?|drag|comedy|performance art|motorsports?|racing|ska|karaoke|a cappella|singer-?songwriter|world music|classical|opera|musicals?|theatre|family|community|civic)\b/;
// A covers band or tribute act is a live band, whatever it plays.
const COVER_ACT = /\b(covers? band|tribute (act|band|show))\b/;
// An electronic style named outright in a title (not 'house party' or '80s disco', which can be anything).
const TITLE_STYLE = /\b(techno|house music|(?:deep|tech|afro|latin|tribal|soulful|funky|jackin'?|acid|progressive|vocal|chicago|organic|melodic|hard|electro|future|bass|piano|french|ghetto|minimal) ?house|amapiano|afro ?piano|drum ?(?:&|and|'?n'?) ?bass|dnb|d&b|jungle|dubstep|uk ?garage|ukg|trance|psytrance|hard ?style|gabber|breakbeat|electronic music|edm)\b/;

/** Whether a title names an electronic style outright ('Latin House', 'Techno vs Hip Hop'). */
export const titleNamesStyle = title => TITLE_STYLE.test(norm(title));
/** Whether a title names another genre outright ('Emo Night', 'Reggaeton Rave'; not 'A Daft Punk party'). */
export const titleNamesOtherGenre = title => NAMED_OTHER_GENRE.test(norm(title));

// Rock, punk, jazz and metal styles named after an electronic word ('Garage Rock', 'Acid Jazz').
const OTHER_COMPOUND = /\b(garage|acid|industrial|electro|dance)[- ]?(rock|punk|jazz|metal)\b/;
// Genres house and disco grew out of, often listed beside them on a house or disco night: they count half.
const NEAR_TAG = /^(soul|funk|funk ?\/ ?soul|northern soul|latin|latino|jazz|world music)$/;

/**
 * Whether one genre tag names an electronic style, another genre ('near' for soul, funk, Latin and jazz,
 * which count half), or neither ('Other', '1990s', 'LGBTQ+').
 */
export function tagKind(tag) {
  const t = norm(tag).trim();
  if (!t) return null;
  if (OTHER_COMPOUND.test(t)) return 'other';
  if (genresFrom(t).length || ELECTRONIC_TAG.test(t)) return 'electronic';
  if (NEAR_TAG.test(t)) return 'near';
  return OTHER_TAG.test(t) ? 'other' : null;
}

/**
 * Whether a listing is electronic music, from its own genre tags first: a night tagged with at least as
 * many electronic styles as other genres stays (house and R&B; house, disco, soul and funk), one tagged
 * mostly with other genres goes (an R&B, dancehall and hip-hop night with one amapiano tag, a rock
 * show), unless its title names an electronic style outright. Without telling tags, the genre families
 * decide: 'misc' (pop, rock, hip-hop… or no sign of electronic music at all) goes.
 */
export function isElectronic({ title = '', tags = [], genres = [] } = {}) {
  if (tags.some(t => COVER_ACT.test(norm(t)))) return false;
  let electronic = 0, other = 0;
  for (const t of tags) { const k = tagKind(t); if (k === 'electronic') electronic++; else if (k === 'other') other++; else if (k === 'near') other += 0.5; }
  if (electronic && electronic >= other) return true;
  if (other) return TITLE_STYLE.test(norm(title));
  return genres.some(g => g !== 'misc');
}

/** Score how clearly a listing is electronic music. Sources that only list electronic music skip this. */
export function electronicScore(...texts) {
  const t = norm(texts.flat().filter(Boolean).join(' | '));
  const tNoDisco = t.replace(NOT_DISCO, ' ');
  const strong = (tNoDisco.match(STRONG) || []).length;
  const weak = (t.match(WEAK) || []).length;
  const neg = (t.match(NEGATIVE) || []).length;
  return strong + Math.min(weak, 2) * 0.5 - neg;
}

const TWO_DECIMAL = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'MXN', 'BRL', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'ZAR', 'SGD', 'HKD', 'AED', 'TRY', 'RON', 'GEL', 'ILS', 'INR', 'THB']);

/** Parse '$20', '€15-25', '£10.00', 20 etc. into { min, max, currency }. */
export function parsePrice(raw, currencyHint) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return { min: raw, max: raw, currency: (currencyHint || '').toUpperCase() || null };
  const s = String(raw);
  if (/free/i.test(s)) return { min: 0, max: 0, currency: (currencyHint || '').toUpperCase() || null, free: true };
  const nums = (s.match(/\d+(?:[.,]\d{1,2})?/g) || []).map(x => parseFloat(x.replace(',', '.'))).filter(Number.isFinite);
  if (!nums.length) return null;
  const cur = currencyHint ? currencyHint.toUpperCase()
    : /£/.test(s) ? 'GBP' : /€/.test(s) ? 'EUR' : /A\$/.test(s) ? 'AUD' : /C\$/.test(s) ? 'CAD' : /\$/.test(s) ? 'USD' : /¥/.test(s) ? 'JPY' : null;
  return { min: Math.min(...nums), max: Math.max(...nums), currency: cur };
}

/** Some sources report prices in minor units (2500 = 25.00). */
export function fromMinor(v, currency) {
  if (!Number.isFinite(v)) return undefined;
  return TWO_DECIMAL.has(String(currency || '').toUpperCase()) ? v / 100 : v;
}

export function eventType({ title, startMs, tz, isFestival, isConcert }) {
  const t = norm(title);
  if (isFestival || /\bfestival\b|\bfest\b|weekender/.test(t)) return 'festival';
  const h = localHour(startMs, tz);
  if (h >= 4 && h < 10) return 'after';
  if (h >= 10 && h < 18) return 'day';
  // Ticket sites file everything as a concert; a show that starts at 10pm or later is a club night.
  const late = h >= 22 || h < 4;
  if (!late && (isConcert || /\blive\b|\btour\b|\bconcert\b/.test(t))) return 'concert';
  return 'club';
}

/** Nearest configured city within maxKm, else a new city built from the event's own place. */
export function assignCity(ctx, lat, lon, fallback = {}) {
  let best = null, bd = Infinity;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    for (const c of ctx.cities) {
      const d = km(lat, lon, c.lat, c.lon);
      if (d < bd) { bd = d; best = c; }
    }
    if (best && bd <= 90) return best;
  }
  if (fallback.cityId && ctx.cityById[fallback.cityId]) return ctx.cityById[fallback.cityId];
  if (fallback.name) {
    const byName = ctx.cities.find(c => norm(c.name) === norm(fallback.name) || norm(fallback.name).startsWith(norm(c.name)));
    if (byName) return byName;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !fallback.name) return null;
  const id = slug(fallback.name + '-' + (fallback.country || ''));
  if (!ctx.cityById[id]) {
    const c = { id, name: fallback.name, country: fallback.country || '', lat, lon, tz: fallback.tz || 'UTC', region: regionAt(ctx, lat, lon), dynamic: true };
    ctx.cities.push(c); ctx.cityById[id] = c;
  }
  return ctx.cityById[id];
}

function regionAt(ctx, lat, lon) {
  let best = null, bd = Infinity;
  for (const c of ctx.cities) { if (c.dynamic) continue; const d = km(lat, lon, c.lat, c.lon); if (d < bd) { bd = d; best = c; } }
  if (best && bd < 1500) return best.region;
  return lon < -30 ? (lat > 15 ? 'na' : 'la') : lon < 60 ? (lat > 35 ? 'eu' : 'af') : 'ap';
}

/** Small deterministic offset so events placed at a city center don't stack on one point. */
export function jitter(id, lat, lon) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const a = ((h >>> 0) % 360) * Math.PI / 180, r = 0.012 + ((h >>> 8) % 100) / 100 * 0.02;
  return [lat + r * Math.sin(a), lon + r * Math.cos(a) / Math.cos(lat * Math.PI / 180)];
}

const cleanName = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// Lineups sometimes carry contact or credit lines instead of names ('booking: x@y.com',
// 'Instagram: handle', 'Founder @label'). Those stay out: no contact details in the feed.
// Handles billed as names ('@veralyn', 'DJ SILK (@SILKSHUTDOWN)') are kept.
const CONTACT = /\S+@\S+\.[a-z]{2,}|https?:\/\/|www\.|^\s*(bookings?|contact|instagram|insta|ig|email|e-mail|mgmt|management|press|promo)\s*[:\-–]|\b(co-?founder|founder|initiator)\b[^@]*@|^[\s@._-]*$/i;
export const isContactLine = s => CONTACT.test(String(s ?? ''));

// Some listings give the lineup as free text, e.g. '【RING】〈OPEN FORMAT〉', 'LIVE：Nia Varan / Marco',
// '-CRUCIAL SOUND-'. Room headers go, 'DJ：' style labels go, and ' / ' separated names are split.
const ROOM = /【[^】]*】|〈[^〉]*〉|《[^》]*》|\[[^\]]*\]/g;
const ROLE = /^[A-Z0-9][A-Z0-9 .&'+-]{0,30}\s*[:：]\s*/;
const NOT_A_NAME = /^-.*-$|^[\s,，、.:：/|·•\-–—]*$/;
export function splitLineup(list) {
  const out = [];
  for (const raw of list || []) {
    for (let part of String(raw ?? '').replace(ROOM, '\n').split(/\s+\/\s+|／|、|\n|\s\|\s/)) {
      part = cleanName(part).replace(/^[,，、\s]+|[,，、\s]+$/g, '').replace(ROLE, '').trim();
      if (part && !NOT_A_NAME.test(part)) out.push(part);
    }
  }
  return out;
}

/**
 * Note a listing dropped for not being electronic music (run.js passes ctx.notElectronic, a Set, so the
 * archive can drop it too) and return null.
 */
export function notElectronic(ctx, source, id) {
  if (ctx && ctx.notElectronic && id !== undefined && id !== null) ctx.notElectronic.add(`${source}:${id}`);
  return null;
}

/**
 * Build the shared event shape. Returns null when required fields are missing.
 * Only event-level facts are kept: no descriptions, attendee lists or organizer contact details.
 */
/**
 * How much a venue position can be trusted: 'none' for missing, 0,0 ('null island') or whole-degree
 * points (listings use these when there's no real position; 53,13 is 55 km from Berlin), 'rough'
 * when both numbers have at most one decimal (a city-level guess), else 'exact'.
 */
export function positionQuality(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return 'none';
  if ((Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) || (Number.isInteger(lat) && Number.isInteger(lon))) return 'none';
  const oneDecimal = v => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
  return oneDecimal(lat) && oneDecimal(lon) ? 'rough' : 'exact';
}

export function makeEvent(ctx, f) {
  if (!f.title || !Number.isFinite(f.startMs)) return null;
  let genres = (f.genres && f.genres.length ? f.genres : genresFrom(f.title, f.tags || [], f.lineupText || ''));
  if (!genres.length) genres = [fallbackGenre({ title: f.title, tags: f.tags || [], text: [f.genreText, f.lineupText].filter(Boolean).join(' | '), source: f.source })];
  if (!isElectronic({ title: f.title, tags: f.tags || [], genres })) return notElectronic(ctx, f.source, f.id);
  const quality = positionQuality(f.lat, f.lon);
  let lat = quality === 'none' ? undefined : f.lat, lon = quality === 'none' ? undefined : f.lon, approx = quality === 'rough';
  const city = assignCity(ctx, lat, lon, { cityId: f.cityHint, name: f.cityName, country: f.country, tz: f.tz });
  if (!city) return null;
  // No usable position: place it near the city center (one spot per venue name).
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { [lat, lon] = jitter(`${city.id}:${norm(f.venueName || f.id)}`, city.lat, city.lon); approx = true; }
  const tz = f.tz || city.tz;
  const type = f.type || eventType({ title: f.title, startMs: f.startMs, tz, isFestival: f.isFestival, isConcert: f.isConcert });
  const dur = { club: 6, after: 6, day: 7, concert: 3.5, festival: 12 }[type] || 5;
  let endMs = Number.isFinite(f.endMs) && f.endMs > f.startMs ? f.endMs : f.startMs + dur * 3600e3;
  if (endMs - f.startMs > 4 * 86400e3) endMs = f.startMs + 4 * 86400e3;
  const lineup = [...new Set(splitLineup(f.lineup).filter(n => n.length < 80 && !isContactLine(n)))].slice(0, 24);
  const listed = promoterNames(f.promoters).filter(n => !isContactLine(n));
  const promoters = mergePromoters(listed, detectPromoters({ title: f.title, promoters: listed, lineup, genres }));
  const labels = detectLabels({ title: f.title, promoters: listed, lineup, genres });
  return {
    id: `${f.source}:${f.id}`,
    title: cleanName(f.title).slice(0, 160),
    start: new Date(f.startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    tz,
    cityId: city.id,
    venue: { name: cleanName(f.venueName || 'Venue to be announced').slice(0, 120), address: f.address ? cleanName(f.address).slice(0, 160) : undefined, lat: +lat.toFixed(5), lon: +lon.toFixed(5), approx: approx || undefined },
    lineup,
    sets: f.sets && f.sets.length ? f.sets : undefined,
    genres,
    tags: [...new Map((f.tags || []).map(cleanName).filter(Boolean).map(t => [norm(t).replace(/[^a-z0-9]/g, ''), t])).values()].slice(0, 8),
    type,
    price: f.price || null,
    status: f.status || 'unknown',
    popularity: Number.isFinite(f.popularity) ? Math.round(f.popularity) : undefined,
    age: f.age || undefined,
    labels: labels.length ? labels : undefined,
    promoters: promoters.length ? promoters : undefined,
    sources: [{ id: f.source, name: f.sourceName, url: f.url }]
  };
}
