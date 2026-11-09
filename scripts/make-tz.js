#!/usr/bin/env node
// Writes site/tz.json: a rough position for each IANA time zone ({ "America/Chicago": [41.9, -87.6] }),
// from the system's tz database (zone1970.tab, zone.tab and the aliases in tzdata.zi). The page uses
// it to start the map near a visitor without asking for their location: the browser's time zone
// stays on the device. Run again only when the tz database adds zones.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZI = process.env.ZONEINFO || '/usr/share/zoneinfo';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'tz.json');
// ISO 6709: +DDMM+DDDMM or +DDMMSS+DDDMMSS.
function coord(s) {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$/.exec(s);
  if (!m) return null;
  const v = (sign, d, mm, ss) => (sign === '-' ? -1 : 1) * (+d + +mm / 60 + (+ss || 0) / 3600);
  return [+v(m[1], m[2], m[3], m[4]).toFixed(1), +v(m[5], m[6], m[7], m[8]).toFixed(1)];
}
const zones = {};
for (const f of ['zone.tab', 'zone1970.tab']) {
  for (const line of fs.readFileSync(path.join(ZI, f), 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [, c, tz] = line.split('\t');
    const p = c && coord(c);
    if (tz && p) zones[tz] = p;
  }
}
let aliases = 0;
const zi = path.join(ZI, 'tzdata.zi');
if (fs.existsSync(zi)) {
  for (const line of fs.readFileSync(zi, 'utf8').split('\n')) {
    const m = /^L (\S+) (\S+)$/.exec(line);
    if (m && zones[m[1]] && !zones[m[2]]) { zones[m[2]] = zones[m[1]]; aliases++; }
  }
}
const sorted = Object.fromEntries(Object.entries(zones).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(out, JSON.stringify(sorted) + '\n');
console.log(`site/tz.json: ${Object.keys(sorted).length} time zones (${aliases} aliases), ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
