#!/usr/bin/env node
// Assembles dist/: one self-contained index.html (map data, demo engine and app inlined)
// plus the files in site/static and events.json from the pipeline, if it exists.
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
for (const [k, v] of Object.entries(parts)) {
  if (v.includes('</script')) throw new Error(`${k} contains a closing script tag`);
  html = html.replace(k, () => v);
}
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), html);
// Static files (favicons) are copied as they are.
const statics = path.join(ROOT, 'site', 'static');
const copied = fs.existsSync(statics) ? fs.readdirSync(statics).filter(f => !f.startsWith('.')) : [];
for (const f of copied) fs.copyFileSync(path.join(statics, f), path.join(dist, f));
const feed = path.join(ROOT, 'public', 'events.json');
if (fs.existsSync(feed)) fs.copyFileSync(feed, path.join(dist, 'events.json'));
else if (fs.existsSync(path.join(dist, 'events.json'))) fs.rmSync(path.join(dist, 'events.json'));
console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB${fs.existsSync(feed) ? ', dist/events.json copied' : ', no feed (the page will show demo data)'}`);
