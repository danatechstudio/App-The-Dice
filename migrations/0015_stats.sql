-- Stats for admins (docs/RTD_STATS.md): daily totals of page views and taps in
-- the app. Only how many: no network address, device ID or cookie.
CREATE TABLE stats_daily (
  day      TEXT NOT NULL,             -- London date, YYYY-MM-DD
  metric   TEXT NOT NULL,             -- e.g. event_view, book_tap, app_open (src/stats/stats.ts)
  event_id TEXT NOT NULL DEFAULT '',  -- the event it's about; '' for the whole app
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, event_id)
) WITHOUT ROWID;

-- How many people tapped each event reminder (docs/RTD_ALERTS.md).
ALTER TABLE push_sends ADD COLUMN opened INTEGER NOT NULL DEFAULT 0;
