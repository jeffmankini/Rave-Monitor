import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decode, ntsGenres, ntsSlot, ytStream, buildStreams } from '../pipeline/streams.js';

const NOW = Date.parse('2026-11-08T22:30:00Z');
const iso = h => new Date(NOW + h * 3600e3).toISOString().replace('.000Z', 'Z');
const slot = (title, h0, h1, show, extra = {}) => ({
  broadcast_title: title, start_timestamp: iso(h0), end_timestamp: iso(h1),
  links: [{ href: `https://www.nts.live/api/v2/shows/${show}/episodes/${show}-ep` }], embeds: {}, ...extra
});
const details = genres => ({ embeds: { details: { genres, location_long: 'London' } } });

/** A fake NTS and YouTube on one port. Records the paths asked for. */
async function mockApis({ yt = 'ok' } = {}) {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url.replace(/key=[^&]+/, 'key=K'));
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/nts/live') {
      return json(200, { results: [
        { channel_name: '1',
          now: slot('Club Night w/ Someone', -0.5, 1.5, 'clubnight', details([{ id: 'genres-housetechno-techno', value: 'Techno' }, { id: 'genres-postpunkwave-minimalsynth', value: 'Minimal Synth' }])),
          next: slot('Folk Hour', 1.5, 2.5, 'folkhour', details([{ id: 'genres-rock-folkrock', value: 'Folk Rock' }])),
          next2: slot('Jungle Special', 2.5, 4.5, 'jungle'),
          next3: slot('Old Show (R)', 4.5, 5.5, 'oldshow'),
          next4: slot('Far Away', 60, 61, 'faraway') },
        { channel_name: '2',
          now: slot('SOUL &amp; BOOGIE (R)', -1, 1, 'soul', details([{ id: 'genres-discoboogie-boogie', value: 'Boogie' }])),
          next: slot('Mystery', 9, 10, 'mystery') }
      ] });
    }
    if (req.url === '/nts/shows/jungle/episodes/jungle-ep') return json(200, { genres: [{ id: 'genres-ukdance-jungle', value: 'Jungle' }], location_long: 'Bristol' });
    if (req.url === '/nts/shows/mystery/episodes/mystery-ep') return json(200, { genres: [], location_long: null });
    if (req.url.startsWith('/yt/playlistItems')) {
      if (yt === 'quota') return json(403, { error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.' } });
      const ch = new URL(req.url, 'http://x').searchParams.get('playlistId');
      if (ch === 'UUmissing') return json(404, { error: { message: 'The playlist identified with the request\'s playlistId parameter cannot be found.' } });
      return json(200, { items: ch === 'UUaaa' ? [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }] : [{ contentDetails: { videoId: 'v3' } }, { contentDetails: { videoId: 'v4' } }] });
    }
    if (req.url.startsWith('/yt/videos')) {
      return json(200, { items: [
        { id: 'v1', snippet: { title: 'Boiler Room: Someone techno set', liveBroadcastContent: 'live', channelTitle: 'Boiler Room' }, liveStreamingDetails: { actualStartTime: iso(-0.4), concurrentViewers: '1234' } },
        { id: 'v2', snippet: { title: 'Old upload', liveBroadcastContent: 'none' } },
        { id: 'v3', snippet: { title: 'Sunrise set at the lake', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: iso(20) }, status: { embeddable: false } },
        { id: 'v4', snippet: { title: 'Placeholder stream', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: iso(-200) } }
      ] });
    }
    json(404, { error: { message: 'not found' } });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.NTS_API_BASE = `${base}/nts`;
  process.env.YOUTUBE_API_BASE = `${base}/yt`;
  return { asked, close: () => server.close() };
}

const CFG = {
  nts: { hours: 36, maxDetails: 30 },
  youtube: { perChannel: 15, upcomingDays: 7, channels: [{ id: 'UCaaa', name: 'Boiler Room' }, { id: 'UCbbb', name: 'Cercle', genres: ['house'], city: 'Paris' }, { id: 'UCmissing', name: 'Gone' }] }
};

test('NTS titles lose their HTML entities and repeat marker', () => {
  assert.equal(decode('FUNKY SOUL &amp; BOOGIE &#39;87 &#x2014; live'), "FUNKY SOUL & BOOGIE '87 — live");
  const s = ntsSlot('2', slot('SOUL &amp; BOOGIE (R)', 0, 1, 'soul'), null);
  assert.equal(s.title, 'SOUL & BOOGIE');
  assert.equal(s.rerun, true);
  assert.equal(s.url, 'https://www.nts.live/shows/soul/episodes/soul-ep');
  assert.equal(s.genres, null); // unknown, not "not club"
});

test('only club genres decide an NTS show\'s families', () => {
  const g = ntsGenres([{ id: 'genres-housetechno-techno', value: 'Techno' }, { id: 'genres-postpunkwave-minimalsynth', value: 'Minimal Synth' }]);
  assert.deepEqual(g.families, ['techno']); // 'Minimal Synth' is post-punk, not minimal house
  assert.equal(g.club, true);
  assert.deepEqual(ntsGenres([{ id: 'genres-rock-krautrock', value: 'Krautrock' }]), { families: [], club: false, tags: ['Krautrock'] });
  assert.deepEqual(ntsGenres([{ id: 'genres-ukdance-drumandbass', value: 'Drum &amp; Bass' }]).families, ['dnb']);
});

test('YouTube videos become streams only when live or coming up soon', () => {
  const ch = { name: 'Cercle', genres: ['house'], city: 'Paris' };
  const live = ytStream({ id: 'a', snippet: { title: 'Techno all night', liveBroadcastContent: 'live' }, liveStreamingDetails: { actualStartTime: iso(-1), concurrentViewers: '50' } }, ch, NOW);
  assert.equal(live.status, 'live');
  assert.equal(live.viewers, 50);
  assert.deepEqual(live.genres, ['techno']); // the title beats the channel's usual genre
  const soon = ytStream({ id: 'b', snippet: { title: 'Sunset set', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: iso(5) } }, ch, NOW);
  assert.deepEqual(soon.genres, ['house']);
  assert.equal(soon.url, 'https://www.youtube.com/watch?v=b');
  const stale = { id: 'c', snippet: { title: 'Never started', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: iso(-30) } };
  const late = { id: 'g', snippet: { title: 'Festival stream running late', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: iso(-3) } };
  assert.ok(ytStream(late, ch, NOW), 'a stream a few hours late is still listed');
  assert.equal(ytStream(stale, ch, NOW), null);
  const far = { id: 'd', snippet: { title: 'Next month', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: iso(24 * 30) } };
  assert.equal(ytStream(far, ch, NOW), null);
  const ended = { id: 'e', snippet: { title: 'Done', liveBroadcastContent: 'live' }, liveStreamingDetails: { actualStartTime: iso(-3), actualEndTime: iso(-1) } };
  assert.equal(ytStream(ended, ch, NOW), null);
  const panel = { id: 'f', snippet: { title: 'Industry panel and networking', liveBroadcastContent: 'upcoming' }, liveStreamingDetails: { scheduledStartTime: iso(3) } };
  assert.equal(ytStream(panel, ch, NOW), null);
});

test('builds streams.json from NTS and YouTube, saving NTS genres between runs', async () => {
  const api = await mockApis();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streams-'));
  try {
    const warnings = [];
    const out = await buildStreams({ cfg: CFG, key: 'SECRETKEY', cacheDir: dir, now: NOW, warn: m => warnings.push(m) });
    const ids = out.streams.map(s => s.id);
    assert.ok(!ids.some(id => id.includes(iso(60))), 'shows beyond the window are left out');
    const club = out.streams.find(s => s.title === 'Club Night w/ Someone');
    assert.deepEqual([club.club, club.genres, club.location], [true, ['techno'], 'London']);
    const jungle = out.streams.find(s => s.title === 'Jungle Special');
    assert.deepEqual([jungle.genres, jungle.location], [['dnb'], 'Bristol']); // looked up from the episode
    assert.equal(out.streams.find(s => s.title === 'Old Show').genres, null); // repeats aren't looked up
    assert.equal(out.streams.find(s => s.title === 'Mystery').club, null);
    assert.ok(!api.asked.some(u => u.includes('oldshow')));
    const yt = out.streams.filter(s => s.platform === 'YouTube');
    assert.deepEqual(yt.map(s => s.id).sort(), ['yt:v1', 'yt:v3']);
    assert.deepEqual(yt.find(s => s.id === 'yt:v3').genres, ['house']);
    assert.equal(yt.find(s => s.id === 'yt:v3').city, 'Paris');
    // The mini player only plays what the channel lets other sites embed.
    assert.deepEqual(yt.map(s => [s.id, s.embed]).sort(), [['yt:v1', true], ['yt:v3', false]]);
    assert.ok(api.asked.some(u => u.startsWith('/yt/videos') && u.includes('part=snippet,liveStreamingDetails,status')));
    assert.deepEqual(out.sources.map(s => [s.id, s.ok, s.n]), [['nts', true, 6], ['youtube', true, 2]]);
    assert.deepEqual(out.sources[1].seen, { live: 1, upcoming: 2 });
    assert.ok(warnings.some(w => w.includes('Placeholder stream') && w.includes('long past')), 'left-out streams are explained');
    assert.equal(out.sources[1].channels, 2);
    assert.ok(warnings.some(w => w.includes('Gone')), 'a missing channel warns');
    assert.ok(!JSON.stringify(out).includes('SECRETKEY') && !warnings.join(' ').includes('SECRETKEY'));
    assert.ok(Date.parse(out.streams[0].start) <= Date.parse(out.streams.at(-1).start));

    // Second run: Jungle Special comes from the saved genres; Mystery (no genres yet) is asked again later.
    const before = api.asked.length;
    await buildStreams({ cfg: CFG, key: 'SECRETKEY', cacheDir: dir, now: NOW + 60e3 });
    const again = api.asked.slice(before);
    assert.ok(!again.some(u => u.includes('/shows/jungle/')));
    assert.ok(again.some(u => u.includes('/shows/mystery/')) === false, 'empty genres are not asked again within 6 hours');
    await buildStreams({ cfg: CFG, key: 'SECRETKEY', cacheDir: dir, now: NOW + 7 * 3600e3 });
    assert.ok(api.asked.slice(before).some(u => u.includes('/shows/mystery/')));
  } finally { api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('YouTube is skipped without a key, and a used-up quota falls back to the saved list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streams-'));
  let api = await mockApis();
  try {
    const none = await buildStreams({ cfg: CFG, key: '', cacheDir: dir, now: NOW });
    assert.deepEqual(none.sources[1], { id: 'youtube', label: 'YouTube', ok: false, n: 0, skipped: 'No YOUTUBE_KEY set' });
    assert.ok(!api.asked.some(u => u.startsWith('/yt/')));
    await buildStreams({ cfg: CFG, key: 'K1', cacheDir: dir, now: NOW });
    api.close();
    api = await mockApis({ yt: 'quota' });
    const later = await buildStreams({ cfg: CFG, key: 'K1', cacheDir: dir, now: NOW + 4 * 3600e3 });
    const yt = later.sources[1];
    assert.equal(yt.ok, false);
    assert.match(yt.error, /quota/);
    assert.equal(yt.stale, true);
    // The scheduled stream is still ahead; the live one was checked 4 hours ago, too long to trust.
    assert.deepEqual(later.streams.filter(s => s.platform === 'YouTube').map(s => s.id), ['yt:v3']);
  } finally { api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
