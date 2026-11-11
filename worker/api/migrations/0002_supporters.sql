-- Supporters: $5 a month through Stripe (worker/api/src/billing.js keeps these columns in step
-- with Stripe's webhook). Perks last while sub_status is active, trialing or past_due and the paid
-- period (sub_until) hasn't ended. Times are Unix milliseconds.
-- stripe_customer, stripe_sub: their Stripe customer and subscription ids.
-- sub_cancel_at_end: 1 once they've cancelled; the perks run to sub_until.
-- supporter_since: when they first became one. custom_theme: their own colors, as JSON
-- ({"bg":"#rrggbb","accent":"#rrggbb"}). scene: 1 for scene alerts (every new night in their
-- cities and genres). cal_token: the secret in their calendar feed's address.
ALTER TABLE users ADD COLUMN stripe_customer TEXT;
ALTER TABLE users ADD COLUMN stripe_sub TEXT;
ALTER TABLE users ADD COLUMN sub_status TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN sub_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sub_cancel_at_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN supporter_since INTEGER;
ALTER TABLE users ADD COLUMN custom_theme TEXT;
ALTER TABLE users ADD COLUMN scene INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN cal_token TEXT;
CREATE INDEX users_stripe_customer ON users (stripe_customer);
CREATE UNIQUE INDEX users_cal_token ON users (cal_token);
