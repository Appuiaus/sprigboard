-- Passkeys (WebAuthn). Public keys only; the private key never leaves the person's device.
CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,               -- credential ID, base64url
  user_id       INTEGER NOT NULL REFERENCES users(id),
  public_key    TEXT NOT NULL,                  -- COSE public key, base64url
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT NOT NULL DEFAULT '[]',     -- JSON array
  backed_up     INTEGER NOT NULL DEFAULT 0,     -- synced passkey (iCloud Keychain, Google Password Manager, …)
  name          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

-- Short-lived, single-use WebAuthn challenges.
CREATE TABLE webauthn_challenges (
  id          TEXT PRIMARY KEY,                 -- random flow id handed to the browser
  purpose     TEXT NOT NULL,                    -- register | login
  user_id     INTEGER REFERENCES users(id),
  challenge   TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
