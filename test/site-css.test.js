import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

test("the stream player's styles stay on the player, not on the lineups' follow stars", () => {
  // .fbtn.mini (the star beside a name) shares the word "mini" with the player, so the player's rules
  // are written aside.mini; a bare .mini rule would pin every star to the corner of the screen.
  assert.doesNotMatch(css, /(^|[\s,{}])\.mini(?=[\s.{,#:[])/m);
  assert.match(css, /aside\.mini \{[^}]*position: fixed/);
  assert.match(css, /\.fbtn\.mini \{/);
});
