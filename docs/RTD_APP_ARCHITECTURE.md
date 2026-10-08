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
- **Visibility.** Only active events with `Public` or `App Bookable` visibility are served in full. `Hidden` never appears.
  - **`Private` events appear only in the diary list (`/api/events`):** they show as "Private session" with their date and time, so the café looks as busy as it is.
  - **Their details never leave the server:** not the name, description, photo or price.
  - **No other pages:** they have no event page, link preview or calendar file, and the app never features them (Home feature, Coming Up, Book, splash).

## Safety rails

- **Atomic sync.** Each sync is one D1 batch: it lands completely or not at all. Each sync uses about 10 queries, well under the free plan's limit per request.
- **Circuit breaker.** A snapshot with no usable rows, or fewer than half the previous count, is refused (`409`) and recorded. A broken sheet read can't empty the diary.
- **Ambiguous rows are skipped and reported** (`warnings` on the sync run): rows with a missing or duplicated Event ID. A duplicated ID never causes a deactivation.
- **Audit log.** `audit_log` is append-only; database triggers reject `UPDATE` and `DELETE`. So it records customers by booking or request number, never by name or email.
- **One Cron Trigger, every minute.** It sends queued event reminders in batches of 20 and the 8pm automatic one ([RTD_ALERTS.md](RTD_ALERTS.md)). At 03:23 UTC the same run erases old details (next point).
- **Erasing old details.** Daily at 03:23 UTC, the Cron Trigger erases booking contact details 12 months after the event, network hashes after 2 days, and declined join requests after 12 months, and event alert network codes after 2 days ([RTD_PRIVACY.md](RTD_PRIVACY.md)).
- **Caching.**
  - Public responses: `Cache-Control: public, max-age=60`.
  - Staff responses, including refusals: `no-store`.
- **Security headers** on every response: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | none | Liveness and time of last good sync |
| GET | `/api/privacy` | none (cached 5 min) | Who the privacy notice names, its contact address, and how long booking details are kept |
| GET | `/api/events?from&to&category` | none | Diary listing: upcoming occurrences, max 120-day range. Private ones are redacted to "Private session" and their time. |
| GET | `/api/events/:eventId` | none | Event page with upcoming occurrences |
| GET | `/api/occurrences/:occurrenceId` | none | Deep link. Still returns cancelled/rescheduled status so old links explain themselves |
| GET | `/api/occurrences/:occurrenceId/calendar.ics` | none | Add to Calendar file (scheduled occurrences only) |
| GET | `/api/occurrences/:occurrenceId/google-calendar` | none | Redirect to a prefilled Google Calendar event |
| GET | `/images/:imageId` | none | An event photo from KV. Served only while its event is visible; cached for a year (content-addressed). |
| GET | `/internal/images/plan` | bearer | Events that want photos, with their Drive folder |
| POST | `/internal/images/sync` | bearer | Each event's chosen Drive files. Removes the rest and answers with the uploads still needed. |
| PUT | `/internal/images/:eventId/:fileId` | bearer | One resized photo (JPEG/PNG/WebP/GIF/AVIF, max 5 MB), only for a file the sync listed |
| POST | `/internal/sync/logic-engine` | bearer `INTERNAL_SYNC_TOKEN` | n8n snapshot of the sheet tabs |
| GET | `/internal/host-sessions/followups` | bearer | One-off host sessions due the follow-up email |
| POST | `/internal/host-sessions/:id/followup-sent` | bearer | Records that the follow-up email went out |
| GET / POST | `/internal/host-sessions/new-submissions`, `/internal/host-sessions/:id/cafe-notified` | bearer | New submissions to email the café about, and recording that email |
| GET / POST | `/internal/host-sessions/to-publish`, `/internal/host-sessions/:id/published` | bearer | Approved sessions with their Event Index row, and marking them Live |
| GET / POST | `/internal/applications/new`, `/internal/applications/decided`, `…/:id/approver-notified`, `…/:id/applicant-notified` | bearer | Join request emails ([RTD_ONBOARDING.md](RTD_ONBOARDING.md)) |
| GET / POST | `/internal/host-sessions/decided`, `/internal/host-sessions/:id/host-notified` | bearer | Emailing hosts the café's decision |
| POST | `/internal/outbox/collect`, `/internal/outbox/:id/sent` | bearer | Booking emails for n8n RTD Outbox ([RTD_BOOKINGS.md](RTD_BOOKINGS.md)) |
| GET / POST | `/internal/sheet-fixes`, `/internal/sheet-fixes/:eventId/done` | bearer | Event Index changes for cancelled dates, matched on Event ID. The old `/internal/host-sessions/sheet-fixes` is retired and always empty. |
| GET | `/api/bookings/availability/:occurrenceId` | none (never cached) | Whether a date can be booked, and places left (null when there's no limit) |
| POST | `/api/bookings`, `/api/bookings/:id/view`, `/api/bookings/:id/cancel` | none; same-origin JSON; the cancel link's secret | Book, see or cancel a booking |
| GET | `/api/staff/me` | Access + staff/admin | Who am I |
| GET | `/api/staff/sync-runs` | Access + staff/admin | Last 50 sync runs with warnings |
| GET | `/api/staff/audit?entity_id&before&limit` | Access + staff/admin | Audit history |
| GET | `/api/staff/sign-in` | Access (anyone it lets in) | The organiser's Sign in button: redirects to `/organise` |
| GET / POST | `/api/host/me`, `/api/host/sessions`, `/api/host/sessions/:id/withdraw`, `…/resubmit`, `…/delete` | Access cookie + host/staff/admin | Host organiser ([RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md)) |
| GET / POST | `/api/staff/host-sessions`, `/api/staff/host-sessions/:id/decision` | Access + approver/admin | Session approvals |
| GET | `/api/staff/hosts` | Access + approver/admin | Hosts |
| GET / POST | `/api/join/me`, `/api/join/apply`, `/api/join/withdraw` | Access cookie (any signed-in email) | Asking to host or join the café team ([RTD_ONBOARDING.md](RTD_ONBOARDING.md)) |
| GET / POST | `/api/staff/applications`, `/api/staff/applications/:id/decision` | Access + approver/admin | Join requests |
| GET / POST | `/api/staff/approvers`, `/api/staff/users/:id/approver`, `/api/staff/users/:id/remove` | Access + approver/admin | Approvers (admins only), and removing access |
| GET | `/api/staff/booked-dates` | Access + approver/admin | The next 3 weeks: hosted dates and booked café events, with bookings |
| GET / POST | `/api/staff/push/key`, `/devices`, `/subscribe`, `/unsubscribe`, `/test` | Access + approver/admin | Push notifications on this device ([RTD_PUSH.md](RTD_PUSH.md)) |
| POST | `/api/host/occurrences/:id/cancel` | Access cookie + the session's host, approver or admin | Cancel a date |
| POST | `/api/host/sessions/:id/places`, `/api/host/occurrences/:id/places` | Access cookie + the session's host (approvers and admins for any single date) | Places on every date of a live session, or on one date ([RTD_BOOKINGS.md](RTD_BOOKINGS.md#places)) |
| GET / POST | `/api/staff/event-places`, `/api/staff/events/:id/places` | Access + approver/admin | Places for café events |
| GET / POST | `/api/markets`, `/api/markets/:id`, `/api/markets/:id/apply` | none; applying is same-origin JSON | Markets vendors can apply to, and applying ([RTD_MARKETS.md](RTD_MARKETS.md)) |
| GET / POST | `/api/staff/markets…`, `/api/staff/market-applications…`, `/api/staff/market-photos/:id` | Access + approver/admin (setting up markets: admins only) | Markets and vendor applications |
| GET / POST | `/internal/market-applications/sheet`, `/internal/market-applications/:id/sheet-synced` | bearer | The market spreadsheet |
| GET / POST | `/api/alerts/key`, `/subscribe`, `/unsubscribe`, `/status`, `/renew` | none; same-origin JSON | Event alerts on this device ([RTD_ALERTS.md](RTD_ALERTS.md)) |
| GET / POST | `/api/staff/reminders` | Access + admin | Event reminders: the list, and sending one (`409 { warning }` within 24 hours of the last for that event) |
| GET / POST | `/internal/social-posts`, `/internal/social-posts/:id/done`, `…/failed` | bearer | Facebook posts for admins' reminders (n8n RTD Event Reminders To Facebook) |

## App pages

Static files in `web/dist` are served directly; unknown paths fall back to the app (single-page app). These paths reach the Worker first (`run_worker_first`):

| Path | What the Worker does |
| --- | --- |
| `/`, `/event/:occurrenceId`, `/events/:eventId` | Serves the app shell with link-preview tags (title, description, image, URL) for that event, so shared links show the event. Unknown or hidden events get the shell with a 404 status. |
| `/api/*`, `/internal/*`, `/images/*` | API and photos, as above |

The **service worker** caches the app shell and the last diary it saw, so the diary opens offline. It never touches `/api/staff` or `/internal`. It also shows push notifications: approvers' (tapping opens the organiser, [RTD_PUSH.md](RTD_PUSH.md)) and event alerts (tapping opens the event, [RTD_ALERTS.md](RTD_ALERTS.md)). When the browser renews its subscription, it tells the app.

## Event photos

- **Where they live:** photos are copied into the app, not linked to Drive. This means they load fast and nothing in Drive has to be shared publicly. The bytes are in Workers KV.
- **How they are chosen and shown:**
  - Each occurrence shows one of its event's photos, picked by a hash of the occurrence id, so different dates of a weekly club show different photos.
  - Event pages show the whole set in a gallery.
  - A manual `image_override` / `default_image` always wins.
- **Why KV, not R2:** R2 isn't enabled on the account. KV's free tier (1 GB, 1,000 writes and 100,000 reads a day) is ample, because photos are only written when folders change, and browsers cache them for a year.

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
| `src/host/sessions.ts` | Host sessions: validation, numbering, withdraw, send again, delete, approver decisions, n8n feeds |
| `src/team/applications.ts` | Onboarding: join requests, approvers, granting and removing access, email feeds |
| `src/bookings/bookings.ts` | Bookings: availability, capacity-safe booking, the cancel link, host and approver views, cancelling a date, two-day emails, Event Index fixes |
| `src/notify/emails.ts`, `src/notify/outbox.ts` | Booking email wording, and the outbox n8n sends from |
| `src/notify/push.ts` | Web Push: VAPID keys, RFC 8291 encryption, approvers' devices, sending |
| `src/notify/alerts.ts` | Event alerts: turning on and off, admins' reminders (24-hour warning), the 8pm automatic reminder, batched sending, the Facebook queue |
| `src/lib/background.ts` | Work after the response (`waitUntil`), such as pushes |
| `src/lib/format.ts` | Dates, times and escaping for emails |
| `src/images/store.ts` | Event photos: plan, sync, upload (type sniffing, content hashing), serving, per-date picking |
| `src/routes/*` | Public, internal, staff endpoints and app pages (link previews) |
| `web/` | The PWA: `src/theme` (tokens), `src/styles`, `src/components`, `src/pages`, `public` (icons, manifest, service worker). See [RTD_APP_THEME.md](RTD_APP_THEME.md). |
| `migrations/` | D1 schema |
| `test/` | 270 tests, run inside the Workers runtime against a real local D1 and KV |

## Future compatibility

- **Discord:** a later notification channel via n8n. Nothing here assumes email only.
- **Native app wrappers (Capacitor):** consume the same API.
- **Customer accounts:** can be added beside the token-based booking links without changing occurrence or booking IDs.
