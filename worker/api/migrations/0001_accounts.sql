-- Rave Monitor accounts: who signed in, what they follow and save, and their alerts.
-- Times are Unix milliseconds. Applied by the API Worker's deploy (wrangler d1 migrations apply).

-- One row per person. An email address is all an account needs; there are no passwords.
-- cities, genres: ids from the site. tz: their time zone, for when digests go out.
-- email_freq: 'instant' | 'daily' | 'weekly' | 'off'. alerts: which kinds they want.
-- mine: new-show alerts only in their cities (when they've picked any).
-- unsub: the secret in their emails' unsubscribe link. digest_at: when their last digest went out.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  cities TEXT NOT NULL DEFAULT '[]',
  genres TEXT NOT NULL DEFAULT '[]',
  tz TEXT NOT NULL DEFAULT 'UTC',
  email_freq TEXT NOT NULL DEFAULT 'daily',
  alerts TEXT NOT NULL DEFAULT '{"follows":true,"saved":true,"picks":true}',
  mine INTEGER NOT NULL DEFAULT 1,
  unsub TEXT NOT NULL,
  digest_at INTEGER NOT NULL DEFAULT 0
);

-- Sign-in links. Only a hash of the link's secret is kept; each works once, for 15 minutes.
CREATE TABLE login_links (
  hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX login_links_email ON login_links (email, created_at);

-- Signed-in browsers. The cookie holds a random secret; only its hash is kept here.
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Follows. kind: 'artist' | 'venue' | 'promoter' | 'label'. key: the name as the site compares it
-- (a venue's key is its directory id). label: the name as shown. city: a venue's city.
CREATE TABLE follows (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  city TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, key)
);
CREATE INDEX follows_key ON follows (kind, key);

-- Saved shows, with enough of the listing to show it after it leaves the feed.
CREATE TABLE saves (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start TEXT,
  city TEXT,
  venue TEXT,
  url TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX saves_event ON saves (event_id);

-- Alerts, written by the alerts step after each refresh (pipeline/notify.js).
-- kind: 'new_show' | 'reminder' | 'soldout' | 'cancelled' | 'postponed' | 'picks'.
-- ref: what it's about, so each alert is made once (an event id, or 'picks:<date>').
-- data: the listing(s) as JSON, for showing the alert.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  emailed_at INTEGER,
  UNIQUE (user_id, kind, ref)
);
CREATE INDEX notifications_user ON notifications (user_id, id);
CREATE INDEX notifications_unsent ON notifications (emailed_at, created_at);

-- Every listing the alerts step has seen: when it first appeared (so only new ones are news), a
-- fingerprint that survives a listing changing id, and its last ticket status.
CREATE TABLE seen_events (
  id TEXT PRIMARY KEY,
  fp TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT ''
);
CREATE INDEX seen_events_fp ON seen_events (fp);
