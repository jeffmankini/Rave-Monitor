/* Rave Monitor's color math, shared by the page (supporters' own colors), the build (the preset
 * themes in config/themes.json, through scripts/themes.js) and the tests. Plain browser script:
 * it sets window.RM_THEMEKIT. */
(function (root) {
  'use strict';
  const HEX = /^#[0-9a-f]{6}$/i;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const hex = a => '#' + a.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  function lum(h) {
    const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  function toHsl(h) {
    const [r, g, b] = rgb(h).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l * 100];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [hh * 60, s * 100, l * 100];
  }
  function fromHsl(h, s, l) {
    s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return hex([f(0), f(8), f(4)].map(v => v * 255));
  }

  // The colors a theme sets itself; everything else is worked out from them.
  const CORE = ['void', 'deck', 'deck2', 'land', 'line', 'ink', 'ink2', 'ink3', 'now', 'nowInk', 'tint'];
  const GREEN = '#3c8c6e';
  /** A theme's full set of colors: the map's and the small extras from its core ones, unless given. */
  function complete(core, extra) {
    const c = {};
    for (const k of CORE) {
      if (!HEX.test(core[k] || '')) throw new Error(k + ' should be a #rrggbb color, not "' + core[k] + '"');
      c[k] = core[k].toLowerCase();
    }
    Object.assign(c, {
      sphere: mix(c.void, c.land, 0.2), shade: mix(c.void, '#000000', 0.7),
      green: mix(c.land, GREEN, 0.1), park: mix(c.land, GREEN, 0.12), building: mix(c.land, c.ink2, 0.1), runway: mix(c.land, c.ink2, 0.16),
      motorway: mix(c.ink2, c.ink, 0.3), waterLabel: mix(c.ink3, c.void, 0.3), streetLabel: mix(c.ink2, c.ink3, 0.5),
      venueLabel: mix(c.ink3, c.void, 0.15), ring: mix(c.ink3, c.ink2, 0.25), grip: mix(c.line, c.ink3, 0.35), dashed: mix(c.line, c.ink3, 0.5)
    });
    for (const [k, v] of Object.entries(extra || {})) {
      if (!(k in c)) throw new Error('unknown map color "' + k + '"');
      if (!HEX.test(v)) throw new Error('map.' + k + ' should be a #rrggbb color, not "' + v + '"');
      c[k] = v.toLowerCase();
    }
    return c;
  }

  /**
   * Supporters' own colors from two picks: a background and an accent. The background sets the hue
   * and stays dark, like every theme, so the map and the listing colors keep working; panels, lines
   * and text are stepped up from it. The accent is brightened until it reads on the panels, and the
   * text on accent buttons is whichever of dark or white reads better.
   */
  function custom(bg, accent) {
    if (!HEX.test(bg || '')) bg = '#070814';
    if (!HEX.test(accent || '')) accent = '#f6ecd8';
    const [h, s0, l0] = toHsl(bg), s = Math.min(s0, 62), v = clamp(l0, 3, 9), si = Math.min(s, 40);
    const core = {
      void: fromHsl(h, s, v), deck: fromHsl(h, s, v + 4), deck2: fromHsl(h, s * 0.95, v + 9), land: fromHsl(h, s * 0.9, v + 10), line: fromHsl(h, s * 0.8, v + 14),
      ink: fromHsl(h, si * 0.5, 93), ink2: fromHsl(h, si * 0.42, 75), ink3: fromHsl(h, si * 0.34, 59), tint: fromHsl(h, Math.min(s + 25, 70), 76),
      now: accent.toLowerCase(), nowInk: '#000000'
    };
    for (let i = 0; i < 12 && contrast(core.now, core.deck) < 4.5; i++) core.now = mix(core.now, '#ffffff', 0.18);
    const dark = fromHsl(h, s, 7);
    core.nowInk = contrast(dark, core.now) >= contrast('#ffffff', core.now) ? dark : '#ffffff';
    return complete(core);
  }

  // The CSS variables a theme sets, and the same colors as r,g,b for see-through versions.
  const VARS = { void: '--void', deck: '--deck', deck2: '--deck-2', land: '--land', line: '--line', ink: '--ink', ink2: '--ink-2', ink3: '--ink-3', now: '--now', nowInk: '--now-ink', tint: '--tint', grip: '--grip', dashed: '--dashed' };
  const RGB_VARS = { void: '--void-rgb', deck: '--deck-rgb', ink: '--ink-rgb', ink2: '--ink-2-rgb', now: '--now-rgb' };
  const css = c => Object.keys(VARS).map(k => VARS[k] + ':' + c[k] + ';').join('') + Object.keys(RGB_VARS).map(k => RGB_VARS[k] + ':' + rgb(c[k]).join(',') + ';').join('');

  root.RM_THEMEKIT = { HEX, CORE, rgb, hex, mix, lum, contrast, toHsl, fromHsl, complete, custom, css };
})(typeof window !== 'undefined' ? window : globalThis);
