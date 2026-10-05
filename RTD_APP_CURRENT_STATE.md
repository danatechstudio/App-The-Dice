# RTD App: Current State

_Last updated: 2026-10-05_

## Live
- **Logic Engine:** every event row now has a permanent `Event ID`, plus `App Visibility` and `App Category` (backup taken first).
- **Monthly events:** no longer auto-rolled. When one passes, Michelle gets the date-picker email.
- **`rtd_config`** n8n data table holds the café notification email.

## Built, not deployed
- **Phase 1 Worker:** Cloudflare Worker + D1.
  - Schema, idempotent Logic Engine sync with occurrence history, public diary API, staff API behind Cloudflare Access, append-only audit log.
  - 82 tests passing. Smoke-tested locally with today's real event data.

## Incomplete
- Deployment (needs your Cloudflare login: [docs/RTD_DEPLOYMENT.md](docs/RTD_DEPLOYMENT.md)).
- RTD Event Sync n8n workflow, built once the Worker URL and token exist.
- Phases 2–9.

## Known issues
- **Secrets in RTD Master V1:** the ImageKit private key and the Meta page access token are hard-coded. Rotate both (S1).
- **Website webhook:** `RTD Cafe Website Requests` is public and unvalidated (S3).
- **Event Guard local edit:** the new Monthly node must be mirrored in `rtd-poster-automation`, or its next build will undo it.
- **Blood on the Clocktower:** auto-rolled from 4 Oct to **4 Nov** before the monthly change, and a poster was generated for that date. Please confirm the date with Michelle.

## Next actions
1. Deploy: run `./scripts/cloudflare-setup.sh`, either on your own machine or by Claude once this cloud environment can reach `api.cloudflare.com` with a `CLOUDFLARE_API_TOKEN`. Then set up Access ([docs/RTD_DEPLOYMENT.md](docs/RTD_DEPLOYMENT.md) §4).
2. Me: build and test RTD Event Sync; then start Phase 2 (PWA and diary).
3. You: push `rtd-poster-automation` to GitHub, so I can fold in the Guard and poster fixes.

## Required user input
- Brand assets (logo files, fonts and colours if they differ from navy #14315c / orange #d9822b), and the initial game inventory.
- Answers to audit §12 items 6, 7, 9, 10 and 11.
