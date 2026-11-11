-- A clean slate, at the owner's request (November 10, 2026): every account and everything that hung
-- off it (follows, saved shows, alerts, sessions, sign-in links), and the search counts, so the admin
-- dashboard starts from zero. The tables stay; only their rows go. On a new database this does nothing.
-- seen_events (which listings the alerts step has already seen) is kept, so people who sign up from
-- now on aren't sent alerts for shows that were listed long ago.
DELETE FROM notifications;
DELETE FROM follows;
DELETE FROM saves;
DELETE FROM sessions;
DELETE FROM login_links;
DELETE FROM users;
DELETE FROM search_daily;
