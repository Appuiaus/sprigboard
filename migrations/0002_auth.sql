-- Sprigboard's own sign-in (replaces Cloudflare Access): email + password, email codes,
-- password reset and invites. Only hashes of secrets are stored, never the secrets.

CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,          -- stored lower case
  name           TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT 'member', -- owner | member
  password_hash  TEXT,                          -- pbkdf2-sha256$iterations$salt$hash; NULL until set
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at  TEXT,
  deleted_at     TEXT
);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,               -- SHA-256 of the cookie value
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- One-time secrets: sign-in codes, password reset links and invite links.
CREATE TABLE auth_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose     TEXT NOT NULL,                    -- code | reset | invite
  email       TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_auth_tokens_lookup ON auth_tokens(purpose, email);
CREATE INDEX idx_auth_tokens_hash ON auth_tokens(token_hash);

-- Fixed-window rate limits (failed passwords, codes sent, …) keyed by email or IP.
CREATE TABLE rate_limits (
  key           TEXT PRIMARY KEY,
  window_start  INTEGER NOT NULL,               -- unix seconds
  count         INTEGER NOT NULL DEFAULT 0
);
