# RTD App Changelog

## 2026-10-05 (Cloudflare)
- **App deployed** at https://rtd-app.dan-289.workers.dev from GitHub (Workers Builds). Staff Access is on `/api/staff`.
- **RTD Event Sync** n8n workflow built (switched off until its credential exists). `rtd_config` gained `RTD_APP_BASE_URL`.
- **Fix:** a retried run of a refused sync now stays refused (`409`), instead of coming back as a "duplicate" success.
- **D1 database `rtd-app` created** (WEUR) through the Cloudflare connector.
  - `0001_foundation.sql` applied and recorded in `d1_migrations`.
  - First admin user added.
- **`wrangler.jsonc`** now points at the real database id.
- **Added `scripts/cloudflare-setup.sh`,** a one-command setup for running it from your own machine.

## 2026-10-05 (later)

### n8n / Logic Engine (live)
- **Logic Engine backup** taken: "Logic Engine_RTD BACKUP 2026-10-05 1200 (before app ID columns)".
- **New sheet columns** `Event ID`, `App Visibility` and `App Category` added at the end of Event Index and Standard Diary.
  - IDs backfilled: `RTD-EVT-00001`–`00031`.
  - One-off workflow: `RTD One-Off: Add App ID Columns`.
- **RTD Master V1:** `Calculate next dates` no longer auto-rolls Monthly events.
- **RTD Event Guard (sub):** new node `Monthly: Ask For Next Date`, so a passed Monthly event expires and the date-picker email goes to Michelle. Published; two dry runs passed.
- **`rtd_config`** data table created, holding `RTD_CAFE_NOTIFICATION_EMAIL`.

### App (repo)
- **Phase 1 data foundation** on Cloudflare Workers + D1: schema migration, Logic Engine sync with occurrence history, public diary API, staff API behind Cloudflare Access, append-only audit log, 82 tests.
- **Docs added:**
  - `RTD_APP_ARCHITECTURE.md`
  - `RTD_DATABASE_SCHEMA.md`
  - `RTD_N8N_WORKFLOWS.md`
  - `RTD_DEPLOYMENT.md`
  - `RTD_RECOVERY.md`
- **Audit updated** with your decisions, the hard-coded Meta token (S1), and the poster title rule bug.

## 2026-10-05
- Repository created with the build specification.
- Phase 0 audit completed (read-only): `docs/RTD_AUDIT.md`. No changes made to n8n, Google Sheets or Drive.
