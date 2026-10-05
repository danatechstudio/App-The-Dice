# Roll The Dice Companion App

Installable Progressive Web App (PWA) for Roll The Dice: an event diary and promotional companion, with a random game selector, Game of the Week, reservation-only booking, a Host Portal and Staff Control.

The **RTD Logic Engine remains the master event source**. The existing **n8n** server handles orchestration, sync, scheduled jobs and reporting. The app keeps its own operational database so public pages keep working when n8n or the Raspberry Pi is unavailable.

```
RTD Logic Engine
      │
      ▼
n8n RTD Event Controller ──► Social / Poster Automation
      │                 ──► Email / Staff Notifications
      │                 ──► Audit / Event Logging
      ▼
App Database / API ──► Customer App
                   ──► Host Portal
                   ──► Staff Control
```

## Status

**Phase 0 (Audit): complete.** **Phase 1 (Data foundation): built and tested, waiting to be deployed.** See [`RTD_APP_CURRENT_STATE.md`](RTD_APP_CURRENT_STATE.md).

Stack: Cloudflare Workers + D1, with Cloudflare Access for staff sign-in. The existing n8n on the Pi handles automation.

```sh
npm ci
npm test          # 82 tests, run in the Workers runtime against a local D1
npm run typecheck
```

## Documents

| File | Purpose |
| --- | --- |
| [`docs/RTD_APP_SPECIFICATION.md`](docs/RTD_APP_SPECIFICATION.md) | Full audit, architecture and build specification |
| [`docs/RTD_AUDIT.md`](docs/RTD_AUDIT.md) | Phase 0 audit of the existing RTD / n8n environment, with migration plan |
| [`docs/RTD_APP_ARCHITECTURE.md`](docs/RTD_APP_ARCHITECTURE.md) | Hosting decision, data flow, occurrence rules, API |
| [`docs/RTD_DATABASE_SCHEMA.md`](docs/RTD_DATABASE_SCHEMA.md) | Tables and columns |
| [`docs/RTD_N8N_WORKFLOWS.md`](docs/RTD_N8N_WORKFLOWS.md) | n8n changes made, rollback points, planned sync workflow |
| [`docs/RTD_DEPLOYMENT.md`](docs/RTD_DEPLOYMENT.md) | One-off Cloudflare setup |
| [`docs/RTD_RECOVERY.md`](docs/RTD_RECOVERY.md) | Rollback and recovery |
| [`RTD_APP_CURRENT_STATE.md`](RTD_APP_CURRENT_STATE.md) | What is live, what is incomplete, next actions |
| [`RTD_CHANGELOG.md`](RTD_CHANGELOG.md) | Changes by date |

Further documents required by the spec (section 54) are added as each phase is delivered.

## Phases

0. Audit of the existing RTD / n8n environment (mandatory, non-destructive)
1. Data foundation: event IDs, event/occurrence split, database, API, sync, audit, auth
2. Public PWA and diary
3. Push notifications
4. Game system
5. Booking
6. Host Portal
7. Become a Host
8. Staff Control
9. Hardening
