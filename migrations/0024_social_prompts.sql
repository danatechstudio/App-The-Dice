-- Event-specific social master prompts (docs/superpowers/specs/2026-10-18-social-master-prompt-design.md §1;
-- Stage 1, the app side). Each event gets its own master prompt, built by n8n from the facts the café
-- wrote down (Approved Facts, People & Roles, Base Details), and every post is checked against that
-- event's facts before it goes out. The Logic Engine stays the master for the facts; this migration
-- holds only what the app adds: the owner columns as the last sync read them, each prompt version,
-- each check made before a post, and the switch. Additive: one column, two tables, one setting (off).
-- It is applied to production only with the owner's go-ahead, after 0023.

-- JSON {approved_facts, people_roles, banned_phrases}: the three owner columns as the last sync read
-- them, raw cell text. Kept out of source_hash, like sheet_values, so adding it changed no event.
ALTER TABLE events ADD COLUMN social_values TEXT;

-- One row per generated or overridden version of an event's master prompt.
CREATE TABLE social_prompts (
  prompt_id           TEXT PRIMARY KEY,                  -- RTD-SP-00001
  event_id            TEXT NOT NULL REFERENCES events (event_id),
  version             INTEGER NOT NULL,                  -- per event, from 1
  status              TEXT NOT NULL CHECK (status IN ('pending', 'validated', 'review_required', 'approved', 'superseded', 'blocked')),
  schema_version      INTEGER NOT NULL DEFAULT 1,
  instruction_version INTEGER NOT NULL DEFAULT 1,
  -- sha256 of the whitelisted source fields (src/social/facts.ts), exactly as computed. Several versions can
  -- share one (an admin's Regenerate or override for the same facts); the newest is the one that counts.
  source_fingerprint  TEXT NOT NULL,
  source_snapshot     TEXT NOT NULL,                     -- JSON of those fields: approved facts only, never dates
  master_prompt       TEXT,                              -- the prompt text; none until generated
  claims              TEXT,                              -- JSON [{claim, source_field}], as Gemini listed them
  ambiguities         TEXT,                              -- JSON
  validation_errors   TEXT,                              -- JSON
  generation_model    TEXT,
  generation_job_id   TEXT,                              -- the n8n execution id
  generated_at        TEXT,
  validated_at        TEXT,
  approved_at         TEXT,
  approved_by         TEXT,                              -- 'system' or an admin's sign-in email
  override_text       TEXT,                              -- set when an admin overrides the generated prompt
  override_reason     TEXT,
  written_at          TEXT,                              -- when the Social Prompt cells were written to the sheet
  last_used_at        TEXT,                              -- when a post last used this version
  created_at          TEXT NOT NULL,
  UNIQUE (event_id, version)
);
CREATE INDEX social_prompts_by_facts ON social_prompts (event_id, source_fingerprint);

-- One row per check made before a post.
CREATE TABLE social_checks (
  check_id     TEXT PRIMARY KEY,
  mode         TEXT NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  kind         TEXT NOT NULL CHECK (kind IN ('event_post', 'roundup', 'poster')),
  platform     TEXT,
  targets      TEXT NOT NULL,                           -- JSON [{event_id, occurrence_id, prompt_version}]
  text         TEXT,                                    -- the final caption and poster wording; cleared after 90 days
  result       TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  reasons      TEXT,                                    -- JSON
  workflow     TEXT,                                    -- the n8n workflow and execution
  execution_id TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX social_checks_by_time ON social_checks (created_at);
CREATE INDEX social_checks_by_result ON social_checks (result, created_at);

-- off: nothing is checked or recorded. shadow: every post is checked and recorded, none is held.
-- enforce: a post that fails its check is held.
INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES ('social_prompts', 'off', '2026-10-18T00:00:00Z', 'migration 0024');
