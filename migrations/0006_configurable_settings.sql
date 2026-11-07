-- Settings are now defined in src/settings.ts with defaults, so new settings need no rows here.
-- Each invoice keeps the GST rate it was made with.
ALTER TABLE invoices ADD COLUMN gst_rate REAL NOT NULL DEFAULT 10;
-- The getting-started checklist switch replaces the old "hidden" flag.
INSERT INTO settings (key, value) SELECT 'show_onboarding', CASE WHEN value = '1' THEN '0' ELSE '1' END
  FROM settings WHERE key = 'onboarding_hidden' ON CONFLICT(key) DO NOTHING;
