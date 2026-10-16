-- Booking modes (docs/RTD_EVENT_CONTROL_AUDIT.md G-5; Stage 4a): whether people need
-- to book an event. Additive.
--   'none'      Not required: no booking form; just come along.
--   'optional'  Optional: people can reserve a place, or just turn up.
--   'required'  Required: people must book to come; full means full.
-- NULL means the default for the kind of event (src/lib/queries.ts BOOKING_MODE): the
-- café's own events Optional, hosts' sessions Required, Standard Diary groups and
-- markets Not required. Approvers and admins change it in the organiser.
ALTER TABLE events ADD COLUMN booking_mode TEXT CHECK (booking_mode IN ('none', 'optional', 'required'));
