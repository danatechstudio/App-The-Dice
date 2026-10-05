-- Sessions proposed by hosts in the organiser (/organise). Staff approve or
-- decline them; approved sessions are then added to the Logic Engine (the one
-- master calendar) by n8n, and reach the diary through the normal sync.

CREATE TABLE host_sessions (
  session_id     TEXT PRIMARY KEY,                       -- RTD-HS-00001
  host_user_id   TEXT NOT NULL REFERENCES users (user_id),
  name           TEXT NOT NULL,
  description    TEXT,
  event_date     TEXT NOT NULL,                          -- YYYY-MM-DD, London
  start_time     TEXT NOT NULL,                          -- HH:MM, London
  end_time       TEXT,
  price_pence    INTEGER NOT NULL DEFAULT 0 CHECK (price_pence BETWEEN 0 AND 10000), -- 0 = free; paid at the venue
  max_players    INTEGER NOT NULL CHECK (max_players BETWEEN 1 AND 100),
  status         TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'declined', 'withdrawn', 'published')),
  decision_note  TEXT,
  decided_by     TEXT,
  decided_at     TEXT,
  event_id       TEXT,                                   -- set once it is in the Logic Engine
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX host_sessions_by_host ON host_sessions (host_user_id, event_date);
CREATE INDEX host_sessions_by_status ON host_sessions (status, event_date);
