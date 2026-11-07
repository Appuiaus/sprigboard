-- GST is two separate things:
--   settings.gst_registered   the business is registered for GST (invoices that add GST are titled "Tax invoice");
--   settings.gst_on_invoices  whether new invoices add 10% GST (the default for each invoice; can be changed per invoice).
-- invoices.gst_registered keeps its meaning of "this invoice adds GST"; invoices.business_gst_registered records
-- whether the business was registered when the invoice was made.
INSERT INTO settings (key, value) SELECT 'gst_on_invoices', value FROM settings WHERE key = 'gst_registered'
  ON CONFLICT(key) DO NOTHING;
ALTER TABLE invoices ADD COLUMN business_gst_registered INTEGER NOT NULL DEFAULT 0;
UPDATE invoices SET business_gst_registered = gst_registered;
