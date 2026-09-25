-- The record of each best run (JSON, see src/checkrun.js), kept for looking into suspicious times.
-- Runs posted before records existed have none.
ALTER TABLE scores ADD COLUMN run TEXT;
