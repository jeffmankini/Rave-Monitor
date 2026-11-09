#!/usr/bin/env node
// Assembles dist/: one self-contained index.html (map data, demo engine and app inlined)
// plus the files in site/static, and events.json and streams.json from the pipeline if they exist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let html = read('site/index.html');
// The page also gets the curated record labels (config/labels.json), so a search for a label with
// nothing coming up can point to the archive, and rough time-zone positions (site/tz.json, from
// scripts/make-tz.js) to start the map near a visitor without asking for their location.
const labelNames = JSON.parse(read('config/labels.json')).labels.map(l => l.name);
const tzTable = read('site/tz.json').trim();
const parts = {
  // The coarse world map and lakes go in the page; the detailed coastline is fetched after it (geo-hi.json).
  __GEO_JSON__: JSON.stringify((({ lo, lakes }) => ({ lo, lakes }))(JSON.parse(read('site/geo.json')))), __DATA_JS__: read('site/demo-data.js'),
  __APP_JS__: `window.RM_LABELS = ${JSON.stringify(labelNames)};\nwindow.RM_TZ = ${tzTable};\n` + read('site/app.js')
};
// Link previews need absolute URLs; set SITE_URL when deploying somewhere else.
const SITE_URL = (process.env.SITE_URL || 'https://ravemonitor.com').replace(/\/+$/, '');
html = html.split('__SITE_URL__').join(SITE_URL);
const REPO_URL = `https://github.com/${process.env.GITHUB_REPOSITORY || 'jeffmankini/Rave-Monitor'}`;
html = html.split('__REPO_URL__').join(REPO_URL);
// Google Analytics only when a Measurement ID is set (config/site.json or GA_MEASUREMENT_ID).
const site = JSON.parse(read('config/site.json'));
const GA_ID = String(process.env.GA_MEASUREMENT_ID || site.gaMeasurementId || '').trim();
if (GA_ID && !/^G-[A-Z0-9]{4,16}$/.test(GA_ID)) throw new Error(`gaMeasurementId should look like G-XXXXXXXXXX, not "${GA_ID}"`);
// The consent tool's embed (site/consent.html) goes first in the head, between the Consent Mode
// defaults and the Analytics tag, so the visitor's choice applies before anything is counted.
const consentFile = path.join(ROOT, 'site', 'consent.html');
const consent = fs.existsSync(consentFile) ? fs.readFileSync(consentFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim() : '';
const head = GA_ID ? read('site/analytics.html').split('__GA_ID__').join(GA_ID).replace('<!-- CONSENT TOOL -->', () => consent).trim() : consent;
html = html.replace('__HEAD_START__', () => head);
// Policy pages (config/legal.json), linked from the About panel and from each other.
const legal = JSON.parse(read('config/legal.json'));
const escHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The footer (every page) has the archive, the policies and the consent tool's Privacy Settings link
// (with the id Usercentrics looks for); the About panel lists the policies by full name.
const PSL = id => `<a href="#"${id ? ' id="usercentrics-psl"' : ''} data-act="privacy-settings">Privacy Settings</a>`;
// The contact form (site/contact.html, worker/contact) needs its Worker address and a Turnstile site key.
const contactEndpoint = process.env.CONTACT_ENDPOINT || site.contactEndpoint || '';
const turnstileKey = process.env.TURNSTILE_SITE_KEY || site.turnstileSiteKey || '';
const contact = !!(contactEndpoint && turnstileKey);
const footerLinks = ['<a href="/archive/">Archive</a>'].concat(contact ? ['<a href="/contact/">Contact</a>'] : [], legal.pages.map(p => `<a href="/${p.slug}/">${escHtml(p.footer || p.short || p.title)}</a>`), consent ? [PSL(true)] : []).join(' · ');
const legalLinks = legal.pages.map(p => `<a href="/${p.slug}/">${escHtml(p.short || p.title)}</a>`).concat(consent ? [PSL(false)] : []).join(' · ');
html = html.replace('__LEGAL_LINKS__', () => legalLinks).replace('__FOOTER_LINKS__', () => footerLinks)
  .replace('__CONTACT_LINK__', () => contact ? 'the <a href="/contact/" style="color:inherit">contact form</a> or ' : '');
function termageddon(id) {
  if (!/^[A-Za-z0-9=]+$/.test(id)) throw new Error(`Termageddon policy id looks wrong: ${id}`);
  return `<div id="${id}" class="policy_embed_div" width="640" height="480" aria-live="polite" aria-busy="true">Please wait while the policy is loaded. If it does not load, please <a rel="nofollow" aria-label="click here to view the policy" href="https://policies.termageddon.com/api/policy/${id}" target="_blank">click here to view the policy</a>.</div>\n<script src="https://policies.termageddon.com/api/embed/c/${id}.js"></script>`;
}
// The event drawer links to the contact form for listing fixes and removals, when there is one.
parts.__APP_JS__ = `window.RM_CONTACT = ${contact ? "'/contact/'" : "''"};\n` + parts.__APP_JS__;
for (const [k, v] of Object.entries(parts)) {
  if (v.includes('</script')) throw new Error(`${k} contains a closing script tag`);
  html = html.replace(k, () => v);
}
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), html);
fs.writeFileSync(path.join(dist, 'geo-hi.json'), JSON.stringify(JSON.parse(read('site/geo.json')).hi));
const pageTpl = read('site/page.html').split('__SITE_URL__').join(SITE_URL).replace('__HEAD_START__', () => head).replace('__LEGAL_LINKS__', () => footerLinks);
// The archive page; its data (archive/data/) is written by pipeline/archive-export.js after this.
fs.mkdirSync(path.join(dist, 'archive'), { recursive: true });
fs.writeFileSync(path.join(dist, 'archive', 'index.html'), read('site/archive.html').split('__SITE_URL__').join(SITE_URL).split('__REPO_URL__').join(REPO_URL)
  .replace('__HEAD_START__', () => head).replace('__LEGAL_LINKS__', () => footerLinks));
// The contact page: the form posts to the Worker, with Cloudflare Turnstile against spam.
if (contact) {
  if (!/^(https:\/\/|http:\/\/localhost[:/])[^\s'"<>]+$/.test(contactEndpoint)) throw new Error(`contactEndpoint should be an https URL, not "${contactEndpoint}"`);
  if (!/^[0-9A-Za-z_-]{10,64}$/.test(turnstileKey)) throw new Error(`turnstileSiteKey looks wrong: "${turnstileKey}"`);
  fs.mkdirSync(path.join(dist, 'contact'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'contact', 'index.html'), read('site/contact.html').split('__SITE_URL__').join(SITE_URL)
    .replace('__HEAD_START__', () => head).replace('__LEGAL_LINKS__', () => footerLinks)
    .split('__CONTACT_ENDPOINT__').join(contactEndpoint).split('__TURNSTILE_SITE_KEY__').join(turnstileKey));
} else fs.rmSync(path.join(dist, 'contact'), { recursive: true, force: true });
for (const p of legal.pages) {
  if (!/^[a-z0-9-]+$/.test(p.slug)) throw new Error(`policy slug looks wrong: ${p.slug}`);
  const out = pageTpl.split('__TITLE__').join(escHtml(p.title)).split('__SLUG__').join(p.slug).replace('__CONTENT__', () => (p.termageddon ? termageddon(p.termageddon) : p.html));
  fs.mkdirSync(path.join(dist, p.slug), { recursive: true });
  fs.writeFileSync(path.join(dist, p.slug, 'index.html'), out);
}
// Search engines: allow everything and point to the sitemap.
fs.writeFileSync(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
fs.writeFileSync(path.join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod><changefreq>daily</changefreq></url>
  <url><loc>${SITE_URL}/archive/</loc><changefreq>daily</changefreq></url>
${contact ? `  <url><loc>${SITE_URL}/contact/</loc><changefreq>yearly</changefreq></url>\n` : ''}${legal.pages.map(p => `  <url><loc>${SITE_URL}/${p.slug}/</loc><changefreq>monthly</changefreq></url>`).join('\n')}
</urlset>
`);
// Static files (favicons) are copied as they are.
const statics = path.join(ROOT, 'site', 'static');
const copied = fs.existsSync(statics) ? fs.readdirSync(statics).filter(f => !f.startsWith('.')) : [];
for (const f of copied) fs.copyFileSync(path.join(statics, f), path.join(dist, f));
const feed = path.join(ROOT, 'public', 'events.json');
if (fs.existsSync(feed)) fs.copyFileSync(feed, path.join(dist, 'events.json'));
else if (fs.existsSync(path.join(dist, 'events.json'))) fs.rmSync(path.join(dist, 'events.json'));
// Livestreams for the Streams tab (pipeline/streams.js); the page reads NTS live on its own too.
const streams = path.join(ROOT, 'public', 'streams.json');
if (fs.existsSync(streams)) fs.copyFileSync(streams, path.join(dist, 'streams.json'));
else if (fs.existsSync(path.join(dist, 'streams.json'))) fs.rmSync(path.join(dist, 'streams.json'));
console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB${fs.existsSync(feed) ? ', dist/events.json copied' : ', no feed (the page will show demo data)'}${GA_ID ? `, Google Analytics ${GA_ID}` : ''}${consent ? ', consent tool' : ''}, ${legal.pages.length} policy pages${contact ? ', contact page' : ''}`);
