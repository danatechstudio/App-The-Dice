# RTD App Architecture

_Updated 2026-10-05 (Phase 1)._

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Hosting | **Cloudflare Workers + D1**, in the existing Cloudflare account | Off the Pi, so the diary and bookings keep working when the Pi or n8n is down (spec §3, §44). No new vendor. Free tier fits. |
| Database | **D1** (SQLite at the edge) | Small data set; SQL with transactions (`batch`), so capacity checks can be atomic later. |
| Staff / Host sign-in | **Cloudflare Access**, email one-time PIN | No passwords to store or reset. Access proves the email; the app's `users` table decides the role, so a Host can never act as Staff. |
| Automation | **Existing n8n on the Pi** | Sync, emails, digests and reminders. Accepted Pi dependency: if the Pi is down, sync and emails pause but the app keeps serving. |
| Master data | **RTD Logic Engine sheet** stays authoritative | No second calendar. The app keeps occurrence history the sheet can't hold. |
| PWA | Preact + Vite in `web/`, served as static assets from the same Worker | One deploy, same origin, no CORS. Small (about 31 KB of gzipped script). |

The Pi is still needed for n8n. Nothing public-facing depends on it.

## Data flow

```
Logic Engine_RTD (Google Sheet)
  Event Index + Standard Diary, each row now carries Event ID / App Visibility / App Category
        │  read every 15 min (RTD Event Sync, n8n; built after first deploy)
        ▼
POST /internal/sync/logic-engine  (bearer token, idempotent per run_id)
        │  normalise → plan → one atomic D1 batch
        ▼
D1: events · occurrences · audit_log · sync_runs · users · settings
        │
        ▼
GET /api/events · /api/events/:id · /api/occurrences/:id   (public, cached 60 s)
GET /api/staff/*                                             (Access + role)
```

## Field ownership

| Owned by the Logic Engine (edited in the sheet) | Owned by the app (edited in Staff Control, later phases) |
| --- | --- |
| Event ID, name, frequency, date, times, Status, Base Details, Photo Folder, **App Visibility**, **App Category** | Occurrence history, capacity and booking settings, bookings, waitlist, hosts, games, notifications, audit |

## Occurrence rules

The sheet holds only an event's *next* date and overwrites it in place. The app turns that into history (`src/sync/plan.ts`):

- **IDs.** An occurrence ID is the event plus the date, e.g. `RTD-OCC-00001-20261023`. Repeating a sync is a no-op.
- **Projection.** Weekly and fortnightly events also get **projected** occurrences six weeks ahead (setting `projection_weeks`), so the diary shows "every Thursday". When the sheet reaches a projected date, it becomes confirmed.
  - Standard Diary monthly groups are projected every 28 days, matching how the sheet rolls them forward.
  - Event Index monthly events are not projected, because their dates vary.
- **Past dates.** Scheduled occurrences whose date has passed become `completed`.
- **Moved dates.** If a future scheduled occurrence is no longer implied by the sheet, it becomes `rescheduled`. It points at the new date, or at nothing while a new date is awaited. If the date moves back, it is reinstated.
- **Nothing is lost.** Nothing is deleted or re-dated. Staff cancellations are never overridden by a sync.
- **Visibility.** Only active events with `Public` or `App Bookable` visibility are ever served publicly. `Private` and `Hidden` never appear.

## Safety rails

- **Atomic sync.** Each sync is one D1 batch: it lands completely or not at all. Each sync uses about 10 queries, well under the free plan's limit per request.
- **Circuit breaker.** A snapshot with no usable rows, or fewer than half the previous count, is refused (`409`) and recorded. A broken sheet read can't empty the diary.
- **Ambiguous rows are skipped and reported** (`warnings` on the sync run): rows with a missing or duplicated Event ID. A duplicated ID never causes a deactivation.
- **Audit log.** `audit_log` is append-only; database triggers reject `UPDATE` and `DELETE`.
- **Caching.**
  - Public responses: `Cache-Control: public, max-age=60`.
  - Staff responses, including refusals: `no-store`.
- **Security headers** on every response: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | none | Liveness and time of last good sync |
| GET | `/api/events?from&to&category` | none | Diary listing: upcoming occurrences, max 120-day range |
| GET | `/api/events/:eventId` | none | Event page with upcoming occurrences |
| GET | `/api/occurrences/:occurrenceId` | none | Deep link. Still returns cancelled/rescheduled status so old links explain themselves |
| GET | `/api/occurrences/:occurrenceId/calendar.ics` | none | Add to Calendar file (scheduled occurrences only) |
| GET | `/api/occurrences/:occurrenceId/google-calendar` | none | Redirect to a prefilled Google Calendar event |
| POST | `/internal/sync/logic-engine` | bearer `INTERNAL_SYNC_TOKEN` | n8n snapshot of the sheet tabs |
| GET | `/api/staff/me` | Access + staff/admin | Who am I |
| GET | `/api/staff/sync-runs` | Access + staff/admin | Last 50 sync runs with warnings |
| GET | `/api/staff/audit?entity_id&before&limit` | Access + staff/admin | Audit history |

## App pages

Static files in `web/dist` are served directly; unknown paths fall back to the app (single-page app). These paths reach the Worker first (`run_worker_first`):

| Path | What the Worker does |
| --- | --- |
| `/`, `/event/:occurrenceId`, `/events/:eventId` | Serves the app shell with link-preview tags (title, description, image, URL) for that event, so shared links show the event. Unknown or hidden events get the shell with a 404 status. |
| `/api/*`, `/internal/*` | API, as above |

The **service worker** caches the app shell and the last diary it saw, so the diary opens offline. It never touches `/api/staff` or `/internal`.

## Code map

| Path | What |
| --- | --- |
| `src/index.ts` | Router, security headers, error handling |
| `src/lib/time.ts` | London dates and times, BST-aware |
| `src/lib/auth.ts` | Access JWT verification, role guard, bearer check |
| `src/sync/normalise.ts` | Sheet rows → clean events (pure) |
| `src/sync/plan.ts` | Occurrence history rules (pure) |
| `src/sync/apply.ts` | Payload validation, circuit breaker, atomic write |
| `src/lib/queries.ts` | Shared public-read SQL (visibility rules) |
| `src/lib/calendar.ts` | `.ics` and Google Calendar links |
| `src/routes/*` | Public, internal, staff endpoints and app pages (link previews) |
| `web/` | The PWA: `src/theme` (tokens), `src/styles`, `src/components`, `src/pages`, `public` (icons, manifest, service worker). See [RTD_APP_THEME.md](RTD_APP_THEME.md). |
| `migrations/` | D1 schema |
| `test/` | 125 tests, run inside the Workers runtime against a real local D1 |

## Future compatibility

- **Discord:** a later notification channel via n8n. Nothing here assumes email only.
- **Native app wrappers (Capacitor):** consume the same API.
- **Customer accounts:** can be added beside the token-based booking links without changing occurrence or booking IDs.
