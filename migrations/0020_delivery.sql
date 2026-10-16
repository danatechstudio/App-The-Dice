-- Delivery (docs/RTD_EVENT_CONTROL_AUDIT.md §5.2-5.3, G-3, G-4; Stage 4b). Additive:
-- new nullable columns on the outbox, and two new tables.

-- The email outbox records each attempt, so a failed email is retried and then given
-- up on visibly, instead of stopping RTD Outbox. A message is:
--   sent     sent_at is set: Gmail accepted it (not proof it was read);
--   dead     dead_at is set: it failed 6 times; an admin can try again;
--   sending  n8n collected it in the last 10 minutes (claim, claimed_at);
--   failing  it failed and is tried again from next_attempt_at;
--   queued   otherwise.
-- booking_id: the booking a customer's email is about, so a failure can say who to contact.
ALTER TABLE outbox ADD COLUMN booking_id TEXT;
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN last_error TEXT;
ALTER TABLE outbox ADD COLUMN last_attempt_at TEXT;
ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT;
ALTER TABLE outbox ADD COLUMN claim TEXT;
ALTER TABLE outbox ADD COLUMN claimed_at TEXT;
ALTER TABLE outbox ADD COLUMN dead_at TEXT;

-- Devices someone asked, when booking, to be told on if the date is cancelled or moved.
-- Opt-in, for that one booking; deleted the day after its date (src/lib/privacy.ts).
CREATE TABLE booking_devices (
  device_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id   TEXT NOT NULL REFERENCES bookings (booking_id),
  -- The push service URL for one browser. It works like a password: never shown.
  endpoint     TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  device_label TEXT,
  created_at   TEXT NOT NULL,
  -- The push service said this browser has gone (404 or 410): never used again.
  invalid_at   TEXT,
  UNIQUE (booking_id, endpoint)
);
CREATE INDEX booking_devices_by_endpoint ON booking_devices (endpoint);

-- A push to one booking device, written in the same batch as the change it tells of
-- and sent by the Worker's every-minute Cron Trigger. Same states as the outbox.
CREATE TABLE push_outbox (
  push_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'push:date-cancelled:<occurrence_id>:<device_id>', 'push:date-moved:…': each once only.
  dedupe_key      TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  device_id       INTEGER NOT NULL,
  booking_id      TEXT NOT NULL,
  occurrence_id   TEXT,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  url             TEXT NOT NULL,
  tag             TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_status     INTEGER,                      -- the push service's last answer (0: unreachable; -1: the device was turned off first)
  last_error      TEXT,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  claim           TEXT,
  claimed_at      TEXT,
  sent_at         TEXT,
  dead_at         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX push_outbox_unsent ON push_outbox (push_id) WHERE sent_at IS NULL AND dead_at IS NULL;
