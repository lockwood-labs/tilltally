-- TillTally D1 schema. Apply with:
--   npx wrangler d1 execute tilltally --remote --file=./schema.sql
-- (run from this worker/ folder, after creating the database — see README)

CREATE TABLE IF NOT EXISTS households (
  code       TEXT PRIMARY KEY,
  data       TEXT,                 -- the household's whole TillTally dataset as JSON (core.js shape)
  updated_at TEXT NOT NULL         -- ISO timestamp of the last write
);
