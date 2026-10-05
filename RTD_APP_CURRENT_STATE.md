# RTD App: Current State

_Last updated: 2026-10-05_

## Live
- Nothing yet. The repository holds the specification only.

## Incomplete
- Phase 0 audit of the RTD Logic Engine, n8n workflows, booking, approval, poster/social automation and event stores.
- Every build phase (1 to 9).

## Known issues
- None recorded yet.

## Next actions
1. Run the Phase 0 audit (read-only): inventory the n8n workflows, Logic Engine data, existing IDs, statuses, logs and email nodes.
2. Produce the KEEP / MODIFY / REPLACE / RETIRE / NEW audit table.
3. Agree the target stack and migration plan before any Phase 1 work.

## Required user input
- Access to the n8n instance and the RTD Logic Engine data for the audit.
- Café notification email address (to be stored as `RTD_CAFE_NOTIFICATION_EMAIL`).
- RTD logo files and brand assets.
- Initial game inventory.
- Current hosting details (where the Raspberry Pi and n8n run, existing domains).
