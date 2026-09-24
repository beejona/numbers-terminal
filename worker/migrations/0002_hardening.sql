-- Rate limits moved to Cloudflare's rate limiter, so addresses aren't kept in the database.
DROP TABLE IF EXISTS hits;

-- New names per address per day (the address hashed with a secret, never stored as is).
CREATE TABLE name_claims (
  who TEXT NOT NULL,
  day INTEGER NOT NULL,
  n   INTEGER NOT NULL,
  PRIMARY KEY (who, day)
);
