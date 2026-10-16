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
