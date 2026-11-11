// Temporary: one line per saved Ticketmaster listing with its own and its artists' classifications.
import fs from 'node:fs';
const saved = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const n = x => (x && x.name && x.name !== 'Undefined') ? x.name : '';
const cls = c => [c.primary ? 'P' : '', n(c.segment), n(c.genre), n(c.subGenre), n(c.type), n(c.subType)].join('/');
console.log(`saved ${new Date(saved.at).toISOString()} items ${saved.items.length}`);
for (const x of saved.items) {
  const v = (x._embedded && x._embedded.venues && x._embedded.venues[0]) || {};
  const atts = ((x._embedded && x._embedded.attractions) || []).map(a => `${a.name} {${(a.classifications || []).map(cls).join(' ; ')}}`);
  console.log('TM\t' + JSON.stringify({ id: x.id, t: x.name, d: (x.dates && x.dates.start && x.dates.start.localDate) || '', v: v.name || '', city: x.__city, c: (x.classifications || []).map(cls), a: atts }));
}
