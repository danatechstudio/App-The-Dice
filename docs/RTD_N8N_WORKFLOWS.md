# RTD n8n Workflows

n8n runs on the Pi at `n8n.arkham-survey.com`. The full inventory and verdicts are in [RTD_AUDIT.md §3](RTD_AUDIT.md#3-component-verdicts). This file tracks what the app relies on and every change made.

## Changes made

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
- `App Visibility` accepts: `Public`, `App Bookable`, `Private`, `Hidden`. A blank cell means Hidden.
- `App Category` accepts: Gaming, Quiz, Social, Club, Tournament, Market, Workshop, Other.

### 2026-10-05: `rtd_config` data table

`rtd_config` (`nMs33jJTorVuKLsp`), key / value / notes. It is the single configuration source for RTD workflows (spec §38).

| key | purpose |
| --- | --- |
| `RTD_CAFE_NOTIFICATION_EMAIL` | Fixed café address for the digest, date requests and change notices |

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

## Spec §46 workflow map

| Spec workflow | Covered by |
| --- | --- |
| RTD – Event Sync | **RTD Event Sync** (above) |
| RTD – Event Approval | New with the Host Portal (Phase 6), reusing the inactive Master Booking decision model |
| RTD – Event Expiry & Redating | **Existing** Event Guard + Event Date Change |
| RTD – Booking Daily Digest | New (Phase 5), reads `rtd_config` |
| RTD – Push Reminder Scheduler | New (Phase 3) |
| RTD – Game of the Week | New (Phase 4) |
| RTD – Host Application Notification | New (Phase 7) |
| RTD – Event / Booking Audit Logger | Not needed as workflows: the app writes `audit_log` itself; n8n actions are recorded via the API |
