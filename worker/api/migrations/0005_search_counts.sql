-- Searches on the map, counted by day for Rave Monitor's own dashboard (worker/api/src/insights.js).
-- Nothing about who searched: no account, IP address or cookie. One row per day and combination,
-- with how many times it happened. Rows older than 400 days are deleted.
--   q:     what was typed, lowercased and trimmed (addresses, long numbers and links are never kept)
--   kind:  the kind of result picked (artist, venue, promoter, label, city, genre, event, osm), '' for none
--   pick:  the picked result's name, '' for none
--   city:  the city in view on the map, '' when zoomed out
--   found: 1 when the search had results
CREATE TABLE search_daily (
  day TEXT NOT NULL,
  q TEXT NOT NULL,
  kind TEXT NOT NULL,
  pick TEXT NOT NULL,
  city TEXT NOT NULL,
  found INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, q, kind, pick, city, found)
);
CREATE INDEX search_daily_day ON search_daily (day);
