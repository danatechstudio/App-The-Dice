-- Whether an event was in the last good sync's snapshot. It replaces comparing each event's
-- last_synced_at with the newest sync run, which needed every event rewritten on every sync:
-- with the sync every minute, that would use most of the free plan's 100,000 rows written a day.
-- A sync now writes only events that changed, and this flag only for events that came or went.
-- last_synced_at stays: the last time a sync wrote the event.
ALTER TABLE events ADD COLUMN in_last_sync INTEGER NOT NULL DEFAULT 0;
UPDATE events SET in_last_sync = 1 WHERE last_synced_at >= (SELECT MAX(received_at) FROM sync_runs WHERE status = 'ok');
