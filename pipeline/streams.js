#!/usr/bin/env node
// Builds public/streams.json for the Streams tab:
//   - NTS Radio's schedule for the next day and a half, with genres for new shows (no key needed)
//   - live and scheduled streams from the YouTube channels in config/streams.json. This needs a free
//     YOUTUBE_KEY (YouTube Data API v3) and is skipped without one. A run costs about 1 unit of the
//     10,000 free daily units per channel, because it reads each channel's uploads list, not search.
//
//   node pipeline/streams.js
//   node pipeline/streams.js --out public --cache cache
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, pool } from './lib/util.js';
import { FAMILIES, genresFrom, electronicScore } from './lib/normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NTS_API = () => process.env.NTS_API_BASE || 'https://www.nts.live/api/v2';
const YT_API = () => process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const HOUR = 3600e3, DAY = 24 * HOUR;

// NTS genre families (the middle part of ids like genres-housetechno-techno) that are club music.
export const NTS_CLUB = ['housetechno', 'ukdance', 'newclub', 'discoboogie', 'electronicadowntempo'];
const ntsFamily = id => String(id || '').replace(/^genres-/, '').split('-')[0];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** NTS titles carry HTML entities ('FUNKY SOUL &amp; BOOGIE'). */
export function decode(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  });
}

/** NTS genres ([{ id: 'genres-housetechno-techno', value: 'Techno' }]) to the map's families. */
export function ntsGenres(list) {
  const all = (list || []).filter(g => g && g.value);
  const club = all.filter(g => NTS_CLUB.includes(ntsFamily(g.id)));
  // Only club genres count: 'Minimal Synth' (post-punk) must not read as minimal house.
  return { families: genresFrom(club.map(g => decode(g.value))), club: club.length > 0, tags: all.map(g => decode(g.value).trim()).slice(0, 4) };
}

function episodeOf(b) {
  for (const l of b.links || []) {
    const m = String(l && l.href || '').match(/\/shows\/([^/?#]+)\/episodes\/([^/?#]+)/);
    if (m) return { show: m[1], episode: m[2] };
  }
  return null;
}
const isRerun = b => /\(R\)\s*$/i.test(decode(b.broadcast_title).trim());

/** One NTS broadcast slot in the streams.json shape. details: the episode record, if known. */
export function ntsSlot(channel, b, details) {
  const raw = decode(b.broadcast_title).trim();
  // No genres yet (common for shows a day out) means unknown, not 'not club'.
  const ep = episodeOf(b), g = details && details.genres && details.genres.length ? ntsGenres(details.genres) : null;
  return {
    id: `nts:${channel}:${b.start_timestamp}`, platform: 'NTS', kind: 'radio', channel: `NTS ${channel}`,
    title: raw.replace(/\s*\(R\)\s*$/i, ''), rerun: isRerun(b), start: b.start_timestamp, end: b.end_timestamp,
    url: ep ? `https://www.nts.live/shows/${ep.show}/episodes/${ep.episode}` : 'https://www.nts.live/',
    genres: g ? g.families : null, club: g ? g.club : null, tags: g ? g.tags : [],
    location: details && details.location_long ? decode(details.location_long) : null
  };
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, data) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data)); }

/**
 * Both NTS channels from now until cfg.hours ahead. The live list carries full details for the
 * current and next show only, so genres for later new shows come from each episode's record,
 * saved in cacheFile between runs. Repeats ('(R)') are not looked up.
 */
export async function collectNts(cfg = {}, { cacheFile, now = Date.now(), warn = () => {} } = {}) {
  const live = await fetchJson(`${NTS_API()}/live`, { headers: { accept: 'application/json' } }, { label: 'NTS live' });
  const until = now + (cfg.hours || 36) * HOUR;
  const slots = [];
  for (const ch of (live && live.results) || []) {
    for (const [key, b] of Object.entries(ch)) {
      if (!/^(now|next\d*)$/.test(key) || !b || !b.start_timestamp || !b.end_timestamp) continue;
      if (!(Date.parse(b.end_timestamp) > now) || Date.parse(b.start_timestamp) > until) continue;
      const d = b.embeds && b.embeds.details;
      slots.push({ ch: String(ch.channel_name), b, details: d && d.genres ? d : null });
    }
  }
  const saved = (cacheFile && readJson(cacheFile)) || {};
  // Genres are kept for a month; an episode without genres yet is asked again after 6 hours.
  for (const [k, v] of Object.entries(saved)) if (!(now - v.at < ((v.genres || []).length ? 30 * DAY : 6 * HOUR))) delete saved[k];
  const missing = [];
  for (const s of slots) {
    const ep = episodeOf(s.b);
    if (s.details || !ep || isRerun(s.b)) continue;
    const k = `${ep.show}/${ep.episode}`;
    if (saved[k]) s.details = saved[k]; else missing.push({ s, ep, k });
  }
  let looked = 0;
  await pool(missing.slice(0, cfg.maxDetails ?? 30), 2, async ({ s, ep, k }) => {
    try {
      const d = await fetchJson(`${NTS_API()}/shows/${encodeURIComponent(ep.show)}/episodes/${encodeURIComponent(ep.episode)}`, {}, { label: `NTS ${k}`, retries: 1 });
      s.details = saved[k] = { genres: (d && d.genres) || [], location_long: (d && d.location_long) || null, at: now };
      looked++;
    } catch (err) { warn(err.message); }
  });
  if (cacheFile) writeJson(cacheFile, saved);
  const items = slots.map(s => ntsSlot(s.ch, s.b, s.details));
  items.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.channel.localeCompare(b.channel));
  return { items, looked };
}

/**
 * A YouTube video record to a stream, or null if it isn't live or coming up soon.
 * why(reason) hears why a live or scheduled video was left out.
 */
export function ytStream(v, ch = {}, now = Date.now(), cfg = {}, why = () => {}) {
  const sn = v.snippet || {}, live = v.liveStreamingDetails || {};
  const status = sn.liveBroadcastContent;
  if (status !== 'live' && status !== 'upcoming') return null;
  if (live.actualEndTime) { why('ended'); return null; }
  const t = Date.parse(status === 'live' ? live.actualStartTime || live.scheduledStartTime : live.scheduledStartTime);
  if (!Number.isFinite(t)) { why('no start time'); return null; }
  // A scheduled stream half a day past its time never started (or was left behind as a placeholder);
  // one weeks out is too far ahead.
  if (status === 'upcoming' && t < now - 12 * HOUR) { why('scheduled time long past'); return null; }
  if (status === 'upcoming' && t > now + (cfg.upcomingDays || 7) * DAY) { why('more than a week ahead'); return null; }
  const title = decode(sn.title).trim();
  if (!title || electronicScore(title) < 0) { why('not a music stream'); return null; } // panels, workshops, webinars
  const fromTitle = genresFrom(title);
  return {
    id: `yt:${v.id}`, platform: 'YouTube', kind: 'video', channel: ch.name || decode(sn.channelTitle) || 'YouTube',
    title, status, start: new Date(t).toISOString(), end: null,
    viewers: Number(live.concurrentViewers) || null,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`,
    genres: fromTitle.length ? fromTitle : (ch.genres || []).filter(g => FAMILIES.includes(g)),
    city: ch.city || null
  };
}

/**
 * Live and scheduled streams on the configured channels: each channel's uploads list
 * (live and scheduled streams appear there too), then the video records in batches of 50.
 * A bad key or a used-up quota fails the whole source; one missing channel only warns.
 */
export async function collectYouTube(cfg = {}, key, { now = Date.now(), warn = () => {} } = {}) {
  const per = Math.min(50, cfg.perChannel || 15), k = encodeURIComponent(key);
  const channels = cfg.channels || [], byVideo = new Map();
  let failed = 0;
  await pool(channels, 3, async ch => {
    try {
      const data = await fetchJson(`${YT_API()}/playlistItems?part=contentDetails&maxResults=${per}&playlistId=UU${String(ch.id).slice(2)}&key=${k}`, {}, { label: `YouTube ${ch.name}` });
      for (const it of (data && data.items) || []) { const id = it.contentDetails && it.contentDetails.videoId; if (id && !byVideo.has(id)) byVideo.set(id, ch); }
    } catch (err) {
      if (err.status === 400 || err.status === 401 || err.status === 403) throw err;
      failed++; warn(err.message);
    }
  });
  if (channels.length && failed === channels.length) throw new Error('YouTube: no channel could be read');
  const ids = [...byVideo.keys()], items = [], seen = { live: 0, upcoming: 0 }, left = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await fetchJson(`${YT_API()}/videos?part=snippet,liveStreamingDetails&id=${ids.slice(i, i + 50).join(',')}&key=${k}`, {}, { label: 'YouTube videos' });
    for (const v of (data && data.items) || []) {
      const st = v.snippet && v.snippet.liveBroadcastContent;
      if (st in seen) seen[st]++;
      const s = ytStream(v, byVideo.get(v.id), now, cfg, reason => left.push(`${(byVideo.get(v.id) || {}).name}: "${decode(v.snippet && v.snippet.title).slice(0, 70)}" (${reason})`));
      if (s) items.push(s);
    }
  }
  for (const l of left) warn(`left out ${l}`);
  return { items, channels: channels.length - failed, checked: ids.length, seen };
}

/** The whole streams.json document. Saved files in cacheDir keep NTS genres and the last YouTube list. */
export async function buildStreams({ cfg, key, cacheDir, now = Date.now(), warn = () => {} }) {
  const out = { generatedAt: new Date(now).toISOString(), streams: [], sources: [] };
  const scrub = s => (key ? String(s).split(key).join('***') : String(s));
  try {
    const r = await collectNts(cfg.nts, { cacheFile: cacheDir && path.join(cacheDir, 'nts-episodes.json'), now, warn });
    out.streams.push(...r.items);
    out.sources.push({ id: 'nts', label: 'NTS Radio', ok: true, n: r.items.length });
  } catch (err) {
    out.sources.push({ id: 'nts', label: 'NTS Radio', ok: false, n: 0, error: err.message });
  }
  const ytFile = cacheDir && path.join(cacheDir, 'youtube.json');
  if (!key) {
    out.sources.push({ id: 'youtube', label: 'YouTube', ok: false, n: 0, skipped: 'No YOUTUBE_KEY set' });
  } else {
    try {
      const r = await collectYouTube(cfg.youtube, key, { now, warn: m => warn(scrub(m)) });
      if (ytFile) writeJson(ytFile, { at: now, items: r.items });
      out.streams.push(...r.items);
      out.sources.push({ id: 'youtube', label: 'YouTube', ok: true, n: r.items.length, channels: r.channels, checked: r.checked, seen: r.seen });
    } catch (err) {
      // Fall back to the last list: scheduled streams still ahead, and live ones checked recently.
      const saved = ytFile && readJson(ytFile);
      const keep = saved && Array.isArray(saved.items) ? saved.items.filter(s => s.status === 'upcoming' ? Date.parse(s.start) > now - HOUR : now - saved.at < 3 * HOUR) : [];
      out.streams.push(...keep);
      out.sources.push({ id: 'youtube', label: 'YouTube', ok: false, n: keep.length, error: scrub(err.message), ...(keep.length ? { stale: true, checkedAt: new Date(saved.at).toISOString() } : {}) });
    }
  }
  out.streams.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'streams.json'), 'utf8'));
  const outDir = path.resolve(ROOT, opt('out') || 'public');
  const cacheDir = path.resolve(ROOT, opt('cache') || 'cache', 'streams');
  const out = await buildStreams({ cfg, key: (process.env.YOUTUBE_KEY || '').trim(), cacheDir, warn: m => console.warn(`  warning: ${m}`) });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'streams.json'), JSON.stringify(out));
  for (const s of out.sources) {
    const detail = s.skipped ? ` (skipped: ${s.skipped})` : s.error ? ` (${s.stale ? 'saved list; ' : ''}${s.error})`
      : s.seen ? ` (checked ${s.checked} recent videos on ${s.channels} channels: ${s.seen.live} live, ${s.seen.upcoming} scheduled)` : '';
    console.log(`${s.label}: ${s.n} streams${detail}`);
  }
  console.log(`${path.relative(ROOT, path.join(outDir, 'streams.json'))}: ${out.streams.length} streams`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
