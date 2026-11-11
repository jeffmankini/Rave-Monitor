/* Donations, in the browser: the Donate button in the header (and any data-act="donate" link) opens the
 * pop-up (#donate), for a gift once or every month through Stripe. Everything on the site is free;
 * a gift unlocks nothing and isn't tied to an account.
 * When the Worker has a publishable key, Stripe's checkout opens inside the pop-up: Stripe.js loads
 * then, and only then, from js.stripe.com. Otherwise the pop-up sends people to Stripe's page, and
 * Stripe sends them back to ?donated=<session>, where the pop-up says thanks.
 * The API is the Worker at window.RM_DONATE.api (worker/api/src/donate.js). */
(function () {
  'use strict';
  const CFG = window.RM_DONATE || {};
  const dlg = document.getElementById('donate'), btn = document.getElementById('donate-btn');
  if (!dlg || !btn) return;
  if (!CFG.api) { btn.hidden = true; return; }
  const API = String(CFG.api).replace(/\/+$/, '');
  const $ = s => dlg.querySelector(s);
  const track = (n, p) => { const a = window.RM_APP; if (a && a.track) a.track(n, p); };
  // Stripe.js on the same release as the Worker's API version (worker/api/src/donate.js).
  const STRIPE_JS = 'https://js.stripe.com/endive/stripe.js';
  const AMOUNTS = { once: [1, 5, 10, 20], monthly: [1, 5, 10, 20] }, START = { once: 5, monthly: 5 };
  const ERR = {
    bad_amount: 'Pick an amount from $1 to $1,000.', rate_limited: 'Too many tries just now. Wait a minute, then try again.',
    not_configured: 'Donations aren\'t switched on yet. Please try again later.', origin: 'Donations only work on ravemonitor.com.'
  };
  let stripeP = null, stripeKey = '', stripe = null, checkout = null, busy = false, gift = null;

  const fmt = n => (Math.round(n * 100) % 100 ? n.toFixed(2) : String(Math.round(n)));
  const freq = () => { const r = $('input[name="don-freq"]:checked'); return r && r.value === 'monthly' ? 'monthly' : 'once'; };
  // The amount: what's typed in Other, or else the picked button. NaN when Other isn't a number.
  function amount() {
    const other = $('#don-other').value.trim().replace(/^\$\s*/, '').replace(/,/g, '');
    if (other) return /^\d{1,4}(\.\d{1,2})?$/.test(other) ? Number(other) : NaN;
    const r = $('input[name="don-amt"]:checked');
    return r ? Number(r.value) : NaN;
  }
  const valid = a => isFinite(a) && a >= 1 && a <= 1000;
  function label() {
    const a = amount(), m = freq() === 'monthly';
    $('#don-go').textContent = valid(a) ? 'Donate $' + fmt(a) + (m ? ' a month' : '') : 'Donate';
    $('#don-hint').textContent = m ? 'Charged each month until you cancel, which takes a couple of clicks.' : 'A single gift, charged once.';
  }
  function drawAmounts() {
    const f = freq();
    $('#don-amts').innerHTML = AMOUNTS[f].map(v => '<label class="don-chip"><input class="sr-only" type="radio" name="don-amt" value="' + v + '"' + (v === START[f] ? ' checked' : '') + '><span>$' + v + '</span></label>').join('');
    label();
  }
  function error(msg, field) {
    const e = $('#don-err'), o = $('#don-other');
    e.textContent = msg || '';
    if (field) { o.setAttribute('aria-invalid', 'true'); o.focus(); } else o.removeAttribute('aria-invalid');
  }
  function view(name) {
    ['pick', 'pay', 'done'].forEach(v => { $('#don-' + v).hidden = v !== name; });
    dlg.classList.toggle('paying', name === 'pay');
  }
  function destroy() {
    if (!checkout) return;
    try { checkout.destroy(); } catch (err) { /* already gone */ }
    checkout = null;
    $('#don-checkout').replaceChildren();
  }

  function open() {
    // One pop-up at a time: About, What's new and the account close first.
    document.querySelectorAll('dialog[open]').forEach(d => { if (d !== dlg) d.close(); });
    if (!checkout && $('#don-done').hidden) view('pick');
    if (!dlg.open) { try { dlg.showModal(); } catch (err) { dlg.setAttribute('open', ''); } }
    track('donate_open', {});
  }
  dlg.addEventListener('close', () => {
    // Closing mid-payment lets the unpaid checkout go; the next one starts fresh.
    destroy();
    if (!$('#don-done').hidden) { view('pick'); error(''); }
  });

  // The site's own panel and accent colors, so Stripe's checkout looks like part of the pop-up.
  function colors() {
    const cs = getComputedStyle(document.documentElement), hex = v => /^#[0-9a-f]{6}$/i.test(v) ? v : null;
    const bg = hex(cs.getPropertyValue('--deck').trim()), accent = hex(cs.getPropertyValue('--now').trim());
    return bg && accent ? { bg, accent } : undefined;
  }
  async function post(body) {
    const r = await fetch(API + '/donate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch (err) { j = null; }
    if (!r.ok || !j || !j.ok) { const e = new Error((j && j.error) || 'http_' + r.status); e.status = r.status; throw e; }
    return j;
  }
  function loadStripe() {
    if (window.Stripe) return Promise.resolve(window.Stripe);
    if (!stripeP) {
      stripeP = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = STRIPE_JS; s.async = true;
        s.onload = () => (window.Stripe ? res(window.Stripe) : rej(new Error('no_stripe')));
        s.onerror = () => rej(new Error('no_stripe'));
        document.head.appendChild(s);
      });
      stripeP.catch(() => { stripeP = null; });
    }
    return stripeP;
  }

  async function submit(ev) {
    ev.preventDefault();
    const a = amount();
    if (!valid(a)) { error(ERR.bad_amount, !!$('#don-other').value.trim()); return; }
    error('');
    if (busy) return;
    busy = true;
    const go = $('#don-go');
    go.disabled = true; go.textContent = 'Opening checkout…';
    gift = { monthly: freq() === 'monthly', amount: a };
    const params = { gift: gift.monthly ? 'monthly' : 'once', value: a, currency: 'USD' };
    try {
      const r = await post({ amount: a, monthly: gift.monthly, colors: colors() });
      if (r.clientSecret) {
        try { await mount(r); track('donate_start', Object.assign({ where: 'popup' }, params)); }
        catch (err) {
          // Stripe.js blocked (an extension, a network): Stripe's own page instead.
          const h = await post({ amount: a, monthly: gift.monthly, colors: colors(), ui: 'hosted' });
          track('donate_start', Object.assign({ where: 'stripe' }, params));
          location.href = h.url;
          return;
        }
      } else if (r.url) {
        track('donate_start', Object.assign({ where: 'stripe' }, params));
        location.href = r.url;
        return;
      }
    } catch (err) {
      error(ERR[err.message] || 'Stripe didn\'t answer just now. Please try again in a moment.');
    } finally {
      busy = false; go.disabled = false; label();
    }
  }
  async function mount(r) {
    const S = await loadStripe();
    if (!stripe || stripeKey !== r.publishableKey) { stripe = S(r.publishableKey); stripeKey = r.publishableKey; }
    destroy();
    const make = stripe.createEmbeddedCheckoutPage || stripe.initEmbeddedCheckout;
    checkout = await make.call(stripe, { fetchClientSecret: () => Promise.resolve(r.clientSecret), onComplete: () => thanks({ status: 'complete', paid: true, monthly: gift.monthly, amount: Math.round(gift.amount * 100) }) });
    $('#don-sum').textContent = '$' + fmt(gift.amount) + (gift.monthly ? ' a month' : '');
    view('pay');
    checkout.mount('#don-checkout');
    $('#don-back').focus();
  }

  function thanks(s) {
    destroy();
    const amt = s.amount ? '$' + fmt(s.amount / 100) : '';
    $('#don-done-msg').textContent = s.paid
      ? (s.monthly ? 'Your ' + (amt ? amt + ' a month' : 'monthly gift') + ' keeps Rave Monitor free for everyone. You can change or cancel it any time from this pop-up.' : 'Your ' + (amt ? amt + ' ' : '') + 'gift keeps Rave Monitor free for everyone.')
      : 'Your payment is on its way through. Thank you for keeping Rave Monitor free for everyone.';
    view('done');
    track('donate_done', { gift: s.monthly ? 'monthly' : 'once', value: s.amount ? s.amount / 100 : 0, currency: 'USD' });
    if (!dlg.open) open();
    const c = $('#don-close'); if (c) c.focus();
  }

  // Back from Stripe's page, or from a bank: how did it go?
  async function returned(id) {
    try {
      const r = await fetch(API + '/donate/session?id=' + encodeURIComponent(id));
      const s = await r.json();
      if (s && s.ok && s.status === 'complete') return thanks(s);
      open();
      error(s && s.ok && s.status === 'open' ? 'That payment didn\'t go through, and nothing was charged. You can try again.' : '');
    } catch (err) { open(); }
  }
  function strip(param) {
    const u = new URL(location.href);
    if (!u.searchParams.has(param)) return;
    u.searchParams.delete(param);
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  }

  $('#don-manage').href = API + '/donate/manage';
  drawAmounts();
  $('#don-form').addEventListener('submit', submit);
  $('#don-form').addEventListener('change', ev => {
    if (ev.target.name === 'don-freq') { $('#don-other').value = ''; error(''); drawAmounts(); }
    else if (ev.target.name === 'don-amt') { $('#don-other').value = ''; error(''); label(); }
  });
  $('#don-other').addEventListener('input', () => {
    // Typing an amount of your own takes over from the buttons.
    if ($('#don-other').value.trim()) $$('input[name="don-amt"]').forEach(r => { r.checked = false; });
    error(''); label();
  });
  $('#don-back').addEventListener('click', () => { destroy(); view('pick'); $('#don-go').focus(); });
  $('#don-close').addEventListener('click', () => dlg.close());
  document.addEventListener('click', ev => {
    const t = ev.target.closest && ev.target.closest('#donate-btn, [data-act="donate"]');
    if (t) { ev.preventDefault(); open(); }
  });
  btn.hidden = false;

  const p = new URLSearchParams(location.search), back = p.get('donated');
  if (back) { strip('donated'); if (/^cs_(live|test)_[A-Za-z0-9]{10,250}$/.test(back)) returned(back); }
  else if (p.has('donate')) { strip('donate'); open(); }
  function $$(s) { return Array.from(dlg.querySelectorAll(s)); }
})();
