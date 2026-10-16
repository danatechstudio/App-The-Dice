-- Needs attention (docs/RTD_EVENT_CONTROL_AUDIT.md, G-2; Stage 3b): events whose
-- date has passed with no next date, and events the Logic Engine gives no usable
-- date. Approvers and admins renew, archive or close each one in the organiser;
-- nothing is resolved by just looking. Additive: one new column, one new table.

-- What the Logic Engine's date cell holds, as written ("Every Thursday", a past
-- date, or NULL when blank), so the organiser can say why an event has no date.
ALTER TABLE events ADD COLUMN sheet_date_raw TEXT;

CREATE TABLE attention_items (
  item_id           INTEGER PRIMARY KEY AUTOINCREMENT, -- shown as RTD-ATT-00001
  -- One item per situation, ever: 'expired:<occurrence_id>', or
  -- 'no_date:<event_id>:<sheet_date_raw>'. Once resolved, the same one never reopens.
  item_key          TEXT NOT NULL UNIQUE,
  -- 'expired': its latest date has ended and nothing follows it.
  -- 'no_date': active and listed, but nothing to come and no usable date in the sheet.
  -- (Later stages add kinds; values are checked in src/attention/attention.ts.)
  kind              TEXT NOT NULL,
  event_id          TEXT NOT NULL REFERENCES events (event_id),
  occurrence_id     TEXT REFERENCES occurrences (occurrence_id),
  detail            TEXT,                              -- no_date: the sheet's date cell, as written
  status            TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  -- 'renewed' (a new date), 'archived' (retired), 'completed' (a one-off, no new date
  -- needed) or 'dismissed' (left as it is).
  resolution        TEXT,
  renew_date        TEXT,                              -- the new date an approver set (YYYY-MM-DD)
  new_occurrence_id TEXT,                              -- the date that arrived from the Logic Engine
  resolved_by       TEXT,                              -- an approver's email, 'sheet' or 'system'
  resolution_note   TEXT,
  opened_at         TEXT NOT NULL,
  resolved_at       TEXT
);
CREATE INDEX attention_by_status ON attention_items (status, opened_at);
CREATE INDEX attention_by_event ON attention_items (event_id);

-- Off until an admin switches it on in the organiser.
INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES
  ('needs_attention', 'off', '2026-10-16T00:00:00Z', 'migration');
