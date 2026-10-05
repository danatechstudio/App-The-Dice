-- Open sessions go in the diary in full. Private ones (a host's own group) show
-- there only as "Private session" with their time: App Visibility Private.
ALTER TABLE host_sessions ADD COLUMN access TEXT NOT NULL DEFAULT 'open' CHECK (access IN ('open', 'private'));
