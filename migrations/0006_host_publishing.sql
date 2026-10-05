-- Host sessions reach the diary through the Logic Engine (docs/RTD_HOST_PORTAL.md).
-- Event Index gains App Price, App Capacity and App Host Session; the sync keeps
-- them on the event (capacity uses the existing default_capacity).
ALTER TABLE events ADD COLUMN price_display TEXT;
ALTER TABLE events ADD COLUMN host_session_id TEXT;

-- n8n records when it emailed the café about a new submission, and when it
-- added an approved session to Event Index.
ALTER TABLE host_sessions ADD COLUMN cafe_notified_at TEXT;
ALTER TABLE host_sessions ADD COLUMN published_at TEXT;
