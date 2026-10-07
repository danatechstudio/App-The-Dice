-- Places set in the organiser (docs/RTD_BOOKINGS.md#places), and erasing
-- people's details once they're no longer needed (docs/RTD_PRIVACY.md).

-- An event's places, set in the organiser: by the host for their own session,
-- or by an approver for a café event. NULL means the sheet's App Capacity.
-- The sync clears it whenever App Capacity changes in the sheet, so whichever
-- was changed last wins. (occurrences.capacity, from 0001, holds one date's places.)
ALTER TABLE events ADD COLUMN capacity_override INTEGER;

-- When a booking's or a join request's personal details were erased.
ALTER TABLE bookings ADD COLUMN erased_at TEXT;
ALTER TABLE applications ADD COLUMN erased_at TEXT;

-- Who the privacy notice names as responsible for people's details. The
-- contact address is set only in the live database (privacy_contact_email).
INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES
  ('privacy_controller', 'Roll The Dice Board Game Café, Cleethorpes', '2026-10-07T00:00:00Z', 'migration'),
  ('booking_retention_months', '12', '2026-10-07T00:00:00Z', 'migration');
