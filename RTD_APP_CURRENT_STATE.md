# RTD App: Current State

_Last updated: 2026-10-05_

## Live
- **Logic Engine:** every event row now has a permanent `Event ID`, plus `App Visibility` and `App Category` (backup taken first).
- **Monthly events:** no longer auto-rolled. When one passes, Michelle gets the date-picker email.
- **`rtd_config`** n8n data table holds the café notification email.

## Cloudflare (deployed)
- **App:** https://rtd-app.dan-289.workers.dev, deployed from GitHub `main` on every push (Workers Builds).
- **Sync:** **RTD Event Sync** runs every 15 minutes, copying the Logic Engine into the app. It is live, with 31 events and 40 occurrences.
- **Database:** D1 `rtd-app` with the schema applied; Dan is admin.
- **Staff sign-in:** Access application "RTD Staff" protects `/api/staff` only (team `solitary-thunder-9de0`).

## Phase 1 Worker
- Cloudflare Worker + D1.
  - Schema, idempotent Logic Engine sync with occurrence history, public diary API, staff API behind Cloudflare Access, append-only audit log.
  - 84 tests passing; verified live against the real sheet.

## Incomplete
- Phases 2–9.

## Known issues
- **Secrets in RTD Master V1:** the ImageKit private key and the Meta page access token are hard-coded. Rotate both (S1).
- **Website webhook:** `RTD Cafe Website Requests` is public and unvalidated (S3).
- **Event Guard local edit:** the new Monthly node must be mirrored in `rtd-poster-automation`, or its next build will undo it.
- **Blood on the Clocktower:** auto-rolled from 4 Oct to **4 Nov** before the monthly change, and a poster was generated for that date. Please confirm the date with Michelle.

## Next actions
1. Me: Phase 2, the branded PWA: home, diary, event pages, splash, Add to Calendar, sharing. It needs the logo files.
2. You: check which Standard Diary groups should appear publicly. They all default to Public (e.g. GirlsGetOut Ladies Night, National Coastguard Institute). Set private bookings to `Hidden` in the sheet's `App Visibility` column.
3. You: push `rtd-poster-automation` to GitHub, so I can fold in the Guard and poster fixes.

## Required user input
- Brand assets (logo files, fonts and colours if they differ from navy #14315c / orange #d9822b), and the initial game inventory.
- Answers to audit §12 items 6, 7, 9, 10 and 11.
