-- Small files kept in D1 while R2 isn't available (plant graphics, logos, small plans; 1 MB each at most).
CREATE TABLE blobs (
  key         TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Time spent per job: a running timer (ended_at NULL) or a finished/manual entry.
-- Jamie times practice jobs to set her size prices; she doesn't bill by the hour.
CREATE TABLE time_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  user_id     INTEGER REFERENCES users(id),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  minutes     INTEGER,            -- set when stopped or entered by hand
  note        TEXT NOT NULL DEFAULT '',
  deleted_at  TEXT
);
CREATE INDEX idx_time_job ON time_entries(job_id);

-- Jamie's own business logo for invoices.
INSERT INTO settings (key, value) VALUES ('business_logo_key', '') ON CONFLICT(key) DO NOTHING;
