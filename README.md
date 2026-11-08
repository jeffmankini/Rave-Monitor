# Rave Monitor, by Geff Bohm

Live at [ravemonitor.com](https://ravemonitor.com). Like it? [Buy me a coffee](https://buymeacoffee.com/geffbohm). A live map of electronic music: club nights, festivals, day parties and where touring DJs play next. It's an open-source proof of concept, inspired by World Monitor-style dashboards and built for fun.

A scheduled job pulls public listings from Resident Advisor, Posh, Partiful, Luma, Ticketmaster and Skiddle (DICE is wired up but switched off), keeps the electronic ones, merges nights listed on more than one platform, and writes one `events.json`. A second step writes `streams.json`, the livestreams for the Streams tab. The site is a single HTML page that reads those files. Without a feed, it falls back to a built-in demo with fictional events.

On the page:

- **The map.** Zoomed out, each city is a cluster of dots. Zoom in and a street map fades in (OpenStreetMap data from OpenFreeMap's free vector tiles, drawn with MapLibre and loaded only when you zoom), with neighbourhoods, streets and each venue in its place. Selecting a city frames its venues.
- **Lists follow the map.** Once you zoom in yourself (scroll, pinch, the + button or picking a city), Live now, Wire, Scene heat, Genres and the other lists only show what's in the map area, and "Show everywhere" zooms back out. Opening an event from a list moves the map without narrowing the list.
- **Streams.** What's on air on NTS Radio right now and its coming club shows, plus live and scheduled YouTube streams from Boiler Room, Cercle, HÖR and other channels.

## How it works

```
Apify scrapers (RA, DICE, Posh, Partiful, Luma) ─┐
Free APIs (Ticketmaster, Skiddle) ───────────────┤
                                                 ▼
   pipeline/run.js: normalize → electronic-music filter → genre families → merge duplicates
                                                 ▼
                               public/events.json  →  dist/ (index.html + events.json)
NTS Radio + YouTube → pipeline/streams.js → public/streams.json ─┘
                                                 ▼
                 GitHub Actions, every 3 hours → GitHub Pages (and optionally Netlify)
```

- **Normalize.** Every source maps to one event shape: title, start and end, venue and coordinates, lineup, genres, price, ticket status and source links.
- **Filter.** RA and Ticketmaster's Dance/Electronic genre are electronic by definition. DICE uses its genre tags. Posh, Partiful, Luma and Skiddle listings must clearly mention electronic music (techno, house, rave, drum and bass and so on); brunches, sample sales and meetups are dropped.
- **Genres.** Listings map to eight families: techno, house, drum and bass, afro and amapiano, disco and edits, garage and breaks, trance and psy, bass and dubstep.
- **Merge.** The same night at the same venue on several platforms becomes one event that keeps every link. DICE set times are kept when present.

## Try it without any keys

Needs Node 20 or newer. There are no dependencies to install.

```bash
npm run build:sample   # runs the pipeline on pipeline/sample (fictional events in each platform's format)
npm run serve          # open http://localhost:8080
npm test
```

## Run it with real listings

1. Push this folder to a public GitHub repository.
2. In **Settings → Secrets and variables → Actions**, add any of:
   - `APIFY_TOKEN`: from the Apify console (Settings → API & Integrations). Turns on RA, DICE, Posh, Partiful and Luma.
   - `TICKETMASTER_KEY`: free at developer.ticketmaster.com.
   - `SKIDDLE_KEY`: free at skiddle.com/api/join.php (UK listings).
   - `YOUTUBE_KEY`: a free YouTube Data API v3 key, for livestreams (see below).
3. In **Settings → Pages**, set the source to **GitHub Actions**.
4. In **Actions → Refresh listings**, choose **Run workflow**.

The job then runs every 3 hours. Sources without a key are skipped and reported on the page (open "Live listings" in the header). To pull every source again right away, run it with "Ignore saved scrapes" ticked. To pull only some again, fill in "Pull just these again now" with sources or source:city pairs, such as `ra:berlin,ra:london`; their new listings are added to what was saved.

To deploy to Netlify as well, add `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` secrets.

To run locally with real data, copy `.env.example` to `.env`, fill it in, then `npm run build && npm run serve`.

### Livestreams

NTS Radio needs nothing: the pipeline reads its public schedule (with genres, so only club shows are listed as coming up), and the page also reads NTS's live list straight from the browser, so what's on air is always current.

YouTube needs a free API key. In the Google Cloud console, create a project, enable **YouTube Data API v3** (APIs & Services → Library), then create an API key (APIs & Services → Credentials); restricting it to that API is a good idea. Add it as the `YOUTUBE_KEY` secret. The channels are in `config/streams.json`. Each run reads each channel's uploads list rather than searching, so it costs about one unit of the free 10,000 a day per channel. YouTube's live status is as of the last run (every 3 hours); a scheduled stream counts as live once its start time passes.

## Costs

Ticketmaster and Skiddle are free. The Apify scrapers charge per result. These are the prices listed on the Apify store's free plan in November 2026, with the default caps from `config/sources.json`:

| Source | Scraper | Per 1,000 results | Default cap per scrape | Most it can cost per scrape |
|---|---|---|---|---|
| Resident Advisor | `chalkandcheese~ra-events-scraper` | $3.30 | 15 cities × 40 | $1.98 |
| DICE (off) | `chalkandcheese~dice-fm-events-scraper` | $3.30 | 10 cities × 30 (DJ listings) | $0.99 |
| Posh | `trev0n~posh-vip-scraper` | $3.00 | 8 cities × 30 | $0.72 |
| Partiful | `heliostech~partiful-event-scraper` | $3.00 | 7 cities × 25 | $0.53 |
| Luma | `solidcode~luma-scraper` | $3.00 | 8 cities × 25 | $0.60 |

DICE is switched off: as of November 2026 it answers these scrapers with 403 Forbidden, even through Apify Proxy. Set `enabled: true` to try it again.

With DICE off, that's at most about $3.85 per full scrape. Paid sources scrape once a month (`maxAgeHours: 720`), reaching 31 days ahead (`scrapeDays`), so the default schedule costs at most about $3.85 a month, while the free APIs refresh daily. The job runs every 3 hours for the Streams tab, but the other runs reuse the saved scrapes and cost nothing. Every Apify run also carries a hard spending cap (`maxChargeUsdPerRun`).

Apify's free plan includes $5 of usage a month and pauses your account, rather than billing you, when it runs out. The monthly default fits inside it. For weekly scrapes (`maxAgeHours: 168`, about $17 a month) you'd need a paid Apify plan.

Scrapes are saved per city. If a city's scrape fails or comes back empty (an expired token, used-up credit, a site change), the page keeps showing that city's last good scrape, for up to 30 days past its usual refresh, and the job tries that city again after `retryHours` (20 hours for the paid scrapers, so a failing page isn't paid for on every 3-hourly run). Editing a city's entry or adding a city pulls just that city again on the next run; editing a source's settings pulls all its cities again.

Apify also limits how many runs you can have going at once and how much memory they use (5 runs and 16 GB on the free plan). The job queues runs to stay under `apifyMaxRuns` and `apifyMemoryMb` in `config/sources.json`; raise them if your plan allows more.

Each city gets its own scraper run and cap, so a busy city can't use up the others' share. The scrapers list events date by date, so in a busy city one pull's cap would fill up with the first few nights. For RA's busiest cities (`spreadCities`), each monthly scrape shares the city's cap across every Friday and Saturday in the next 31 days (`spreadNights`), so every weekend gets a few listings. That's one small run per night, about 100 RA runs a month, at the same cost. Raise `maxItemsPerCity` for fuller coverage.

To spend less, cut cities, lower `maxItemsPerCity`, raise `maxAgeHours` or switch a source off.

## The archive

Every listing the site shows is also kept in the `archive` branch, merged across platforms and kept after the night is over, so the repo grows into a living archive of the scene. The daily job adds new listings and updates known ones: new platforms, lineup changes, and status changes such as sold out or cancelled, with the day each was seen.

- `events/YYYY-MM.ndjson`: one listing per line, filed by its local month; `cities.json` and `summary.json` alongside.
- The site offers the whole archive as a SQLite database (`/archive/archive.sqlite`, with `events`, `event_artists`, `event_sources`, `event_status` and `cities` tables) and a CSV file (`/archive/events.csv`), rebuilt on every deploy.
- It's only as complete as the scrapes: paid sources are capped per city, so busy cities hold a sample of their nights.

To build it locally: `node pipeline/archive.js <dir> public/events.json`, then `node pipeline/archive-export.js <dir> <out-dir>`.

## Configuration

- `config/cities.json` lists the 72 cities and, for each, what to ask every source for: the RA area page, the DICE browse page (the part after dice.fm/browse/), the Posh explore location, the Partiful city slug and the Luma city handle. Some RA area pages are best guesses; if a city comes back empty, copy the right URL from ra.co. A city can list more than one RA page, and a wrong one simply returns nothing.
- `config/streams.json` sets the YouTube channels for the Streams tab (add any channel id; `genres` and `city` are optional) and how far ahead NTS shows are listed.
- `config/sources.json` turns sources on or off and sets cities, caps, spending limits and how long a scrape stays fresh. Any Apify actor can be swapped in by changing `actor` and its `normalize()` in `pipeline/sources/`.
- Link previews: the title, description and share image are in the head of `site/index.html`. Their URLs use `SITE_URL` (default `https://ravemonitor.com`); set it as an environment variable when building for another address. The share image, `site/static/og-image.jpg`, is a screenshot of `scripts/og-card.html` at 1200×630 (instructions are in that file). Everything in `site/static` (icons, share image) is copied next to the page.

## Scraping responsibly

This is a non-commercial demo built on third-party scrapers. It tries to be a good citizen:

- **Event details only.** It keeps titles, times, venues, lineups, prices, status and links. It never stores descriptions, attendee or guest lists, or organizer contact details, even where a scraper offers them. Contact or credit lines that turn up in a lineup ("booking: name@…", "Instagram: …", "Founder @…") are dropped too.
- **Opt-outs are respected.** Posh events whose organizers turned off third-party display are skipped, and only public Partiful events are used.
- **Light load.** Sources are scraped on a schedule and cached, never on page views, and every listing links back to its source.
- **Event facts only, in the archive too.** Raw scrapes live only in the job's cache. The archive branch and the deployed files keep the same event facts as the site (title, time, venue, lineup, genres, price, status, links), never descriptions, attendee lists or organizer contacts.
- **Removal on request.** If a platform or promoter asks to be left out, switch the source off or filter them in `normalize()`.

Each scraper is run by its own author under the platform's terms. Check those terms before running this at any scale.

## The feed format

`events.json` holds `generatedAt`, `sources` (a per-source report), `cities` and `events`. Each event looks like this:

```json
{
  "id": "ra:9100005",
  "title": "Body Heat: Ash Ottley",
  "start": "2026-11-14T22:00:00.000Z",
  "end": "2026-11-15T04:00:00.000Z",
  "tz": "Europe/London",
  "cityId": "london",
  "venue": { "name": "Railway Arch 7", "lat": 51.497, "lon": -0.087 },
  "lineup": ["Ash Ottley", "Juno Price"],
  "sets": [{ "name": "Juno Price", "start": "2026-11-14T22:00:00.000Z" }],
  "genres": ["garage"],
  "tags": ["UK Garage", "Breaks"],
  "type": "club",
  "price": { "min": 15, "max": 15, "currency": "GBP" },
  "status": "onsale",
  "popularity": 300,
  "sources": [
    { "id": "ra", "name": "Resident Advisor", "url": "https://ra.co/events/9100005" },
    { "id": "dice", "name": "DICE", "url": "https://dice.fm/event/..." }
  ]
}
```

## Project layout

```
config/            cities and source settings
pipeline/run.js    builds public/events.json
pipeline/streams.js builds public/streams.json (NTS and YouTube)
pipeline/lib/      normalize, merge duplicates, Apify client, helpers
pipeline/sources/  one adapter per source
pipeline/sample/   sample input in each platform's format
site/              the map: index.html, app.js, demo engine, map shapes
scripts/           build-site.js (assembles dist/), serve.js (local preview)
test/              node --test
```

## License

MIT. Map shapes are from Natural Earth via world-atlas, in the public domain. The street map is © OpenStreetMap contributors (ODbL), with tiles from OpenFreeMap and the OpenMapTiles schema, drawn with MapLibre GL JS (BSD-3-Clause).
