-- Phase 1 data foundation.
-- The RTD Logic Engine (Google Sheet) stays authoritative for events and their
-- next date. This database holds the app's operational copy plus everything the
-- sheet cannot: occurrence history, audit, sync runs, users and settings.

-- One row per permanent event identity (RTD-EVT-00001), synced from the
-- Logic Engine "Event Index" and "Standard Diary" tabs.
CREATE TABLE events (
  event_id          TEXT PRIMARY KEY,
  source            TEXT NOT NULL CHECK (source IN ('event_index', 'standard_diary', 'app')),
  source_row        INTEGER,
  event_name        TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  category          TEXT CHECK (category IN ('Gaming', 'Quiz', 'Social', 'Club', 'Tournament', 'Market', 'Workshop', 'Other')),
  description       TEXT,
  frequency         TEXT NOT NULL CHECK (frequency IN ('weekly', 'fortnightly', 'monthly', 'one-off')),
  repeatable        INTEGER NOT NULL DEFAULT 0,
  requires_redating INTEGER NOT NULL DEFAULT 0,
  visibility        TEXT NOT NULL DEFAULT 'hidden' CHECK (visibility IN ('public', 'app_bookable', 'private', 'hidden')),
  sheet_status      TEXT,
  active            INTEGER NOT NULL DEFAULT 0,
  default_image     TEXT,
  default_capacity  INTEGER,
  default_host_id   TEXT,
  photo_folder_id   TEXT,
  source_hash       TEXT,
  last_synced_at    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One row per dated occurrence. Never overwritten with a different date and
-- never deleted: when the sheet moves an event to a new date, the old
-- occurrence is completed (past) or marked rescheduled (future).
CREATE TABLE occurrences (
  occurrence_id        TEXT PRIMARY KEY,
  event_id             TEXT NOT NULL REFERENCES events (event_id),
  event_date           TEXT NOT NULL,
  start_time           TEXT,
  end_time             TEXT,
  starts_at            TEXT,
  ends_at              TEXT,
  all_day              INTEGER NOT NULL DEFAULT 0,
  -- 1 = generated from the event's weekly/fortnightly cadence, not yet the
  -- date held in the Logic Engine. Becomes 0 when the sheet reaches it.
  projected            INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled', 'rescheduled')),
  rescheduled_to       TEXT,
  host_id              TEXT,
  capacity             INTEGER,
  booking_enabled      INTEGER NOT NULL DEFAULT 0,
  booking_deadline     TEXT,
  visibility           TEXT CHECK (visibility IN ('public', 'app_bookable', 'private', 'hidden')),
  price_display        TEXT,
  image_override       TEXT,
  description_override TEXT,
  approved_at          TEXT,
  completed_at         TEXT,
  cancelled_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (event_id, event_date)
);

CREATE INDEX occurrences_by_date ON occurrences (event_date, status);
CREATE INDEX occurrences_by_event ON occurrences (event_id, status);

-- Append-only record of every significant change (spec §34).
CREATE TABLE audit_log (
  audit_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  occurrence_id  TEXT,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('system', 'n8n', 'staff', 'host', 'customer')),
  actor_id       TEXT,
  action         TEXT NOT NULL,
  previous_value TEXT,
  new_value      TEXT,
  source         TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX audit_by_entity ON audit_log (entity_id, created_at);
CREATE INDEX audit_by_time ON audit_log (created_at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- One row per sync attempt from n8n. run_id is the idempotency key.
CREATE TABLE sync_runs (
  run_id              TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('ok', 'rejected')),
  reason              TEXT,
  rows_received       INTEGER NOT NULL DEFAULT 0,
  events_seen         INTEGER NOT NULL DEFAULT 0,
  events_changed      INTEGER NOT NULL DEFAULT 0,
  occurrences_created INTEGER NOT NULL DEFAULT 0,
  occurrences_updated INTEGER NOT NULL DEFAULT 0,
  warnings            TEXT,
  received_at         TEXT NOT NULL
);

-- Host / Staff / Admin accounts. Sign-in is Cloudflare Access (email one-time
-- PIN); this table decides what a signed-in email may do.
CREATE TABLE users (
  user_id      TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  role         TEXT NOT NULL CHECK (role IN ('host', 'staff', 'admin')),
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

INSERT INTO settings (key, value, updated_at, updated_by) VALUES
  ('projection_weeks', '6', '2026-10-05T00:00:00.000Z', 'migration'),
  ('splash_window_days', '14', '2026-10-05T00:00:00.000Z', 'migration'),
  ('waitlist_offer_hours', '12', '2026-10-05T00:00:00.000Z', 'migration'),
  ('reminder_lead_minutes', '240', '2026-10-05T00:00:00.000Z', 'migration');
