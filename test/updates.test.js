import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadUpdates, updatesHtml, longDate } from '../scripts/updates.js';

const list = JSON.parse(fs.readFileSync(new URL('../config/updates.json', import.meta.url), 'utf8')).updates;

test("What's new loads: newest first, each with a kind, a title and a sentence", () => {
  const u = loadUpdates(list);
  assert.ok(u.length > 10);
  assert.ok(u.some(x => x.title === 'Rave Monitor goes live' && x.date === u[u.length - 1].date), 'the backlog starts at launch');
  for (let i = 1; i < u.length; i++) assert.ok(u[i].date <= u[i - 1].date);
});

test('the list groups by day and escapes text', () => {
  const html = updatesHtml(loadUpdates([
    { date: '2026-11-10', kind: 'new', title: 'Colors', text: 'Pick <yours> & go.' },
    { date: '2026-11-10', kind: 'fixed', title: 'Posh', text: 'Back.' },
    { date: '2026-11-08', kind: 'better', title: 'Start', text: 'Hi.' }
  ]), 'h3');
  assert.equal((html.match(/<section class="upd-day">/g) || []).length, 2);
  assert.match(html, /<h3><time datetime="2026-11-10">November 10, 2026<\/time><\/h3>/);
  assert.match(html, /<span class="upd-k upd-new">New<\/span> <b>Colors\.<\/b> Pick &lt;yours&gt; &amp; go\./);
  assert.match(html, /<span class="upd-k upd-fixed">Fixed<\/span>/);
  assert.equal(longDate('2026-01-02'), 'January 2, 2026');
});

test('mistakes in the list are caught at build time', () => {
  const ok = { date: '2026-11-09', kind: 'new', title: 'A', text: 'B.' };
  assert.throws(() => loadUpdates([ok, { ...ok, date: '2026-11-10' }]), /newest first/);
  assert.throws(() => loadUpdates([{ ...ok, kind: 'shiny' }]), /kind should be/);
  assert.throws(() => loadUpdates([{ ...ok, date: '11/09/2026' }]), /YYYY-MM-DD/);
  assert.throws(() => loadUpdates([{ ...ok, text: '' }]), /text/);
  assert.throws(() => loadUpdates([]), /no updates/);
});
