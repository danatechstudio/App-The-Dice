# RTD Privacy

The app holds customers' names, emails and phone numbers from bookings, and hosts' details. This file covers the public privacy notice, what is kept and for how long, and what is still left for the café to do.

## Status (2026-10-07)

| Part | State |
| --- | --- |
| Privacy notice at `/privacy` | **Built** |
| Linked from the booking form, the join form, the booking page, the footer and the booking confirmation email | **Built** |
| Booking contact details erased 12 months after the event | **Built** (daily Cron Trigger) |
| Network hashes erased after 2 days; declined or withdrawn join requests after 12 months | **Built** |
| No people in the audit log (it can never be erased) | **Built** for bookings, join requests and market applications |
| Market stall applications erased 12 months after the market, photos and spreadsheet row included | **Built** (2026-10-08, [RTD_MARKETS.md](RTD_MARKETS.md)) |
| The business's legal name on the notice | **Waiting on Dan.** It shows the trading name until then. |
| ICO data protection fee | **Check:** does the café already pay it? |
| Clearing old booking emails out of the café's mailboxes | **To do by the café:** the notice promises it (see below) |

## The notice

The page is `web/src/pages/Privacy.tsx`. In plain English, it covers:
- **Who:** who is responsible (the data controller), and how to get in touch.
- **What and why:** booking details (to take the booking), the scrambled network code (to stop misuse), hosts' details, and preferences kept on the device. There are no advertising or tracking cookies.
- **Who sees it:**
  - **The café team:** everything.
  - **The host:** names, numbers and notes, but not contact details.
  - **Our app developer, Cloudflare and Google:** they run the app for the café.
  - **Never:** sold, or used for marketing.
- **How long:** as in the table below.
- **Rights:** copy, correct, delete, object; a reply within a month; complaints to the ICO.
- **Children:** under 13s ask a parent or carer to book.

**Settings:** three values come from the D1 `settings` table, read through `GET /api/privacy` (cached 5 minutes). They change without a release:

| Key | Live value | Notes |
| --- | --- | --- |
| `privacy_controller` | Roll The Dice Board Game Café, Cleethorpes | Replace with the legal name (and company number, if a limited company) |
| `privacy_contact_email` | The café's info@ address | Set in the live database only, never in the repo. If it's missing or not an address, the page says "reply to any email from us, or ask at the café". |
| `booking_retention_months` | 12 | 1–120; anything else counts as 12 |

To change one:
```sql
UPDATE settings SET value = 'Roll The Dice Ltd (company 01234567)', updated_at = '<now>', updated_by = '<you>' WHERE key = 'privacy_controller';
```

**When the wording changes,** update `UPDATED` at the top of `Privacy.tsx`.

## What is kept, and for how long

| What | Where | Kept | How |
| --- | --- | --- | --- |
| Booking name, email, mobile, note | `bookings` | 12 months after the event (`booking_retention_months`) | Daily: replaced with "Erased" / `erased-RTD-BK-…`; `erased_at` set. The booking number, party size and status stay, so numbers still add up. |
| Scrambled network address (`ip_hash`) | `bookings` | 2 days | Daily: set to NULL |
| Emails about bookings | `outbox` | 90 days after sending | Deleted each time n8n collects (every 5 minutes) |
| Declined or withdrawn join requests | `applications` | 12 months after the decision | Daily: name, email, what they wrote and the café's note erased; `erased_at` set |
| Market stall applications | `market_applications`, `market_photos`, KV `vendor:…`, the RTD Market Vendors spreadsheet | 12 months after the market | Daily: details erased and photos deleted; the next spreadsheet sync writes the row as Erased. Google Sheets' version history keeps old values until cleared. |
| Hosts and approvers | `users`, `host_sessions` | While they have access | **By hand, on request:** the notice says so |
| Audit log | `audit_log` | For good (append-only) | Holds booking and request numbers, not people. Staff and hosts' own actions are recorded under their sign-in email: the notice says decisions in the organiser are kept. |
| Push devices (approvers) | `push_subscriptions` | Until turned off, or the device stops working | See [RTD_PUSH.md](RTD_PUSH.md) |
| Copies of emails | The café's inbox (info@) and the sending Gmail account (ATech GMAIL, Sent folder) | Outside the app | **The café must clear these out regularly:** the notice says copies in the café's mailboxes are deleted once they're no longer needed |

**The daily job:**
- **When it runs:** a Cron Trigger at 03:23 UTC (`wrangler.jsonc` `triggers.crons`) calls `applyRetention` (`src/lib/privacy.ts`) and logs what it erased (Workers Logs: `retention {...}`).
- **Safe to repeat:** it touches each row once.

## Before promoting the app

1. **Legal name:** send it to Claude, or update `privacy_controller` yourself.
2. **ICO fee:** check whether the café pays the data protection fee (most small businesses that hold customer details need to). Look it up at ico.org.uk.
3. **Mailboxes:** decide how often booking emails are cleared from info@ and from the ATech Gmail Sent folder. For example, a monthly clear-out of anything over 12 months old, or a Gmail filter.
4. **Read the notice through,** and tell Claude what to change.
