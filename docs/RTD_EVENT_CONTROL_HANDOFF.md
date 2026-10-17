# RTD Event Control: Handoff (end of 2026-10-16)

For the next session picking up the brief "Roll The Dice — Event Control Audit & Staged Implementation". Read this first, then [RTD_EVENT_CONTROL_AUDIT.md](RTD_EVENT_CONTROL_AUDIT.md) (§4.4 for Stage 6, §6 for the plan, §7 for decisions) and [RTD_EVENT_CONTROL_MIGRATION.md](RTD_EVENT_CONTROL_MIGRATION.md).

## Where things stand

- **Branch:** `claude/new-session-qt4dd9` (always develop and push here). It is ahead of `main` by docs commits (`8d3b9bb`, `86e6a56`, this handoff) and `6534993` (**Stage 6**); `git log origin/main..` lists them. They all go in the Stage 6 PR.
- **Production** (`main`, Workers Builds) runs everything up to **Stage 5b** (PR #8). Migrations `0017` to `0021` are applied live; **`0022` is not**.
- **Stage 6 is built, tested and pushed, but not live:** no migration applied, no PR opened, RTD Sheet Writer unpublished, nothing written to any sheet.
- **Tests:** `npm test` → 28 files, 400 passed. `npm run typecheck` clean.
- **The GitHub connector failed to connect** in the last session (proxy 403). If it still fails, ask the owner to merge, or to reconnect GitHub; don't claim a merge you can't see.

## Standing rules (from the brief and the owner; they still apply)

- **No production migrations, mass notifications or destructive edits without the owner's explicit go-ahead.** Ask before each one.
- **"Do not make any new events or delete any old events"** while the app is still being tested (the owner, 2026-10-16). They will clear the diary and start afresh later. Prove things with the events already there; try anything new locally.
- **Never claim deployed or working without runtime evidence:** check the deployed Worker code (`workers_get_worker_code`, grep the saved file), the next sync's result, and n8n executions.
- **Sheet IDs and secrets never go in this repository** (it's public until the owner makes it private, D-16). They live in n8n `rtd_config` (data table `nMs33jJTorVuKLsp`, project `a6aiHSgNNQaGrWrm`).
- **No live writes to the Logic Engine from the new writer** until the test copy has been used, then at least a week's read-only trial, then the owner says go (D-13).
- Commits end with the attribution lines; don't put model names in commits or PRs; no PR unless the owner asks.

## Next steps for Stage 6 (each needs the owner's go-ahead where marked)

### 1. Apply `0022` and deploy (go-ahead needed)
The routine used for 0019 to 0021:
1. **Restore point:** note the UTC time and the counts (events, occurrences, bookings, audit_log, open attention items) and the last sync's status.
2. **Apply** `migrations/0022_sheet_edits.sql` through the Cloudflare connector (`d1_database_query`), **one statement at a time**: the `ALTER TABLE`, the `CREATE TABLE`, the two `CREATE INDEX`, the `INSERT OR IGNORE INTO settings`. Then `INSERT INTO d1_migrations (name) VALUES ('0022_sheet_edits.sql')`.
3. **Check:** the column, table, indexes and setting (`sheet_writes = off`) exist; counts unchanged; the **next 15-minute sync on the old code is `ok`**.
4. **Must happen before the merge:** the new sync writes `events.sheet_values` and updates `sheet_edits`, so on the old schema every sync would fail.
5. **PR and merge** (the owner may need to merge; see above). Then confirm the deployed Worker has the new code (grep the saved code for `sheet-edits/claim` and `sheet_writes`).
6. **Next sync on the new code:** `ok`, `events_changed` as usual (sheet_values is outside the hash), and `SELECT COUNT(*) FROM events WHERE sheet_values IS NOT NULL` equals the events in the sync.
7. Record it all under `0022` in RTD_EVENT_CONTROL_MIGRATION.md (the section has "Applied to production: not yet").

### 2. Test copy (go-ahead needed)
- An admin sets **Logic Engine changes → Test copy** in the organiser (the owner can do it, or with approval write the setting and a test edit in D1).
- **Publish RTD Sheet Writer** (`TAa4F7wKzzeIDKm8`, version `308a5e79-d71b-4fa6-8153-7282beb2b0f1`, settings already set). Rolling back = unpublishing.
- Make one or two test changes on existing café events (don't create events). Each must end "In the sheet · Test copy" within 5 minutes.
- **Check on the staging copy** (rtd_config `RTD_STAGING_LOGIC_ENGINE_ID`):
  - only the named cells changed;
  - Day follows a new date (and whether Day was a formula; writing it replaces it with text);
  - dates and times are written as text.
- **Conflict test:** make a change, edit the same cell in the copy by hand before the next run. It should show "The sheet changed", and nothing should be written.
- The live app and live sheet must be untouched (staging changes never settle as `synced`).
- Watch the first executions of RTD Sheet Writer. Known untested-for-real parts:
  - the Google Sheets update by Event ID with `autoMapInputData` on the copy;
  - the read-back;
  - `Report Failure To App` on a real Google error.

### 3. Trial on the live sheet, at least a week (go-ahead needed)
- Add `RTD_LOGIC_ENGINE_ID` to rtd_config, with the live Logic Engine's ID. It's the document ID already used in RTD Event Sync and RTD Host Sessions To Diary. Don't write it here.
- An admin sets **Trial**. Changes are checked against the live sheet and show "Trial done · Would write: …"; nothing is written (the app never answers `write` for shadow, and the workflow's **Write It?** also refuses shadow).

### 4. Live (only on the owner's explicit go-ahead after the trial)
An admin sets **Live**. Then update the docs (audit G-6 / D-13, changelog, n8n doc).

## Open items and reminders

**Waiting on the owner:**
- The Stage 6 go-aheads above.
- Spooky Market's booking mode (Optional suggested).
- Bingo under Needs attention: an earlier reminder to the owner. Check its state in the organiser before saying anything about it.
- Making the repo private (D-16).

**Live but never exercised for real:**
- RTD Outbox's `/failed` branch (no email has failed since).
- RTD Host Sessions To Diary branch D (no approved host change yet).
- A booking push on a real phone.

**Audit items not done** (see the gap table and §6):
- **Stage 2:** a staging Worker/D1. Only the sheet copy exists.
- **G-6 / C8:** the row_number writes in RTD Event Sync ID write-back and the Guard should re-check the row before writing.
- **G-8:** export n8n workflow JSON to private storage before changes. Version history keeps one version.
- **G-12 / D-14:** the Google Calendar mirror's filter. Is the calendar public?
- **G-15:** DST tests, and the Master V1 timezone.
- **G-16:** RTD Outbox ignores unknown `@` placeholders.
- **G-17:** identifiers in public docs.
- **G-18:** current-state doc drift. `RTD_APP_CURRENT_STATE.md` was last updated 2026-10-15.
- **D-11:** an email provider.
- **D-17:** the Cloudflare plan.
- **Stage 7:** enhancements.
- **Stage 8:** production cutover (reconciliation, sign-off).

## How to work here (what's worked)

**Local check:**
1. Write a `.dev.vars` with `ENVIRONMENT=development`, `DEV_AUTH_EMAIL=dan@example.com` (admin in the local D1) and `INTERNAL_SYNC_TOKEN=local-token`.
2. Run `npx wrangler d1 migrations apply rtd-app --local`, then `npx wrangler dev --port 8787` in the background.
3. Post a sync to `/internal/sync/logic-engine`.
4. Drive the organiser with Playwright: `PW=$(npm root -g)/playwright`, scripts in the scratchpad, `/organise?nosplash`, 390 px wide.
5. **Delete `.dev.vars` afterwards.**
6. Don't `pkill -f "wrangler dev"` from the same shell (it kills the shell). Stop the server separately.

**n8n:**
- Change workflows with `update_workflow`, then check the draft (`get_workflow_details` / `get_workflow_versions_diff`), then `publish_workflow`, and record the rollback version.
- `test_workflow` simulates every node with credentials (Sheets, HTTP), so it tests the logic only.

**D1:**
- JS numbers bind as REAL, so `CAST(?n AS INTEGER)` when building strings.
- Batches support `RETURNING`.

**Key Stage 6 code:**
- `src/sync/sheetValues.ts` (canonical values, the row check);
- `src/sync/edits.ts` (queue, modes, conflicts, endpoints);
- `src/sync/apply.ts` (sheet_values, and settling written changes);
- `web/src/pages/OrganiseSheetSync.tsx`;
- `test/sheet-edits.test.ts`.
