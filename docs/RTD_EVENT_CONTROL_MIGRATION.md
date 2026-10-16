# RTD Event Control: Migrations, Backups and Rollback

How each event-control migration reaches the live database ([RTD_EVENT_CONTROL_AUDIT.md](RTD_EVENT_CONTROL_AUDIT.md) §6).

**The rules:**
- Every migration is **additive**: new tables, or new nullable columns. Nothing is renamed or dropped.
- So every migration is applied **before** the code that uses it is deployed. The running code ignores the new column or table.
- Nothing is applied to the live database without the owner's go-ahead.
- **While the app is still being tested, no events are created or deleted in production** (the owner, 2026-10-16). The owner will clear the diary and start afresh before the app goes fully public. Checks in production use the events already there; anything new is tried locally.

## Order for every migration

1. **Restore point.** Note the exact UTC time just before applying. D1 Time Travel can restore to any minute in the last 7 days on the free plan (30 on paid). Record the row counts of the tables involved.
2. **Apply.** Run the migration's statements on the live D1 and record the file in `d1_migrations`. Use the Cloudflare connector, or `npx wrangler d1 migrations apply rtd-app --remote`.
3. **Verify.** The new table or column exists, existing row counts are unchanged, and the next RTD Event Sync run is `ok`.
4. **Deploy** the code by merging to `main` (Workers Builds).
5. **Verify** in production, as each stage's notes describe.

**Rollback, from the least to the most drastic:**
- Switch the feature off: its setting, or `npx wrangler rollback` to the previous Worker version. The new table stays, unused and harmless.
- Restore D1 to the restore point: `npx wrangler d1 time-travel restore rtd-app --timestamp=<restore point>`. This also undoes everything written since, so it's a last resort. Pause RTD Event Sync first.

## 0017_attention.sql (Stage 3b: Needs attention)

**What it adds:**
- `events.sheet_date_raw` (nullable): the sheet's date cell, filled by the next sync;
- table `attention_items`;
- setting `needs_attention = off`.

Nothing existing changes. Sheet edits, bookings, the diary and n8n behave exactly as before. Until an admin switches it on, nothing is written to the new table.

**Why it must be applied before the deploy:** the new sync writes `sheet_date_raw`. Deploying the code first would make RTD Event Sync fail (and retry every 15 minutes) until the migration ran. Applying the migration first is harmless to the current code.

**After the deploy:**
- **The next sync:** fills `sheet_date_raw` for every event. Every event's `source_hash` changes once, so `updated_at` moves once; no audit rows are written for it.
- **Then an admin presses Switch on** under **Needs attention** in the organiser. Wait for that first sync (up to 15 minutes; `sheet_date_raw` is filled for Cleeples) before switching on. Otherwise Cleeples and Wednesdays first appear as "no date" and are replaced by their text a sync later.
- **Expected list:** Bingo (date passed), plus Dungeons & Dragons, Magic: The Gathering, Cleeples, Wednesdays, DM Alfie, MoreThanABitDicey and Brownies & Guides (no usable date).
- **Bingo:** the owner decided to archive it, so an admin presses **Archive**. It's already Inactive in the sheet, so nothing changes there.

**Rollback:** switch it off in the organiser, or `npx wrangler rollback`. The column and table can stay. A Time Travel restore isn't needed for this migration.

**Applied to production:** 2026-10-16 08:43 UTC, with the owner's go-ahead, through the Cloudflare connector, one statement at a time; recorded in `d1_migrations`.
- **Restore point:** 2026-10-16T08:43:15Z.
- **Before:** 32 events, 56 occurrences, 0 bookings, 276 audit rows, 9 settings.
- **After:** the same, plus the `needs_attention = off` setting (10). The column, the empty `attention_items` table and both indexes are present.
- **The 08:45 sync**, on the old code with the migrated database: `ok`.
- **Deployed:** PR #2 merged at 08:45; the new code was confirmed live from the deployed Worker.
- **The 09:00 sync, the first on the new code:** `ok`, 32 events, no audit noise (still 276 rows). `sheet_date_raw` filled for the 21 events with something in their date cell; for example Cleeples "Every Thursday" and Wednesdays "Open Wednesdays!"; Dungeons & Dragons and DM Alfie are blank.
- **Ready for an admin to switch on.**

## 0018_attention_emails.sql (Stage 3c: Needs attention emails)

**What it adds:**
- `attention_items.first_notified_at`, `last_reminded_at` and `reminder_count` (default 0);
- settings `attention_emails = off` and `attention_email_to = ''`.

Nothing existing changes. No email is sent until an admin enters the addresses and switches emails on in the organiser.

**Why it must be applied before the deploy:** the new hourly run reads the new columns.

**After the deploy:** an admin enters the addresses under **Needs attention → Email reminders**, presses **Switch on**, then **Send a test**. The items already waiting go into the next morning's reminder (about 9am).

**Rollback:** **Switch off** in the organiser, or `npx wrangler rollback`. The columns and settings can stay.

**Applied to production:** 2026-10-16 13:10 UTC, with the owner's go-ahead, through the Cloudflare connector; recorded in `d1_migrations`.
- **Restore point:** 2026-10-16T13:10:28Z.
- **Before:** 32 events, 56 occurrences, 0 bookings, 285 audit rows, 10 settings, 8 open items, an empty outbox.
- **After:** the same, plus `attention_emails = off` and `attention_email_to = ''` (12 settings). The three columns are present; the 8 items are untouched.
- **Deployed:** PR #3 merged at 13:12; the new code was confirmed live from the deployed Worker.
- **The same day, 13:15:** the Event Guard's date-picker email was switched off ([RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#2026-10-16-the-event-guard-no-longer-emails-the-date-picker)).
- **Waiting for:** an admin to set the addresses and switch emails on in the organiser.

## 0019_booking_mode.sql (Stage 4a: booking modes)

**What it adds:** `events.booking_mode` (nullable; `none`, `optional` or `required`). NULL means the default for the kind of event, so no backfill is needed.

**Why it must be applied before the deploy:** the new code reads the column in every public list.

**What changes when the code is deployed** (live data on 2026-10-16, 0 bookings):
- **The café's own Event Index events stay bookable (Optional),** with "Booking is optional: you can also just turn up." That includes Spooky Market, which is an Event Index row rather than a market set up in the app; set it to **Not required** if vendors' customers shouldn't book.
- **The 5 public Standard Diary groups stop offering booking (Not required):** GirlsGetOut Ladies Night, Arkham Horror Card Game, DM Olivia, National Coastguard Institute. They show "No booking needed: just come along."
- **Hosts' sessions:** unchanged, booking Required.

**Rollback:** `npx wrangler rollback`. The column can stay; the old code ignores it.

**Applied to production:** 2026-10-16 14:36 UTC, with the owner's go-ahead, through the Cloudflare connector; recorded in `d1_migrations`.
- **Restore point:** 2026-10-16T14:36:36Z.
- **Before:** 32 events, 56 occurrences, 0 bookings, 289 audit rows, 12 settings, 8 open items; the 14:30 sync `ok`.
- **After:** the same; the column is present and empty on all 32 events.
- **The 14:45 sync**, on the old code with the migrated database: `ok`.
- **Deployed:** PR #4 merged at 14:47; the new code was confirmed live from the deployed Worker (the booking-mode SQL and copy are in it).
- **Live modes:** 6 café events Optional (Spooky Market, Home Education Support Club, Kids Chess Club, Quiz, Blood on the Clocktower); 5 Standard Diary groups Not required.
- **The 15:00 sync, the first on the new code:** `ok`, 32 events, nothing changed, no audit noise (still 289 rows).

## 0020_delivery.sql (Stage 4b: telling people booked, and email delivery)

**What it adds:**
- seven nullable columns on `outbox` (`booking_id`, `attempts` default 0, `last_error`, `last_attempt_at`, `next_attempt_at`, `claim`, `claimed_at`, `dead_at`);
- tables `booking_devices` and `push_outbox`, both empty.

Nothing existing changes. Emails already in the outbox read as queued or sent, exactly as before.

**Why it must be applied before the deploy:** the new code claims emails and records failures in the new columns, and every cancellation writes to `push_outbox`.

**What changes when the code is deployed:**
- **Collecting claims:** an email RTD Outbox collects is held for 10 minutes. Until RTD Outbox is changed, a failed email is offered again after 10 minutes (it was 5), and the run still fails so Dan is emailed.
- **The booking form** offers "Tell this device if it's cancelled or moved" where the browser can show notifications. The privacy notice says what that keeps.
- **Needs attention** can list "Moved, with bookings" and "Email not sent" items. There are 0 bookings live, so none are expected.
- **Delivery** appears in the organiser.

**Then, with the owner's go-ahead:** the RTD Outbox change ([RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#proposed-stage-4b-not-made-yet-rtd-outbox-reports-failed-emails-to-the-app)).

**Rollback:** `npx wrangler rollback` (the old code ignores the new columns and tables). Roll the n8n change back first if it was made: the old app has no `/failed`.

**Applied to production:** 2026-10-16 15:19 UTC, with the owner's go-ahead, through the Cloudflare connector, one statement at a time; recorded in `d1_migrations`.
- **Restore point:** 2026-10-16T15:18:54Z.
- **Before:** 32 events, 56 occurrences, 0 bookings, 289 audit rows, 12 settings, 8 open items, 2 emails in the outbox (both sent); the 15:15 sync `ok`.
- **After:** the same. The seven outbox columns, both tables (empty) and both indexes are present; the 2 emails read as untouched (no attempts, no claim).
- **The 15:30 sync**, on the old code with the migrated database: `ok`.
- **Deployed:** PR #5 merged at 15:31; the new code was confirmed live from the deployed Worker at 15:38 (the push outbox, `/outbox/:id/failed`, booking devices and the moved-date email are in it).
- **First runs on the new code:** RTD Outbox at 15:40 and 15:45 succeeded; collect answered `{ messages: [] }` as before (nothing was waiting). The 15:45 sync: `ok`, 32 events, nothing changed, still 289 audit rows and 8 open items.
- **The RTD Outbox change** waited for its own go-ahead, then was published at 17:23 UTC (version `e50af06e…`; rollback `a1b77acb…`). The 17:25 and 17:30 runs on it succeeded ([RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md)).

## 0021_change_requests.sql (Stage 5a: host change requests)

**What it adds:** table `event_change_requests` and two indexes, empty. Nothing existing changes.

**Why it must be applied before the deploy:** the organiser's session list reads it.

**What changes when the code is deployed:** hosts see **Ask for a change** on a live session; approvers see **Changes to approve** when there are any. Live: one published host session (a private weekly). Approved changes wait for n8n branch D before they reach Event Index ([RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md)).

**Rollback:** `npx wrangler rollback`; the table can stay.

**Applied to production:** 2026-10-16 18:29 UTC, with the owner's go-ahead, through the Cloudflare connector; recorded in `d1_migrations`.
- **Restore point:** 2026-10-16T18:29:02Z.
- **Before:** 32 events, 56 occurrences, 0 bookings, 289 audit rows, 2 host sessions, 8 open items; the 18:15 sync `ok`.
- **After:** the same; the table (empty) and both indexes are present.
- **The 18:30 sync**, on the old code with the migrated database: `ok`.
- **Deployed:** PR #7 merged at 18:31; the new code was confirmed live from the deployed Worker at 18:37.
- **n8n branch D** published at 18:38 (`7ef4429d…`; rollback `d9cad8de…`). Its 18:45 run succeeded with nothing to write; the 18:45 sync was `ok`, 32 events, still 289 audit rows and 8 open items.

## Stage 5b (no migration)

The per-date editor uses columns that already exist and that the sync never writes (`occurrences.visibility`, `description_override`, `price_display`). **Rollback:** `npx wrangler rollback`; any date hidden or changed keeps its setting, and can be put back from the organiser after a redeploy (or by setting those columns to NULL).

## Stage 4c (no migration)

- **Deployed:** PR #6 merged at 17:15 UTC, with the owner's go-ahead; the new code was confirmed live from the deployed Worker at 17:22 (the monthly `inactive:<date>` fix and the `cancelled` items are in it).
- **Live data:** no cancelled dates, so nothing changed: the 17:30 sync was `ok`, 32 events, still 289 audit rows and 8 open items.
- **Rollback:** `npx wrangler rollback`.
