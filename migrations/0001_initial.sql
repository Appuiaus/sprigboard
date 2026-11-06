-- Sprigboard v1 schema. Money is integer cents (AUD). Dates are ISO strings.
-- Records Jamie deletes are soft-deleted (deleted_at) so nothing is lost by a misclick.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('business_name', 'Your business name'),
  ('abn', ''),
  ('gst_registered', '0'),
  ('email', ''),
  ('phone', ''),
  ('address', ''),
  ('payment_terms_days', '14'),
  ('payment_details', ''),
  ('job_prefix', 'J-'),
  ('job_next', '1'),
  ('job_pad', '4'),
  ('invoice_prefix', 'INV-'),
  ('invoice_next', '1'),
  ('invoice_pad', '4'),
  ('drawn_by', 'Jamie'),
  ('default_disclaimer', 'Not for construction. For presentation purposes only.');

CREATE TABLE clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  contact     TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  disclaimer  TEXT NOT NULL DEFAULT '',
  copyright   TEXT NOT NULL DEFAULT '',
  logo_key    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);

-- Fixed prices by job size (Jamie prices by size, not by the hour).
CREATE TABLE size_tiers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price_cents  INTEGER NOT NULL DEFAULT 0,
  sort         INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);

INSERT INTO size_tiers (name, description, price_cents, sort) VALUES
  ('Small',  'Small yard or a single garden area, few plant types', 0, 1),
  ('Medium', 'Typical house block, front and back', 0, 2),
  ('Large',  'Large block or many elements (fencing, play equipment, paving)', 0, 3),
  ('Extra large', 'Multi-lot, commercial or estate work', 0, 4);

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_number    TEXT NOT NULL UNIQUE,
  client_id     INTEGER REFERENCES clients(id),
  project       TEXT NOT NULL DEFAULT '',  -- end client or project name for the title block
  site_address  TEXT NOT NULL DEFAULT '',
  scope         TEXT NOT NULL DEFAULT '',
  tier_id       INTEGER REFERENCES size_tiers(id),
  scale         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'new',  -- new | drawing | sent | invoiced | done
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);

CREATE TABLE plan_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id),
  r2_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  read_status  TEXT NOT NULL DEFAULT 'unread',  -- unread | read | failed
  read_error   TEXT,
  summary      TEXT NOT NULL DEFAULT '',
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);

-- The checklist: what Claude read off the plan, plus anything Jamie adds by hand.
CREATE TABLE checklist_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES jobs(id),
  file_id    INTEGER REFERENCES plan_files(id),
  kind       TEXT NOT NULL,  -- plant | street | dimension | marking | note
  label      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  quantity   TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'manual',  -- claude | manual
  sort       INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX idx_items_job ON checklist_items(job_id);

-- Jamie's plant graphics library.
CREATE TABLE plant_symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  botanical   TEXT NOT NULL,
  common      TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL DEFAULT '',
  r2_key      TEXT,
  filename    TEXT,
  mime        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);

CREATE TABLE invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  number          TEXT NOT NULL UNIQUE,
  job_id          INTEGER REFERENCES jobs(id),
  client_id       INTEGER REFERENCES clients(id),
  issued_on       TEXT NOT NULL,
  due_on          TEXT NOT NULL,
  lines_json      TEXT NOT NULL,
  gst_registered  INTEGER NOT NULL DEFAULT 0,
  subtotal_cents  INTEGER NOT NULL,
  gst_cents       INTEGER NOT NULL,
  total_cents     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | paid
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);
