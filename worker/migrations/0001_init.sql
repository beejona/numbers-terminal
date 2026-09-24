-- Who owns each leaderboard name: the SHA-256 of a random key kept in the browser that first used
-- it, so nobody else can post times under that name.
CREATE TABLE names (
  name_key   TEXT PRIMARY KEY,           -- lowercased, so "Beejona" and "beejona" are one name
  name       TEXT NOT NULL,              -- as first entered
  owner      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Each name's best per terminal size and play mode.
CREATE TABLE scores (
  count      INTEGER NOT NULL,           -- 14 or 10 numbers
  mode       TEXT NOT NULL,              -- 'click', 'drop' (drop key) or 'hover'
  name_key   TEXT NOT NULL,
  name       TEXT NOT NULL,
  time_ms    INTEGER NOT NULL,
  ping       INTEGER NOT NULL,           -- the simulated ping the run was played with
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (count, mode, name_key)
);
CREATE INDEX scores_by_time ON scores (count, mode, time_ms);

-- Names taken off the board by hand, which can't be used again.
CREATE TABLE blocked_names (
  name_key   TEXT PRIMARY KEY,
  blocked_at INTEGER NOT NULL
);

-- Submissions per address per minute, for the rate limit.
CREATE TABLE hits (
  ip     TEXT NOT NULL,
  minute INTEGER NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (ip, minute)
);
