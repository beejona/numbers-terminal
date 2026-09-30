-- Ranked runs the server refused, and why (src/session.js): to see which check real players run
-- into. Only the latest few hundred are kept (index.js, saveRefusal).
CREATE TABLE refusals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  name       TEXT,
  count      INTEGER NOT NULL,
  mode       TEXT NOT NULL,
  time_ms    INTEGER NOT NULL,
  ping       INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  run        TEXT
);
