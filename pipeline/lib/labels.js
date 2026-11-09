// Record labels and promoters. Listings have no label field, so labels come from a curated list
// (config/labels.json) found in the title, a promoter name or a lineup credit like
// 'Ben UFO (Hessle Audio)'. Promoter names come from the listing itself: names only.
import fs from 'node:fs';
import { norm } from './util.js';

/** Lowercase, no accents or apostrophes, & as 'and', everything else that isn't a letter or digit a space. */
export const fold = s => ' ' + norm(s).replace(/['’‘`´]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

let LIST = null;
/** The curated list, compiled once. Tests can pass their own. */
export function labelList(raw) {
  if (raw) return compile(raw);
  if (!LIST) LIST = compile(JSON.parse(fs.readFileSync(new URL('../../config/labels.json', import.meta.url), 'utf8')).labels);
  return LIST;
}
function compile(labels) {
  return labels.map(l => ({
    name: l.name,
    match: (l.match || [l.name]).map(fold).filter(p => p.trim()),
    lead: (l.lead || []).map(leadRe),
    genres: l.genres || null
  }));
}

// A lead phrase opens the title and is followed by a break: 'RINSE: Y U QT', 'Optimo | Glasgow', 'Rinse x Fabric'.
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function leadRe(phrase) {
  return new RegExp('^[^a-z0-9]*' + fold(phrase).trim().split(' ').map(escRe).join('[^a-z0-9]+') + '\\s*(?:[:|@–—-]|x\\s|presents?\\b|pres\\b|w/|$)');
}
const plain = s => norm(s).replace(/['’‘`´]/g, '').replace(/&/g, ' and ');

// A credit in brackets after a name: 'Ben UFO (Hessle Audio)', 'Nocapz [Hot Creations]'.
const CREDIT = /[([]([^)\]]{2,60})[)\]]/g;

/**
 * Labels an event names, in list order, at most four. f: { title, promoters, lineup, genres }.
 * A lineup line counts when the whole line is the label ('Anjunadeep', 'Dekmantel Soundsystem')
 * or it's in a credit, so 'Groove Armada' doesn't become Armada Music.
 */
export function detectLabels(f, list = labelList()) {
  const title = fold(f.title || ''), rawTitle = plain(f.title || '').trim();
  const promoters = (f.promoters || []).map(fold);
  const lines = (f.lineup || []).map(String);
  const credits = lines.flatMap(n => [...n.matchAll(CREDIT)].map(m => fold(m[1])));
  const whole = lines.map(n => fold(n.replace(CREDIT, ' ')));
  const genres = new Set(f.genres || []);
  const out = [];
  for (const l of list) {
    if (l.genres && !l.genres.some(g => genres.has(g))) continue;
    const hit = l.match.some(p => title.includes(p) || promoters.some(x => x.includes(p)) || credits.some(x => x.includes(p)) ||
      whole.some(x => x === p || x.startsWith(p) && /^ (showcase|soundsystem|sound system|label night|takeover|records|recordings) $/.test(x.slice(p.length - 1))))
      || l.lead.some(re => re.test(rawTitle));
    if (hit) out.push(l.name);
    if (out.length === 4) break;
  }
  // A promoter named like a label ('American Death Records', 'Roam Recordings') is one, even off the list.
  // Capitalised only: 'public records' is a club.
  for (const p of f.promoters || []) {
    if (out.length === 4) break;
    if (/\s(Records|Recordings)$/.test(p) && !out.some(n => fold(n) === fold(p) || fold(p).startsWith(fold(n).slice(0, -1) + ' records') || fold(p).startsWith(fold(n).slice(0, -1) + ' recordings'))) out.push(p);
  }
  return out;
}

const CONTACTISH = /\S+@\S+\.[a-z]{2,}|https?:\/\/|www\.|\.(com|net|org|io|co)\b/i;
/** Promoter names from a listing: strings or { name } objects, cleaned, no links or addresses, at most four. */
export function promoterNames(list) {
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  const names = arr.map(p => typeof p === 'string' ? p : p && (p.name || p.title)).filter(Boolean)
    .map(s => String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 1 && s.length <= 80 && !CONTACTISH.test(s));
  const seen = new Map();
  for (const n of names) if (!seen.has(fold(n))) seen.set(fold(n), n);
  return [...seen.values()].slice(0, 4);
}
