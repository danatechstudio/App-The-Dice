-- Messages asking to join a private game (docs/superpowers/specs/2026-10-18-private-events-design.md).
-- A private game shows in the diary by name, with a message form instead of booking; each message
-- is emailed to the café (and the host, for a host's session) and kept here for the hourly limit
-- and a record. Erased by the daily retention job: the network hash after 2 days, the row after
-- 90 days (src/lib/privacy.ts). Additive: one new table.

CREATE TABLE enquiries (
  enquiry_id     TEXT PRIMARY KEY,                     -- RTD-ENQ-00001
  occurrence_id  TEXT NOT NULL REFERENCES occurrences (occurrence_id),
  event_id       TEXT NOT NULL,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  message        TEXT NOT NULL,
  ip_hash        TEXT,                                 -- the network, scrambled with the day: the hourly limit only
  created_at     TEXT NOT NULL
);

CREATE INDEX enquiries_ip ON enquiries (ip_hash, created_at);
CREATE INDEX enquiries_created ON enquiries (created_at);
