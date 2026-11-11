// Color themes (config/themes.json) for scripts/build-site.js: the full set of colors for each,
// the CSS that applies them, and the small script that applies the visitor's choice before the page
// draws (a preset, or the visitor's own colors). The color math is site/themekit.js, which the page
// uses too; test/themes.test.js checks the colors read well.
import fs from 'node:fs';
import vm from 'node:vm';

const KIT_SRC = fs.readFileSync(new URL('../site/themekit.js', import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(KIT_SRC, sandbox);
export const kit = sandbox.RM_THEMEKIT;
export { KIT_SRC };
export const { CORE, rgb, mix, contrast } = kit;

/** A theme from config/themes.json: its full set of colors. */
export function themeColors(t) {
  try { return kit.complete(t, t.map); } catch (err) { throw new Error(`theme "${t.id}": ${err.message}`); }
}

export function loadThemes(cfg) {
  const ids = new Set();
  const list = (cfg.themes || []).map(t => {
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(t.id || '') || t.id === 'custom') throw new Error(`theme id looks wrong: "${t.id}"`);
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

// What goes in each page's head, after its theme-color tag: the themes' variables (the default on
// :root, the others on :root[data-theme=…], which wins over a page's own :root), then the choice.
// The visitor's own colors come from local storage (rm_theme_custom: the CSS the page worked out,
// checked to be nothing but color variables).
export function themeHead(T) {
  const def = T.list.find(t => t.id === T.def);
  const css = `:root{${kit.css(def.c)}}` + T.list.filter(t => t !== def).map(t => `:root[data-theme="${t.id}"]{${kit.css(t.c)}}`).join('');
  const bg = JSON.stringify(Object.fromEntries(T.list.map(t => [t.id, t.c.void])));
  const script = `try{var d=document,t=localStorage.getItem('rm_theme'),T=${bg},c='';` +
    `if(t==='custom'){var x=JSON.parse(localStorage.getItem('rm_theme_custom')||'null');` +
    `if(x&&/^(--[a-z0-9-]+:(#[0-9a-f]{6}|\\d{1,3},\\d{1,3},\\d{1,3});)+$/.test(x.css||'')&&/^#[0-9a-f]{6}$/.test(x.void||'')){var s=d.createElement('style');s.id='rm-custom';s.textContent=':root[data-theme="custom"]{'+x.css+'}';d.head.appendChild(s);c=x.void}}` +
    `else if(t&&Object.prototype.hasOwnProperty.call(T,t))c=T[t];` +
    `if(c){d.documentElement.setAttribute('data-theme',t);var m=d.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',c)}}catch(e){}`;
  return `<style id="rm-themes">${css}</style>\n<script>${script}</script>`;
}
