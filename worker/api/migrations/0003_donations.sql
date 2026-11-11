-- Donations replace the $5-a-month supporter tier (worker/api/src/donate.js): every perk is free,
-- and nothing about donors is kept here, so the Stripe columns from 0002 go. No one subscribed while
-- the tier was open. Kept: custom_theme (their own colors), scene (scene alerts) and cal_token (the
-- calendar feed's secret), which every account now has.
DROP INDEX IF EXISTS users_stripe_customer;
ALTER TABLE users DROP COLUMN stripe_customer;
ALTER TABLE users DROP COLUMN stripe_sub;
ALTER TABLE users DROP COLUMN sub_status;
ALTER TABLE users DROP COLUMN sub_until;
ALTER TABLE users DROP COLUMN sub_cancel_at_end;
ALTER TABLE users DROP COLUMN supporter_since;
