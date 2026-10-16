-- Host change requests (docs/RTD_EVENT_CONTROL_AUDIT.md G-7, D-7; Stage 5a). A host asks to
-- change a live session's name, description, date, times, price or who can come; nothing
-- public changes until an approver or admin approves it. Then n8n writes the changed cells
-- to the session's Event Index row (matched on Event ID) and the next sync brings them into
-- the diary. Places and cancelling a date stay immediate (D-7). Additive: one new table.

CREATE TABLE event_change_requests (
  request_id    TEXT PRIMARY KEY,                       -- RTD-CR-00001
  session_id    TEXT NOT NULL REFERENCES host_sessions (session_id),
  event_id      TEXT NOT NULL,                          -- the Event Index row it changes
  origin        TEXT NOT NULL DEFAULT 'host',           -- who asked: 'host' (later stages may add others)
  requested_by  TEXT NOT NULL,                          -- the host's sign-in email
  -- JSON: what was public when it was asked for (name, description, event_date, start_time,
  -- end_time, price, access), so the decision shows "now" against "proposed", and approving
  -- refuses if any of the changed fields has moved on since.
  published     TEXT NOT NULL,
  proposed      TEXT NOT NULL,                          -- JSON: only the fields that change
  note          TEXT,                                   -- the host's note to the café
  -- pending: waiting for a decision; superseded: the host asked again before a decision.
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn', 'superseded')),
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,                                   -- the reason, when declined
  applied_at    TEXT,                                   -- n8n wrote it to Event Index
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX change_requests_by_status ON event_change_requests (status, created_at);
CREATE INDEX change_requests_by_session ON event_change_requests (session_id, created_at);
