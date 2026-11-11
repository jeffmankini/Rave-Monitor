import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = f => JSON.parse(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
const { artists } = read('config/artists.json');
const cities = new Set(read('config/cities.json').cities.map(c => c.id));
// Each link field and the address it should point at (url is the artist's own site, anywhere).
const HOSTS = { url: /^https:\/\/[^/]+/, youtube: /^https:\/\/(www\.)?youtube\.com\//, spotify: /^https:\/\/open\.spotify\.com\/artist\//,
  soundcloud: /^https:\/\/soundcloud\.com\//, instagram: /^https:\/\/(www\.)?instagram\.com\// };

test('curated artists have a name, a known city and well-formed links', () => {
  const names = new Set();
  for (const a of artists) {
    assert.ok(a.name && a.name.trim() === a.name, 'a name: ' + JSON.stringify(a));
    assert.ok(!names.has(a.name.toLowerCase()), a.name + ' is listed twice');
    names.add(a.name.toLowerCase());
    if (a.city) assert.ok(cities.has(a.city), a.name + ': no city "' + a.city + '" in config/cities.json');
    for (const k of Object.keys(a)) {
      if (k === 'name' || k === 'city') continue;
      assert.ok(HOSTS[k], a.name + ': unknown field "' + k + '"');
      assert.match(a[k], HOSTS[k], a.name + ': ' + k);
    }
  }
});
