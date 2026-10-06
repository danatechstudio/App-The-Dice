# RTD Bookings: hosted sessions

People can book places on **open host sessions** in the app. The host is emailed for every booking, gets the numbers two days before each date, and can cancel a date if there aren't enough players. Everyone booked is then emailed for them.

## Status (2026-10-06)

| Part | State |
| --- | --- |
| Booking an open host session on its event page (no account) | **Built** |
| Confirmation email with a Manage / Cancel link | **Built** |
| Customer cancels their own booking | **Built** |
| Host emailed for every booking, and every cancellation | **Built** |
| Host emailed the numbers two days before each date, with the option to cancel | **Built** |
| Host (or Michelle) cancels a date: everyone booked emailed, the café or the host told | **Built** |
| Cancelled dates taken out of the Logic Engine, so they're never advertised | **Built** (n8n **RTD Host Sessions To Diary**) |
| The café's own events (quizzes, clubs) | Not bookable. Book with the café team, as before. |
| Waiting list, daily staff digest, editing a booking | Not built (spec §23, §33) |

**What can be booked:**
- **Open host sessions:** live (approved and in the diary), with a size set (Max players). Their cards show a **Book in the app** chip, and the Book page lists them.
- **Private host sessions:** never bookable. They're the host's own group.
- **Everything else:** keeps the "Ask the café team to save you a place" note.

## Booking

**On the event page, under the facts:**
- **Places left:** shown as "3 places left of 6".
- **Your name:** required.
- **Email:** required, for the confirmation and for changes.
- **Mobile:** optional.
- **How many places?:** 1 up to the places left, at most 10.
- **Note for the host:** optional, up to 300 characters.

**After booking:** "You're booked." and a **See your booking** link. The confirmation email arrives within 5 minutes.

**Rules:**
- **Capacity counts people, not bookings:** a booking for 3 takes 3 places. The check happens inside the database insert itself, so two people can't both take the last place.
- **Bookings close** when the session starts, or when it's cancelled.
- **One booking per email per date:** to change the numbers, cancel and book again.
- **Limits:** 5 bookings per email address a day, and 10 per network address an hour (a one-way hash of the address and the day, never the address itself). There's also a hidden form field that only robots fill in.
- **Payment:** none online. Paid sessions say "Pay at the café on the day".
- **Numbering:** bookings are numbered `RTD-BK-00001` upwards.

**Who sees what:**
- **The host:** names, how many and notes. Not email addresses or phone numbers.
- **Approvers (the café):** also the email and mobile, to get in touch.
- **The booking form says so,** next to the Book button.

## The Manage / Cancel link

- **Where it is:** the confirmation email links to `/booking/RTD-BK-00001#t=<secret>`.
- **The secret:**
  - **Where it travels:** it stays after the `#`, so it's never sent in a page request or kept in server logs. The page sends it in a JSON request to read or cancel the booking.
  - **What's stored:** only its SHA-256 hash.
- **What the page shows:** the session, date, time, places and status.
- **Cancelling:** **Cancel my booking** is there until the session starts. The places go back, and the host is emailed.
- **If the host or the café cancelled the date,** the page says so, with their message.

## For hosts: numbers and cancelling

**In the organiser:** each live session lists its upcoming dates, each with "3 of 8 booked" and **Who's coming** (names, places, notes).

**Emails to the host** (from "Roll The Dice"; replies go to the café):

| Email | When |
| --- | --- |
| "New booking: D&D One Shot, Sat 24 Oct" | Each booking, with how many places are taken now and the person's note |
| "Booking cancelled: …" | Each time someone cancels their own booking |
| "D&D One Shot, Sat 24 Oct: 5 of 6 places booked" | **Two days before each date**, from 09:00, listing everyone booked, with a link to cancel the date in the organiser. If that's missed (n8n down), it goes the day before. |

**Which dates get the two-day email:**
- **Included:** dates of open sessions, even when nobody has booked.
- **Not included:** private sessions and cancelled dates.

**Cancelling a date** ("Cancel this date" in the organiser):
1. **Message:** the host can add a message for the people booked (optional).
2. **What happens at once:**
   - **The date:** it's marked cancelled in the app, and leaves the diary. Its event page and old links say "This event has been cancelled".
   - **Bookings:** every booking on it is cancelled.
3. **Emails go out within 5 minutes:**
   - **Everyone booked:** "Cancelled: D&D One Shot, Sat 24 Oct", with the host's message.
   - **The café:** "Host cancelled: …", with how many people were told. Replies go to the host.
4. **The Logic Engine is updated within 15 minutes** (n8n **RTD Host Sessions To Diary**), so the date isn't advertised:
   - **A one-off:** its Event Index row goes `Inactive`.
   - **A weekly session:** the row's Event Date moves on to its next date that isn't cancelled. The weeks after carry on as normal.

**Who else can cancel:** approvers (Michelle) and admins can cancel any hosted date, in the organiser's **Hosted sessions coming up** list. The host is then emailed "The café cancelled: …" instead of the café.

**What stays the same:**
- **Cancelling is per date.** To stop a weekly session for good, the café sets its Event Index row to Inactive, as before.
- **Cancelled dates stay cancelled.** The Logic Engine sync never brings a cancelled date back. Cancel in the app, not just in the sheet, so people booked are told.

## Emails: the outbox

The app writes each booking email itself (`src/notify/emails.ts`) into the `outbox` table, in the same database transaction as the change it describes. n8n **RTD Outbox** (every 5 minutes) collects and sends them. Details are in [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#rtd-outbox-dju9njoh7aisaiff).

- **Once only:** each email has a unique key (for example `host-numbers:RTD-OCC-…`), so a retry never sends it twice. n8n marks each one sent after Gmail accepts it.
- **The café's address:** stays in n8n (`rtd_config`). The app leaves "to" or "reply to" empty to mean the café.
- **Failures:** an email that fails stays queued and is tried again in 5 minutes; the rest still go. The run then fails, so the error handler emails Dan.
- **Retention:** sent emails are deleted from the outbox after 90 days.
- **Escaping:** everything people typed is HTML-escaped.

## Audit

| Action | Entity | Actor |
| --- | --- | --- |
| `booking.created` | `booking` | the customer (their email) |
| `booking.cancelled` | `booking` | the customer |
| `occurrence.cancelled` | `occurrence` (with the occurrence ID) | the host (`host`) or an approver (`staff`); keeps the message and how many bookings were cancelled |

Bookings are never deleted. A cancelled one keeps who cancelled it and why.

## API

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/bookings/availability/:occurrenceId` | anyone | `{ bookable, open, reason, capacity, places_left, max_party }`. Never cached. |
| POST | `/api/bookings` | anyone | `{ occurrence_id, lead_name, email, mobile?, party_size, notes? }`. 201 with `manage_path`, or 400 / 404 / 409 (full, closed, already booked) / 429. |
| POST | `/api/bookings/:id/view` | the link holder | `{ token }`: the booking |
| POST | `/api/bookings/:id/cancel` | the link holder | `{ token }`: cancel it |
| GET | `/api/host/sessions` | host | Each live session has `dates`, each with its bookings (no contact details) |
| POST | `/api/host/occurrences/:occurrenceId/cancel` | the session's host, approver, admin | `{ message? }`: cancel a date |
| GET | `/api/staff/hosted-dates` | approver, admin | Every hosted date in the next 3 weeks, with bookings and contact details |
| POST | `/internal/outbox/collect` | n8n (bearer token) | Queues any two-day emails now due, then returns unsent emails (`to` / `reply_to` null = the café) |
| POST | `/internal/outbox/:id/sent` | n8n | Mark one sent |
| GET | `/internal/host-sessions/sheet-fixes` | n8n | Event Index changes for cancelled dates, matched on App Host Session |
| POST | `/internal/host-sessions/:id/sheet-fixed` | n8n | `{ key }`: record it done |

Booking changes must be same-origin JSON (403 for other sites, 415 for non-JSON), like the rest of the app.

## Data

The new tables are `bookings` and `outbox`. There are also new columns: `occurrences.cancelled_by`, and `host_sessions.sheet_fix_sent` / `sheet_fix_sent_at`. All come from migration `0008_bookings.sql`; see [RTD_DATABASE_SCHEMA.md](RTD_DATABASE_SCHEMA.md).

## Not yet

- **Waiting list** (spec §23): a full session just says it's full.
- **Daily staff booking digest** (spec §33).
- **A privacy notice:** the app now holds customers' names, emails and phone numbers. See [RTD_PRODUCTION_READINESS.md](RTD_PRODUCTION_READINESS.md).
- **Sending from a café address:** booking emails come from the ATech Gmail account, as "Roll The Dice".
