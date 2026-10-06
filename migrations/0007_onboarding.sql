-- Onboarding: someone signs in and asks to host games or join the café team.
-- Host requests are approved by staff (Michelle); café team requests by an
-- admin (Dan). Approval creates or re-activates their users row
-- (docs/RTD_ONBOARDING.md).
CREATE TABLE applications (
  application_id         TEXT PRIMARY KEY,            -- RTD-APP-00001
  email                  TEXT NOT NULL COLLATE NOCASE, -- the Access sign-in that sent it
  display_name           TEXT NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('host', 'staff')),
  about                  TEXT NOT NULL,               -- host: what they'd run; staff: their role at the café
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  decision_note          TEXT,
  decided_by             TEXT,
  decided_at             TEXT,
  approver_notified_at   TEXT,                        -- n8n emailed the approver
  applicant_notified_at  TEXT,                        -- n8n emailed the outcome
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE INDEX applications_by_email ON applications (email, created_at);
CREATE INDEX applications_by_status ON applications (status, role);

-- n8n tells the host when the café approves or declines a session.
ALTER TABLE host_sessions ADD COLUMN host_notified_at TEXT;
