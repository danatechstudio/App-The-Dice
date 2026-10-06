-- Hosts can delete a declined or withdrawn session from their list, or edit it
-- and send it again (docs/RTD_HOST_PORTAL.md).

-- Deleted sessions are hidden from every list; the row and its audit trail stay,
-- so a session number is never reused.
ALTER TABLE host_sessions ADD COLUMN deleted_at TEXT;
-- How many times it has been sent again, so approvers can see it's back.
ALTER TABLE host_sessions ADD COLUMN resubmissions INTEGER NOT NULL DEFAULT 0;
