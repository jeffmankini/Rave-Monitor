import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { norm, lkey, akey, followKey } from '../worker/api/src/keys.js';

// The site has its own copies of these (site/app.js); a follow made on the site must match what the
// alerts step compares, so they have to agree.
const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const grab = name => {
  const m = app.match(new RegExp(`const ${name} = (s => [^\\n]+);`));
  assert.ok(m, `site/app.js defines ${name}`);
  return m[1];
};
const site = new Function(`const norm = ${grab('norm')}; const lkey = ${grab('lkey')}; const akey = ${grab('akey')}; return { norm, lkey, akey };`)();

const NAMES = ['Ben UFO', 'BEN U.F.O.', 'Bén UFO', 'Body & Soul', "Mama's Boyz", 'DJ KOZE', 'Ryōji Ikeda', '石野卓球', 'Hessle Audio', '  split/shift  ', 'Ø [Phase]', 'Café Lounge (Room 2)', '', null];

test('the site and the Worker compare names the same way', () => {
  for (const n of NAMES) {
    assert.equal(site.norm(n), norm(n), `norm ${n}`);
    assert.equal(site.lkey(n), lkey(n), `lkey ${n}`);
    assert.equal(site.akey(n), akey(n), `akey ${n}`);
  }
});

test('follow keys', () => {
  assert.equal(followKey('artist', 'Bén UFO'), 'ben ufo');
  assert.equal(followKey('artist', '石野卓球'), '石野卓球');
  assert.equal(followKey('promoter', 'Body & Soul'), 'body and soul');
  assert.equal(followKey('label', 'split/shift'), 'split shift');
  assert.equal(followKey('venue', 'ignored', 'milwaukee-split-shift'), 'milwaukee-split-shift');
  assert.equal(followKey('venue', 'x', 'Bad Id!'), '');
});
