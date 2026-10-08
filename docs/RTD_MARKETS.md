# RTD Markets

A few times a year the café runs a market. An admin sets it up in the organiser, and vendors apply for a pitch in the app. Approvers (Michelle) approve or decline each one, and approved vendors are emailed the pitch fee and how to pay. Every application is also kept in the **RTD Market Vendors** spreadsheet.

## Status (2026-10-08)

| Part | State |
| --- | --- |
| Admins set up a market in the organiser; it reaches the Logic Engine and the diary within 15 minutes | **Built** |
| Vendors apply at `/markets` (no account): stall, contact, what they sell, links, insurance, up to 3 photos | **Built** |
| The vendor gets an acknowledgement; the approvers' inbox (info@) gets every application, and approvers get a push | **Built** |
| Approvers approve or decline in the organiser; approval emails the fee, the payment details and a reference | **Built** |
| Waiting list once every pitch is approved; "Mark as dropped out" frees a pitch | **Built** |
| Every application in the RTD Market Vendors spreadsheet, kept up to date | **Built** (n8n **RTD Market Vendors To Sheet**) |
| Applications erased 12 months after the market, photos and spreadsheet row included | **Built** |
| Tracking who has paid | Not built (by choice: the email gives the details; payment is checked outside the app) |
| Cancelling a whole market from the app | Not built: set its Event Index row Inactive, and email the vendors |

## Setting up a market (admins)

In the organiser, admins see **Markets** → **New market**:

| Field | Rules |
| --- | --- |
| Market name | 3–80 characters |
| Date, start time, end time (optional) | From tomorrow, within a year |
| Description (optional) | Up to 1,000 characters. Shown to vendors, and used as Base Details when it's added to the diary |
| Pitches | 1–200 |
| Pitch fee | In pounds; empty for no fee |
| Applications close | The last day vendors can apply; on or before the market day |
| How approved vendors pay | Bank details or a payment link, up to 1,000 characters. Required when there's a fee. Only approved vendors see it, in their approval email |

**What happens next:**
1. **Into the diary:** within 15 minutes, n8n **RTD Host Sessions To Diary** adds the market to Event Index with the rest of the approved sessions:
   - **Row values:** Frequency `One-off`, App Category `Market`, App Visibility `Public`, Organiser Email = the admin, App Host Session = the market's number (`RTD-MKT-00001`).
   - **Name clashes:** if the name is already in the sheet (last year's market), the year is added: "Christmas Market (2026)".
2. **Linked back:** the next sync links the row to the market (`events.market_id`). The diary page then shows **Want a stall? Apply for a pitch** instead of the booking form.
3. **Not bookable:** customers don't book markets set up in the app.

**Changing a market:** **Change** on its card.
- **What can change:** everything, but pitches can't go below the vendors already approved.
- **Once it's in the diary:** a new name, date or times must be changed in its Event Index row too; the organiser says so. The description in the diary is the row's Base Details.

## Applying (vendors)

**Where:** `/markets` lists every market still to come: the date, the pitch fee, pitches left and the closing date. It's linked from the footer, the **Become a host** page and each market's diary page.

**The form** (`/markets/RTD-MKT-…`):

| Field | Rules |
| --- | --- |
| Stall or business name | Required |
| Your name, email, mobile | Required: the mobile is for the day |
| What do you sell? | 10–1,000 characters |
| Website or social links | Optional, one per line |
| Public liability insurance | Yes or No. If Yes: the insurer and the date the cover ends (not already past) |
| Photos | Optional, up to 3. The page shrinks each one to 1,600 px and re-saves it as JPEG, which also drops hidden details like location. The server accepts only JPEG, PNG or WebP, under 2 MB each |
| Anything else? | Optional, up to 500 characters |

**Rules:**
- **One per market:** one waiting or approved application per email address per market.
- **Limits:** 3 applications per email address a day, and 5 per network address an hour. There's also a hidden field only robots fill in.
- **Closing:** applications close at the end of the closing day, or if the market has passed.
- **Waiting list:** once every pitch is approved, new applicants are told they're on the waiting list, and the approvers see a **Waiting list** chip.
- **Numbering:** applications are numbered `RTD-MV-00001` upwards. That's the vendor's reference.

## Deciding (approvers and admins)

**Market applications** in the organiser lists each market (from a fortnight ago on): how many pitches are approved, then the applications waiting.

**On each card:**
- **Contact:** the email and mobile, as links.
- **What they sell, and their links:** web links open in a new tab.
- **Insurance:** with chips for **No insurance** and **Cover ends before the market**.
- **Photos:** click one to open it full size.

**Actions:**

| Action | What happens |
| --- | --- |
| **Approve** | Needs a free pitch (checked in the same database statement, so two approvers can't take the last one). The vendor is emailed "You're in", with the pitch fee, the payment details, and their reference to quote. |
| **Decline** (with an optional note) | The vendor is emailed, with the note. |
| **Mark as dropped out** (approved vendors) | Their pitch is free again, for someone on the waiting list. **No email is sent**: use this when the vendor has already told the café. |

When every pitch is taken, **Approve** is greyed out until a pitch frees up or an admin adds pitches.

## Emails

All go through the app's outbox and n8n **RTD Outbox** ([RTD_BOOKINGS.md](RTD_BOOKINGS.md#the-outbox-and-the-bookings-inbox)).

| Email | To | Replying reaches | When |
| --- | --- | --- | --- |
| "We've got your application: …" (with the reference; says if they're on the waiting list) | The vendor | The approvers' inbox | Straight after applying |
| "Market application to approve: …" (everything they entered; the photos are in the organiser) | The approvers' inbox (`@approvals` = `RTD_APPROVAL_ALERT_EMAIL`, info@) | The vendor | Every application |
| "You're in: …" (fee, payment details, reference, the café's note) | The vendor | The approvers' inbox | Approved |
| "Your application: …" (with the café's note) | The vendor | The approvers' inbox | Declined |

Approvers also get a **Market application** push notification ([RTD_PUSH.md](RTD_PUSH.md)).

## The spreadsheet

- **The file:** **RTD Market Vendors** in the ATech Google account (Google Sheets), tab **Applications**, one row per application. It was made by the manual workflow **RTD One-Off: Create Market Vendors Sheet**.
- **Keeping it up to date:** n8n **RTD Market Vendors To Sheet** runs every 15 minutes:
  1. `GET /internal/market-applications/sheet` returns each application whose row is out of date, with the whole row.
  2. The row matched on **Application ID** is written (or added), as plain text, so nothing typed can run as a formula.
  3. `POST /internal/market-applications/:id/sheet-synced` records it, so it's written once per change.
- **Columns:** Application ID, Market, Market Date, Status, Waiting List, Stall Name, Contact Name, Email, Mobile, What They Sell, Links, Insured, Insurer, Insurance Expiry, Photos, Notes, Pitch Fee, Applied, Decided, Decided By, Decision Note, Organiser Link.
- **Photos:** they stay in the app. The sheet says how many there are, with a link to the organiser.
- **Edits in the sheet aren't read back:** the app is the record, and its next change to that application overwrites the row. Add your own columns to the right if you need notes.
- **Sharing:** share it with Michelle from Google Drive if they need it.

## Privacy

- **Who sees it:** applications are seen only by approvers and admins, photos included. Photos are kept in KV (`vendor:<id>`), and are only ever served to a signed-in approver, never cached.
- **Erasing:** 12 months after the market, the daily job erases the stall and contact details, what they sell, links, insurance details, notes and the café's note. It deletes the photos, and the next spreadsheet sync writes the row as **Erased**.
- **Note:** Google Sheets keeps version history, so clear it, or delete old tabs, if you need the old values gone too.
- **The audit log** records applications by number, never the vendor's details.
- **The privacy notice** (`/privacy`) covers vendors ([RTD_PRIVACY.md](RTD_PRIVACY.md)).

## API

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/markets` | anyone (cached 1 min) | Markets still to come: date, fee, pitches left, closing date |
| GET | `/api/markets/:id` | anyone | One market |
| POST | `/api/markets/:id/apply` | anyone (same-origin JSON, up to ~9 MB) | Apply. Photos as `photos: [{ data: base64 }]` |
| GET | `/api/staff/markets` | approver, admin | Markets from a month ago on, with counts |
| POST | `/api/staff/markets`, `/api/staff/markets/:id` | admin | Set up / change a market |
| GET | `/api/staff/market-applications` | approver, admin | Applications, with photo IDs |
| POST | `/api/staff/market-applications/:id/decision` | approver, admin | `{ decision: 'approve' \| 'decline', note? }` |
| POST | `/api/staff/market-applications/:id/withdraw` | approver, admin | Mark as dropped out |
| GET | `/api/staff/market-photos/:photoId` | approver, admin | One photo (`no-store`, sandboxed) |
| GET | `/internal/host-sessions/to-publish` | n8n | Now includes markets not yet in Event Index |
| POST | `/internal/host-sessions/:id/published` | n8n | Also takes `RTD-MKT-…` |
| GET | `/internal/market-applications/sheet` | n8n | Spreadsheet rows to write |
| POST | `/internal/market-applications/:id/sheet-synced` | n8n | `{ hash }` |

## Data

Migration `0013_markets.sql`: tables `markets`, `market_applications` and `market_photos`, plus the column `events.market_id`. See [RTD_DATABASE_SCHEMA.md](RTD_DATABASE_SCHEMA.md#markets).
