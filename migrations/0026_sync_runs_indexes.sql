-- The sync log is read on every sync (every 5 minutes) for the last good run, and by the
-- organiser for the latest runs. Without an index each of those read the whole log and
-- sorted it: about 17,000 rows a time by November 2026, nearly all of the free plan's
-- 5M rows read a day. With these, each reads one row.
-- Applied to production by hand on 15 Nov 2026 (d1_migrations id 26); IF NOT EXISTS keeps a re-run harmless.
CREATE INDEX IF NOT EXISTS sync_runs_by_status ON sync_runs (status, received_at);
CREATE INDEX IF NOT EXISTS sync_runs_by_time ON sync_runs (received_at);
