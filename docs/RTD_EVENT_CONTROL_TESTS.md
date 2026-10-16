# RTD Event Control: Tests and Evidence

The test matrix for the event control plan ([RTD_EVENT_CONTROL_AUDIT.md](RTD_EVENT_CONTROL_AUDIT.md) §6). It's updated at the end of every stage.

**How these tests run:**
- `npm test` builds the app, then runs everything inside the Workers runtime against a real local D1.
- Times are fixed with fake timers.
- Nothing calls n8n, Gmail or a push service.

## Stage 3a: public visibility (2026-10-16)

**Result:** `npm test`: 20 files, **326 passed** (313 before, 13 new in `test/visibility.test.ts`). `tsc --noEmit` is clean for both the Worker and the web app.

No sync runs after each test's seed, so every check below is enforced **at read time**, not by n8n.

### Brief §4 acceptance: "an occurrence ending one second ago is excluded"

| Path | 1 s before the end | 1 s after the end | Test |
| --- | --- | --- | --- |
| `GET /api/events` (and `?category=`) | Listed | Not listed | `leaves the diary list…` |
| `GET /api/events/:eventId` | In `occurrences` | Not in `occurrences` | same |
| `GET /api/occurrences/:id` | 200, full details | **410**: name, date, reason, next date only; no description, photo or price | same; `gives an old link only…` |
| `.ics` / Google Calendar link | 200 / 302 | 404 | `stops the calendar file…` |
| Link preview `/event/:id` | Event preview | **410**, plain café preview, event name absent | `gives shared links the plain site preview…` |
| Evergreen `/events/:eventId` | This date | Moves on to the next date; 404 if there's none | same |
| Admin reminders (list, and send) | Offered | Not offered; send → 409 | `can't be picked for an admin's reminder` |
| `GET /api/markets`, `/api/markets/:id` | Listed / 200 | Not listed / 404 | `leave the vendor listing when they end` |
| Web app (Home, Diary, Book, splash, chips, event page) | Shown | Hidden; a cached copy of the event page shows "has finished" | `treats a date as over from its end…` (`web/src/lib/upcoming.ts`) |

### Times

| Case | Expectation | Test |
| --- | --- | --- |
| BST (23 Oct, 18:30–22:00 = until 21:00 UTC) | Gone at 21:00:01 UTC | `leaves the diary list…` |
| GMT, the day the clocks go back (25 Oct, 18:00–20:00) | Listed at 19:59:59 UTC; gone at 20:00:00 UTC | `uses GMT after the clocks go back` |
| BST, the day the clocks go forward (28 Mar 2027) | Timed: gone at 21:00 UTC. All-day: gone at 23:00 UTC (London midnight) | `uses BST after the clocks go forward…` |
| Past midnight (19:00–01:00) | Listed at 23:30; deep link still works at 00:59:59; gone at 01:00:01 | `keeps an event that runs past midnight…` |
| All day | Listed at 23:59:59 London; gone at 00:00 | `keeps an all-day date until London midnight` |

### Cancelled and moved

Cancelled and moved dates are never listed. An old link gets 410 with `reason: cancelled` (and the next date) or `reason: moved` (`are never listed…`). The existing host-cancellation test now expects 410 too (`test/bookings.test.ts`).

### Caching

`max-age` is the seconds left before the first date in the response ends, capped at 60. Checked at 30 s and at 1 s before an end, and at a normal 60 s (`caps max-age…`).

### Not tested automatically (manual checks before release)

- **The service worker on a real phone, offline.** The page code re-checks every cached date with the same rule (unit-tested above); the service worker itself is unchanged.

### Checked in the running app (2026-10-16, local `wrangler dev`, Chromium at 390 px)

Seeded with two events that had ended earlier that morning and one still to come. No sync ran afterwards, so D1 still held both ended dates as `scheduled`.
- **Diary and `/api/events`:** listed only the event still to come.
- **The ended events' deep links:** 410 with `reason: finished`. The weekly one carried its next date; the one-off had none.
- **Their `/event/…` pages:** 410 with the plain café `<title>`.
- **On screen:** "Early Chess Club has finished. The next date is Friday 23 October." with **See the next date** and **See what's on**. The one-off said "Sunrise Quiz has finished. Keep an eye on the diary for new dates."
- **The next date's page:** the full details and booking form, as before.
- **Console:** no errors.

### Rollback

Code only; no database change.
- **Before it's merged:** nothing to undo.
- **After it's deployed:** `npx wrangler rollback` to the previous Worker version, or revert the commit on `main`.

## Stage 3b: Needs attention (2026-10-16)

**Result:** `npm test`: 21 files, **339 passed** (13 new in `test/attention.test.ts`, 1 in `test/normalise.test.ts`, 1 updated). `tsc --noEmit` is clean for the Worker and the web app.

| Behaviour | Test |
| --- | --- |
| Off until an admin switches it on; approvers can't switch it; hosts can't see it; the switch is audited | `is off until an admin switches it on…` |
| Events with no usable date are listed at once (blank, free text; never Hidden rows), each with the right actions (the Standard Diary can't be renewed here) | `lists events with no usable date…` |
| A date that ends with nothing after it opens **exactly one** item, however often the detector runs; one audit row; a weekly club whose next date exists never appears | `opens exactly one item…` |
| A one-off host session closes by itself (`completed`, by `system`) | `closes a one-off host session by itself…` |
| It settles itself when the Logic Engine answers: a new date arrives (renewed, with the new occurrence), a no-date event is switched off (archived), its date text changes (the old one dismissed, a new one opened) | `settles itself when the Logic Engine answers…` |
| More than 50 new items at once opens none and says so | `opens nothing when far too much appears at once…` |
| Dates with no end time are listed | `lists dates that will only show for an hour…` |
| Setting a new date: validated (tomorrow to a year ahead); offered to n8n once as Status Active + the new Event Date (by Event ID); gone after `done`; stops "waiting" when the sync brings the date in; audited with the approver's email | `sets a new date…` |
| Archive: an active Event Index row gets Status Inactive with its date cell written back unchanged; an already-inactive one (Bingo) changes nothing in the sheet | `archives…` |
| No renewal from the app for the Standard Diary or hosts' sessions; no "finished" for a missing date | `doesn't renew what the app can't write…` |
| Something sorted never reopens | `never reopens something that has been sorted` |
| Access: hosts 403; unknown item 404; unknown action 400; already sorted 409 | `needs approver or admin access` and above |

### Checked in the running app (2026-10-16, local `wrangler dev`, Chromium at 390 px)

Seeded with a one-off that had ended that morning, a weekly club, an event with a blank date, one with "Every Thursday", a Standard Diary group with no date, and an event with no end time.
- **After an admin pressed Switch on:** four items with the right buttons, plus the "No end time" note.
- **Finished, no new date** (on the ended one-off) and **Set a new date** (14 Nov, on the blank one) each showed a confirmation message.
- **Sorted in the last 30 days:** listed both, with the new date marked **Waiting for the Logic Engine**.
- **`/internal/sheet-fixes`:** offered exactly `{ Status: Active, Event Date: 14/11/2026 }` for that event.
- **Console:** no errors.

## Later stages

| Brief §4 criterion | Stage |
| --- | --- |
| Expiry creates exactly one attention item; both recipients; daily reminders until resolved; no multiplication on retry | 3b / 3c |
| Booking modes none / optional / required; capacity; old bookings survive | 4 |
| Cancellation: email + eligible push per booking contact, no duplicates, invalid push doesn't block email, zero bookings → no attendee messages | 4 |
| Reschedule preserves history and notifies bookers; a fresh recurrence doesn't migrate bookings | 4 |
| Host edit needs approval; reject with reason | 5 |
| Sheet ↔ app: uncontested edits apply both ways; concurrent edits → conflict; recovery after outages | 6 |
| Audit trail records changes and delivery outcomes; no attendee data leaks | 3b–6 |
| Regression: game chooser, library, bookings, host auth, PWA, deployments | Every stage (the full suite) |
