-- Push notifications for approvers (docs/RTD_PUSH.md): approvers and admins
-- turn them on per device in the organiser, and get one whenever a session or
-- a join request needs approving, as well as the email.

CREATE TABLE push_subscriptions (
  -- The push service URL for one browser on one device. It works like a password: only its owner sees it.
  endpoint     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (user_id),
  -- The browser's public key and secret, for encrypting each message to it (RFC 8291).
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  device_label TEXT,
  created_at   TEXT NOT NULL,
  last_sent_at TEXT,
  failures     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_by_user ON push_subscriptions (user_id);

-- The app's own VAPID key pair (RFC 8292), made by the Worker the first time
-- it's needed, so no secret has to be set by hand. Only ever one row.
CREATE TABLE push_keys (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
