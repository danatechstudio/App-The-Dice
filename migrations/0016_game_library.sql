-- The café's game library (docs/GAME_LIBRARY_AUDIT.md). Additive: no existing
-- table changes. Games reach the public app only once confirmed as owned, and
-- only after the switch `game_library_live` is turned on.

-- Confirmed holdings. Retired games keep their row so history still reads.
CREATE TABLE games (
  game_id               TEXT PRIMARY KEY,           -- RTD-GAME-00001 upwards; never reused
  slug                  TEXT NOT NULL UNIQUE,       -- edition-aware, for /games/<slug>
  title                 TEXT NOT NULL,
  edition               TEXT,
  category              TEXT NOT NULL,
  audiences             TEXT NOT NULL DEFAULT '[]', -- JSON array: Children, Family, Adults, Party, Strategy
  min_age               INTEGER,
  min_players           INTEGER,
  max_players           INTEGER,
  play_time_min         INTEGER,                    -- minutes
  play_time_max         INTEGER,
  synopsis              TEXT NOT NULL,
  verification_status   TEXT NOT NULL DEFAULT 'confirmed' CHECK (verification_status IN ('confirmed', 'needs_review', 'rejected')),
  available_for_chooser INTEGER NOT NULL DEFAULT 1,
  available_for_gotw    INTEGER NOT NULL DEFAULT 1,
  copies                INTEGER,                    -- NULL: not counted (not the same as one)
  cover_image_id        TEXT,                       -- KV game:<id>
  thumb_image_id        TEXT,
  image_source_url      TEXT,                       -- the page the cover came from
  image_attribution     TEXT,
  image_rights_status   TEXT NOT NULL DEFAULT 'unknown' CHECK (image_rights_status IN ('approved', 'pending', 'restricted', 'unknown')),
  image_status          TEXT NOT NULL DEFAULT 'placeholder' CHECK (image_status IN ('verified', 'placeholder', 'pending')),
  image_checked_at      TEXT,
  source_key            TEXT UNIQUE,                -- normalised title|edition from the manifest; NULL if added by hand
  source_title          TEXT NOT NULL,              -- the title as the source wrote it
  source_evidence       TEXT,
  ownership_evidence    TEXT NOT NULL,              -- how we know the café has it
  confirmed_by          TEXT NOT NULL,
  confirmed_at          TEXT NOT NULL,
  import_batch_id       TEXT,
  admin_edited_at       TEXT,                       -- set when an admin edits it: re-imports then leave its details alone
  retired_at            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (min_players IS NULL OR max_players IS NULL OR min_players <= max_players),
  CHECK (play_time_min IS NULL OR play_time_max IS NULL OR play_time_min <= play_time_max)
);
CREATE INDEX games_live ON games (verification_status, retired_at, available_for_chooser);
CREATE INDEX games_by_category ON games (category);
CREATE INDEX games_by_players ON games (min_players, max_players);
CREATE INDEX games_by_time ON games (play_time_max);

-- Titles waiting for evidence that the café owns them, or held back as
-- uncertain. Never shown to the public.
CREATE TABLE game_review (
  review_id       TEXT PRIMARY KEY,                 -- RTD-GREV-00001 upwards
  source_key      TEXT NOT NULL UNIQUE,
  source_title    TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('provisional', 'uncertain')),
  entry           TEXT NOT NULL,                    -- JSON: the parsed metadata
  reasons         TEXT NOT NULL DEFAULT '[]',       -- JSON array: why it's held
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'rejected')),
  decision_note   TEXT,
  decided_by      TEXT,
  decided_at      TEXT,
  game_id         TEXT,                             -- once confirmed
  import_batch_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX game_review_by_status ON game_review (status, source_title);

-- Each dry run or import of the manifest.
CREATE TABLE game_import_batches (
  batch_id      TEXT PRIMARY KEY,
  mode          TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  source_sha256 TEXT NOT NULL,
  counts        TEXT NOT NULL,                      -- JSON
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Game of the Week: one row per week, so a week can't be picked twice. The
-- snapshot keeps old weeks readable if a game is later retired.
CREATE TABLE gotw_weeks (
  week_key       TEXT PRIMARY KEY,                  -- Monday's London date, YYYY-MM-DD
  game_id        TEXT NOT NULL,
  title          TEXT NOT NULL,
  edition        TEXT,
  cover_image_id TEXT,
  mode           TEXT NOT NULL CHECK (mode IN ('random', 'least_recent')),
  pool_size      INTEGER NOT NULL,
  selected_at    TEXT NOT NULL
);
CREATE INDEX gotw_by_game ON gotw_weeks (game_id, week_key);

-- Off: the public app keeps the preview shelf. On: the confirmed library.
INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES ('game_library_live', 'off', '2026-10-15T00:00:00Z', 'migration 0016');
-- Game of the Week avoids games featured in this many previous weeks.
INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES ('gotw_avoid_weeks', '12', '2026-10-15T00:00:00Z', 'migration 0016');
