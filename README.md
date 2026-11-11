# Rave Monitor, by [Geff Bohm](https://geffbohm.com)

Live at [ravemonitor.com](https://ravemonitor.com). Like it? Use the Donate button there, once or monthly. A live map of electronic music: club nights, festivals, day parties and where touring DJs play next.

Rave Monitor started inside split/shift, a Milwaukee dance-music nonprofit, out of a need for a better way to browse events and happenings, so we could plan our work and create new event experiences with the whole scene in view. It's open source, inspired by World Monitor-style dashboards, and free for everyone.

A scheduled job pulls public listings from Resident Advisor, Posh, Partiful, Luma, Ticketmaster and Skiddle (DICE is wired up but switched off), keeps the electronic ones, merges nights listed on more than one platform, and writes one `events.json`. A second step writes `streams.json`, the livestreams for the Streams tab. The site is a single HTML page that reads those files. Without a feed, it falls back to a built-in demo with fictional events.

On the page:

- **The map.** Zoomed out, each city is a cluster of dots. Zoom in and a street map fades in (OpenStreetMap data from OpenFreeMap's free vector tiles, drawn with MapLibre and loaded only when you zoom), with neighbourhoods, streets and each venue in its place. Selecting a city frames its venues.
- **Listings, for planning.** Every listing in the chosen time window (live now up to 30 days), grouped by night, with lineups, genres and prices, plus the busiest nights, the leading genres and who's playing more than once. Zoomed in to street level, each venue on the map shows its next date and headliners in the genre's colour, and the legend says which colour is which genre.
- **Lists follow the map.** Once you zoom in yourself (scroll, pinch, the + button or picking a city), Live now, Wire, Scene heat, Genres and the other lists only show what's in the map area, and "Show everywhere" zooms back out. Opening an event from a list moves the map without narrowing the list.
- **Spinning globe.** In Globe view, Spin (or S) turns the globe on its own like a screensaver, with a caption for the city it's passing over: its local time, what's live and what's coming up. Drag or zoom to look around and it carries on a few seconds later; pick a place or switch to the map to stop it. In full screen the controls fade until you move.
- **Full-screen map.** The corner-arrows button (or F) puts the map over the whole window, and the whole screen where the browser allows it, with its own controls; Esc or the button brings the lists back.
- **Near me.** The map opens near you, from a guess based on your browser's time zone, and the crosshair button uses your actual location to frame the closest city with listings and show where you are. The location stays in the browser: it isn't sent anywhere, and the browser only asks for it when you press the button.
- **Promoters & groups.** The Promoters tab lists who's throwing nights in the map area (or everywhere): promoters, collectives and event series, busiest first, with where they play and their next night, and a switch to record labels. Pick one for its card (based in, cities, venues, sounds, nights listed, website, past nights) and its nights on the map. Promoters come from the listings, plus collectives and event series found in titles (`config/promoters.json`, which is also where a group's home city, website and kind live; split/shift is on it). A venue's own nights stay under Venues.
- **Venues.** The Venues tab lists the clubs in the map area (or everywhere), busiest first, each with its next night and a bar of the sounds it books; concert venues and theatres come after the clubs. Zoomed in, every venue is on the map as a pool in the colour of its main sound, sized by how often it's listed, so the quiet ones show too, and the clubs and music venues on OpenStreetMap that haven't had a listing yet show as faint dashed rings (they're in the tab and search too, with their website and directions). Pick a venue (from the tab, the map, search or an event's venue name) to filter everything to its nights and see its card: address, sounds, regulars, directions and its past nights in the archive. The venue list comes from the archive, so it grows with it, and one venue's spellings and rooms across platforms ("SWG3", "TV Studio SWG3") count as one. Venues that should be there before a listing names them, like split/shift's space in Milwaukee, are in `config/venues.json` with their exact spot, address and website; listings that name one join it.
- **Accounts and alerts.** Sign in with a link emailed to you (no password) to follow artists, venues, promoters and labels, save shows, and pick your cities, genres and emails. Alerts collect under the bell: new shows from who you follow (only in your cities, if you like), a reminder the day before a saved show, a heads-up when one sells out, is cancelled or postponed, and weekly picks for your cities and genres. Email comes right away or as a daily or weekly digest, with one-click unsubscribe. Scene alerts, if you turn them on, bring every new night in your cities and genres. "Your shows" lists every upcoming night from who you follow, with a calendar feed of them for Google, Apple or Outlook Calendar, and you can delete your account from its settings. See [Accounts](#accounts) to switch it on.
- **Record labels.** Search a label (Drumcode, Hospital Records, Hessle Audio…) or a promoter to filter the map and every list to their nights. A label with nothing coming up links to its past nights in the archive. Labels come from a curated list (`config/labels.json`) found in event titles, promoter names and lineup credits like "Ben UFO (Hessle Audio)"; listings have no label field of their own.
- **On phones.** A compact header and one swipeable filter row (the time window is a native picker), the map with Near me and a key that folds away, Listings first with night headings that stay pinned, a Map button to jump back up, and event details in a sheet you drag down to close, with the ticket link and Share always in reach. Inputs are 16px so iOS doesn't zoom, controls are thumb-sized, and it can be added to the home screen. The detailed coastline and the street map library load only when needed.
- **Colors.** The palette button in the header switches the whole site, map included, between six themes (`config/themes.json`): Midnight, Ember, Acid, Ultraviolet, Lagoon and Graphite, or Your own: pick a background and an accent, and `site/themekit.js` works out the rest (kept dark, with readable text). The choice stays in the browser (`localStorage` `rm_theme`, and `rm_theme_custom` for your own colors) and every page applies it before it draws; signed in, your own colors are saved to your account too. `test/themes.test.js` checks each theme's text contrast.
- **What's new.** A changelog of what visitors would notice (`config/updates.json`, newest first), in a panel from the map page's footer and at `/updates/`. A dot by the link marks a change from the last three weeks that this browser hasn't opened yet.
- **Streams.** What's on air on NTS Radio right now and its coming club shows, plus live and scheduled YouTube streams from Boiler Room, Cercle, HÖR and other channels. They play on the site, in a mini player docked at the bottom that keeps going while you browse (`site/player.js`): YouTube in its privacy-enhanced embed, loaded only when you press play and only for channels that allow embedding, and NTS from the stream links NTS publishes for listeners' own players. A click with a modifier key still opens the stream's own page.
- **Donate.** The Donate button opens a pop-up for a gift once or every month, through Stripe (see [Donations](#donations)). Every feature is free for everyone; a gift unlocks nothing.

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
- **Genres.** Listings map to eight families: techno, house, drum and bass, afro and amapiano, disco and edits, garage and breaks, trance and psy, bass and dubstep. A listing none of them fits is **Dance/electronic** (EDM, electronica, club and ambient nights, or an untagged night from a source that only lists electronic music, like RA) or **Misc** (pop, rock, hip-hop, R&B, Latin and other shows, or no clue at all). A genre tag on the listing decides first: Ticketmaster's "Dance/Electronic" is Dance/electronic, its "Pop/Rock" is Misc.
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
- `osm/` holds OpenStreetMap's clubs and music venues within 30 km of each city (`pipeline/osm.js`, from the Overpass API about once a week): they put the venues with no listings yet on the map, add websites and addresses, and place listed venues that came without a position. That data is © OpenStreetMap contributors under the ODbL; the site credits it wherever it shows.
- `/archive/data/venues.json` is the venue directory the Venues tab and map layer use (`pipeline/venues.js`): every place that has hosted a night, its spellings merged, with its position, how many nights it's had, its sounds and regulars.
- The site offers the whole archive as a SQLite database (`/archive/archive.sqlite`, with `events`, `event_artists`, `event_sources`, `event_status` and `cities` tables) and a CSV file (`/archive/events.csv`), rebuilt on every deploy.
- It's only as complete as the scrapes: paid sources are capped per city, so busy cities hold a sample of their nights.

To build it locally: `node pipeline/archive.js <dir> public/events.json`, then `node pipeline/archive-export.js <dir> <out-dir>`.

## Configuration

- `config/cities.json` lists the 72 cities and, for each, what to ask every source for: the RA area page, the DICE browse page (the part after dice.fm/browse/), the Posh explore location, the Partiful city slug and the Luma city handle. Some RA area pages are best guesses; if a city comes back empty, copy the right URL from ra.co. A city can list more than one RA page, and a wrong one simply returns nothing.
- `config/site.json` holds `gaMeasurementId`, the Google Analytics 4 Measurement ID (empty: no analytics). The tag uses Google Consent Mode: no ad features anywhere, and analytics cookies stay off in the EEA, the UK and Switzerland until the consent tool says yes. Paste the consent tool's embed code (Termageddon and Usercentrics) into `site/consent.html`; the build puts it at the top of the head, between the Consent Mode defaults and the Analytics tag. Besides page views, the site sends `open_event`, `ticket_click`, `stream_click`, `select_city`, `select_search_result`, `open_tab`, `set_filter` (genres, labels, promoters, venues), `set_view`, `fullscreen_map`, `spin_globe`, `sign_in_start`, `sign_in`, `sign_out`, `follow`, `unfollow`, `save_event`, `unsave_event`, `open_alerts`, `delete_account`, `open_colors`, `set_colors` (the theme), `open_updates`, `stream_play` (a stream opened in the mini player), `player_close`, `donate_open`, `donate_start` and `donate_done` (once or monthly, and the amount), `calendar_link`, `locate` (how, and the nearest listing city, never coordinates), `archive_search` and `contact_submit` events; register parameters such as `city` and `listing_source` as custom dimensions in Analytics to see them in reports.
- `config/labels.json` is the record label list. Each label has a `name` and, where its name is an ordinary word, distinctive `match` phrases ("Warp Records", not "Warp", which would match "Time Warp"), `lead` phrases that only count at the start of a title ("RINSE: …") or `genres` it's limited to ("Hospitality" only for drum and bass nights). The archive works labels out again on every run, so additions reach past nights too.
- The contact page (`/contact/`) is built when `config/site.json` has `contactEndpoint` and `turnstileSiteKey`. Its back end is a Cloudflare Worker (`worker/api`, which also serves accounts) that checks Cloudflare Turnstile, a per-IP rate limit and a honeypot, then emails the message through Cloudflare Email Routing with Reply-To set to the visitor; nothing is stored. `.github/workflows/api-worker.yml` deploys it to `api.ravemonitor.com` when it changes, with the GitHub Actions secrets `CLOUDFLARE_API_TOKEN` (Account > Workers Scripts > Edit, Account Settings > Read, Zone > Workers Routes > Edit), `CLOUDFLARE_ACCOUNT_ID`, `CONTACT_TO` (the verified Email Routing destination) and `TURNSTILE_SECRET`.
- `config/legal.json` lists the policy pages built to `/<slug>/` (Termageddon policies by their embed ID, or the page's own text, like the accessibility statement). They're linked from the About panel and from each other, with the consent tool's Privacy Settings link.
- `config/sources.json`: `feedDays` (31) is how far ahead the feed goes. Keep `windowDays` as it is: saved scrapes are matched by it, so changing it means paying for every scrape again.
- `config/streams.json` sets the YouTube channels for the Streams tab (add any channel id; `genres` and `city` are optional) and how far ahead NTS shows are listed.
- `config/sources.json` turns sources on or off and sets cities, caps, spending limits and how long a scrape stays fresh. Any Apify actor can be swapped in by changing `actor` and its `normalize()` in `pipeline/sources/`.
- Link previews: the title, description and share image are in the head of `site/index.html`. Their URLs use `SITE_URL` (default `https://ravemonitor.com`); set it as an environment variable when building for another address. The share image, `site/static/og-image.jpg`, is a screenshot of `scripts/og-card.html` at 1200×630 (instructions are in that file). Everything in `site/static` (icons, share image) is copied next to the page.

## Accounts

Accounts are off until `config/site.json` has `accountsApi`. Turning them on:

1. **Postmark** sends the sign-in links and alerts. In Postmark, create a server for Rave Monitor and add `ravemonitor.com` under Sender Signatures as a domain, then add the DKIM and Return-Path records it shows to the domain's DNS in Cloudflare. Add the server's API token (its API Tokens tab) as the GitHub Actions secret `POSTMARK_TOKEN`. Alerts go out on a broadcast stream named `alerts`, which the alerts step makes the first time; sign-in links use the server's default transactional stream.
2. **Cloudflare D1** holds the accounts. Edit the `CLOUDFLARE_API_TOKEN` token and add **Account > D1 > Edit**. The next run of `.github/workflows/api-worker.yml` (run it by hand from the Actions tab) creates the `ravemonitor-accounts` database, applies `worker/api/migrations`, and deploys the Worker with it.
3. Set `"accountsApi": "https://api.ravemonitor.com/v1"` in `config/site.json`. The site then shows Sign in, Follow and Save, and the refresh workflow's `alerts` job (`pipeline/notify.js`) writes alerts and sends emails after every refresh.
4. Update the privacy and cookie policies (Termageddon here) to cover accounts: email addresses, follows, saved shows and settings, Postmark as the email processor, and the sign-in cookie (`rm_session`, strictly necessary).

Alerts are kept for 180 days; expired sessions and sign-in links are deleted by the alerts step. How it works: the API Worker (`worker/api/src/accounts.js`) emails a sign-in link that works once, for 15 minutes; the link's page trades it for an HttpOnly session cookie on `api.ravemonitor.com`. Only hashes of links and sessions are stored, and there are no passwords. Sign-in asks for Turnstile, and every route is rate limited. The alerts step only counts listings first seen since its last run as new (`seen_events`), compares names the way the site does (`worker/api/src/keys.js`), and sends changes and reminders right away and new shows on each person's schedule (8am in their time zone for digests, Thursdays for weekly ones). An address Postmark won't deliver to has its emails turned off. Locally: `npx wrangler dev` in `worker/api` with `--var DEV_MODE:1 --var SITE_URL:http://localhost:8778 --var ALLOWED_ORIGINS:http://localhost:8778` shows sign-in links instead of emailing them, and `ACCOUNTS_API=http://localhost:8787/v1 ACCOUNTS_TURNSTILE= npm run site` builds the site against it.

## Donations

The Donate button opens a pop-up (`site/donate.js`) where people give once or every month: $5, $10, $25 or $50 once, $3, $5, $10 or $25 a month, or their own amount from $1 to $1,000. Payment happens in Stripe Checkout, inside the pop-up (Stripe's embedded checkout, with Stripe.js loaded only then) or, without a publishable key, on Stripe's own page and back. Nothing about donors is kept by Rave Monitor and a gift isn't tied to an account; Stripe holds the payments and, for monthly gifts, the subscriptions. Monthly donors change or cancel from the pop-up's "Change or cancel a monthly gift" link, which leads to Stripe's customer portal login page (Stripe emails them a link).

Turning it on:

1. In Stripe, create a restricted key with **Write** on Checkout Sessions, Products, Prices, Customer portal, Webhook Endpoints and Payment Method Domains, and **Read** on Subscriptions, and add it as the GitHub Actions secret `STRIPE_SECRET_KEY`.
2. Add the account's publishable key (`pk_live_…`, under Developers > API keys) as the secret `STRIPE_PUBLISHABLE_KEY`, so checkout opens inside the pop-up.
3. Run `.github/workflows/api-worker.yml` by hand. It makes the product every gift is for (id `rm_donation`), turns on the customer portal's login page (cancel straight away, change the card, past payments), registers `ravemonitor.com` for Apple Pay, Google Pay and Link in the pop-up, and gives the Worker both keys.
4. In Stripe's settings, turn on receipt emails for successful payments, and check the public business name and statement descriptor donors will see.

How it works: `worker/api/src/donate.js` makes a Checkout Session for each gift (`POST /v1/donate`, from the site only, rate limited), with the amount as an inline price on the `rm_donation` product, the site's current colors for Stripe's page, and the API version pinned. Back on the site (`?donated=<session>`), the pop-up asks `GET /v1/donate/session` how it went, which answers with the status and amount only. `GET /v1/donate/manage` sends monthly donors to the portal's login page. The deploy also archives what was left of the earlier $5-a-month supporter tier. Update the privacy policy for Stripe as the payment processor.

## Scraping responsibly

This is a non-commercial demo built on third-party scrapers. It tries to be a good citizen:

- **Event details only.** It keeps titles, times, venues, lineups, prices, status and links. It never stores descriptions, attendee or guest lists, or organizer contact details, even where a scraper offers them. Contact or credit lines that turn up in a lineup ("booking: name@…", "Instagram: …", "Founder @…") are dropped too.
- **Opt-outs are respected.** Posh events whose organizers turned off third-party display are skipped, and only public Partiful events are used.
- **Light load.** Sources are scraped on a schedule and cached, never on page views, and every listing links back to its source.
- **Event facts only, in the archive too.** Raw scrapes live only in the job's cache. The archive branch and the deployed files keep the same event facts as the site (title, time, venue, lineup, genres, price, status, links), never descriptions, attendee lists or organizer contacts.
- **Removal on request.** If a platform or promoter asks to be left out, switch the source off or filter them in `normalize()`.

Each scraper is run by its own author under the platform's terms. Check those terms before running this at any scale.

## The feed format

`events.json` holds `generatedAt`, `sources` (a per-source report), `cities` and `events`. Each event looks like this (`labels` and `promoters` only when there are some; promoters are names only):

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
  "labels": ["Hessle Audio"],
  "promoters": ["Body Heat"],
  "sources": [
    { "id": "ra", "name": "Resident Advisor", "url": "https://ra.co/events/9100005" },
    { "id": "dice", "name": "DICE", "url": "https://dice.fm/event/..." }
  ]
}
```

## Project layout

```
config/            cities and source settings; themes.json (the color themes) and updates.json (What's new)
pipeline/run.js    builds public/events.json
pipeline/archive*.js, venues.js, osm.js  the archive branch, its exports, the venue directory and OpenStreetMap's clubs
pipeline/streams.js builds public/streams.json (NTS and YouTube)
pipeline/notify.js  alerts and their emails, after each refresh (accounts, scene alerts and digests)
pipeline/lib/      normalize, merge duplicates, Apify client, helpers
pipeline/sources/  one adapter per source
pipeline/sample/   sample input in each platform's format
site/              the map: index.html, app.js, account.js, player.js (the stream player), donate.js, demo engine, map shapes, archive and contact pages
worker/api/        the Cloudflare Worker behind api.ravemonitor.com: the contact form, accounts, donations (Stripe) and the calendar feed
scripts/           build-site.js (assembles dist/, with themes.js and updates.js), serve.js (local preview), make-tz.js (site/tz.json)
test/              node --test
```

## License

MIT. The fonts, Archivo and Unbounded, are served from the site itself (`site/static/fonts`, from Fontsource) under the SIL Open Font License 1.1, so no page loads anything from Google Fonts. Map shapes are from Natural Earth via world-atlas, in the public domain. The street map is © OpenStreetMap contributors (ODbL), with tiles from OpenFreeMap and the OpenMapTiles schema, drawn with MapLibre GL JS (BSD-3-Clause).
