# RTD App: Current State

_Last updated: 2026-10-05_

## Live
- Nothing from the app yet. Existing RTD automation is unchanged.

## Done
- Phase 0 audit (read-only): [`docs/RTD_AUDIT.md`](docs/RTD_AUDIT.md).

## Incomplete
- Phase 0 migration steps 1–4 (backup, security fixes, sheet columns, `rtd_config`). These wait on the decisions below.
- Phases 1–9.

## Known issues (existing system)
- ImageKit private key is hard-coded in two RTD Master V1 nodes. Rotate it.
- `RTD Cafe Website Requests` webhook is public and unvalidated.
- Event Name is the only identity. The Event Index mixes events with social-content rows.
- One Google OAuth client powers every RTD workflow. It caused a ~34 h outage on 2–3 Oct.

## Next actions
1. Get answers to the decisions in [`docs/RTD_AUDIT.md` §12](docs/RTD_AUDIT.md#12-decisions-needed-from-you).
2. Export RTD workflows and sheets as a dated backup.
3. Start Phase 1: DB schema, auth, audit log, `/internal/sync`, `RTD Event Sync`.

## Required user input
- Hosting and domain choice; café notification email; approval for the new sheet columns.
- Monthly recurrence rules; `RTD_Booking` history; website webhook; ImageKit key rotation.
- `rtd-poster-automation` source in Git; transactional email provider.
- RTD logo files, brand assets, initial game inventory.
