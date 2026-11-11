// What's new (config/updates.json) for scripts/build-site.js: checks the list and turns it into the
// HTML that the map page's panel and /updates/ show.

export const KINDS = { new: 'New', better: 'Better', fixed: 'Fixed' };
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function loadUpdates(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('config/updates.json has no updates');
  let prev = '9999-12-31';
  return list.map((u, i) => {
    const where = `update ${i + 1} ("${u && u.title}")`;
    if (!u || !/^\d{4}-\d{2}-\d{2}$/.test(u.date || '') || isNaN(Date.parse(u.date + 'T00:00:00Z'))) throw new Error(`${where}: date should be YYYY-MM-DD`);
    if (u.date > prev) throw new Error(`${where}: newest first, so ${u.date} can't come after ${prev}`);
    prev = u.date;
    if (!KINDS[u.kind]) throw new Error(`${where}: kind should be ${Object.keys(KINDS).join(', ')}`);
    if (!u.title || String(u.title).length > 60) throw new Error(`${where}: needs a short title`);
    if (!u.text || String(u.text).length > 400) throw new Error(`${where}: needs a sentence or two of text`);
    return { date: u.date, kind: u.kind, title: String(u.title), text: String(u.text) };
  });
}

// "November 10, 2026"
export const longDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });

// One section a day: the date as a heading (h2 on the page, h3 in the panel), then that day's changes.
export function updatesHtml(list, h) {
  const days = [];
  for (const u of list) {
    const last = days[days.length - 1];
    if (last && last.date === u.date) last.items.push(u); else days.push({ date: u.date, items: [u] });
  }
  return days.map(d => `<section class="upd-day"><${h}><time datetime="${d.date}">${longDate(d.date)}</time></${h}><ul class="upd">` +
    d.items.map(u => `<li><span class="upd-k upd-${u.kind}">${KINDS[u.kind]}</span> <b>${esc(u.title)}.</b> ${esc(u.text)}</li>`).join('') +
    '</ul></section>').join('\n');
}
