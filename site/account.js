/* Rave Monitor accounts, in the browser: sign in with an emailed link, follow artists, venues,
 * promoters and labels, save shows, pick cities, genres and emails, and read alerts.
 * The API is the Worker at window.RM_ACCOUNTS.api (worker/api/src/accounts.js); the session is an
 * HttpOnly cookie this page never sees. app.js draws the Follow and Save buttons (data-follow,
 * data-save) and shares a few things as window.RM_APP; this file keeps the buttons in step.
 * Nothing here runs unless the build set window.RM_ACCOUNTS. */
(function () {
  'use strict';
  const CFG = window.RM_ACCOUNTS || {};
  if (!CFG.api) return;
  const API = String(CFG.api).replace(/\/+$/, '');
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = () => window.RM_APP || null;
  const track = (n, p) => { const a = app(); if (a) a.track(n, p); };
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (err) { return 'UTC'; } };
  const store = {
    get: k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (err) { return null; } },
    set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (err) { /* private mode */ } }
  };

  // Follows of labels and promoters are one set of names, as the alerts compare them.
  const fk = (kind, key) => (kind === 'label' || kind === 'promoter' ? 'crew' : kind) + '|' + key;
  const A = { me: null, follows: new Map(), saves: new Map(), unread: 0, items: null, view: 'alerts', ts: null, sentTo: '', reason: '', note: '', flash: '', calendar: null };
  const following = (kind, key) => A.follows.has(fk(kind, key));

  async function api(method, path, body) {
    const r = await fetch(API + path, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch (err) { j = null; }
    if (!r.ok || !j || j.ok === false) { const e = new Error((j && j.error) || 'http_' + r.status); e.status = r.status; throw e; }
    return j;
  }

  function strip(param) {
    const u = new URL(location.href);
    if (!u.searchParams.has(param)) return;
    u.searchParams.delete(param);
    history.replaceState(history.state, '', u.pathname + (u.search ? u.search : '') + u.hash);
  }

  function setMe(p) {
    if (!p || !p.user) { A.me = null; A.follows = new Map(); A.saves = new Map(); A.unread = 0; A.items = null; A.calendar = null; }
    else {
      A.me = p.user;
      A.follows = new Map((p.follows || []).map(f => [fk(f.kind, f.key), f]));
      A.saves = new Map((p.saves || []).map(s => [s.id, s]));
      A.unread = p.unread || 0;
      if ('calendar' in p) A.calendar = p.calendar || null;
    }
    header(); sync(document); share();
    if (A.me) themeSync();
    if (dlg().open) render();
  }
  // What the rest of the page may want to know: whether someone's signed in, and their own colors.
  function share() {
    window.RM_ACCT = { signedIn: !!A.me, customTheme: (A.me && A.me.customTheme) || null };
    document.dispatchEvent(new CustomEvent('rm:account'));
  }

  /* ---------- the header: account and bell ---------- */
  const ICON = {
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.8 19.5c1.3-3.3 4-5 7.2-5s5.9 1.7 7.2 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 20.5a2.1 2.1 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };
  function header() {
    const ab = $('#acct-btn'), bb = $('#bell-btn');
    if (!ab || !bb) return;
    ab.hidden = false;
    if (A.me) {
      ab.innerHTML = '<span class="acct-i" aria-hidden="true">' + esc((A.me.email || '?')[0].toUpperCase()) + '</span>' + (A.unread ? '<span class="badge">' + (A.unread > 99 ? '99+' : A.unread) + '</span>' : '');
      ab.setAttribute('aria-label', A.unread ? 'Your account, ' + A.unread + ' new alerts' : 'Your account');
      ab.classList.add('in');
      bb.hidden = false;
      bb.innerHTML = ICON.bell + (A.unread ? '<span class="badge">' + (A.unread > 99 ? '99+' : A.unread) + '</span>' : '');
      bb.setAttribute('aria-label', A.unread ? 'Alerts, ' + A.unread + ' new' : 'Alerts');
    } else {
      ab.innerHTML = ICON.user + '<span class="acct-l">Sign in</span>';
      ab.setAttribute('aria-label', 'Sign in');
      ab.classList.remove('in');
      bb.hidden = true;
    }
  }

  /* ---------- Follow and Save buttons, wherever app.js draws them ---------- */
  function sync(root) {
    $$('[data-follow]', root).forEach(b => {
      const on = following(b.dataset.follow, b.dataset.key);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', (on ? 'Unfollow ' : 'Follow ') + b.dataset.name);
      b.title = on ? 'Following ' + b.dataset.name + '. Select to unfollow' : 'Follow ' + b.dataset.name + ' for alerts';
      if (!b.classList.contains('mini')) b.textContent = on ? 'Following' : 'Follow';
    });
    $$('[data-save]', root).forEach(b => {
      const on = A.saves.has(b.dataset.save);
      b.setAttribute('aria-pressed', String(on));
      const l = $('span', b); if (l) l.textContent = on ? 'Saved' : 'Save';
      b.setAttribute('aria-label', on ? 'Saved. Select to unsave' : 'Save this show for reminders');
    });
  }
  let syncQueued = false;
  new MutationObserver(muts => {
    if (syncQueued) return;
    if (!muts.some(m => Array.from(m.addedNodes).some(n => n.nodeType === 1 && (n.matches('[data-follow], [data-save]') || n.querySelector('[data-follow], [data-save]'))))) return;
    syncQueued = true;
    requestAnimationFrame(() => { syncQueued = false; sync(document); });
  }).observe(document.body, { childList: true, subtree: true });

  async function toggleFollow(kind, key, name, city) {
    if (!A.me) { store.set('rm_pending', { t: 'follow', kind, key, name, city, at: Date.now() }); return open('signin', 'Sign in to follow ' + name + '. You\'ll get alerts when they have new shows.'); }
    const k = fk(kind, key), had = A.follows.get(k);
    if (had) A.follows.delete(k); else A.follows.set(k, { kind, key, label: name, city: city || null, at: Date.now() });
    sync(document);
    try {
      const r = await api('POST', '/follows', { kind: had ? had.kind : kind, key, label: had ? had.label : name, city: city || null, on: !had });
      if (r.follow) { A.follows.delete(k); A.follows.set(fk(r.follow.kind, r.follow.key), r.follow); }
      track(had ? 'unfollow' : 'follow', { kind });
      if (!had) flash('Following ' + name + '. New shows will show up in your alerts.');
    } catch (err) {
      if (had) A.follows.set(k, had); else A.follows.delete(k);
      flash(err.status === 401 ? 'You were signed out. Sign in again to follow.' : 'Couldn\'t update that. Try again in a moment.');
      if (err.status === 401) setMe(null);
    }
    sync(document);
    if (dlg().open) render();
  }

  async function toggleSave(id) {
    const a = app(), e = a && a.event(id);
    if (!A.me) { store.set('rm_pending', { t: 'save', id, at: Date.now() }); return open('signin', 'Sign in to save shows. You\'ll get a reminder the day before, and an alert if a show sells out or is cancelled.'); }
    const had = A.saves.get(id);
    if (!had && !e) return;
    const snap = had || { id, title: e.title, start: new Date(e.start).toISOString(), city: e.cityId, venue: a.venueName(e), url: e.url || null };
    if (had) A.saves.delete(id); else A.saves.set(id, snap);
    sync(document);
    try {
      await api('POST', '/saves', { event: snap, on: !had });
      track(had ? 'unsave_event' : 'save_event', {});
      if (!had) flash('Saved. You\'ll get a reminder the day before.');
    } catch (err) {
      if (had) A.saves.set(id, had); else A.saves.delete(id);
      flash(err.status === 401 ? 'You were signed out. Sign in again to save shows.' : 'Couldn\'t update that. Try again in a moment.');
      if (err.status === 401) setMe(null);
    }
    sync(document);
    if (dlg().open) render();
  }

  // After signing in (often in a new tab from the email), finish what they were doing.
  async function pending() {
    const p = store.get('rm_pending');
    store.set('rm_pending', null);
    if (!p || !A.me || Date.now() - (p.at || 0) > 3600e3) return;
    if (p.t === 'follow' && !following(p.kind, p.key)) await toggleFollow(p.kind, p.key, p.name, p.city);
    if (p.t === 'save' && !A.saves.has(p.id)) await toggleSave(p.id);
  }

  document.addEventListener('click', ev => {
    const f = ev.target.closest('[data-follow]');
    if (f) { ev.preventDefault(); ev.stopPropagation(); toggleFollow(f.dataset.follow, f.dataset.key, f.dataset.name, f.dataset.city || null); return; }
    const s = ev.target.closest('[data-save]');
    if (s) { ev.preventDefault(); ev.stopPropagation(); toggleSave(s.dataset.save); return; }
    if (ev.target.closest('#acct-btn')) { open(A.me ? (A.unread ? 'alerts' : A.view || 'alerts') : 'signin'); return; }
    if (ev.target.closest('#bell-btn')) { open('alerts'); return; }
  }, true);

  /* ---------- the account dialog ---------- */
  const dlg = () => $('#account') || { open: false, close() {}, showModal() {}, setAttribute() {} };
  let flashTimer = 0;
  function flash(msg) {
    const el = $('#maptoast');
    if (dlg().open) { A.flash = msg; const f = $('#acct-flash'); if (f) { f.textContent = msg; f.hidden = !msg; } return; }
    if (!el) return;
    el.textContent = msg; el.hidden = !msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }
  function open(view, reason) {
    A.view = view || 'alerts'; A.reason = reason || ''; A.flash = '';
    if (!A.me && A.view !== 'sent') A.view = 'signin';
    const d = dlg();
    render();
    if (!d.open) { try { d.showModal(); } catch (err) { d.setAttribute('open', ''); } }
    if (A.view === 'signin') { const i = $('#acct-email'); if (i) i.focus(); }
  }

  const TABS = [['alerts', 'Alerts'], ['shows', 'Your shows'], ['following', 'Following'], ['settings', 'Settings']];
  function render() {
    const body = $('#acct-body');
    if (!body) return;
    if (!A.me) { body.innerHTML = A.view === 'sent' ? sentView() : signinView(); if (A.view === 'signin') mountTurnstile(); return; }
    const v = TABS.some(t => t[0] === A.view) ? A.view : 'alerts';
    A.view = v;
    body.innerHTML = '<h2 id="acct-title">Your account</h2><p class="acct-sub">' + esc(A.me.email) + '</p>' +
      (A.note ? '<p class="acct-note">' + A.note + '</p>' : '') +
      '<div class="acct-tabs" role="tablist" aria-label="Account">' + TABS.map(t => '<button type="button" role="tab" data-acct-tab="' + t[0] + '" aria-selected="' + (t[0] === v) + '">' + t[1] +
        (t[0] === 'alerts' && A.unread ? ' <span class="badge">' + A.unread + '</span>' : '') + '</button>').join('') + '</div>' +
      '<p class="acct-flash" id="acct-flash" role="status"' + (A.flash ? '' : ' hidden') + '>' + esc(A.flash) + '</p>' +
      '<div class="acct-pane" role="tabpanel">' + ({ alerts: alertsView, shows: showsView, following: followingView, settings: settingsView }[v])() + '</div>';
    if (v === 'alerts') loadAlerts();
  }

  function signinView() {
    return '<h2 id="acct-title">Sign in to Rave Monitor</h2>' +
      '<p>' + esc(A.reason || 'Follow artists, venues and promoters, save shows, and get alerts on the site and by email when there\'s something new.') + '</p>' +
      '<form id="acct-signin" class="acct-form" novalidate><label for="acct-email">Email</label>' +
      '<input id="acct-email" name="email" type="email" autocomplete="email" inputmode="email" required placeholder="you@example.com" value="' + esc(A.sentTo) + '">' +
      (CFG.turnstile ? '<div id="acct-ts" class="acct-ts"></div>' : '') +
      '<button class="btn primary" type="submit">Email me a sign-in link</button>' +
      '<p class="acct-err" id="acct-err" role="alert" hidden></p></form>' +
      '<p class="fine">No password: each time, we email you a link that signs you in. We use your email only for sign-in links and the alerts you choose. You can delete your account at any time.</p>';
  }
  function sentView() {
    return '<h2 id="acct-title">Check your email</h2>' +
      '<p>We sent a sign-in link to <b>' + esc(A.sentTo) + '</b>. It works once, for the next 15 minutes. Open it on this device to sign in here.</p>' +
      (A.devLink ? '<p class="fine">Local testing: <a href="' + esc(A.devLink) + '" id="acct-devlink">open the sign-in link</a>.</p>' : '') +
      '<p class="fine">Nothing there? Check your spam folder, or <button type="button" class="linkish" data-acct-act="again">send it to a different address</button>.</p>';
  }

  // Cloudflare Turnstile, the same check the contact form uses. Loaded when the form opens.
  let tsLoading = null;
  function mountTurnstile() {
    const box = $('#acct-ts');
    if (!box || !CFG.turnstile) return;
    A.ts = null;
    const draw = () => { if (!window.turnstile || !document.contains(box)) return; box.innerHTML = ''; window.turnstile.render(box, { sitekey: CFG.turnstile, theme: 'dark', size: 'flexible', callback: t => { A.ts = t; }, 'expired-callback': () => { A.ts = null; }, 'error-callback': () => { A.ts = null; } }); };
    if (window.turnstile) return draw();
    if (!tsLoading) tsLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    tsLoading.then(draw, () => { tsLoading = null; });
  }

  const ERR = {
    invalid_email: 'That doesn\'t look like an email address.', challenge: 'Please wait for the security check to finish, then try again.',
    rate_limited: 'Too many tries. Wait a minute, then try again.', too_many_links: 'We\'ve sent a few links already. Use the latest one, or try again in an hour.',
    not_configured: 'Sign-in isn\'t switched on yet. Try again later.', send_failed: 'We couldn\'t send the email. Try again in a moment.'
  };
  async function submitSignin(form) {
    const email = form.email.value.trim(), err = $('#acct-err'), btn = $('button[type=submit]', form);
    err.hidden = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = ERR.invalid_email; err.hidden = false; return; }
    if (CFG.turnstile && !A.ts) { err.textContent = ERR.challenge; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await api('POST', '/auth/start', { email, turnstile: A.ts || '' });
      A.sentTo = email; A.devLink = r.devLink || ''; A.view = 'sent';
      track('sign_in_start', {});
      render();
      watchForSignIn();
    } catch (e) {
      err.textContent = ERR[e.message] || 'Something went wrong. Try again in a moment.'; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Email me a sign-in link';
      if (window.turnstile && CFG.turnstile) { try { window.turnstile.reset($('#acct-ts')); } catch (x) { /* re-rendered */ } A.ts = null; }
    }
  }
  // If they open the link in another tab, this one notices the sign-in too.
  let watching = 0;
  function watchForSignIn() {
    clearInterval(watching);
    const until = Date.now() + 15 * 60e3;
    watching = setInterval(async () => {
      if (A.me || Date.now() > until) { clearInterval(watching); return; }
      if (document.hidden) return;
      try { const p = await api('GET', '/me'); if (!p.user) return; clearInterval(watching); setMe(p); A.view = 'alerts'; render(); flash('You\'re signed in.'); } catch (err) { /* not yet */ }
    }, 4000);
  }

  async function verify(token) {
    try {
      const p = await api('POST', '/auth/verify', { token, tz: tz() });
      setMe(p);
      track('sign_in', { new_account: !!p.isNew });
      const went = await pending();
      if (went) return;
      if (p.isNew) { A.note = 'Welcome! Pick your cities and genres, and choose how often to get email. You can follow artists, venues and promoters from their cards, and save shows from their details.'; open('settings'); }
      else flash('You\'re signed in.');
    } catch (err) {
      await loadMe();
      if (!A.me) open('signin', err.message === 'link_expired' || err.message === 'link_invalid' ? 'That sign-in link has expired or was already used. Enter your email for a new one.' : 'We couldn\'t sign you in just now. Try again in a moment.');
    }
  }
  async function loadMe() {
    try { setMe(await api('GET', '/me')); } catch (err) { setMe(null); }
  }
  // Colors follow the account: the theme it has saved (a preset, or your own colors) shows on every
  // device you sign in on. An account with none saved yet takes this browser's pick.
  function themeSync() {
    const t = app() && app().theme, me = A.me;
    if (!t || !me) return;
    const cur = t.current(), own = t.own(), mine = me.customTheme;
    if (me.theme === 'custom' && mine) {
      if (cur !== 'custom' || !own || own.bg !== mine.bg || own.accent !== mine.accent) t.custom(mine.bg, mine.accent, true);
    } else if (me.theme && me.theme !== 'custom') {
      if (cur !== me.theme && t.has(me.theme)) t.set(me.theme);
    } else if (!me.theme) {
      let picked = null;
      try { picked = localStorage.getItem('rm_theme'); } catch (err) { picked = null; }
      if (picked === 'custom' && own) patch({ local: { theme: 'custom', customTheme: own }, send: { theme: 'custom', customTheme: own }, quiet: true });
      else if (picked && t.has(picked)) patch({ local: { theme: picked }, send: { theme: picked }, quiet: true });
      // Saved by an earlier version: own colors without a theme.
      else if (mine) { t.custom(mine.bg, mine.accent, true); patch({ local: { theme: 'custom' }, send: { theme: 'custom' }, quiet: true }); }
    }
  }
  // From the colors picker: every pick is saved to the account too, when signed in.
  document.addEventListener('rm:theme', ev => { if (A.me && ev.detail && ev.detail.id) patch({ local: { theme: ev.detail.id }, send: { theme: ev.detail.id }, quiet: true }); });
  document.addEventListener('rm:custom-colors', ev => { if (A.me) patch({ local: { theme: 'custom', customTheme: ev.detail }, send: { theme: 'custom', customTheme: ev.detail }, quiet: true }); });

  /* ---------- alerts ---------- */
  const KIND = { new_show: 'New show', reminder: 'Reminder', soldout: 'Sold out', cancelled: 'Cancelled', postponed: 'Postponed', picks: 'Picks', scene: 'Scene' };
  const ago = t => { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); return s < 3600 ? Math.max(1, Math.round(s / 60)) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  function when(iso, tzName) { const a = app(), t = Date.parse(iso); return a && Number.isFinite(t) ? a.when(t, tzName) : ''; }
  function evLine(d) { return [when(d.start, d.tz), [d.venue, d.cityName].filter(Boolean).join(', ')].filter(Boolean).join(' · '); }
  function alertsView() {
    if (!A.items) return '<p class="acct-empty">Loading your alerts…</p>';
    if (!A.items.length) return '<p class="acct-empty">No alerts yet. Follow artists, venues and promoters, or save shows, and alerts show up here: new shows, reminders, sell-outs and your weekly picks.</p>';
    return '<ul class="acct-list">' + A.items.map(n => {
      const d = n.data || {};
      if (n.kind === 'picks' || n.kind === 'scene') return '<li class="acct-alert' + (n.read ? '' : ' new') + '"><div class="aa-k">' + KIND[n.kind] + ' · ' + ago(n.at) + '</div><b>' + esc(n.title) + '</b><p>' + esc(n.body) + '</p><ul class="acct-picks">' +
        (d.events || []).map(e => '<li><button type="button" class="linkish" data-acct-ev="' + esc(e.id) + '" data-acct-url="' + esc(e.url || '') + '">' + esc(e.title) + '</button><span>' + esc(evLine(e)) + '</span></li>').join('') + '</ul></li>';
      return '<li class="acct-alert' + (n.read ? '' : ' new') + '"><div class="aa-k">' + (KIND[n.kind] || 'Alert') + ' · ' + ago(n.at) + '</div>' +
        '<button type="button" class="linkish aa-t" data-acct-ev="' + esc(d.id || n.ref) + '" data-acct-url="' + esc(d.url || '') + '">' + esc(d.title || n.title) + '</button>' +
        '<p>' + esc(evLine(d)) + '</p>' + (n.body ? '<p class="aa-why">' + esc(n.body) + '</p>' : '') + '</li>';
    }).join('') + '</ul>';
  }
  let alertsBusy = false;
  async function loadAlerts() {
    if (alertsBusy) return;
    alertsBusy = true;
    try {
      const r = await api('GET', '/notifications?limit=50');
      A.items = r.items; A.unread = r.unread;
      if (dlg().open && A.view === 'alerts') { const pane = $('.acct-pane'); if (pane) pane.innerHTML = alertsView(); }
      // Seen now: the badge clears, the new ones stay marked until the list is drawn again.
      if (r.unread) { const m = await api('POST', '/notifications/read', { all: true }); A.unread = m.unread; header(); const b = $('[data-acct-tab="alerts"] .badge'); if (b) b.remove(); }
      track('open_alerts', {});
    } catch (err) {
      if (err.status === 401) setMe(null);
      else if (A.items == null) { A.items = []; const pane = $('.acct-pane'); if (pane && A.view === 'alerts') pane.innerHTML = '<p class="acct-empty">Alerts couldn\'t load. Try again in a moment.</p>'; }
    }
    alertsBusy = false;
  }

  /* ---------- your shows: upcoming nights from who you follow, and the ones you saved ---------- */
  function yourShows() {
    const a = app();
    if (!a) return [];
    const now = Date.now(), mine = A.me.mine && A.me.cities.length ? new Set(A.me.cities) : null, out = [];
    for (const e of a.events()) {
      if (e.end < now) continue;
      const why = [];
      let place = false;
      if (A.saves.has(e.id)) { why.push('Saved'); place = true; }
      const v = a.venueOf(e);
      if (v && following('venue', v.id)) { why.push(v.name); place = true; }
      for (const n of a.artistNames(e)) if (following('artist', a.akey(n))) why.push(n);
      for (const n of (e.promoters || []).concat(e.labels || [])) if (following('promoter', a.lkey(n))) why.push(n);
      if (!why.length || (mine && !place && !mine.has(e.cityId))) continue;
      out.push({ e, why: Array.from(new Set(why)) });
    }
    return out.slice(0, 100);
  }
  // The calendar feed: saved shows and new shows from who you follow, in Google, Apple or Outlook Calendar.
  function calendarBox() {
    if (!A.calendar) return '<div class="acct-cal"><p class="fine">Put these in your calendar: your saved shows and new shows from who you follow, kept up to date in Google, Apple or Outlook Calendar.</p>' +
      '<div class="acct-row"><button type="button" class="btn" data-acct-act="cal">Get your calendar address</button></div></div>';
    const webcal = A.calendar.replace(/^https:/, 'webcal:');
    return '<div class="acct-cal"><label for="acct-cal-url">Your calendar address</label><input id="acct-cal-url" type="text" readonly value="' + esc(A.calendar) + '">' +
      '<div class="acct-row"><button type="button" class="btn" data-acct-act="cal-copy">Copy</button>' +
      '<a class="btn" href="https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal) + '" target="_blank" rel="noopener">Google Calendar</a>' +
      '<a class="btn" href="' + esc(webcal) + '">Apple Calendar</a></div>' +
      '<p class="fine">In Outlook, add a calendar "from the internet" and paste the address. Anyone with it can see the shows, so keep it to yourself. <button type="button" class="linkish" data-acct-act="cal-reset">Make a new address</button> if it gets out.</p></div>';
  }
  function showsView() {
    const a = app(), list = yourShows();
    const past = Array.from(A.saves.values()).filter(s => !(a && a.event(s.id)));
    if (!list.length && !past.length) return '<p class="acct-empty">Nothing here yet. Follow artists, venues and promoters from their cards, or save shows from their details, and their upcoming nights collect here.</p>' + calendarBox();
    return calendarBox() + (list.length ? '<ul class="acct-list">' + list.map(x => '<li><button type="button" class="linkish aa-t" data-acct-ev="' + esc(x.e.id) + '">' + esc(x.e.title) + '</button>' +
      '<p>' + esc(a.when(x.e.start, (a.city(x.e.cityId) || {}).tz) + ' · ' + a.venueName(x.e) + ', ' + (a.city(x.e.cityId) || {}).name) + '</p><p class="aa-why">' + esc(x.why.join(' · ')) + '</p></li>').join('') + '</ul>' : '') +
      (past.length ? '<h3>Saved shows no longer listed</h3><ul class="acct-list">' + past.map(s => '<li><b>' + esc(s.title) + '</b><p>' + esc([s.venue, s.start ? new Date(s.start).toLocaleDateString() : ''].filter(Boolean).join(' · ')) + '</p>' +
        '<div class="acct-row">' + (s.url ? '<a class="btn" href="' + esc(s.url) + '" target="_blank" rel="noopener">Listing</a>' : '') + '<button class="btn" type="button" data-save="' + esc(s.id) + '"><span>Saved</span></button></div></li>').join('') + '</ul>' : '');
  }

  /* ---------- following ---------- */
  function followingView() {
    const groups = [['artist', 'Artists'], ['venue', 'Venues'], ['promoter', 'Promoters & groups'], ['label', 'Record labels']];
    const all = Array.from(A.follows.values());
    if (!all.length && !A.saves.size) return '<p class="acct-empty">You\'re not following anyone yet. Use Follow on an artist\'s dates, a venue\'s card or a promoter\'s card, or the star beside a name in a show\'s lineup.</p>';
    const a = app();
    return groups.map(([k, title]) => {
      const fs = all.filter(f => f.kind === k).sort((x, y) => x.label.localeCompare(y.label));
      if (!fs.length) return '';
      return '<h3>' + title + '</h3><ul class="acct-chips">' + fs.map(f => '<li><span>' + esc(f.label) + (f.city && a ? ' <small>' + esc(a.cityName(f.city)) + '</small>' : '') + '</span>' +
        '<button type="button" class="fbtn" data-follow="' + esc(f.kind) + '" data-key="' + esc(f.key) + '" data-name="' + esc(f.label) + '" aria-pressed="true">Following</button></li>').join('') + '</ul>';
    }).join('') +
      (A.saves.size ? '<h3>Saved shows</h3><ul class="acct-chips">' + Array.from(A.saves.values()).sort((x, y) => String(x.start).localeCompare(String(y.start))).map(s => '<li><span>' + esc(s.title) + (s.start ? ' <small>' + esc(new Date(s.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })) + '</small>' : '') + '</span>' +
        '<button type="button" class="btn sbtn" data-save="' + esc(s.id) + '" aria-pressed="true"><span>Saved</span></button></li>').join('') + '</ul>' : '');
  }

  /* ---------- settings ---------- */
  function settingsView() {
    const a = app(), me = A.me;
    const cities = a ? a.cities().slice().sort((x, y) => x.name.localeCompare(y.name)) : [];
    const cname = id => (cities.find(c => c.id === id) || { name: id }).name;
    const genres = a ? a.genres() : [];
    const freq = [['instant', 'Instant alerts'], ['daily', 'Daily digest, mornings'], ['weekly', 'Weekly digest, Thursday mornings'], ['off', 'No emails']];
    const chk = (name, on, label, hint) => '<label class="acct-chk"><input type="checkbox" data-acct-pref="' + name + '"' + (on ? ' checked' : '') + '><span>' + label + (hint ? '<small>' + hint + '</small>' : '') + '</span></label>';
    return '<form class="acct-form acct-settings" id="acct-settings" onsubmit="return false">' +
      '<h3>Your cities</h3><p class="fine">For your weekly picks, and to keep new-show alerts close to home.</p>' +
      '<ul class="acct-chips">' + me.cities.map(id => '<li><span>' + esc(cname(id)) + '</span><button type="button" class="btn" data-acct-city-del="' + esc(id) + '" aria-label="Remove ' + esc(cname(id)) + '">Remove</button></li>').join('') + '</ul>' +
      (me.cities.length < 12 ? '<label class="sr-only" for="acct-city-add">Add a city</label><select id="acct-city-add"><option value="">Add a city…</option>' + cities.filter(c => !me.cities.includes(c.id)).map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('') + '</select>' : '') +
      '<h3>Genres you like</h3><p class="fine">Your picks come from these. None picked means all of them.</p><div class="acct-genres">' +
      genres.map(g => '<button type="button" class="gchip" data-acct-genre="' + esc(g.id) + '" aria-pressed="' + me.genres.includes(g.id) + '" style="--c:' + esc(g.color) + '"><i class="gdot" style="--c:' + esc(g.color) + '"></i>' + esc(g.name) + '</button>').join('') + '</div>' +
      '<h3>Alerts</h3>' +
      chk('follows', me.alerts.follows, 'New shows from who you follow') +
      chk('mine', me.mine, 'Only new shows in your cities', me.cities.length ? '' : 'Pick a city above for this to apply. Venues you follow always count.') +
      chk('saved', me.alerts.saved, 'Reminders and changes for shows you saved', 'The day before, and if a show sells out, is cancelled or is postponed.') +
      chk('picks', me.alerts.picks, 'Weekly picks in your cities') +
      chk('scene', me.scene, 'Scene alerts', 'Every new night in your cities' + (me.genres.length ? ' and genres' : '') + ', as soon as it\'s listed.' + (me.cities.length ? '' : ' Pick a city above for this to work.')) +
      '<h3>Email</h3><p class="fine">Alerts always show here when you\'re signed in. Changes and reminders for saved shows always come as instant alerts, unless you turn emails off.</p>' +
      '<div class="acct-radios" role="radiogroup" aria-label="How often to email you">' + freq.map(f =>
        '<label class="acct-chk"><input type="radio" name="acct-freq" value="' + f[0] + '"' + (me.freq === f[0] ? ' checked' : '') + '><span>' + f[1] + (f[0] === 'instant' ? '<small>New shows emailed the moment we spot them.</small>' : '') + '</span></label>').join('') + '</div>' +
      '<p class="fine">Digests go out in your time zone (' + esc(me.tz) + ')' + (me.tz !== tz() ? '. <button type="button" class="linkish" data-acct-act="tz">Use this device\'s, ' + esc(tz()) + '</button>' : '') + '.</p>' +
      '<h3>Your account</h3><div class="acct-row">' +
      '<button type="button" class="btn" data-acct-act="signout">Sign out</button>' +
      '<button type="button" class="btn danger" data-acct-act="delete">Delete your account</button></div>' +
      '<div class="acct-confirm" id="acct-confirm" hidden><p>Delete your account, your follows, saved shows and alerts? This can\'t be undone.</p><div class="acct-row"><button type="button" class="btn danger" data-acct-act="delete-yes">Delete everything</button><button type="button" class="btn" data-acct-act="delete-no">Keep my account</button></div></div>' +
      '</form>';
  }
  let saveTimer = 0, patchQueue = {}, patchLoud = false;
  function patch(change) {
    Object.assign(A.me, change.local || {});
    Object.assign(patchQueue, change.send);
    // Settings say "Saved."; a color pick saves quietly.
    if (!change.quiet) patchLoud = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const body = patchQueue, loud = patchLoud; patchQueue = {}; patchLoud = false;
      try { const r = await api('PATCH', '/me', body); A.me = r.user; share(); if (loud) flash('Saved.'); }
      catch (err) {
        flash(err.status === 401 ? 'You were signed out.' : 'Couldn\'t save that. Try again in a moment.');
        if (err.status === 401) setMe(null); else loadMe();
      }
    }, 350);
  }

  document.addEventListener('click', async ev => {
    if (!ev.target.closest('#account')) return;
    const t = ev.target;
    const tab = t.closest('[data-acct-tab]');
    if (tab) { A.view = tab.dataset.acctTab; A.flash = ''; A.note = ''; render(); const b = $('[data-acct-tab="' + A.view + '"]'); if (b) b.focus(); return; }
    const evb = t.closest('[data-acct-ev]');
    if (evb) {
      const a = app();
      if (a && a.openEvent(evb.dataset.acctEv)) dlg().close();
      else if (evb.dataset.acctUrl) window.open(evb.dataset.acctUrl, '_blank', 'noopener');
      else flash('That show isn\'t listed any more.');
      return;
    }
    const del = t.closest('[data-acct-city-del]');
    if (del) { const cities = A.me.cities.filter(c => c !== del.dataset.acctCityDel); patch({ local: { cities }, send: { cities } }); render(); return; }
    const g = t.closest('[data-acct-genre]');
    if (g) { const id = g.dataset.acctGenre, genres = A.me.genres.includes(id) ? A.me.genres.filter(x => x !== id) : A.me.genres.concat(id); patch({ local: { genres }, send: { genres } }); g.setAttribute('aria-pressed', String(genres.includes(id))); return; }
    const act = t.closest('[data-acct-act]');
    if (!act) return;
    const a = act.dataset.acctAct;
    if (a === 'again') { A.view = 'signin'; render(); return; }
    if (a === 'tz') { patch({ local: { tz: tz() }, send: { tz: tz() } }); render(); return; }
    if (a === 'signout') { try { await api('POST', '/auth/signout', {}); } catch (err) { /* signed out anyway */ } setMe(null); dlg().close(); flash('You\'re signed out.'); track('sign_out', {}); return; }
    if (a === 'cal' || a === 'cal-reset') {
      try { const r = await api('POST', '/me/calendar', a === 'cal-reset' ? { reset: true } : {}); A.calendar = r.url; render(); flash(a === 'cal-reset' ? 'New address made. Update it in your calendar app; the old one has stopped working.' : 'Here\'s your calendar address.'); track('calendar_link', {}); }
      catch (err) { flash('Couldn\'t get the address just now. Try again in a moment.'); }
      return;
    }
    if (a === 'cal-copy') {
      const i = $('#acct-cal-url');
      try { await navigator.clipboard.writeText(A.calendar); flash('Copied.'); } catch (err) { if (i) { i.focus(); i.select(); } flash('Select the address and copy it.'); }
      return;
    }
    if (a === 'delete') { $('#acct-confirm').hidden = false; $('[data-acct-act="delete-no"]').focus(); return; }
    if (a === 'delete-no') { $('#acct-confirm').hidden = true; return; }
    if (a === 'delete-yes') {
      try { await api('DELETE', '/me', { confirm: 'delete' }); setMe(null); dlg().close(); flash('Your account and everything in it are deleted.'); track('delete_account', {}); }
      catch (err) { flash('Couldn\'t delete your account. Try again in a moment.'); }
    }
  });
  document.addEventListener('change', ev => {
    if (!ev.target.closest('#account')) return;
    const t = ev.target;
    if (t.id === 'acct-city-add' && t.value) { const cities = A.me.cities.concat(t.value).slice(0, 12); patch({ local: { cities }, send: { cities } }); render(); const s = $('#acct-city-add'); if (s) s.focus(); return; }
    if (t.name === 'acct-freq') { patch({ local: { freq: t.value }, send: { freq: t.value } }); return; }
    const p = t.dataset.acctPref;
    if (p === 'mine') { patch({ local: { mine: t.checked }, send: { mine: t.checked } }); return; }
    if (p === 'scene') { patch({ local: { scene: t.checked }, send: { scene: t.checked } }); return; }
    if (p) { const alerts = Object.assign({}, A.me.alerts, { [p]: t.checked }); patch({ local: { alerts }, send: { alerts } }); }
  });
  document.addEventListener('submit', ev => {
    if (ev.target.id === 'acct-signin') { ev.preventDefault(); submitSignin(ev.target); }
  });

  /* ---------- start ---------- */
  async function start() {
    header();
    const p = new URLSearchParams(location.search);
    const token = p.get('signin'), want = p.get('account');
    // Left over from the supporter tier: links that still carry these, and the preview switch.
    strip('signin'); strip('account'); strip('checkout'); strip('preview');
    store.set('rm_supporter_preview', null);
    if (token) await verify(token); else await loadMe();
    if (A.me) await pending();
    if (want) open(['settings', 'shows'].includes(want) ? want : want === 'supporter' ? 'settings' : 'alerts');
    // The bell stays current while the page is open.
    setInterval(async () => {
      if (!A.me || document.hidden) return;
      try { const r = await api('GET', '/notifications?limit=1'); if (r.unread !== A.unread) { A.unread = r.unread; A.items = null; header(); } }
      catch (err) { if (err.status === 401) setMe(null); }
    }, 5 * 60e3);
  }
  // app.js says when the listings are in (RM_APP); the account loads either way.
  if (window.RM_APP) start();
  else {
    let started = false;
    const go = () => { if (!started) { started = true; start(); } };
    document.addEventListener('rm:ready', go, { once: true });
    setTimeout(go, 6000);
  }
  document.addEventListener('rm:ready', () => { if (A.me) { sync(document); themeSync(); } });
})();
