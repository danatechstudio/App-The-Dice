-- Event alerts (docs/RTD_ALERTS.md): anyone can turn them on in the app, with
-- no account. Admins send a reminder about an event whenever they like (and it
-- posts to Facebook); the app also sends one about a random event at 8pm, at
-- most every 48 hours.

-- Devices with event alerts on. Separate from push_subscriptions (approvers).
CREATE TABLE alert_subscriptions (
  -- The push service URL for one browser on one device. It works like a password: never shown.
  endpoint     TEXT PRIMARY KEY,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  device_label TEXT,
  -- Scrambled network address and day, only for the turn-ons-an-hour limit; erased after 2 days.
  ip_hash      TEXT,
  created_at   TEXT NOT NULL,
  last_sent_at TEXT,
  failures     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX alert_subscriptions_by_ip ON alert_subscriptions (ip_hash, created_at);

-- Each reminder sent to everyone with alerts on.
CREATE TABLE push_sends (
  send_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('manual', 'auto')),
  event_id       TEXT NOT NULL,
  occurrence_id  TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  url            TEXT NOT NULL,
  sent_by        TEXT NOT NULL,                 -- the admin's email, or 'auto'
  devices        INTEGER NOT NULL DEFAULT 0,    -- devices it was queued for
  delivered      INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  -- The Facebook post that goes with an admin's reminder (n8n RTD Event Reminders To Facebook). NULL: none.
  social         TEXT CHECK (social IN ('pending', 'posted', 'failed')),
  social_text    TEXT,
  social_image   TEXT,
  social_post_id TEXT,
  social_error   TEXT,
  social_at      TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX push_sends_by_event ON push_sends (event_id, created_at);
CREATE INDEX push_sends_by_kind ON push_sends (kind, created_at);

-- A reminder waiting to reach each device. Sent in batches (a Worker can only
-- make so many requests at once), then deleted.
CREATE TABLE push_deliveries (
  send_id    INTEGER NOT NULL REFERENCES push_sends (send_id),
  endpoint   TEXT NOT NULL,
  claim      TEXT,
  claimed_at TEXT,
  PRIMARY KEY (send_id, endpoint)
);
