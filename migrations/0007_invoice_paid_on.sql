-- When an invoice was paid (for cash-basis GST and the invoice list).
ALTER TABLE invoices ADD COLUMN paid_on TEXT;
UPDATE invoices SET paid_on = substr(created_at, 1, 10) WHERE status = 'paid' AND paid_on IS NULL;
