# RTD n8n Workflows

n8n runs on the Pi at `n8n.arkham-survey.com`. The full inventory and verdicts are in [RTD_AUDIT.md §3](RTD_AUDIT.md#3-component-verdicts). This file tracks what the app relies on and every change made.

## Changes made

### 2026-10-06 (later): bookings and cancelled dates

Dan's decisions: hosts and café staff join the same way; "email the event host whenever a person books… 2 days before the event to confirm numbers… option to cancel… email any attendees".

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| **New:** RTD Outbox (`dJU9NJOh7aisAiFF`) | See [below](#rtd-outbox-dju9njoh7aisaiff). Sends every booking email the app queues. | `a5990c68-8523-4393-bf71-6a225f39da09` | Unpublish it (emails wait in the outbox until it's back) |
| RTD Host Sessions To Diary (`rdS8LF56B9k170BY`) | **New branch C:** takes cancelled host dates out of Event Index (`GET /internal/host-sessions/sheet-fixes` → update the row matched on `App Host Session` → `POST …/sheet-fixed`). Branches A and B unchanged. | `f7a6d7b7-8077-4b67-a5a0-24a53a16104c` | `58fb14a4-db75-4973-bc8c-efae1b210ff7` |
| RTD Team Notices (`diKojCurHeRWQjAR`) | No change. Every join request is now a host request, so they all go to the café address. | — | — |

**How it was verified:**
- **RTD Outbox:**
  - **First live run** (`20675`): the app answered, and nothing was queued.
  - **Simulated run** (`20676`): an email meant for the café got the café's address from `rtd_config`, and each email was marked sent.
- **Branch C:**
  - **Live run** (`20682`): nothing to fix.
  - **Simulated run** (`20684`): a one-off went Inactive and a weekly row moved to its next date.
  - **Not yet run against the real sheet:** the sheet-update node passed n8n's validator. If it ever fails, the error handler emails Dan, and the app offers the same change again on the next run.

### 2026-10-06: onboarding and decision emails

Dan's decision: "I will be the approving party for staff, Michelle for game hosts and booking requests."

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| **New:** RTD Team Notices (`diKojCurHeRWQjAR`) | See [below](#rtd-team-notices-dikojcurherwqjar). No existing workflow was changed. | `383adf40-39d4-4990-b024-c7f6c10dcd81` | Unpublish it (it only sends emails) |

### 2026-10-05 (evening): host sessions into the diary; private sessions never advertised

Dan's decision: "Private sessions don't advertise, public yes please."

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| RTD Master V1 (`yPhchrcwuJSt3RLI`) | **Local edits to three code nodes:** `Find Next 2 Diary Days & Build Prompt` (evening round-up), `Find Next 7 Days Events & Build Prompt` (Sunday weekly post) and `Is Event Due Right Now?` (hourly event post) now skip rows whose `App Visibility` is `Private`, in both Event Index and Standard Diary. Hidden social-content rows (Food1–3, Drinks, Cafe Vibes) are unaffected. | `c8485b62-c318-47f6-bb0f-bee99a670e5c` | `95b638b5-11f4-47ce-91ec-db77c3eb4f89` |
| RTD Event Guard (sub) (`RtdEventGuardSub1`) | **Two new local-edit nodes:** **App: Private Rows Get No Poster** (before `Evaluate Events`) relabels a Private row's Status in memory, so it gets no poster but still expires. **App: No Date Request For Host Sessions** (before `Request New Date`) drops rows with an `App Host Session`: they still go Inactive when they pass, but the café isn't asked for a new date, because the host gets the follow-up email instead. | `d3c74b27-dfa8-4e02-8f1d-d609751f9537` | `fe0eeae3-49f9-4e20-94d6-a342208809b0` |
| RTD Event Sync (`fOYrFBOElFkWx7R3`) | `Build Snapshot` also sends `App Price`, `App Capacity` and `App Host Session`. | `a6de4b57-6675-4061-8bea-8b981128ea56` | `1d43463b-e143-413c-ad1a-c2c012063725` |
| Logic Engine sheet | **Backup first:** "Logic Engine_RTD BACKUP 2026-10-05 2157 (before host session columns)" (`1bMrXUUYfFHP0l-Y-WozCe2ovfzvApVeKyn51EanUTyM`). **Then:** `App Price`, `App Capacity` and `App Host Session` were added as Event Index columns V–X, after App Category. No column moved. Workflow: `RTD One-Off: Add Host Session Columns` (`jgEBveDZA5Dg4Iif`), manual-only and safe to re-run. | — | — |
| **New:** RTD Host Sessions To Diary (`rdS8LF56B9k170BY`) | See [below](#rtd-host-sessions-to-diary-rds8lf56b9k170by). | | |

**How it was verified:**
- **Master V1:** the three patched code nodes were run locally against sample rows. Both round-ups left out a Private Event Index row and a Private Standard Diary group, and kept the public ones; the hourly post picked only the public event. The draft was then diffed against the live version: only those three `jsCode` values changed.
- **Guard:** both new nodes were run locally against sample rows. A dry run through `Event Guard Dry Run (Manual)` (executions 19339/19340) then succeeded, and every existing event took the same path as before.

> **Local edits.**
> - **Guard:** its code is generated from `~/projects/rtd-poster-automation`, so mirror both Guard nodes there (skip posters when App Visibility is Private; no date request for rows with an App Host Session), then delete them.
> - **Master V1:** its nodes aren't generated, but keep the three edits if it's ever rebuilt.
> - **Known limit:** the Guard still refuses to act if more than 3 rows expire in one night, and host one-offs count towards that.

### 2026-10-05: Monthly events re-dated by Michelle, not auto-rolled

Dan's decision: "dates can vary, ask Michelle for a new date".

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| RTD Master V1 (`yPhchrcwuJSt3RLI`) | `Calculate next dates` no longer advances **Monthly** Event Index rows. Weekly and Bi/Two-Weekly unchanged. Standard Diary untouched. Sticky note updated. | `95b638b5-11f4-47ce-91ec-db77c3eb4f89` | `03601fc5-c0c9-402a-a988-26ac3b6192fa` |
| RTD Event Guard (sub) (`RtdEventGuardSub1`) | New node **Monthly: Ask For Next Date** between the sheet read and `Evaluate Events (Guard)`. It blanks Frequency for Monthly rows, so a passed monthly event is expired like a one-off: Status → Inactive, and the date-picker email asks for the next date. | `fe0eeae3-49f9-4e20-94d6-a342208809b0` | `20a1ffc4-e334-42fb-8a7f-420e90a569fc` |

How it was verified: two dry runs of the Guard (executions 18094/18095 and 18115/18116). Both succeeded, the new node ran, and Quiz (Monthly, future date) still took the normal poster path. The first live expiry will be **Bingo, after 9 Oct**.

> **Local edit.** The Guard's code is generated from `~/projects/rtd-poster-automation` (`build.py`). Make the same change there (remove `'monthly'` from `CONFIG.recurringFrequencies` in `logic.js`), then delete the extra node. Otherwise the next build will undo it.

### 2026-10-05: App ID columns added to the Logic Engine

- **Backup first:** a Drive copy named "Logic Engine_RTD BACKUP 2026-10-05 1200 (before app ID columns)" (file id `1W5RLKtd9eYoiE15mckGl-DkIkrkFmPwWblag9EN7Tkc`), saved next to the original.
- **New columns at the end of Event Index and Standard Diary:** `Event ID`, `App Visibility`, `App Category`. No existing column moved. Every existing write to these tabs maps columns by name and row number, so nothing else was affected; this was confirmed by a Guard dry run after the change.
- **Values backfilled:**
  - Event Index rows got `RTD-EVT-00001`–`00023`.
  - Standard Diary rows got `RTD-EVT-00024`–`00031`.
  - Food1–3, Drinks and Cafe Vibes were set to `Hidden`; everything else to `Public`.
  - Categories were guessed from event names. Michelle can change any of them.
- **Workflow:** `RTD One-Off: Add App ID Columns` (`6XN4fpSvTk5t5OW9`). Manual-only, never activated, safe to re-run (it fills blanks only and never renumbers). It can be archived: RTD Event Sync now assigns IDs to new rows.

| Event ID | Event Index row |
| --- | --- |
| 00001 Quiz · 00002 Bingo · 00003 Blood on the Clocktower · 00004 Kids Chess Club | rows 2–5 |
| 00005 Home Education Support ClubM · 00006 …ClubT · 00007 Dungeons & Dragons · 00008 Cafe Vibes | rows 6–9 |
| 00009 Cleeples · 00010 Magic: The Gathering · 00011 DM Liv's DND · 00012 DM Alfie's DnD | rows 10–13 |
| 00013 Wednesdays · 00014 Food1 · 00015 Food2 · 00016 Food3 · 00017 Drinks | rows 14–18 |
| 00018 SazLou · 00019 BookClub · 00020 Writing Club · 00021 Spooky Market · 00022 MicNight · 00023 BritQuiz | rows 19–24 |

**Rules for the sheet from now on:**
- Never change or reuse an `Event ID`. Rename events freely; the ID keeps their history together.
- New rows, including copied rows, get an ID automatically within 15 minutes.
- `App Visibility` accepts: `Public`, `App Bookable`, `Private`, `Hidden`. A blank cell means Hidden. `Private` shows in the app's diary only as "Private session" with its time (no name or details), so the café still looks busy.
- `App Category` accepts: Gaming, Quiz, Social, Club, Tournament, Market, Workshop, Other.

### 2026-10-05: `rtd_config` data table

`rtd_config` (`nMs33jJTorVuKLsp`), key / value / notes. It is the single configuration source for RTD workflows (spec §38).

| key | purpose |
| --- | --- |
| `RTD_CAFE_NOTIFICATION_EMAIL` | Fixed café address for the digest, date requests and change notices. Also gets an email for each new host session (RTD Host Sessions To Diary), and is the Reply-To on host follow-up emails. |

Still to do: point the Guard's date-change recipient at this instead of its hard-coded copy. That change goes in `rtd-poster-automation`.

## RTD Event Sync (`fOYrFBOElFkWx7R3`)

**Live since 2026-10-05 13:40.**
- **First run** (`n8n-18419`): 31 events, 40 occurrences. The two expected `invalid_date` warnings were Cleeples ("Every Thursday") and Wednesdays ("Open Wednesdays!").
- **Repeat run** (`n8n-18421`): 0 changes, which confirms a repeat sync is a no-op.

- **Triggers:** every 15 minutes (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read the app URL from `rtd_config` (`RTD_APP_BASE_URL` = `https://rtd-app.dan-289.workers.dev`).
  2. Read Event Index and Standard Diary.
  3. **Build Snapshot.** A row with no `Event ID`, or carrying a copy of another row's ID (a copied row), gets the next free `RTD-EVT` number. The first row holding an ID keeps it. New rows default to `App Visibility` = Public, and `App Category` = Other (Event Index) or Club (Standard Diary).
  4. Write any new IDs back to the sheet.
  5. `POST /internal/sync/logic-engine` with only the fields the app uses (no prompt columns). `run_id` = `n8n-<execution id>`.
- **Errors:** retried 3 times, then passed to `Studio: Error Handler`. A `409` means the app refused a suspicious snapshot (for example an empty sheet read), and the data in the app is left untouched.
- **Credential `rtd-app` (Header Auth):** header name `Authorization`, value `Bearer <INTERNAL_SYNC_TOKEN>`.

Payload shape:

```json
{
  "run_id": "n8n-18200",
  "sources": {
    "event_index":    [{ "row_number": 2, "Event Name": "Quiz", "Frequency": "Monthly", "Event Date": "23/10/2026",
                         "Event Time": "18:30", "End Time": "22:00", "Status": "Active", "Base Details": "...",
                         "Photo Folder ID": "...", "Event ID": "RTD-EVT-00001", "App Visibility": "Public", "App Category": "Quiz" }],
    "standard_diary": [{ "row_number": 2, "Group": "...", "Date": "05/10/2026", "Notes": "...", "Frequency": "Weekly",
                         "Event ID": "RTD-EVT-00024", "App Visibility": "Public", "App Category": "Club" }]
  }
}
```

## RTD Event Images (`GeafnErtRe5ZMbiD`)

This workflow copies event photos from Drive into the app. Each Event Index row's **Photo Folder ID** (the folders the poster automation already uses) is the source.

- **Triggers:** every 6 hours (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read `RTD_APP_BASE_URL` from `rtd_config`.
  2. `GET /internal/images/plan`. The app lists the events that want photos: active, Public or App Bookable, and with a folder.
  3. **One Drive search** across all those folders (images only, not in the bin). This uses the existing `ATECHGoogleDrive` credential.
  4. **Choose Photos:** the newest 8 per event. Files with **`noapp`** or **`private`** in their name are skipped.
  5. `POST /internal/images/sync` with each event's chosen files. The app drops photos no longer chosen, and answers with the ones it hasn't got yet.
  6. **Fetch and upload the missing photos:**
     - It fetches each missing photo through Drive's own thumbnail link, so Google resizes it to 1400px: WebP for photos (`=s1400-rw`, about 100–210 KB against 2–5 MB originals), JPEG for PNG posters (`=s1400-rj`), because WebP from a PNG is lossless and several MB.
     - It uploads each one with `PUT /internal/images/:eventId/:fileId`.
- **Repeat runs:** a run with no folder changes uploads nothing.
- **Live since 2026-10-05 18:40** (published; runs every 6 hours).
- **First run** (`18869`): 10 folders searched, 65 photos stored.
  - Quiz, Bingo, Blood on the Clocktower, Kids Chess Club, D&D, Cleeples, Magic: The Gathering and Wednesdays got 8 each; Spooky Market got its poster.
  - The poster came through as a 2.3 MB lossless WebP, so PNGs now use JPEG. Re-run `18903` replaced it with a 525 KB JPEG.
  - The store is about 10.6 MB in total.
- **Errors:**
  - HTTP steps retry 3 times, then failures go to `Studio: Error Handler`.
  - The app refuses (409) a photo list with no eligible events, so a failed Drive read never wipes the photos.
- **Execution data:** successful runs aren't stored, which avoids keeping photo bytes in n8n.

**For the café team:**
- **New photos:** drop them in the event's photo folder. The 8 newest appear within 6 hours.
- **Keep a photo out of the app:** rename it to include `noapp`, or move it out of the folder.
- **Hidden events never show photos:** Food, Drinks and Cafe Vibes are Hidden, so their folders aren't read.

## RTD Host Follow-up (`FFy0lBTZCm4A5p08`)

This workflow emails the host of each approved **one-off** session the day after it ran, inviting them to run it again ([RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md#after-a-one-off-session)).

- **Triggers:** every day at 10:00 (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read `RTD_APP_BASE_URL` and `RTD_CAFE_NOTIFICATION_EMAIL` from `rtd_config`.
  2. `GET /internal/host-sessions/followups`: approved or live one-offs from the last 14 days whose date has passed and whose host hasn't been emailed.
  3. **Write Email:** a short thank-you with a link to `/organise`. Host-typed names are HTML-escaped.
  4. **Email The Host:**
     - **Sent from:** the `ATech GMAIL` account, as "Roll The Dice".
     - **Replies:** they go to the café address (Reply-To).
  5. `POST /internal/host-sessions/:id/followup-sent`, so each host gets it once.
- **Live since 2026-10-05 21:25** (published).
- **Checks:**
  - **First live run** (`19236`): nothing due, so nothing was sent.
  - **Simulated run with sample data** (`19238`): the email text and escaping are correct.
- **Errors:** HTTP steps retry 3 times and Gmail twice; failures go to `Studio: Error Handler`. If Gmail fails partway through a run, a host already emailed in that run may get the email again the next day, because their session wasn't marked sent.
- **Execution data:** successful runs are kept, so you can see who was emailed.

## RTD Host Sessions To Diary (`rdS8LF56B9k170BY`)

This workflow does two jobs for the host organiser ([RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md)).

- **Triggers:** every 15 minutes (Europe/London), plus **Run By Hand**.
- **A. Telling the café about new submissions:**
  1. `GET /internal/host-sessions/new-submissions`.
  2. One email per submission to `RTD_CAFE_NOTIFICATION_EMAIL`:
     - **Contents:** the session name, when, time, cost, max players, open or private, and the description.
     - **Link:** a link to `/organise` to approve or decline it.
     - **Sender:** `ATech GMAIL`, shown as "Roll The Dice app".
     - **Replies:** they go to the host (Reply-To).
  3. `POST /internal/host-sessions/:id/cafe-notified`, so each submission is emailed once.
- **B. Approved sessions into Event Index:**
  1. `GET /internal/host-sessions/to-publish`. The app returns each session's finished row.
     - **Row values:** Frequency `One-off`/`Weekly`, Day, Event Date as DD/MM/YYYY text, Event Time, End Time, Base Details, Status `Active`, Organiser Email, App Visibility `Public`/`Private`, App Category `Gaming`, App Price, App Capacity and App Host Session.
  2. **Reading the sheet:** only when something is waiting, it reads Event Index.
  3. **Already in the sheet:** a session whose `App Host Session` is already there is only marked Live, so a retry never adds a row twice.
  4. **Name clashes:** Event Name is the poster and guard automations' key, so a clashing name gets " (hosted)" added.
  5. **Appending:** it appends the rows as RAW text. It stops with an error rather than create a column if a header was renamed.
  6. **Marking Live:** `POST /internal/host-sessions/:id/published`. The next Event Sync then gives each row an Event ID, and the app links it back to the session.
- **What happens to the rows afterwards:**
  - **Weekly rows:** `Calculate next dates` rolls them forward.
  - **One-offs:** they go Inactive after their date. Event Guard doesn't send the "pick a new date" email for host sessions; the host gets RTD Host Follow-up instead.
  - **Open sessions:** they appear in the evening and weekly round-up posts.
  - **Private sessions:** they never appear in posts. The diary shows them only as "Private session".
- **C. Cancelled host dates out of Event Index** (added 2026-10-06):
  1. `GET /internal/host-sessions/sheet-fixes`. The app works out the change for each cancelled date still in the sheet:
     - **A one-off:** Status `Inactive`.
     - **A weekly session whose next date is cancelled:** Event Date moves on to the next date that isn't.
  2. **Update Event Index Row:** updates `Status` and `Event Date` (RAW text) on the row whose `App Host Session` matches.
  3. `POST /internal/host-sessions/:id/sheet-fixed` with the change's key, so it's made once.
  - **Why:** RTD Master V1's posts read the sheet, so a cancelled date must leave it.
  - **Timing:** if Master V1 rolls a weekly row onto a date that's already cancelled, this moves it on again within 15 minutes.
- **Individual promotion:** a session gets its own hourly Facebook post or a poster only if Michelle adds a prompt (and a photo folder) to its row, as for any other event.
- **Live since 2026-10-05 22:15** (published).
- **Errors:** HTTP steps retry 3 times; failures go to `Studio: Error Handler`.
- **Checks:**
  - **First live run** (`19322`): nothing pending, so nothing was sent or written.
  - **Simulated run with sample data** (`19323`): a clashing "Quiz" became "Quiz (hosted 2)", a session already in the sheet was only marked Live, and the café email escaped host-typed text.

## RTD Team Notices (`diKojCurHeRWQjAR`)

This workflow sends the onboarding emails and tells hosts what the café decided about their sessions ([RTD_ONBOARDING.md](RTD_ONBOARDING.md)).

- **Triggers:** every 15 minutes (Europe/London), plus **Run By Hand**.
- **Setup:** reads `RTD_APP_BASE_URL` and `RTD_CAFE_NOTIFICATION_EMAIL` from `rtd_config`, then runs three branches.
- **A. New join requests, to the approvers:**
  1. `GET /internal/applications/new`.
  2. **Who gets it:** the café address. Since 2026-10-06 every request is a request to host, café staff included. The code still handles the old "café team" requests, which went to the admins.
  3. **The email:** subject "New host request: …" or "New café team request: …", with a link to `/organise`. It's sent as "Roll The Dice app", and replies go to the applicant.
  4. `POST /internal/applications/:id/approver-notified`.
- **B. Outcomes, to the applicant:**
  1. `GET /internal/applications/decided`: approved or declined in the last 14 days, and not yet emailed.
  2. **The email:**
     - **Subject:** "You are now a Roll The Dice host", or "Your Roll The Dice request" (declined, with the note).
     - **Sender and replies:** sent as "Roll The Dice"; replies go to the café.
  3. `POST /internal/applications/:id/applicant-notified`.
- **C. Session decisions, to the host:**
  1. `GET /internal/host-sessions/decided`: approved, live or declined in the last 14 days, and not yet emailed. Withdrawn sessions are never emailed.
  2. **The email:**
     - **Subject:** "Approved: …" or "Not approved: …", with the café's note.
     - **Approved and private:** says the diary shows it only as "Private session" and it won't be advertised.
     - **Approved and open:** says it will be in the diary within 15 minutes.
     - **Replies:** they go to the café.
  3. `POST /internal/host-sessions/:id/host-notified`.
- **Shared behaviour:**
  - **Escaping:** text people typed is HTML-escaped in every email.
  - **Credentials:** HTTP steps use the `rtd-app` credential; Gmail uses `ATech GMAIL`.
- **Live since 2026-10-06 07:23** (published).
- **Errors:** HTTP steps retry 3 times and Gmail twice; failures go to `Studio: Error Handler`. If Gmail fails partway through a run, someone already emailed in that run may get the email again on the next run, because it wasn't marked sent.
- **Checks:**
  - **First live run** (`20485`): all three app feeds answered and were empty, so nothing was sent.
  - **Simulated run with sample data** (`20486`):
    - **Routing:** a host request went to the café address and a café team request to the admin; a café team request with no admin was skipped.
    - **Content:** the outcome and session emails had the right wording for approved, declined and private.
    - **Escaping:** HTML in names and notes was escaped.

## RTD Outbox (`dJU9NJOh7aisAiFF`)

This workflow sends the emails the app writes for bookings ([RTD_BOOKINGS.md](RTD_BOOKINGS.md#emails-the-outbox)). The app decides who gets what and writes each email; this workflow only delivers them.

- **Triggers:** every 5 minutes (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read `RTD_APP_BASE_URL` and `RTD_CAFE_NOTIFICATION_EMAIL` from `rtd_config`.
  2. `POST /internal/outbox/collect`. The app first queues any two-day numbers emails now due (from 09:00), then returns up to 50 unsent emails.
  3. **Split Emails:** an empty `to` or `reply_to` means the café, so it gets the café address.
  4. **Send Email:** Gmail (`ATech GMAIL`), sent as "Roll The Dice". If one email fails, the rest still go.
  5. `POST /internal/outbox/:id/sent` for each one sent.
  6. **Email Not Sent:** if any email failed, the run then stops with an error naming it, so `Studio: Error Handler` emails Dan. The email stays queued and is tried again in 5 minutes.
- **What it sends:**
  - **To the person who booked:** the booking confirmation.
  - **To the host:** each new booking and cancellation, and the numbers two days before each date.
  - **When a date is cancelled:** an email to everyone booked, plus one to the café or the host.
- **Live since 2026-10-06 08:55** (published).
- **Errors:** collecting and marking retry 3 times; Gmail retries twice.

## Spec §46 workflow map

| Spec workflow | Covered by |
| --- | --- |
| RTD – Event Sync | **RTD Event Sync** (above) |
| RTD – Event Approval | Approval happens in the app's organiser. **RTD Host Sessions To Diary** emails the café; **RTD Team Notices** emails the host the decision. |
| RTD – Event Expiry & Redating | **Existing** Event Guard + Event Date Change |
| RTD – Booking Daily Digest | Not built yet. Booking emails to hosts and customers go through **RTD Outbox** |
| RTD – Push Reminder Scheduler | New (Phase 3) |
| RTD – Game of the Week | New (Phase 4) |
| RTD – Host Application Notification | **RTD Team Notices** (join requests for hosts and café staff) |
| RTD – Event / Booking Audit Logger | Not needed as workflows: the app writes `audit_log` itself; n8n actions are recorded via the API |
