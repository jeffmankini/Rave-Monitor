import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadThemes, themeHead, contrast, themeColors, kit } from '../scripts/themes.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../config/themes.json', import.meta.url), 'utf8'));
const T = loadThemes(cfg);
const byId = Object.fromEntries(T.list.map(t => [t.id, t]));

test('every theme loads, with a default', () => {
  assert.ok(T.list.length >= 2);
  assert.equal(T.def, 'midnight');
  for (const t of T.list) for (const v of Object.values(t.c)) assert.match(v, /^#[0-9a-f]{6}$/);
});

test('text stays readable in every theme', () => {
  for (const { id, c } of T.list) {
    const at = (fg, bg, min) => assert.ok(contrast(c[fg], c[bg]) >= min, `${id}: ${fg} on ${bg} is ${contrast(c[fg], c[bg]).toFixed(2)}, under ${min}`);
    at('ink', 'void', 12); at('ink', 'deck', 11);
    at('ink2', 'deck', 7); at('ink2', 'deck2', 6.5);
    at('ink3', 'void', 4.5); at('ink3', 'deck', 4.5); at('ink3', 'deck2', 4.4);
    at('now', 'void', 4.5); at('now', 'deck', 4.5);  // the accent is used for text too
    at('nowInk', 'now', 7);                          // text on accent buttons and chips
    at('streetLabel', 'land', 3); at('waterLabel', 'void', 2.2);
  }
});

test('Midnight is the page as it was: same colors as site/index.html', () => {
  const root = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8').match(/:root \{([\s\S]*?)\n\}/)[1];
  const v = name => (root.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];
  const m = byId.midnight.c;
  assert.deepEqual([v('--void'), v('--deck'), v('--deck-2'), v('--land'), v('--line'), v('--ink'), v('--ink-2'), v('--ink-3'), v('--now'), v('--now-ink')],
    [m.void, m.deck, m.deck2, m.land, m.line, m.ink, m.ink2, m.ink3, m.now, m.nowInk]);
});

test("the map's fallback colors in site/app.js match Midnight", () => {
  const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  const src = app.match(/const MIDNIGHT = (\{[\s\S]*?\});/)[1];
  const fallback = vm.runInNewContext('(' + src + ')');
  for (const [k, v] of Object.entries(fallback)) assert.equal(v, byId.midnight.c[k], `MIDNIGHT.${k}`);
});

test('the head applies a saved theme and ignores anything else', () => {
  const head = themeHead(T);
  assert.match(head, /<style id="rm-themes">:root\{--void:#070814;/);
  assert.match(head, /:root\[data-theme="ember"\]\{--void:#0e0907;/);
  assert.match(head, /--ink-2-rgb:169,171,203/);
  const script = head.match(/<script>([\s\S]*)<\/script>/)[1];
  const run = (saved, custom) => {
    const attrs = {}, meta = { content: '#070814', setAttribute: (k, v) => { meta[k] = v; } }, styles = [];
    vm.runInNewContext(script, {
      localStorage: { getItem: k => k === 'rm_theme' ? saved : k === 'rm_theme_custom' ? custom : null },
      document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } }, querySelector: () => meta, head: { appendChild: el => styles.push(el.textContent) }, createElement: () => ({}) }
    });
    return [attrs['data-theme'] || null, meta.content, styles];
  };
  assert.deepEqual(run('lagoon'), ['lagoon', byId.lagoon.c.void, []]);
  assert.deepEqual(run(null), [null, '#070814', []]);
  assert.deepEqual(run('constructor'), [null, '#070814', []]);
  assert.deepEqual(run('nope'), [null, '#070814', []]);
  // A supporter's own colors: applied from local storage, only if it's nothing but color variables.
  const own = kit.custom('#3a0d0d', '#ffd166');
  const good = JSON.stringify({ bg: '#3a0d0d', accent: '#ffd166', void: own.void, css: kit.css(own) });
  const [th, bg, st] = run('custom', good);
  assert.equal(th, 'custom'); assert.equal(bg, own.void);
  assert.match(st[0], /^:root\[data-theme="custom"\]\{--void:#[0-9a-f]{6};/);
  for (const evil of [JSON.stringify({ void: own.void, css: '--void:#000000;} body{display:none' }), JSON.stringify({ void: 'red', css: kit.css(own) }), 'not json'])
    assert.deepEqual(run('custom', evil), [null, '#070814', []]);
  // Storage switched off (Safari private mode, some embeds): nothing breaks.
  assert.doesNotThrow(() => vm.runInNewContext(script, { localStorage: { getItem: () => { throw new Error('denied'); } }, document: {} }));
});

test("supporters' own colors stay dark, readable and in their hue", () => {
  const picks = [['#070814', '#f6ecd8'], ['#ff0000', '#ffffff'], ['#ffffff', '#000000'], ['#123456', '#1a1a1a'], ['#00ff88', '#ffd166'], ['#5b2a86', '#ff6bd6'], ['#000000', '#3987e5']];
  for (const [bg, accent] of picks) {
    const c = kit.custom(bg, accent), tag = bg + '/' + accent;
    assert.ok(kit.lum(c.void) < 0.02, tag + ': the background stays dark');
    assert.ok(contrast(c.ink, c.void) >= 12, tag + ': text on the page');
    assert.ok(contrast(c.ink2, c.deck) >= 7, tag + ': secondary text on panels');
    assert.ok(contrast(c.ink3, c.deck) >= 4.5, tag + ': quiet text on panels');
    assert.ok(contrast(c.now, c.deck) >= 4.5, tag + ': the accent on panels');
    assert.ok(contrast(c.nowInk, c.now) >= 4.5, tag + ': text on accent buttons');
  }
  // The hue carries over: a red background makes reddish panels.
  const red = kit.rgb(kit.custom('#ff0000', '#ffffff').deck);
  assert.ok(red[0] > red[1] && red[0] > red[2]);
  // Nonsense falls back to Midnight-like colors rather than breaking.
  assert.match(kit.custom('nope', 'nah').void, /^#[0-9a-f]{6}$/);
});

test('bad theme colors are refused', () => {
  assert.throws(() => themeColors({ id: 'x', ...byId.midnight.c, now: 'pink' }), /now should be a #rrggbb color/);
  assert.throws(() => themeColors({ id: 'x', ...byId.midnight.c, map: { lasers: '#ffffff' } }), /unknown map color/);
  assert.throws(() => loadThemes({ default: 'gone', themes: cfg.themes }), /default theme "gone"/);
  assert.throws(() => loadThemes({ default: 'midnight', themes: [cfg.themes[0], cfg.themes[0]] }), /listed twice/);
});
