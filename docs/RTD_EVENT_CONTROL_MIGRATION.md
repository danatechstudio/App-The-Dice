# RTD Event Control: Migrations, Backups and Rollback

How each event-control migration reaches the live database ([RTD_EVENT_CONTROL_AUDIT.md](RTD_EVENT_CONTROL_AUDIT.md) §6).

**The rules:**
- Every migration is **additive**: new tables, or new nullable columns. Nothing is renamed or dropped.
- So every migration is applied **before** the code that uses it is deployed. The running code ignores the new column or table.
- Nothing is applied to the live database without the owner's go-ahead.

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
