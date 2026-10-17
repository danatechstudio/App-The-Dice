-- Two-way Logic Engine sync (docs/RTD_EVENT_CONTROL_AUDIT.md §4, G-6, D-13; Stage 6).
-- Admins change an event's sheet-owned fields (name, details, next date, times, Status,
-- App Visibility / Category / Price) in the organiser. The change is never applied in the
-- app directly: it is queued here, n8n "RTD Sheet Writer" checks the row (found by Event ID)
-- still holds what the admin saw, writes only the changed cells, reads them back, and the
-- next Event Sync brings them into the diary like any edit made in the sheet. If the sheet
-- has moved on, nothing is written and the admin chooses (a conflict). Additive: one column,
-- one table, one setting (off).

-- JSON: the editable columns as the last sync read them, in canonical form (dates ISO,
-- times HH:MM, visibility as the app's word), so an edit records what it changes from.
ALTER TABLE events ADD COLUMN sheet_values TEXT;

CREATE TABLE sheet_edits (
  edit_id         TEXT PRIMARY KEY,                     -- RTD-SE-00001
  event_id        TEXT NOT NULL REFERENCES events (event_id),
  source          TEXT NOT NULL CHECK (source IN ('event_index', 'standard_diary')),
  -- Where it goes, fixed when it's made: staging = the test copy of the sheet; shadow = a
  -- trial against the live sheet that writes nothing; live = the Logic Engine itself.
  target          TEXT NOT NULL CHECK (target IN ('staging', 'shadow', 'live')),
  fields          TEXT NOT NULL,                        -- JSON {column: {from, to}}, canonical
  note            TEXT,
  requested_by    TEXT NOT NULL,                        -- the admin's sign-in email
  -- queued: waiting for the writer (claim set while it works on it); written: in the sheet
  -- and read back; synced: a live edit the app now shows; overtaken: the sheet changed again
  -- before the app saw it; dry_run: a shadow trial, nothing written; conflict: the sheet no
  -- longer held what the admin saw, nothing written; dead: given up on; cancelled: withdrawn,
  -- or the sheet's value kept after a conflict.
  status          TEXT NOT NULL CHECK (status IN ('queued', 'written', 'synced', 'overtaken', 'dry_run', 'conflict', 'dead', 'cancelled')),
  cells           TEXT,                                 -- JSON: the cells written (or that a trial would write)
  found           TEXT,                                 -- JSON {column: value}: what the writer found in the sheet
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  claim           TEXT,
  claimed_at      TEXT,
  written_at      TEXT,
  settled_at      TEXT,                                 -- synced, overtaken, dry_run, conflict, dead or cancelled
  resolved_by     TEXT,                                 -- who withdrew it or chose after a conflict
  resolution      TEXT,                                 -- withdrawn, kept_sheet, kept_mine, retried
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX sheet_edits_by_status ON sheet_edits (status, next_attempt_at);
CREATE INDEX sheet_edits_by_event ON sheet_edits (event_id, created_at);

-- off: nothing is written and the editor is closed. staging / shadow / live: see target.
INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES ('sheet_writes', 'off', '2026-10-16T00:00:00Z', 'migration 0022');
