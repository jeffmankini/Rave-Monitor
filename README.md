# Rave Monitor archive

Every listing [Rave Monitor](https://ravemonitor.com) has shown, merged across platforms and kept after
the night is over. Updated by the daily refresh job; don't edit by hand.

- `events/YYYY-MM.ndjson`: one JSON object per line, filed by the event's local month. Each has the
  event facts (title, start, end, tz, cityId, venue, lineup, genres, tags, type, price, status, and
  record labels and promoter names when known), the
  platforms it was listed on (`sources`), when it was first and last seen, and `statusLog`
  (status changes such as sold out or cancelled, with when they were seen).
- `cities.json`: names and coordinates for each `cityId`.
- `summary.json`: counts by month, city, genre and platform.

Event facts only: no descriptions, attendee lists or organizer contact details. The site also offers
the whole archive as a SQLite database and a CSV file.
