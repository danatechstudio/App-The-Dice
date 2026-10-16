-- Needs attention emails (docs/RTD_EVENT_CONTROL_AUDIT.md §5.1; Stage 3c): a notice
-- when a date passes with nothing after it, then a reminder every morning until it's
-- sorted. Sent through the outbox (n8n RTD Outbox). Additive.

-- When each item's first email was queued (or, for items already waiting when emails
-- were switched on, when it joined the daily reminder), and its reminders since.
ALTER TABLE attention_items ADD COLUMN first_notified_at TEXT;
ALTER TABLE attention_items ADD COLUMN last_reminded_at TEXT;
ALTER TABLE attention_items ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0;

-- Off, with nobody to email, until an admin sets the addresses and switches it on in
-- the organiser. The addresses live only in the live database, never in this repository.
INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES
  ('attention_emails', 'off', '2026-10-16T00:00:00Z', 'migration'),
  ('attention_email_to', '', '2026-10-16T00:00:00Z', 'migration');
