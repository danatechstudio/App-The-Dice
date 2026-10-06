-- Bookings for open host sessions, and the app's email outbox
-- (docs/RTD_BOOKINGS.md). Customers book without an account; each booking
-- reserves party_size places against the occurrence's capacity.

CREATE TABLE bookings (
  booking_id              TEXT PRIMARY KEY,                      -- RTD-BK-00001
  occurrence_id           TEXT NOT NULL REFERENCES occurrences (occurrence_id),
  lead_name               TEXT NOT NULL,
  email                   TEXT NOT NULL COLLATE NOCASE,
  mobile                  TEXT,
  party_size              INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 10),
  notes                   TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  source                  TEXT NOT NULL DEFAULT 'app',
  cancelled_by            TEXT CHECK (cancelled_by IN ('customer', 'host', 'staff')),
  cancel_message          TEXT,
  cancelled_at            TEXT,
  -- SHA-256 of the secret in the customer's Manage / Cancel link. The secret itself is never stored.
  cancellation_token_hash TEXT NOT NULL UNIQUE,
  -- SHA-256 of the requester's IP and the day, only to limit how many bookings one address makes.
  ip_hash                 TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX bookings_by_occurrence ON bookings (occurrence_id, status);
CREATE INDEX bookings_by_email ON bookings (email, created_at);
CREATE INDEX bookings_by_ip ON bookings (ip_hash, created_at);

-- Emails the app has written, waiting for n8n (RTD Outbox) to send them.
-- to_email / reply_to NULL mean the café address, which only n8n knows (rtd_config).
CREATE TABLE outbox (
  message_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key  TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  to_email    TEXT,
  reply_to    TEXT,
  subject     TEXT NOT NULL,
  html        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE INDEX outbox_unsent ON outbox (message_id) WHERE sent_at IS NULL;

-- Who cancelled a date, and when (the status itself is occurrences.status = 'cancelled').
ALTER TABLE occurrences ADD COLUMN cancelled_by TEXT;

-- The last Event Index change sent for a cancelled date, so n8n makes it once.
ALTER TABLE host_sessions ADD COLUMN sheet_fix_sent TEXT;
ALTER TABLE host_sessions ADD COLUMN sheet_fix_sent_at TEXT;
