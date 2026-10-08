# RTD Bookings

Customers can book places on **every public event** in the app: the café's own events and hosts' open sessions. Every booking and cancellation is emailed to the café's bookings inbox (info@). Hosts also hear about bookings on their own sessions.

## Status (2026-10-07)

| Part | State |
| --- | --- |
| Booking any public event on its page (no account) | **Built** |
| Confirmation email with a Manage / Cancel link; replies go to info@ | **Built** |
| Customer cancels their own booking | **Built** |
| info@ emailed for every booking and every cancellation | **Built** |
| info@ emailed the numbers two days before each booked café event | **Built** |
| info@ warned when a booked date disappears from the Logic Engine | **Built** |
| Host emailed for each booking and cancellation on their session, and the numbers two days before | **Built** |
| Host cancels a date of their session; Michelle cancels any date: everyone booked emailed | **Built** |
| Cancelled dates taken out of the Logic Engine, so they're never advertised | **Built** (one-off, weekly and fortnightly Event Index rows; n8n **RTD Host Sessions To Diary**) |
| Hosts change their own sessions' places; approvers set café events' places, or any date's | **Built** (2026-10-07): see [Places](#places) |
| Privacy notice, and booking details erased 12 months after the event | **Built**: see [RTD_PRIVACY.md](RTD_PRIVACY.md) |
| Waiting list, daily staff digest, editing a booking | Not built (spec §23, §33) |

## What can be booked

| Event | Bookable? | Limit |
| --- | --- | --- |
| The café's own events with App Visibility **Public** or **App Bookable** (Event Index and Standard Diary) | Yes | The number set in the organiser, else the row's **App Capacity**. With neither, there's no limit. |
| A host's **open** session | Yes | Its Max players, which the host can change once it's live |
| **Private** events and host sessions | Never | |
| **Hidden** or inactive events | Never (not shown) | |
| Markets set up in the organiser | No: vendors apply for pitches instead ([RTD_MARKETS.md](RTD_MARKETS.md)) | |

**Notes:**
- **Booking per date:** a weekly or fortnightly event is booked one date at a time.
- **The Book page** lists the next date of every bookable event. Every event page has the booking form.
- **To limit numbers for a café event:** set its places under **Places for café events** in the organiser, or fill in App Capacity on its row. To stop bookings altogether, it has to be Private or Hidden.

## Booking

**On the event page, under the facts:**
- **Places left:** "3 places left of 6", shown only when there's a limit.
- **Your name:** required.
- **Email:** required, for the confirmation and for changes.
- **Mobile:** optional.
- **How many places?:** 1 up to the places left, at most 10 in one booking.
- **Anything we should know?:** optional, up to 300 characters.

**After booking:** "You're booked." and a **See your booking** link. The confirmation email arrives within 5 minutes.

**Rules:**
- **Capacity counts people, not bookings:** a booking for 3 takes 3 places. The check happens inside the database insert itself, so two people can't both take the last place.
- **Bookings close** when the event starts, or when it's cancelled.
- **One booking per email per date:** to change the numbers, cancel and book again.
- **Limits:** 5 bookings per email address a day, and 10 per network address an hour (a one-way hash of the address and the day, never the address itself). There's also a hidden form field that only robots fill in.
- **Payment:** none online. Paid events say "Pay at the café on the day". A cost appears in the confirmation only when the sheet has an App Price.
- **Numbering:** bookings are numbered `RTD-BK-00001` upwards.

**Who sees what:**
- **The café (info@ and approvers in the organiser):** name, email, mobile, party size and note.
- **A host:** names, how many and notes, not contact details.
- **The booking form says so,** next to the Book button.

## Places

How many people can book a date. It counts people, not bookings.

**Which number applies to a date, first match wins:**
1. **That date's own number,** set in the organiser.
2. **The event's number set in the organiser:** by the host for their session, or by an approver for a café event.
3. **App Capacity in the sheet.**
4. **None of these:** there's no limit.

**Who can change what:**

| Who | Where | What |
| --- | --- | --- |
| A host | **Change places** on their live session's card | Every date of their own session (1–100). It becomes the session's Max players. No new approval is needed. |
| A host | **Change places** on one of their dates | That date only, or back to **Same as the other dates** |
| An approver or admin | **Places for café events** in the organiser | Every date of a café event (1–500), or **No limit** / **Use the sheet's N** |
| An approver or admin | **Change places** on a date in **Bookings coming up** | That date only, for café events and hosted sessions alike |

**Rules:**
- **Never below what's booked:** a number below what's already booked on a date it would apply to is refused, naming the date: "5 places are already booked on Tue 20 Oct, so it can't go below 5."
- **"Every date" means every date:** a new number for every date replaces any date's own number from today on.
- **Hosts' sessions are the host's:** approvers can't change every date of a host's session, only single dates.
- **The sheet and the app:** a number set in the app holds through syncs until someone changes App Capacity in the sheet. Then the sheet's number wins (the sync clears the app's number), so the last change always wins.
- **Checked at the last moment:** the booking itself checks the places at the moment it's saved, so lowering the places can't let a booking through on the old number.
- **Audit:** every change is in the audit log (`host_session.places_changed`, `event.places_changed`, `occurrence.places_changed`, with the old and new numbers).

## The Manage / Cancel link

- **Where it is:** the confirmation email links to `/booking/RTD-BK-00001#t=<secret>`.
- **The secret:**
  - **Where it travels:** it stays after the `#`, so it's never sent in a page request or kept in server logs. The page sends it in a JSON request to read or cancel the booking.
  - **What's stored:** only its SHA-256 hash.
- **What the page shows:** the event, date, time, places and status.
- **Cancelling:** **Cancel my booking** is there until the event starts. The places go back; info@ (and the host, for a hosted session) is emailed.
- **If the host or the café cancelled the date,** the page says so, with their message.

## Emails

### To the café's bookings inbox (info@)

| Email | When | Replying reaches |
| --- | --- | --- |
| "New booking: Bingo, Fri 9 Oct (4 places)": name, email, mobile, note, booking number, how many are booked now | Every booking, café events and hosted sessions alike | The customer |
| "Booking cancelled: …" | Every time a customer cancels | The customer |
| "Bingo, Fri 9 Oct: 18 places booked": everyone booked, with contact details | Two days before a café event that people have booked (from 09:00; the day before if that was missed) | — |
| "Check bookings: Bingo, Fri 9 Oct" | A booked date has gone from the Logic Engine: it was moved, or the row was switched off or deleted. Cancel it in the organiser so people are told, or put it back. | — |
| "Host cancelled: …" | A host cancelled a date of their session | The host |
| "Cancelled: Quiz, Thu 8 Oct" | A record when an approver cancels a café event's date, saying whether the sheet is updated for you | — |

### To the customer

| Email | When |
| --- | --- |
| "You're booked: …", with a cancel link | Booking |
| "Cancelled: …", with the host's or café's message | The date is cancelled |

Replies go to info@.

### To a host (their own sessions)

| Email | When |
| --- | --- |
| "New booking: …" (names and numbers) | Each booking |
| "Booking cancelled: …" | Each customer cancellation |
| "D&D One Shot, Sat 24 Oct: 5 of 6 places booked", with a link to cancel the date | Two days before each date, even when nobody has booked |
| "The café cancelled: …" | An approver cancelled the date |

Replies go to the café's general address.

## Cancelling a date

**Who can cancel:**
- **Hosts:** in the organiser, **Cancel this date** on their own sessions.
- **Approvers (Michelle) and admins:** any date in **Bookings coming up**, which lists the next three weeks. It shows every hosted date, plus every café event date someone has booked.

**What happens:**
1. **Message:** whoever cancels can add a message for the people booked (optional).
2. **At once:**
   - **The date:** it's marked cancelled in the app and leaves the diary. Its page and old links say "This event has been cancelled".
   - **Bookings:** every booking on it is cancelled.
3. **Emails go out within 5 minutes:**
   - **Everyone booked:** an email with the message.
   - **The other side:** the bookings inbox (or the host, if the café cancelled a host's session) gets a notice.
4. **The Logic Engine is updated within 15 minutes** (n8n **RTD Host Sessions To Diary**, matched on the row's **Event ID**), so the date isn't advertised:
   - **A one-off:** its Event Index row goes `Inactive`.
   - **A weekly or fortnightly event:** the row's Event Date moves on to its next date that isn't cancelled. The dates after carry on as normal.
   - **Monthly events and Standard Diary groups:** left to the café. The cancellation notice says to update the sheet.

**Cancelled dates stay cancelled:** the Logic Engine sync never brings a cancelled date back.

**Cancel in the app, not just in the sheet:** that way, the people booked are told. If a booked date is changed or removed in the sheet instead, info@ gets a "Check bookings" warning.

## The outbox and the bookings inbox

The app writes every booking email itself (`src/notify/emails.ts`) into the `outbox` table, in the same database transaction as the change it describes. n8n **RTD Outbox** (every 5 minutes) collects and sends them. Details are in [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#rtd-outbox-dju9njoh7aisaiff).

**Addresses never live in the app.** The outbox uses placeholders, which n8n fills in from `rtd_config`:

| In the outbox | Becomes |
| --- | --- |
| `@bookings` | `RTD_BOOKINGS_EMAIL`: the café's info@ address. If the key is missing, it falls back to the café address. |
| empty | `RTD_CAFE_NOTIFICATION_EMAIL`: the café's general address |
| anything else | That address (a customer's or a host's) |

**How the outbox behaves:**
- **Once only:** each email has a unique key (for example `booking-new-cafe:RTD-BK-00001`, `cafe-numbers:RTD-OCC-…`), so a retry never sends it twice. n8n marks each one sent after Gmail accepts it.
- **Failures:** an email that fails stays queued and is tried again in 5 minutes; the rest still go. The run then fails, so the error handler emails Dan.
- **Retention:** sent emails are deleted from the outbox after 90 days.
- **Escaping:** everything people typed is HTML-escaped.

## Audit

| Action | Entity | Actor |
| --- | --- | --- |
| `booking.created` | `booking` | the customer, recorded as the booking number (never their email: the audit log can't be erased) |
| `booking.cancelled` | `booking` | the customer, as above |
| `occurrence.cancelled` | `occurrence` (with the occurrence ID) | the host (`host`) or an approver (`staff`). It keeps the message and how many bookings were cancelled. |
| `…places_changed` | `host_session`, `event` or `occurrence` | the host or an approver, with the old and new numbers |

Bookings are never deleted. A cancelled one keeps who cancelled it and why. Twelve months after the event, the person's name, email, mobile and note are erased ([RTD_PRIVACY.md](RTD_PRIVACY.md)).

## API

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/bookings/availability/:occurrenceId` | anyone | `{ bookable, open, reason, capacity, places_left, max_party }`. `capacity` / `places_left` are null when there's no limit. Never cached. |
| POST | `/api/bookings` | anyone | `{ occurrence_id, lead_name, email, mobile?, party_size, notes? }`. 201 with `manage_path`, or 400 / 404 / 409 (full, closed, already booked) / 429. |
| POST | `/api/bookings/:id/view` | the link holder | `{ token }`: the booking |
| POST | `/api/bookings/:id/cancel` | the link holder | `{ token }`: cancel it |
| GET | `/api/host/sessions` | host | Each live session has `dates`, each with its bookings (no contact details) |
| POST | `/api/host/occurrences/:occurrenceId/cancel` | the session's host; approvers and admins for any date | `{ message? }`: cancel a date |
| GET | `/api/staff/booked-dates` | approver, admin | The next 3 weeks: hosted dates, and café dates people have booked, with contacts. Each date has `capacity` and `own_capacity`. |
| POST | `/api/host/sessions/:id/places` | the session's host | `{ places }`: every date of their live session |
| POST | `/api/host/occurrences/:occurrenceId/places` | the session's host; approvers and admins for any date | `{ places: number \| null }`: one date; null goes back to the event's number |
| GET | `/api/staff/event-places` | approver, admin | Every café event that can be booked, with its places (sheet, app, applying), the most booked on a date, and how many dates have their own number |
| POST | `/api/staff/events/:eventId/places` | approver, admin | `{ places: number \| null }`: every date of a café event; null goes back to the sheet |
| POST | `/internal/outbox/collect` | n8n (bearer token) | Queues emails now due (numbers, warnings), then returns unsent emails |
| POST | `/internal/outbox/:id/sent` | n8n | Mark one sent |
| GET | `/internal/sheet-fixes` | n8n | Event Index changes for cancelled dates, each with its Event ID |
| POST | `/internal/sheet-fixes/:eventId/done` | n8n | `{ key }`: record it done |
| GET | `/internal/host-sessions/sheet-fixes` | n8n | Retired: always empty |

Booking changes must be same-origin JSON (403 for other sites, 415 for non-JSON), like the rest of the app.

## Data

**Tables:**
- **`bookings` and `outbox`:** from migration `0008_bookings.sql`.
- **`sheet_fixes`:** from `0011_cafe_bookings.sql`. It records the last Event Index change made for each event.

**Columns:**
- **0008:** `occurrences.cancelled_by`.
- **0012:** `events.capacity_override` (places set in the organiser) and `bookings.erased_at`.
- **From 0001:** `occurrences.capacity` holds a date's own number.
- **No longer used:** `host_sessions.sheet_fix_sent`.

See [RTD_DATABASE_SCHEMA.md](RTD_DATABASE_SCHEMA.md).

## Before promoting it

- **Privacy:** the notice is live at `/privacy`. Still to do: the business's legal name, checking the ICO fee, and clearing old booking emails from the café's mailboxes. See [RTD_PRIVACY.md](RTD_PRIVACY.md).
- **Sending address:** emails come from the ATech Gmail account, shown as "Roll The Dice". Gmail has a daily sending limit, which matters if bookings grow.
- **Places:** set places on events where numbers matter (quizzes, tournaments), under **Places for café events**. Without a number, there's no limit.
