// Color themes (config/themes.json) for scripts/build-site.js: the full set of colors for each,
// the CSS that applies them, and the small script that applies the visitor's choice before the page
// draws. test/themes.test.js checks the colors read well.

const HEX = /^#[0-9a-f]{6}$/i;
// The colors a theme must set, and the CSS variable each one becomes.
export const CORE = ['void', 'deck', 'deck2', 'land', 'line', 'ink', 'ink2', 'ink3', 'now', 'nowInk', 'tint'];
const VARS = { void: '--void', deck: '--deck', deck2: '--deck-2', land: '--land', line: '--line', ink: '--ink', ink2: '--ink-2', ink3: '--ink-3', now: '--now', nowInk: '--now-ink', tint: '--tint', grip: '--grip', dashed: '--dashed' };
// The same colors as r,g,b, for see-through versions in CSS: rgba(var(--ink-2-rgb), .12).
const RGB_VARS = { void: '--void-rgb', deck: '--deck-rgb', ink: '--ink-rgb', ink2: '--ink-2-rgb', now: '--now-rgb' };

export const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const hex = a => '#' + a.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
// WCAG contrast ratio between two colors.
export function contrast(a, b) {
  const lum = h => { const [r, g, bl] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A theme's colors, with the map's and the small extras worked out from the core ones unless set.
export function themeColors(t) {
  for (const k of CORE) if (!HEX.test(t[k] || '')) throw new Error(`theme "${t.id}": ${k} should be a #rrggbb color, not "${t[k]}"`);
  const c = {};
  for (const k of CORE) c[k] = t[k].toLowerCase();
  const green = '#3c8c6e';
  Object.assign(c, {
    sphere: mix(c.void, c.land, 0.2), shade: mix(c.void, '#000000', 0.7),
    green: mix(c.land, green, 0.1), park: mix(c.land, green, 0.12), building: mix(c.land, c.ink2, 0.1), runway: mix(c.land, c.ink2, 0.16),
    motorway: mix(c.ink2, c.ink, 0.3), waterLabel: mix(c.ink3, c.void, 0.3), streetLabel: mix(c.ink2, c.ink3, 0.5),
    venueLabel: mix(c.ink3, c.void, 0.15), ring: mix(c.ink3, c.ink2, 0.25), grip: mix(c.line, c.ink3, 0.35), dashed: mix(c.line, c.ink3, 0.5)
  });
  for (const [k, v] of Object.entries(t.map || {})) {
    if (!(k in c)) throw new Error(`theme "${t.id}": unknown map color "${k}"`);
    if (!HEX.test(v)) throw new Error(`theme "${t.id}": map.${k} should be a #rrggbb color, not "${v}"`);
    c[k] = v.toLowerCase();
  }
  return c;
}

export function loadThemes(cfg) {
  const ids = new Set();
  const list = (cfg.themes || []).map(t => {
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(t.id || '')) throw new Error(`theme id looks wrong: "${t.id}"`);
    if (ids.has(t.id)) throw new Error(`theme "${t.id}" is listed twice`);
    ids.add(t.id);
    if (!t.name || String(t.name).length > 24) throw new Error(`theme "${t.id}" needs a short name`);
    return { id: t.id, name: String(t.name), c: themeColors(t) };
  });
  if (!list.length) throw new Error('config/themes.json lists no themes');
  const def = list.find(t => t.id === cfg.default);
  if (!def) throw new Error(`the default theme "${cfg.default}" isn't in the list`);
  return { def: def.id, list };
}

const cssVars = c => Object.entries(VARS).map(([k, v]) => `${v}:${c[k]}`)
  .concat(Object.entries(RGB_VARS).map(([k, v]) => `${v}:${rgb(c[k]).join(',')}`)).join(';');

// What goes in each page's head, after its theme-color tag: the themes' variables (the default on
// :root, the others on :root[data-theme=…], which wins over a page's own :root), then the choice.
export function themeHead(T) {
  const def = T.list.find(t => t.id === T.def);
  const css = `:root{${cssVars(def.c)}}` + T.list.filter(t => t !== def).map(t => `:root[data-theme="${t.id}"]{${cssVars(t.c)}}`).join('');
  const bg = JSON.stringify(Object.fromEntries(T.list.map(t => [t.id, t.c.void])));
  return `<style id="rm-themes">${css}</style>\n` +
    `<script>try{var t=localStorage.getItem('rm_theme'),T=${bg};if(t&&Object.prototype.hasOwnProperty.call(T,t)){document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',T[t])}}catch(e){}</script>`;
}
