-- Every public café event can be booked, not only hosts' sessions
-- (docs/RTD_BOOKINGS.md). A cancelled date of any Event Index event is taken out
-- of the Logic Engine by n8n, matched on Event ID; this records the last change
-- made for each event so it's made once. (It replaces host_sessions.sheet_fix_sent,
-- which is no longer used.)
CREATE TABLE sheet_fixes (
  event_id TEXT PRIMARY KEY REFERENCES events (event_id),
  fix_key  TEXT NOT NULL,
  sent_at  TEXT NOT NULL
);
