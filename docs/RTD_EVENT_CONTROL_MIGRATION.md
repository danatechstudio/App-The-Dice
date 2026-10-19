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

## 0023_enquiries.sql (private games: messages asking to join)

One new table, `enquiries`, for the message form on a private game's page (spec `docs/superpowers/specs/2026-10-18-private-events-design.md`). Additive; nothing else changes.
- **Order:** apply the migration first (`npx wrangler d1 migrations apply rtd-app --remote`, or through the Cloudflare connector, then record it in `d1_migrations`), then merge the code. Code that runs before the table exists makes the form fail with "Something went wrong", and nothing else.
- **Rollback:** `npx wrangler rollback`; the table can stay.
**Applied to production:** 2026-10-19 10:27 UTC, with the owner's go-ahead, through the Cloudflare connector, one statement at a time (the table and its two indexes); recorded in `d1_migrations`.
- **Restore point:** 2026-10-19T10:27:04Z.
- **Before:** 32 events, 79 occurrences, 0 bookings, 326 audit rows, 16 settings; the 10:15 sync `ok`.
- **After:** the same; `enquiries` (empty) and both indexes are present.

## 0024_social_prompts.sql (event social prompts, Stage 1)

The app side of event-specific social master prompts (spec `docs/superpowers/specs/2026-10-18-social-master-prompt-design.md`; the n8n contract is in [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#event-social-prompts-contract-for-stage-2)). Additive.

**What it adds:**
- column `events.social_values` (nullable): Approved Facts, People & Roles and Banned Phrases as the last sync read them. It is kept out of each event's change hash, so filling it changes no event.
- table `social_prompts`: one row per version of an event's master prompt. Each version number is unique per event (`UNIQUE (event_id, version)`), with an index on the event and its facts (`social_prompts_by_facts`).
- table `social_checks`: one row per check made before a post, with two indexes (`social_checks_by_time`, `social_checks_by_result`). The caption and poster wording are deleted after 90 days.
- setting **`social_prompts = off`**.

Nothing existing changes. **At Off nothing is checked or recorded, and nothing posts differently.** That stays true until Stage 2's n8n changes are made and an admin changes the switch, each with the owner's go-ahead.

**Order:**
1. **0023 first.** `0023_enquiries.sql` (private games) isn't applied yet either. 0024 goes after it, never before.
2. **Restore point**, as for every migration.
3. **Apply.** Try it locally first with `npx wrangler d1 migrations apply rtd-app --local`. Then, **only after the owner's go-ahead**, the owner's step: `npx wrangler d1 migrations apply rtd-app --remote`. That applies whatever is waiting, in number order, so 0023 then 0024. Or use the Cloudflare connector, one statement at a time, and record the file in `d1_migrations`.
4. **Verify:** the column, both tables, the three indexes and `social_prompts = off` are present. Existing row counts are unchanged, and the next RTD Event Sync is `ok`.
5. **Then merge** the branch.

**Why it must be applied before the deploy:**
- The new sync writes `events.social_values`. On the old schema every sync would fail (and be retried), so the diary would stop updating.
- The organiser hub's counts read `social_prompts` and `social_checks` in one batch, so on the old schema the whole hub fails for every staff user, not just one count.
- The daily privacy clean-up clears old check text from `social_checks` in the same batch as the booking and enquiry erasure, so on the old schema that whole clean-up stops.
- So: apply 0023, then 0024, check them, and only then merge. Never merge this branch first.

**What changes when the code is deployed:**
- The first sync stores `social_values` for every event. It changes no event's hash, so `events_changed` stays as usual and no audit rows are written.
- The columns stay blank until RTD Event Sync is changed to send them (Stage 2, [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#first-rtd-event-sync-must-carry-the-new-columns)).
- Admins see **Social prompts** under Organise › Events & dates, switched **Off**, and a **Social prompt** section on each event's edit page.
- Hosts and approvers see nothing new.

**Rollback, from the least drastic:**
- Leave the switch at **Off** (or set it back to Off). The tables stay, unused and harmless.
- `npx wrangler rollback` to the previous Worker. The old code ignores the column, tables and setting.
- **Remove it entirely,** only after the code is rolled back:
  ```sql
  DROP TABLE social_checks;   -- its two indexes go with it
  DROP TABLE social_prompts;  -- and its index
  DELETE FROM settings WHERE key = 'social_prompts';
  DELETE FROM d1_migrations WHERE name = '0024_social_prompts.sql';
  ```
  The `events.social_values` column can stay; nothing old reads it. This loses the prompt history and check log. The prompts themselves are still in the Logic Engine's Social Prompt cells, once Stage 2 has written them.

**Applied to production:** 2026-10-19 10:28 UTC, straight after 0023, with the owner's go-ahead, through the Cloudflare connector, one statement at a time (the column, the two tables, their three indexes, the setting); recorded in `d1_migrations`. Restore point as for 0023: 2026-10-19T10:27:04Z.
- **After:** 32 events, 79 occurrences, 0 bookings, 326 audit rows (unchanged); 17 settings (`social_prompts = off` added); `events.social_values` present; both tables empty.
- **Deployed:** merged to main at 10:30 UTC (0d060ce). The 10:30 sync ran `ok` on the old code with the migrated database; the 10:45 sync ran `ok` on the new code and stored `social_values` for all 32 events (blank, as RTD Event Sync doesn't send those columns yet), with no audit rows and no event changes.

## Admin event editor (2026-10-18, no migration)

The editor (spec `docs/superpowers/specs/2026-10-18-admin-event-editor-design.md`) sends café event details through the Stage 6 queue below, so **they reach the sheet only once RTD Sheet Writer (`TAa4F7wKzzeIDKm8`) is published**.
- **Current state (checked 18 Oct):** the setting `sheet_writes` has been `live` since 17 Oct 09:09 (set by Dan), but the workflow has never been published. It has run once, manually, on 16 Oct. `sheet_edits` was empty.
- **Turning it on, each step with the owner's go-ahead:**
  1. Set **Test copy** under Logic Engine changes, publish RTD Sheet Writer, and make one change in the editor. On the staging copy, check that only the named cells changed and the Day column followed a date. Then edit the copy by hand between a change and the next run, and check the conflict is caught.
  2. Set **Live** and make one real change chosen by the owner. Check it in the sheet, then in the app after the next sync.
- **Rollback:** set **Off**, unpublish the workflow. Queued changes wait and can be withdrawn.
- **What works without it:** places, need to book, cancelling a date, stopping a host session, and every host-session change (those go through n8n branch D, already published).

## 0022_sheet_edits.sql (Stage 6: changing events from the organiser)

**What it adds:** column `events.sheet_values` (NULL until the next sync fills it), table `sheet_edits` and two indexes (empty), and the setting `sheet_writes` = `off`. Nothing existing changes.

**Why it must be applied before the deploy:** the new sync writes `events.sheet_values` and settles `sheet_edits` in the same batch as everything else. On the old schema every sync would fail (and be retried), so the diary would stop updating, though nothing would be lost.

**What changes when the code is deployed:** the first sync fills `sheet_values` for every event, with no change to any event's hash (`events_changed` stays as usual). Admins see **Logic Engine changes**, switched **Off**, so nothing can be queued or written. RTD Sheet Writer stays unpublished until the owner says so.

**Then, each with the owner's go-ahead:**
1. **Test copy:** an admin sets **Test copy**, RTD Sheet Writer is published, and test changes are made. Only the staging copy (rtd_config `RTD_STAGING_LOGIC_ENGINE_ID`) is written. Check there that only the named cells changed, the Day column follows a date, and a conflict is caught (edit the copy by hand between making a change and the next run).
2. **Trial:** `RTD_LOGIC_ENGINE_ID` is added to rtd_config (kept out of this repository) and an admin sets **Trial**, for at least a week. Changes are checked against the live sheet and show what they would write; nothing is written.
3. **Live:** an admin sets **Live**.

**Rollback:** set **Off** (queued changes wait and can be withdrawn); unpublish RTD Sheet Writer; `npx wrangler rollback`. The column, table and setting can stay. A change already written is in the sheet like any hand edit: change it back there.

**Applied to production:** 2026-10-17 08:37–08:38 UTC, with the owner's go-ahead, through the Cloudflare connector, one statement at a time (the `ALTER TABLE`, the `CREATE TABLE`, the two `CREATE INDEX`, the setting); recorded in `d1_migrations`.
- **Restore point:** 2026-10-17T08:36:20Z.
- **Before:** 32 events, 74 occurrences, 0 bookings, 301 audit rows, 5 open items; the 08:00, 08:15 and 08:30 syncs `ok` (32 events seen, 0 changed). No `sheet_values` column or `sheet_edits` table.
- **After (08:38:54Z):** the same counts. The column, the table, both indexes and `sheet_writes = off` are present.
- **The 08:45 sync** (`n8n-60337`), on the old code with the migrated database: `ok`, 32 seen, 0 changed.
- **Deployed:** PR #11 merged at 08:47; the deployed Worker had the new code (`sheet-edits/claim`, `sheet_writes`, `sheet_values`) at 08:50.
- **First sync on the new code** (`n8n-60377`, 09:00): `ok`, 32 seen, 0 changed; `sheet_values` filled for all 32 events; 74 occurrences, 301 audit rows and 5 open items, as before; no sheet edits; `sheet_writes` still `off`.
- **Next, each with the owner's go-ahead:** the test copy, then the trial (above). RTD Sheet Writer is still unpublished.

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

The per-date editor uses columns that already exist and that the sync never writes (`occurrences.visibility`, `description_override`, `price_display`). Deployed: PR #8 merged at 18:48; the new code was confirmed live from the deployed Worker at 18:54. The 19:00 sync was `ok`, 32 events, nothing changed, 289 audit rows, 8 open items, and no date has an override yet. **Rollback:** `npx wrangler rollback`; any date hidden or changed keeps its setting, and can be put back from the organiser after a redeploy (or by setting those columns to NULL).

## Stage 4c (no migration)

- **Deployed:** PR #6 merged at 17:15 UTC, with the owner's go-ahead; the new code was confirmed live from the deployed Worker at 17:22 (the monthly `inactive:<date>` fix and the `cancelled` items are in it).
- **Live data:** no cancelled dates, so nothing changed: the 17:30 sync was `ok`, 32 events, still 289 audit rows and 8 open items.
- **Rollback:** `npx wrangler rollback`.
