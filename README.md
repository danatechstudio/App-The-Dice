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

**Phase 0 (Audit): not started.** No application code yet. See [`RTD_APP_CURRENT_STATE.md`](RTD_APP_CURRENT_STATE.md).

## Documents

| File | Purpose |
| --- | --- |
| [`docs/RTD_APP_SPECIFICATION.md`](docs/RTD_APP_SPECIFICATION.md) | Full audit, architecture and build specification |
| [`RTD_APP_CURRENT_STATE.md`](RTD_APP_CURRENT_STATE.md) | What is live, what is incomplete, next actions |

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
