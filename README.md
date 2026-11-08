# Rave Monitor

A live map of electronic music: club nights, festivals, day parties and where touring DJs play next. It's an open-source proof of concept, inspired by World Monitor-style dashboards and built for fun.

A scheduled job pulls public listings from Resident Advisor, DICE, Posh, Partiful, Luma, Ticketmaster and Skiddle, keeps the electronic ones, merges nights listed on more than one platform, and writes one `events.json`. The site is a single HTML page that reads that file. Without a feed, it falls back to a built-in demo with fictional events.

## How it works

```
Apify scrapers (RA, DICE, Posh, Partiful, Luma) ─┐
Free APIs (Ticketmaster, Skiddle) ───────────────┤
                                                 ▼
   pipeline/run.js: normalize → electronic-music filter → genre families → merge duplicates
                                                 ▼
                               public/events.json  →  dist/ (index.html + events.json)
                                                 ▼
                     GitHub Actions, daily → GitHub Pages (and optionally Netlify)
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
3. In **Settings → Pages**, set the source to **GitHub Actions**.
4. In **Actions → Refresh listings**, choose **Run workflow** and tick "fresh" the first time.

The job then runs daily. Sources without a key are skipped and reported on the page (open "Live listings" in the header).

To deploy to Netlify as well, add `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` secrets.

To run locally with real data, copy `.env.example` to `.env`, fill it in, then `npm run build && npm run serve`.

## Costs

Ticketmaster and Skiddle are free. The Apify scrapers charge per result. These are the prices listed on the Apify store's free plan in November 2026, with the default caps from `config/sources.json`:

| Source | Scraper | Per 1,000 results | Default cap per scrape | Most it can cost per scrape |
|---|---|---|---|---|
| Resident Advisor | `chalkandcheese~ra-events-scraper` | $3.30 | 15 cities × 40 | $1.98 |
| DICE | `hoholabs~dicefm-scraper` | $1.00 | 12 cities × 60 | $0.72 |
| Posh | `trev0n~posh-vip-scraper` | $3.00 | 8 cities × 30 | $0.72 |
| Partiful | `heliostech~partiful-event-scraper` | $3.00 | 7 cities × 25 | $0.53 |
| Luma | `solidcode~luma-scraper` | $3.00 | 8 cities × 25 | $0.60 |

That's at most about $4.55 per full scrape. Paid sources reuse their last scrape for a week (`maxAgeHours: 168`), so the default schedule costs at most about $20 a month, while the free APIs refresh daily. Every Apify run also carries a hard spending cap (`maxChargeUsdPerRun`).

To spend less, cut cities, lower `maxItemsPerCity`, raise `maxAgeHours` or switch a source off.

## Configuration

- `config/cities.json` lists the 72 cities and, for each, what to ask every source for: the RA area page, the DICE city name, the Posh explore location, the Partiful city slug and the Luma city handle. Some RA area pages are best guesses; if a run reports an error for one, copy the right URL from ra.co.
- `config/sources.json` turns sources on or off and sets cities, caps, spending limits and how long a scrape stays fresh. Any Apify actor can be swapped in by changing `actor` and its `normalize()` in `pipeline/sources/`.

## Scraping responsibly

This is a non-commercial demo built on third-party scrapers. It tries to be a good citizen:

- **Event details only.** It keeps titles, times, venues, lineups, prices, status and links. It never stores descriptions, attendee or guest lists, or organizer contact details, even where a scraper offers them.
- **Opt-outs are respected.** Posh events whose organizers turned off third-party display are skipped, and only public Partiful events are used.
- **Light load.** Sources are scraped on a schedule and cached, never on page views, and every listing links back to its source.
- **Data stays out of the repo.** The code is public. Scraped data lives only in the job's cache and the deployed `events.json`.
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
pipeline/lib/      normalize, merge duplicates, Apify client, helpers
pipeline/sources/  one adapter per source
pipeline/sample/   sample input in each platform's format
site/              the map: index.html, app.js, demo engine, map shapes
scripts/           build-site.js (assembles dist/), serve.js (local preview)
test/              node --test
```

## License

MIT. Map shapes are from Natural Earth via world-atlas, in the public domain.
