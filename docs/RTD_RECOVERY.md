# RTD Recovery

## n8n changes

To roll back, open the workflow in n8n → Version history → restore, then publish. The version IDs are in [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#changes-made).

| If… | Do |
| --- | --- |
| Monthly events should auto-roll again | Restore RTD Master V1 to `03601fc5…` and RTD Event Guard (sub) to `20a1ffc4…`. Restore both, or neither: restoring only one leaves monthly events either never rolled forward or rolled forward and also expired. |
| The new sheet columns cause trouble | Hide or delete the last three columns (`Event ID`, `App Visibility`, `App Category`) on both tabs. No existing workflow reads them. The pre-change copy is "Logic Engine_RTD BACKUP 2026-10-05 1200 (before app ID columns)". |

## App

| If… | Do |
| --- | --- |
| A deploy is bad | `npx wrangler rollback` (previous Worker version) |
| A sync wrote bad data | Find the run in `/api/staff/sync-runs` (or the `sync_runs` table), then restore D1 to just before its `received_at`: `npx wrangler d1 time-travel restore rtd-app --timestamp=<ISO time>`. Time Travel keeps 7 days on the free plan and 30 on paid. Pause RTD Event Sync first, so it doesn't immediately re-apply the bad data. |
| The sheet is broken or mid-edit | Deactivate RTD Event Sync. The app keeps serving the last good data. The circuit breaker already refuses snapshots that lose more than half the events. |
| Nobody can sign in to Staff Control | Use `wrangler d1 execute` to add or re-activate an admin row ([RTD_DEPLOYMENT.md §5](RTD_DEPLOYMENT.md#5-first-admin)), and check the Access application's AUD tag matches `ACCESS_AUD`. |
| The sync token leaks | Run `npx wrangler secret put INTERNAL_SYNC_TOKEN` with a new value, then update the n8n `RTD App Sync` credential. |

## Pi or n8n down

The public app keeps working from D1. Sync, digests and reminders pause and resume when n8n is back. Each sync is a full snapshot, so nothing needs replaying.
