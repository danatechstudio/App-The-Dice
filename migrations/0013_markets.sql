-- Markets (docs/RTD_MARKETS.md): an admin sets up a market in the organiser,
-- the app adds it to the Logic Engine, and vendors apply for a pitch in the app.
-- Approvers approve or decline; approved vendors are emailed the payment details.

CREATE TABLE markets (
  market_id          TEXT PRIMARY KEY,                       -- RTD-MKT-00001
  name               TEXT NOT NULL,
  description        TEXT,
  event_date         TEXT NOT NULL,                          -- YYYY-MM-DD (London)
  start_time         TEXT NOT NULL,                          -- HH:MM
  end_time           TEXT,
  pitches            INTEGER NOT NULL CHECK (pitches BETWEEN 1 AND 200),
  pitch_fee_pence    INTEGER NOT NULL CHECK (pitch_fee_pence BETWEEN 0 AND 100000),
  applications_close TEXT NOT NULL,                          -- last day to apply (YYYY-MM-DD)
  payment_details    TEXT NOT NULL,                          -- typed by the admin; sent to approved vendors
  status             TEXT NOT NULL CHECK (status IN ('scheduled', 'published')),
  event_id           TEXT,                                   -- its Logic Engine event, once the sync links it
  published_at       TEXT,                                   -- n8n added it to Event Index
  created_by         TEXT NOT NULL,                          -- the admin's email
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX markets_by_date ON markets (event_date);

-- One application per stall per market. Personal details are erased 12 months
-- after the market (docs/RTD_PRIVACY.md).
CREATE TABLE market_applications (
  application_id    TEXT PRIMARY KEY,                        -- RTD-MV-00001
  market_id         TEXT NOT NULL REFERENCES markets (market_id),
  stall_name        TEXT NOT NULL,
  contact_name      TEXT NOT NULL,
  email             TEXT NOT NULL COLLATE NOCASE,
  mobile            TEXT NOT NULL,
  products          TEXT NOT NULL,                           -- what they sell
  links             TEXT,                                    -- website and social links, as typed
  insured           INTEGER NOT NULL CHECK (insured IN (0, 1)),
  insurer           TEXT,
  insurance_expiry  TEXT,                                    -- YYYY-MM-DD
  notes             TEXT,
  photo_count       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  waitlisted        INTEGER NOT NULL DEFAULT 0,              -- every pitch was taken when they applied
  decision_note     TEXT,
  decided_by        TEXT,
  decided_at        TEXT,
  ip_hash           TEXT,                                    -- only for the applications-an-hour limit
  submit_key        TEXT NOT NULL UNIQUE,                    -- random, so the photos and emails saved with it find it
  sheet_hash        TEXT,                                    -- what n8n last wrote to the market spreadsheet
  erased_at         TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX market_applications_by_market ON market_applications (market_id, status);
CREATE INDEX market_applications_by_email ON market_applications (email, created_at);
CREATE INDEX market_applications_by_ip ON market_applications (ip_hash, created_at);

-- Photos of a vendor's stall, kept in KV (key vendor:<photo_id>). Only approvers see them.
CREATE TABLE market_photos (
  photo_id        TEXT PRIMARY KEY,                          -- random
  application_id  TEXT NOT NULL REFERENCES market_applications (application_id),
  position        INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  content_type    TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX market_photos_by_application ON market_photos (application_id, position);

-- The Logic Engine row a market came from: Event Index "App Host Session"
-- holds RTD-MKT-… for markets (RTD-HS-… for host sessions).
ALTER TABLE events ADD COLUMN market_id TEXT;
