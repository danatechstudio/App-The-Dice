-- Host sessions can repeat weekly, in the Logic Engine's own Frequency words.
-- One-offs get an email to their host the day after (followup_sent_at records it).
ALTER TABLE host_sessions ADD COLUMN frequency TEXT NOT NULL DEFAULT 'one-off' CHECK (frequency IN ('one-off', 'weekly'));
ALTER TABLE host_sessions ADD COLUMN followup_sent_at TEXT;
