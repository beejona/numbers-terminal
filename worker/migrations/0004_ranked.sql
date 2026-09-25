-- Ranked runs: played through the server (src/session.js), timed by its clock. The old `scores`
-- table (times the browser reported) stays as "old times".
CREATE TABLE ranked_scores (
  count      INTEGER NOT NULL,
  mode       TEXT NOT NULL,
  name_key   TEXT NOT NULL,
  name       TEXT NOT NULL,
  time_ms    INTEGER NOT NULL,
  ping       INTEGER NOT NULL,           -- round trip to the server, measured by the server
  updated_at INTEGER NOT NULL,
  run        TEXT,
  PRIMARY KEY (count, mode, name_key)
);
CREATE INDEX ranked_by_time ON ranked_scores (count, mode, time_ms);
