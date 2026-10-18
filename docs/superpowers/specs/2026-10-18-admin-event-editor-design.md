# Admin event editor — design

Date: 18 October 2026. Status: approved in conversation, awaiting review of this written spec.

## What the owner asked for

> Ensure admin accounts can change/cancel and update event details for ALL events, including
> capacity, need to book, public or closed etc.
>
> Hosts must be able to add their own events, and have ability to modify only their own events,
> nothing else. Admin account has full access to modify all. All failsafes for approvals via hosts
> need to remain in place.

Success: an admin can open any event in the app (café, host session or market; public, private or
hidden; running or stopped) and change every detail or cancel it from one place. Hosts and
approvers can do exactly what they can today and no more.

## Roles (unchanged except admin)

| Role | Can do | Change in this work |
|---|---|---|
| Host | Submit their own sessions (an approver or admin must approve them), ask to change their own live session (approval needed), set places on and cancel dates of their own sessions | None. Tests added proving a host is refused (403) on anyone else's session, date, places or change request |
| Approver | Approve or decline host sessions and change requests, places and need to book on café events, hide or annotate a date, cancel any date | None |
| Admin | Everything an approver can, plus Logic Engine changes on café events | **New:** full edit of every event from one editor (below) |

## What exists today (and the gaps)

- Logic Engine panel (`src/sync/edits.ts`, admins): café events only. Changes are queued for n8n
  "RTD Sheet Writer", which checks the sheet hasn't changed and writes just those cells.
  **Gap:** RTD Sheet Writer (`TAa4F7wKzzeIDKm8`) has never been published, so although the setting
  `sheet_writes` has been `live` since 17 Oct, nothing queued would ever reach the sheet. No edits
  have been made (the `sheet_edits` table is empty).
- Places and need to book (`src/bookings/places.ts`): café events that are Public or App Bookable.
  **Gap:** private and hidden events aren't listed; host sessions are refused (the host sets
  places; booking is always required).
- Dates panel (`src/events/dates.ts`): hide one date, or give it its own description or price; the
  next four weeks only.
- Cancel a date (`cancelDate`, `src/bookings/bookings.ts`): approvers can cancel any date, but the
  organiser only offers it on booked-date screens. **Gap:** no obvious way to cancel an unbooked
  date, or to stop an event running.
- Host sessions: an admin can only approve the host's own requests. **Gap:** an admin can't change
  one directly.

## Design

One editor, admins only, that saves each field through the route it already uses. The Logic Engine
sheet stays the master copy for event details; nothing is written to the diary that the sheet
would overwrite on the next sync.

### 1. All events list

Organise › Events › **All events** (new panel, admins only; the existing panels stay for approvers).

- Every active or inactive event in the last sync, plus every published host session and every
  market. Columns: name, kind (Café · Event Index / Café · Standard Diary / Host session / Market),
  next date, who can see it, running or stopped, bookings to come, and a chip for anything on its
  way (Logic Engine change queued or in conflict; host change waiting).
- Search by name; filter chips: All, Café, Host sessions, Markets, Stopped, Hidden or private.
- `GET /api/staff/events` (admins only, no-store).

### 2. Edit event

`/organise/events/:eventId`, one form with the event's current values.

| Section | Fields | Notes |
|---|---|---|
| Details | Name, description, date, start time, end time, price, category | Standard Diary rows have no time or price columns: those fields read "Set in the Standard Diary tab". Weekly events change the next date's date |
| Who can see it | Public · App Bookable · Private (invite only) · Hidden | All four, as separate choices |
| Running | Active · Inactive | Inactive is set with **Stop running this event** (below) |
| Booking | Places (blank = no limit), need to book (Not required · Optional · Required · default) | Places can't go below the most booked on any date to come |
| Dates to come | Each date: Cancel this date, Hide this date, its own places | Up to 12 dates |

Markets show a summary and a button to open the existing Markets editor, which admins already
control fully. They aren't edited here.

`GET /api/staff/events/:id` returns the form. `POST /api/staff/events/:id` saves it.

### 3. How a save goes through

Only fields that differ from what the admin opened are sent. Each kind of field goes to its
existing route.

**Café events**
- Details, visibility and running go to the Sheet Writer queue (`requestEdit`). That keeps its
  conflict check: if the sheet changed since the form was opened, nothing is written and the admin
  chooses which value to keep. The form says "On its way to the Logic Engine, in the app within
  about 20 minutes".
- Places and need to book are saved immediately (`setEventPlaces`, `setBookingMode`, now allowed
  on private and hidden events too).
- A new start or end time: when n8n confirms it's written (`/internal/sheet-edits/:id/written`),
  everyone booked on dates to come is emailed the new time, with the same email as a host change.
- A new date while people are booked on the current one is refused, with a link to
  **Cancel this date** first. Moving bookings silently is never allowed, and Needs attention (which
  would otherwise catch it) is switched off.

**Host sessions**
- Details and visibility: the admin's change is recorded as a change request with
  `origin = 'admin'`, approved on the spot by that admin. It then follows the existing approved
  path:
  - only the changed cells are written to the Event Index row by n8n branch D
  - the session's own record follows
  - people booked are emailed a new time
  - the host is emailed "An admin changed your session", showing old and new values
- If the host has a request waiting, the form says so and asks the admin to approve or decline it
  first, so neither change silently replaces the other.
- A new date while people are booked is refused, as for café events.
- Places and need to book: admins may now set them (`setSessionPlaces` allows an admin;
  `setBookingMode` allows an admin on a host session). Hosts can still set their own places.
- Branch D's cell mapping gains App Visibility for all four values, and Status, so that Hidden and
  Inactive reach the sheet.

**Cancelling**
- **Cancel this date**: the existing `cancelDate`, with an optional message. Everyone booked is
  emailed, the café's bookings inbox or the host is told, and the sheet follows as it does today.
- **Stop running this event**: shows how many dates and people are booked. On confirm, every booked
  date to come is cancelled with one message (each person emailed once per booking), then Status
  Inactive is set (Sheet Writer for café events, the admin change path for host sessions). Without
  bookings it just sets Inactive.

**Every save**
- Checked as today: dates from today to two years ahead, times like 18:30, name length and no
  clash with another event, places 1–500.
- Recorded in the audit log, with the admin's email and the values before and after.
- Hosts and approvers calling the new endpoints get 403.

### 4. Turning on the Sheet Writer (owner's go-ahead needed)

Café event details only reach the sheet once RTD Sheet Writer is published. It writes to the live
Logic Engine, so it follows the rollout already agreed in `docs/RTD_EVENT_CONTROL_MIGRATION.md`:

1. set **Test copy**, publish the workflow, and make one change on the staging sheet: check only
   the named cells changed and a conflict is caught
2. set **Live** and make one real change chosen by the owner

Rollback: set Off, unpublish the workflow. Nothing in this work publishes it without that go-ahead.

### 5. Testing

- Server (Vitest):
  - the events list and form for each kind of event
  - each save route: café sheet fields queue an edit; places and booking mode apply immediately;
    a host session change is created as an approved admin request and emails the host
  - a date move refused while booked
  - stop running cancels booked dates then sets Inactive
  - a time change emails booked people once written
  - 403 for approvers and hosts on the new endpoints
  - 403 for a host on another host's session, date, places and change request
- Browser (Playwright, local): the list and form on phone and desktop width.

## Out of scope

- Hosts' own forms and approval steps (unchanged).
- Making the app the master copy of events instead of the sheet.
- Editing markets here (they keep their own editor).
- Turning Needs attention on (still an owner decision).
