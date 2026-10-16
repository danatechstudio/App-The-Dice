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

## Stage 3c: Needs attention emails (2026-10-16)

**Result:** `npm test`: 22 files, **346 passed** (7 new in `test/reminders.test.ts`). `tsc` is clean for the Worker and the web app.

| Brief requirement | Test |
| --- | --- |
| Nothing is sent until an admin sets the addresses and switches it on; approvers can't change them; bad addresses, more than 5, or switching on with none are refused; changes are audited | `sends nothing until an admin…` |
| Items already waiting at switch-on go into the next morning's reminder, not a notice now. No reminder at 08:59 London; one per address at 09:10, listing the event, its date and wait, the no-date count and the organiser link | `puts what was already waiting into the next morning reminder…` |
| **Both** addresses get the notice when a date passes, **exactly once** over 4 runs, with "Opening this email doesn't sort it". Something announced today isn't in today's reminder | `sends a notice to every address when a date passes…` |
| A reminder every morning, once a day per address however often it runs (counted once a day), and **none once it's sorted** | `reminds every morning, once a day per address, and stops when it is sorted` |
| A burst can't flood anyone: at most 5 items a run; the rest follow | `announces at most 5 items a run…` |
| Test email to every address, deduplicated within the minute; admins only | `sends a test to every address…` |
| Delivery is never claimed from a queued email: queued, then stuck (unsent after 30 minutes), then sent only when n8n marks it sent; literal addresses go through RTD Outbox unchanged | `shows admins how the emails have gone…` |

### Checked in the running app (2026-10-16, local `wrangler dev`, Chromium at 390 px)

As an admin: entered two addresses, **Save addresses**, **Switch on**, **Send a test**.
- **The box:** showed **On** and "Latest test: queued, going out within 5 minutes".
- **The outbox:** held exactly one test per address.
- **An expired monthly event already waiting:** showed "In the morning reminder".
- **Console:** no errors.

## Stage 4a: booking modes (2026-10-16)

**Result:** `npm test`: 23 files, **351 passed** (5 new in `test/booking-modes.test.ts`; `test/bookings.test.ts`, `test/markets.test.ts` and `test/places.test.ts` updated for the mode). `tsc` is clean for the Worker and the web app.

| Brief requirement | Test |
| --- | --- |
| Defaults by kind: café events Optional, hosts' sessions Required, Standard Diary groups Not required; a private event says nothing; Not required refuses a booking with "No booking needed" | `defaults by kind…` |
| An approver changes it, and back to the default; the sync leaves it alone; each change audited with the old and new mode | `lets an approver change it…` |
| Switching to Not required with people booked: a warning with the numbers and nothing changed; with `confirm` it switches; **the old booking stays confirmed and its link still shows and cancels it** | `warns before switching to Not required…` |
| Capacity: Optional full says "you can still come along on the day"; Required full says "full" | `says it differently when the places run out…` |
| Refused: hosts' sessions and markets (409), unknown event (404), unknown mode (400), hosts (403), signed out (401) | `refuses hosts' sessions, markets…` |

### Checked in the running app (2026-10-16, local `wrangler dev`, Chromium at 390 px)

Seeded with a weekly quiz (40 places, one booking for 3), a one-off murder mystery and a weekly Standard Diary chess club.
- **Booking for café events:** Chess Club "Not required (the default)", Quiz Night "Optional (the default) · 1 booking to come", Murder Mystery "Optional (the default)".
- **Quiz Night → Not required:** warned "1 booking (3 places) on dates to come…", then **Switch to Not required**; its page then said "No booking needed: just come along."
- **Murder Mystery → Required:** its page showed the **Booking required** chip and "Booking is required: you need a place to come."
- **Chess Club → Optional:** the toast said "Chess Club: booking optional." and **Set a limit** appeared.
- **Console:** no errors apart from the expected 409 for the warning.

## Stage 4b: telling people booked, and email delivery (2026-10-16)

**Result:** `npm test`: 24 files, **363 passed** (12 new in `test/delivery.test.ts`; one outbox test in `test/bookings.test.ts` updated for the 10-minute claim). `tsc` is clean for the Worker and the web app.

| Brief requirement | Test |
| --- | --- |
| Push is opt-in per booking, with the Manage link's secret; wrong secret 404; not a push subscription 400; at most 3 devices; the browser renewing its subscription is followed; turning it off; not once the booking is cancelled | `is opt-in per booking…` |
| **Cancel with bookings:** an email per booking (with the booking on it) and a push per opted-in device; **a second click sends nothing**; the push says the event, date and "cancelled" only; **a 410 marks that device invalid and every email still goes**; nothing is pushed twice | `emails everyone booked and pushes each device…` |
| A failing push service is retried after 5 m, 15 m, 1 h, 4 h, 12 h, then given up on; shown under Delivery; the email was never held up; hosts can't see Delivery | `tries a failing push service again later…` |
| **Zero bookings:** no messages to people, only the café's notice | `sends no messages to people when nobody had booked` |
| Collecting claims for 10 minutes (no double send from overlapping runs); unclaimed after that, offered again | `claims what it collects…` |
| `/failed`: retried later; the same attempt reported twice counts once; a customer's email opens an item with their details, the café's own copy doesn't; settles when a later try goes; bearer token required | `retries a failed email…` |
| Given up after six tries; shown under Delivery with the contact; **Try again now** | `gives up after six tries…` |
| **Moved booked date (G-4):** held under Needs attention; **nobody told** until chosen; **Tell them** cancels the old bookings, emails "Moved: …, now …" with a link to the new date and the message, pushes, audits; a second choice 409 | `holds it under Needs attention…` |
| Moved: **Cancel their bookings** sends the usual cancellation | `can cancel their bookings instead…` |
| Moved: the date comes back in the sheet, so it settles itself and the bookings stand; no emails | `settles itself, with the bookings standing…` |
| Moved: the attention addresses get a notice at once | `emails the attention addresses at once` |
| Privacy: booking devices deleted the day after the date; the record of what was sent stays | `forgets booking devices the day after the date…` |

### Checked in the running app (2026-10-16, local `wrangler dev`, Chromium at 390 px)

Seeded with a quiz with two bookings, and a murder mystery with one, whose confirmation email was reported failed (`Invalid To header`). Then the sheet moved the quiz from 23 to 30 October.
- **Needs attention:** "Quiz Night: Moved, with bookings. Fri, 23 Oct (7:30 PM) has moved in the Logic Engine to Fri, 30 Oct (7:30 PM). 2 bookings (4 places) were for the old date, and nobody has told them yet." Buttons: **Tell them it has moved**, **Cancel their bookings**, **Leave it**.
- **The other item:** "Murder Mystery: Email not sent", with Gmail's error, the next try at 4:05 PM, and Cara's email.
- **Tell them it has moved**, with a message, then **Tell all 2:** two `attendee_date_moved` emails were queued, and the item moved to "Sorted" as "Told it has moved".
- **Delivery:** "Emails: 5 sent, 1 being tried again", with the failing email listed.
- **The booking form:** the opt-in checkbox with its hint. Headless Chromium always reports notifications as blocked, so the checkbox is hidden there, which is the intended behaviour; it was shown by stubbing the permission.
- **Console:** no errors.

### Not tested automatically (manual checks before release)

- **A real phone receiving a booking notification:** Android Chrome, and an iPhone with the app on the Home Screen. The encryption and sending are the same code as event alerts, which are proven live.

## Stage 4c: cancelled dates leave the sheet (2026-10-16)

**Result:** `npm test`: 25 files, **371 passed** (8 new in `test/cancelled-dates.test.ts`). `tsc` is clean for the Worker and the web app.

| Brief requirement (G-13) | Test |
| --- | --- |
| A cancelled monthly date: `/internal/sheet-fixes` offers Status Inactive with the date unchanged; the notice says so; Needs attention asks for the next date (renew / archive / leave); after n8n and the sync it waits; **renewing** sends Status Active and the new date; then nothing more | `is switched off in the sheet, and Needs attention asks…` |
| The date before it has ended, but it isn't listed as expired as well | `is never also shown as expired…` |
| A later month's cancellation is sent too (keyed by date) | `a later month is switched off too` |
| A cancelled Standard Diary date: no sheet fix (can't be written); the notice says to change the tab; Needs attention can only be left (no renew); **clears itself when the sheet's date moves on** | `asks the café to change the tab…` |
| …or once the date has passed | `clears itself once the date has passed` |
| A cancelled later week that isn't the sheet's date yet: nothing | `asks nothing for a later week…` |
| The attention addresses get a notice | `is emailed to the attention addresses` |
| A cancelled one-off: switched off as before, and not listed as a missing date meanwhile | `is switched off in the sheet as before…` |

### Checked in the running app (2026-10-16, local `wrangler dev`, Chromium at 390 px)

A monthly event (12 Nov) and a weekly Standard Diary group (19 Oct, the sheet's date) were each cancelled by an admin.
- **`/internal/sheet-fixes`:** offered exactly `{ Event ID: RTD-EVT-00006, Status: Inactive, Event Date: 12/11/2026 }`, and nothing for the Standard Diary.
- **Board Game Social card:** "Cancelled. Thu, 12 Nov was cancelled. It's switched off in the Logic Engine so it isn't advertised: set its next date, or archive it." Buttons: **Set a new date**, **Archive**, **Leave as it is**.
- **Chess Club card:** "Mon, 19 Oct was cancelled, but the Standard Diary tab still has that date, so it may still be advertised." With how to change the tab, and only **Leave as it is**.
- **Console:** no errors.

**Production check before the deploy:** there are no cancelled dates live, so the 8 open items are unaffected.

## Stage 5a: hosts' changes need approval (2026-10-16)

**Result:** `npm test`: 26 files, **376 passed** (5 new in `test/changes.test.ts`). `tsc` is clean for the Worker and the web app.

| Brief requirement (G-7, D-7) | Test |
| --- | --- |
| **A host edit doesn't change public content until approved:** the request shows "now" against "proposed" and the bookings; the approvers' inbox is emailed; the diary is unchanged and nothing is offered to the sheet. Approving: the host and each person booked (new time) are emailed; only the changed cells are offered for Event Index; the diary changes only once the sheet does; `applied` is idempotent; audit rows for each step | `changes nothing public until an approver approves it…` |
| **Reject with reason:** declining without one is refused; the host is emailed it; nothing reaches the sheet; can't then be approved | `needs a reason to decline…` |
| Asking again replaces a waiting request; only the host can withdraw it, once | `replaces a waiting request…` |
| Approving is refused when the sheet changed that field since it was asked for (no silent overwrite) | `refuses to approve when the sheet changed that field…` |
| A new date is written with its day; the form is checked (nothing changed, a name another event uses, a past date); another host can't ask; a host can't decide | `writes a new date with its day…` |

### Checked in the running app (2026-10-16, local `wrangler dev`, Chromium at 390 px)

Seeded with a live weekly host session (Catan Club, Tuesdays 6:30pm, free) with one booking.
- **The host's card:** **Ask for a change**. The form opened filled in with the diary's details. Start set to 7pm, Paid £3, and a note, then **Send to the café**.
- **Then:** the card showed "Change waiting for the café" with 6:30 PM → 7 PM and Free → £3, and **Withdraw this request**.
- **Changes to approve:** the same side by side, the note, and "1 booking (2 places) on dates to come. They are emailed the new time when you approve." **Approve** emptied the list.
- **After approving:** the card said "Change approved: reaching the diary within about half an hour". The outbox held the approvers' email, Ava's "New time" email and the host's "Change approved". `/internal/host-changes` offered exactly `{ Event ID, Event Time: 19:00, App Price: £3 }`.
- **Console:** no errors.

## Stage 5b: dates in the app (2026-10-16)

**Result:** `npm test`: 27 files, **382 passed** (6 new in `test/dates.test.ts`). `tsc` is clean for the Worker and the web app.

| Requirement | Test |
| --- | --- |
| The next four weeks are listed, never what the sheet hides; hosts can't see it | `lists the dates coming up…` |
| **Unpublish / publish one date:** it leaves the diary and its page, only that date; the sync leaves it alone; shown again; each change audited with before and after | `hides a date in the app and shows it again…` |
| Hiding a booked date asks first, with the numbers; the booking stands, and its link still shows it | `asks before hiding a date people have booked…` |
| **Edit app-owned fields:** a description and price for one date; other dates unchanged; the sync leaves them; empty or the same as the event's goes back to the event's | `gives one date its own description and price…` |
| The form is checked; hosts can't; only dates still to come | `checks the form, and only changes dates still to come` |
| A hidden last date still raises Needs attention when it ends | `still raises Needs attention when a hidden last date ends` |

### Checked in the running app (2026-10-16, local `wrangler dev`, Chromium at 390 px)

A weekly quiz, with one booking on 23 October.
- **Dates in the app:** listed the next four weeks.
- **Change this date** on 23 October: description, price £3, and **Hide this date in the app**, then **Save**. It warned "1 booking (2 places) on this date…". **Hide it** saved.
- **Afterwards:** the row showed **Hidden in the app**, **Own description** and **Own price: £3**, and `/api/events` no longer listed 23 October (30 October onwards still listed).
- **Console:** only the expected 409 for the warning.

## Stage 6: changing events from the organiser (2026-10-16)

**Result:** `npm test`: 28 files, **400 passed** (18 new in `test/sheet-edits.test.ts`; `test/normalise.test.ts` now checks the sheet values). `tsc` is clean for the Worker and the web app.

| Brief requirement (G-6, D-13) | Test |
| --- | --- |
| Canonical values: `6:30 PM` = `18:30`, sheet time fractions and serial dates, `App Bookable`, blank visibility = hidden, case of Status and category, line endings | `treats the same value written two ways as equal` |
| Cells written as the sheet holds them (DD/MM/YYYY, `App Bookable`), Day with a date | `writes cells the way the sheet holds them…` |
| Checking a row: write only what still holds `from`; a column already changed the same way is left alone; anything else is a conflict; no row, a duplicate Event ID or a renamed column is an error | `checks a row: write, nothing to do, conflict, or an error` |
| The sync stores the sheet values without changing any event's hash | `stores them on each event without changing its hash` |
| Closed while off; admins only (approvers get 403 for the setting, the list and changes); the setting is audited | `is closed while switched off, and only for admins` |
| The café's events with their sheet values; host sessions are not offered | `lists the café’s events with their sheet values…` |
| **An app edit reaches the sheet, then the app at the next sync, with no echo:** only changed columns queued; nothing public changes before the sheet does; claimed once; the check offers just the cells; read back; the sync shows it and marks it synced; nothing goes back | `reaches the sheet, then the app at the next sync, with no echo` |
| **Concurrent edits are a conflict with neither overwritten:** nothing to write; the admin is emailed; a stale run can't settle it; another change waits; **write mine** checks again against the sheet's new value | `records a conflict when the sheet moved on…` |
| Keep the sheet's value | `keeps the sheet’s value when asked` |
| Both sides made the same change: nothing written | `writes nothing when the sheet already has the change` |
| The sheet changed again before the app read it: overtaken, the sheet's value stands; a sync that may have read before the write proves nothing | `marks a written change overtaken…` |
| Shadow writes nothing; staging writes only the test copy and never touches the app | `only tries it out in shadow mode, and only writes the test copy in staging mode` |
| Live changes wait while the mode is off or a trial; withdraw | `holds live changes while the mode is off or a trial` |
| **Recovery after an n8n / Google outage:** retries at 5 m, 15 m, 1 h, 4 h, 12 h; not claimable before its time; a failure counts once per claim; given up on with an email; **Try again** | `tries again after a failure, then gives up…` |
| A cell that reads back wrong is given up on at once | `gives up at once when the cells read back wrong` |
| The form is checked: a name another row has, past or invalid dates, an end with no start, unknown values, columns that can't be changed, nothing changed, host sessions, unknown events | `checks the form` |
| Moving a booked date or switching an event off asks first, with the numbers | `asks first when people have booked` |
| The overview for admins: mode, counts, the last sync; claims never shown | `shows the queue and the last sync to admins` |

### Checked in the running app (2026-10-16, local `wrangler dev`, Chromium at 390 px)

Seeded with a weekly Quiz Night (one booking on 23 October).
- **Logic Engine changes:** Off at first. **Test copy**, then **Save**.
- **Find an event:** "quiz" found Quiz Night. **Change:** Ends 22:30 and new base details, then **Send to the sheet**. It warned "1 booking (2 places) on Friday 23 October…"; **Change it anyway** queued it: "Waiting to be written · Test copy", only End Time and Base Details listed.
- **The writer, by hand** (`/internal/sheet-edits/claim`, then `/check` with a row whose Base Details had been changed by hand): `{ action: skip, status: conflict }`. The card showed "The sheet changed", "the sheet now has Teams of up to six, bring a pen.", and **Keep the sheet's** / **Write mine over it**.
- **Write mine over it:** back to waiting, now from the sheet's value. The next `/check` answered `write` with exactly `{ Event ID, Base Details, End Time }`; `/written` with the row read back: "In the sheet".
- **Console:** only the expected 409 for the warning.

### n8n RTD Sheet Writer (2026-10-16, a test run with the sheet and app calls simulated)

Three changes: a staging one, a live one (no `RTD_LOGIC_ENGINE_ID` set) and a Standard Diary one whose simulated check answer named another event. Each was handled on its own pass of the loop with its own Event ID; the live one was reported to the app as a failed try ("rtd_config has no RTD_LOGIC_ENGINE_ID…"); the third was refused by **Cells To Write** ("The cells are for a different Event ID") and reported, so nothing would have been written. The rtd_config reads were real; the staging ID resolved to the test copy.

## Later stages

| Brief §4 criterion | Stage |
| --- | --- |
| Expiry creates exactly one attention item; both recipients; daily reminders until resolved; no multiplication on retry | 3b / 3c |
| Booking modes none / optional / required; capacity; old bookings survive | 4a |
| Cancellation: email + eligible push per booking contact, no duplicates, invalid push doesn't block email, zero bookings → no attendee messages | 4b |
| Reschedule preserves history and notifies bookers; a fresh recurrence doesn't migrate bookings | 4b |
| Host edit needs approval; reject with reason | 5a |
| Sheet ↔ app: uncontested edits apply both ways; concurrent edits → conflict; recovery after outages | 6 |
| Audit trail records changes and delivery outcomes; no attendee data leaks | 3b–6 |
| Regression: game chooser, library, bookings, host auth, PWA, deployments | Every stage (the full suite) |
