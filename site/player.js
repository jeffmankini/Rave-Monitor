/* The mini player: livestreams from the Streams tab play here, docked at the bottom of the page, and
 * keep playing while people look around the map, the listings and the other tabs.
 *  - YouTube streams play in YouTube's privacy-enhanced embed (youtube-nocookie.com), loaded only when
 *    someone presses play, and only for channels that allow embedding (pipeline/streams.js).
 *  - Live NTS radio plays the stream NTS publishes for listeners' own players and speakers.
 * Stream rows carry data-play (app.js); a click with a modifier key still opens the source's own page,
 * and so does every row if this script is missing. window.RM_PLAYER tells app.js what's playing. */
(function () {
  'use strict';
  const el = document.getElementById('mini');
  if (!el) return;
  const $ = s => el.querySelector(s);
  const NTS = { 1: 'https://stream-relay-geo.ntslive.net/stream?client=direct', 2: 'https://stream-relay-geo.ntslive.net/stream2?client=direct' };
  const YT_ID = /^[A-Za-z0-9_-]{6,20}$/;
  const track = (n, p) => { const a = window.RM_APP; if (a && a.track) a.track(n, p); };
  const time = ms => { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (err) { return ''; } };
  let cur = null, audio = null, timer = 0;

  // Rows in the Streams tab say which stream is playing.
  function markRows() {
    document.querySelectorAll('a[data-play]').forEach(a => {
      const on = !!cur && a.dataset.play === cur.id;
      a.classList.toggle('playing', on);
      const l = a.querySelector('.pl-l');
      if (l) l.textContent = on ? 'Playing' : a.dataset.play.indexOf('nts:') === 0 ? 'Listen' : 'Watch';
    });
  }
  function say(msg) { const s = $('#mini-said'); if (s) s.textContent = msg; }
  function setPlaying(on) {
    const b = $('#mini-play');
    el.classList.toggle('paused', !on);
    b.setAttribute('aria-label', on ? 'Pause' : 'Play');
    b.setAttribute('aria-pressed', String(!on));
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
  }
  function sub(x) {
    if (x.kind === 'radio') return x.channel + (x.until ? ' · until ' + time(x.until) : ' · live radio');
    if (x.status === 'soon' && x.start) return x.channel + ' · starts ' + time(x.start);
    return x.channel + ' · live';
  }
  function paint(x) {
    $('#mini-title').textContent = x.title;
    $('#mini-title').title = x.title;
    $('#mini-sub').textContent = sub(x);
    const out = $('#mini-out');
    out.href = x.url;
    out.setAttribute('aria-label', 'Open on ' + (x.kind === 'radio' ? 'NTS' : 'YouTube'));
    out.title = out.getAttribute('aria-label');
  }

  // NTS: when a show ends the channel carries on, so the title follows the schedule app.js keeps.
  function follow() {
    clearTimeout(timer);
    if (!cur || cur.kind !== 'radio') return;
    const app = window.RM_APP, next = app && app.onAir ? app.onAir(cur.channel) : null;
    if (next && next.until !== cur.until) { cur.title = next.title; cur.until = next.until; cur.url = next.url; paint(cur); }
    else if (cur.until && Date.now() >= cur.until) { cur.title = cur.channel; cur.until = 0; cur.url = 'https://www.nts.live/'; paint(cur); }
    timer = setTimeout(follow, cur.until && cur.until > Date.now() ? Math.min(cur.until - Date.now() + 5000, 15 * 60e3) : 5 * 60e3);
  }

  function playRadio(x) {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'none';
      audio.addEventListener('playing', () => { setPlaying(true); el.classList.remove('loading'); });
      audio.addEventListener('pause', () => setPlaying(false));
      audio.addEventListener('waiting', () => el.classList.add('loading'));
      audio.addEventListener('error', () => {
        if (!cur || cur.kind !== 'radio' || !audio.getAttribute('src')) return;
        setPlaying(false); el.classList.remove('loading');
        $('#mini-sub').textContent = 'Couldn\'t reach NTS. Try again in a moment.';
      });
    }
    resumeRadio();
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: x.title, artist: x.channel, album: 'Rave Monitor' });
        navigator.mediaSession.setActionHandler('play', resumeRadio);
        navigator.mediaSession.setActionHandler('pause', pauseRadio);
        navigator.mediaSession.setActionHandler('stop', close);
      } catch (err) { /* older browsers: the page's own buttons still work */ }
    }
  }
  // Live radio has nothing to come back to: pausing lets the stream go (it would keep downloading),
  // and playing again starts it from now.
  function resumeRadio() {
    if (!audio || !cur || cur.kind !== 'radio') return;
    audio.src = NTS[cur.ch];
    el.classList.add('loading');
    const p = audio.play();
    if (p && p.catch) p.catch(() => { setPlaying(false); el.classList.remove('loading'); });
  }
  function pauseRadio() {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setPlaying(false);
    el.classList.remove('loading');
  }
  function stopRadio() {
    pauseRadio();
    if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; } catch (err) { /* fine */ } }
  }

  function open(x) {
    if (cur && cur.id === x.id) { if (x.kind === 'radio' && audio && audio.paused) resumeRadio(); else setSize(true); return; }
    stop();
    cur = x;
    el.hidden = false;
    document.body.classList.add('has-mini');
    el.classList.toggle('radio', x.kind === 'radio');
    el.classList.remove('paused', 'loading');
    $('#mini-play').hidden = x.kind !== 'radio';
    $('#mini-size').hidden = x.kind === 'radio';
    paint(x);
    if (x.kind === 'radio') { playRadio(x); follow(); }
    else {
      const f = document.createElement('iframe');
      f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(x.vid) + '?autoplay=1&playsinline=1&rel=0';
      f.title = 'YouTube: ' + x.title;
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      $('#mini-screen').replaceChildren(f);
      setSize(true);
    }
    say('Playing ' + x.title + ', ' + x.channel);
    markRows();
  }
  function stop() {
    clearTimeout(timer);
    stopRadio();
    $('#mini-screen').replaceChildren();
    cur = null;
  }
  function close() {
    if (!cur) return;
    track('player_close', { platform: cur.kind === 'radio' ? 'NTS' : 'YouTube' });
    stop();
    el.hidden = true;
    document.body.classList.remove('has-mini');
    say('');
    markRows();
  }
  // YouTube: the video folds away and the sound carries on.
  function setSize(big) {
    el.classList.toggle('small', !big);
    const b = $('#mini-size');
    b.setAttribute('aria-expanded', String(big));
    b.setAttribute('aria-label', big ? 'Hide the video' : 'Show the video');
    b.title = b.getAttribute('aria-label');
  }

  $('#mini-close').addEventListener('click', close);
  $('#mini-size').addEventListener('click', () => setSize(el.classList.contains('small')));
  $('#mini-play').addEventListener('click', () => { if (audio && cur) { if (audio.paused) resumeRadio(); else pauseRadio(); } });

  // A plain click on a playable stream row plays it here.
  document.addEventListener('click', ev => {
    const a = ev.target.closest && ev.target.closest('a[data-play]');
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const id = a.dataset.play, d = a.dataset;
    let x = null;
    const nts = id.match(/^nts:([12])$/);
    if (nts) x = { id, kind: 'radio', ch: nts[1], channel: 'NTS ' + nts[1], title: d.playTitle || 'NTS ' + nts[1], until: +d.playUntil || 0, url: a.href };
    else if (id.indexOf('yt:') === 0 && YT_ID.test(id.slice(3))) x = { id, kind: 'video', vid: id.slice(3), channel: d.playChannel || 'YouTube', title: d.playTitle || 'Livestream', status: d.playStatus || 'live', start: +d.playStart || 0, url: a.href };
    if (!x) return;
    ev.preventDefault();
    open(x);
  });

  // On phones the Map button and the footer make room for the player, however tall it is.
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (!el.hidden) document.documentElement.style.setProperty('--mini-h', el.offsetHeight + 'px'); }).observe(el);

  window.RM_PLAYER = { current: () => (cur ? cur.id : null), open, close };
})();
