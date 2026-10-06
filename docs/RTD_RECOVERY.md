# RTD Recovery

## n8n changes

To roll back, open the workflow in n8n → Version history → restore, then publish. The version IDs are in [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#changes-made).

| If… | Do |
| --- | --- |
| Monthly events should auto-roll again | Restore RTD Master V1 to `03601fc5…` and RTD Event Guard (sub) to `20a1ffc4…`. Restore both, or neither: restoring only one leaves monthly events either never rolled forward or rolled forward and also expired. **These versions predate the private-session filters**, so turn off RTD Host Sessions To Diary first, or private sessions will be advertised. |
| Host sessions should stop reaching the sheet | Deactivate **RTD Host Sessions To Diary** (`rdS8LF56B9k170BY`). This also stops the café's new-submission emails. Rows already added stay; set their Status to `Inactive` to take them out of the diary. |
| Private rows appear in social posts or get posters | Check that RTD Master V1 is on `c8485b62…` or later, and RTD Event Guard (sub) on `d3c74b27…` or later. If `rtd-poster-automation` was rebuilt, it may have removed the Guard's **App:** nodes; re-add them ([RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#changes-made)). |
| Undo tonight's private-session filters | Restore RTD Master V1 to `95b638b5…` and RTD Event Guard (sub) to `fe0eeae3…`, but turn off RTD Host Sessions To Diary first, and set any `Private` rows to `Hidden`. Otherwise private sessions will be advertised. |
| The host session columns cause trouble | Hide the `App Price`, `App Capacity` and `App Host Session` columns (Event Index V–X); hidden columns keep working. Don't delete them while RTD Host Sessions To Diary is on: it stops rather than write to a missing column. The pre-change copy is "Logic Engine_RTD BACKUP 2026-10-05 2157 (before host session columns)". |
| Onboarding or decision emails go wrong | Deactivate **RTD Team Notices** (`diKojCurHeRWQjAR`). Requests, approvals and access keep working in the app; only the emails stop. When it's turned back on, it only emails about the last 14 days. |
| The app ID columns cause trouble | Hide the `Event ID`, `App Visibility` and `App Category` columns on both tabs; hidden columns keep working. **Don't delete them:** the app sync, RTD Master V1 and Event Guard now read them. The pre-change copy is "Logic Engine_RTD BACKUP 2026-10-05 1200 (before app ID columns)". |

## App

| If… | Do |
| --- | --- |
| A deploy is bad | `npx wrangler rollback` (previous Worker version) |
| A sync wrote bad data | Find the run in `/api/staff/sync-runs` (or the `sync_runs` table), then restore D1 to just before its `received_at`: `npx wrangler d1 time-travel restore rtd-app --timestamp=<ISO time>`. Time Travel keeps 7 days on the free plan and 30 on paid. Pause RTD Event Sync first, so it doesn't immediately re-apply the bad data. |
| The sheet is broken or mid-edit | Deactivate RTD Event Sync. The app keeps serving the last good data. The circuit breaker already refuses snapshots that lose more than half the events. |
| Someone was given access by mistake | Remove them in `/organise` (**Hosts** or **Café team** table). That sets `users.active = 0`; it's in `audit_log`. |
| Nobody can sign in to Staff Control | Use `wrangler d1 execute` to add or re-activate an admin row ([RTD_DEPLOYMENT.md §5](RTD_DEPLOYMENT.md#5-first-admin)), and check the Access application's AUD tag matches `ACCESS_AUD`. |
| The sync token leaks | Run `npx wrangler secret put INTERNAL_SYNC_TOKEN` with a new value, then update the n8n `rtd-app` credential (Header Auth: `Authorization: Bearer <token>`). |

## Pi or n8n down

The public app keeps working from D1. Sync, digests and reminders pause and resume when n8n is back. Each sync is a full snapshot, so nothing needs replaying.
