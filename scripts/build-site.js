#!/usr/bin/env node
// Assembles dist/: one self-contained index.html (map data, demo engine and app inlined)
// plus the files in site/static, and events.json and streams.json from the pipeline if they exist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let html = read('site/index.html');
const parts = { __GEO_JSON__: read('site/geo.json'), __DATA_JS__: read('site/demo-data.js'), __APP_JS__: read('site/app.js') };
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
for (const [k, v] of Object.entries(parts)) {
  if (v.includes('</script')) throw new Error(`${k} contains a closing script tag`);
  html = html.replace(k, () => v);
}
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), html);
// Search engines: allow everything and point to a one-page sitemap.
fs.writeFileSync(path.join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
fs.writeFileSync(path.join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}/</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod><changefreq>daily</changefreq></url>
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
console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB${fs.existsSync(feed) ? ', dist/events.json copied' : ', no feed (the page will show demo data)'}${GA_ID ? `, Google Analytics ${GA_ID}` : ''}${consent ? ', consent tool' : ''}`);
