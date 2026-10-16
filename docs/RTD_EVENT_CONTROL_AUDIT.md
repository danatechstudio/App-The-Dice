# RTD Event Control Audit (Stage A)

_Audit date: 2026-10-16. Read-only. Brief: "Roll The Dice — Event Control Audit & Staged Implementation"._

**Nothing was changed by this audit.** No code, schema, D1 row, n8n workflow, Google Sheet, calendar, email or push was created, edited, sent or deleted. Live systems were read with `SELECT` queries and n8n read calls only. The only artefact is this file.

> **This repository is public.** This document names systems, workflows and tables, but deliberately contains no spreadsheet, calendar, Drive or credential IDs and no personal email addresses. Those belong in private environment documentation (see [G-17](#3-gap-analysis)).

**Stop point:** this is the Stage A deliverable. Stage B (any code, migration, workflow or sheet change) waits for explicit approval of §6 and answers to §7.

---

## 0. Summary

**What exists today.** The Logic Engine Google Sheet is the master for events. n8n reads it every 15 minutes and posts a full snapshot to the Cloudflare Worker, and the Worker keeps event and occurrence history in D1. The public PWA, the host organiser and the staff screens read D1. n8n on the Pi also handles expiry, posters, social posts, the Google Calendar mirror and every email. The app writes to the sheet only in three narrow cases: new Event IDs, approved host sessions (appended rows) and cancelled dates (Status / Event Date fixes).

**Headline findings.**

| # | Severity | Finding |
| --- | --- | --- |
| G-1 | **P0** | Public queries filter by **date, not end time**. An occurrence that ended at 14:00 today is still returned by `/api/events`, `/api/events/:id`, link previews, `.ics` and Google Calendar links until London midnight. Deep links (`/api/occurrences/:id`) return **finished occurrences in full** by design. |
| G-2 | **P0** | **The app has no expiry or "Needs Attention" concept.** Expiry happens in n8n (RTD Event Guard, daily 01:15). It keys on **Event Name**, sends one date-picker email to **one hard-coded personal address** (not info@, not Dan), and never sends a reminder. **Live example:** Bingo expired on 10 Oct; its date-picker closed as `NO_RESPONSE` 6½ hours later (the form should wait 30 days, and the cause is unknown); nothing has chased it since. |
| G-3 | **P0** | **Cancellation emails bookers but never pushes to them.** Bookings aren't linked to any device: push subscriptions are anonymous (`alert_subscriptions`) or approver-only (`push_subscriptions`). The outbox records only `sent_at`, so failures, attempts and dead letters aren't recorded. |
| G-4 | **P0** (latent) | **When the sheet moves a booked date** (the occurrence becomes `rescheduled`), only the café gets a "check bookings" email. The bookers are never told. |
| G-5 | P1 | **No booking mode.** Every public event is bookable (`bookable` is derived), including Standard Diary groups that never take bookings. There's no `none / optional / required`. |
| G-6 | P1 | **The sheet → app flow is one-way, with silent overwrite.** There's no revision, base snapshot or conflict record, and no two-way sync. ID write-back and Guard updates match on **row number**. |
| G-7 | P1 | **Hosts can't propose edits to a live session.** They can change places and cancel dates **immediately, with no approval**. |
| G-8 | P1 | **n8n keeps only the current version of each workflow.** Every "roll back to `<versionId>`" in `RTD_N8N_WORKFLOWS.md` and `RTD_RECOVERY.md` points at a version that no longer exists. |

**What is solid and must be kept:**
- the append-only `audit_log`, with triggers that block UPDATE and DELETE;
- an atomic, idempotent sync with a circuit breaker;
- sync never overriding a cancelled or completed occurrence;
- a capacity check inside the booking insert;
- per-email `dedupe_key` in the outbox;
- token-hashed guest booking links;
- 12-month retention and erasure.

**The app is a good base.** The gaps are additive: no table needs replacing.

**Live data at audit time** (D1, 2026-10-16 ~06:00 UTC):
- **Events:** 32 (19 listed publicly or as private).
- **Occurrences:** 56: 43 scheduled (31 projected), 12 completed, 1 rescheduled.
- **Bookings:** **0.** The outbox has never held an email.
- **Users:** 2. **Host sessions:** 2. **Alert devices:** 1. **Approver push devices:** 1.
- **Sync:** 1,024 runs, all `ok`, the latest at 05:45 UTC. Each carries the same 2 warnings: Cleeples and Wednesdays have free text in the date column.
- **Migrations:** all 16 applied.

**Why zero bookings matters:** schema and behaviour changes to booking and cancellation carry almost no data-migration risk right now.

**Test baseline:** `npm ci && npm test` on this branch passes 313 tests in 19 files, using the Workers runtime and a local D1.

---

## 1. Current-state architecture

### 1.1 Diagram

```
                      Google Sheet "Logic Engine_RTD"  (master for events today)
                      ├─ Event Index     one row per event; holds only its NEXT date
                      └─ Standard Diary  recurring groups; date only, no times
                            ▲   │
   writes to the sheet ─────┘   │ read every 15 min (full snapshot)
   (see 1.3)                    ▼
 ┌──────────────── n8n on the Pi ───────────────────────────────────────────────┐
 │ RTD Event Sync (15 min) ── assigns RTD-EVT ids (writes back by row_number) ──┐│
 │ RTD Master V1  00:00 Calendar Refresh → Google Calendar (delete+recreate 30d) ││
 │                01:00 Calculate next dates → overwrites Event Date in place    ││
 │                01:15 Event Guard → Status=Inactive (by row_number) → Date     ││
 │                      Change sub (Gmail form, 1 recipient, 30-day wait)        ││
 │                      → Poster Generator (Gemini → Drive)                      ││
 │                19:00–22:30 posts, weekly posts, IG (read the sheet directly)  ││
 │ RTD Host Sessions To Diary (15 min) A: email café · B: append approved rows · ││
 │                                     C: sheet fixes for cancelled dates        ││
 │ RTD Outbox (5 min) · RTD Team Notices (15 min) · RTD Host Follow-up (daily)   ││
 │ RTD Event Images (6 h) · RTD Event Reminders To Facebook (1 min)             ││
 └──────────────────────────────────────────────────────────────────────────────┘│
                                │ bearer token (INTERNAL_SYNC_TOKEN)             │
                                ▼                                                │
 ┌──────────── Cloudflare Worker rtd-app + D1 + KV ─────────────────────────────┐│
 │ /internal/sync/logic-engine → normalise → plan → one atomic batch            ◄┘
 │ D1: events · occurrences · bookings · outbox · sheet_fixes · audit_log · …    │
 │ Cron every minute: alert pushes, 8pm auto reminder, GotW, 03:23 retention     │
 │ /api/* public (60 s cache) · /api/host · /api/staff (Cloudflare Access)       │
 └───────────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
           PWA (service worker: network-first diary, offline fallback)
           Customers · Hosts (/organise) · Approvers/Admins (/organise)
```

### 1.2 Data-flow table

| # | System / flow | Read/write authority | Trigger | Identifier | Error mode |
| --- | --- | --- | --- | --- | --- |
| F1 | Logic Engine sheet (human edits) | **Master** for name, frequency, next date, times, Status, Base Details, App Visibility/Category/Price/Capacity | Ad hoc | Row; `Event ID` column (since 5 Oct) | No validation. Free text in date cells; duplicates possible |
| F2 | RTD Event Sync → `POST /internal/sync/logic-engine` | Sheet → D1 (events overwritten; occurrences derived) | Every 15 min | `Event ID`; occurrence = `RTD-OCC-<n>-<yyyymmdd>` | 3 HTTP retries, then Studio error handler. The app refuses (409) empty snapshots or ones that halve the event count. Duplicate IDs are skipped with a warning |
| F3 | Event Sync ID write-back | n8n → sheet (`Event ID`, `App Visibility`, `App Category`) | Same run | **row_number** | No re-check that the row is still the same one (G-6) |
| F4 | Master V1 "Calculate next dates" | n8n → sheet `Event Date` / `Date` | Daily 01:00 (instance timezone) | **row_number** | Weekly and fortnightly only; monthly is not rolled (decision of 5 Oct) |
| F5 | RTD Event Guard | n8n → sheet `Status = Inactive`; starts Date Change | Daily 01:15 | **Event Name** + row_number | Refuses everything if more than 3 rows expire in one night. One-offs and monthlies only; Event Index only |
| F6 | RTD Event Date Change (sub) | Gmail form → sheet `Event Date` + `Status = Active` | Per expiry | **Event Name** (refuses duplicates) | One recipient, hard-coded; 30-day wait; 3 attempts only for invalid dates; **no reminders**; "ignore this email if it isn't coming back" |
| F7 | Master V1 Calendar Refresh | Sheet → Google Calendar "Roll The Dice Cafe" | Daily 00:00 | None (delete and recreate 30 days) | **No Status or App Visibility filter** (G-12). If create fails after delete, the calendar is left empty |
| F8 | Master V1 posts, Guard posters | Read the sheet | 19:00–22:30, 01:15, weekly | Event Name | Private rows skipped (local edits, 5 Oct). They rely on the sheet being right about cancellations |
| F9 | RTD Host Sessions To Diary B | App → sheet (append row) | 15 min | `App Host Session` = `RTD-HS-…` / `RTD-MKT-…` | Idempotent (an existing row is only marked Live) |
| F10 | RTD Host Sessions To Diary C (`/internal/sheet-fixes`) | App → sheet `Status` / `Event Date` for cancelled dates | 15 min | **Event ID** | Event Index one-off, weekly and fortnightly only. Monthly and Standard Diary are left to the café |
| F11 | Public API `/api/events`, `/api/events/:id`, `/api/occurrences/:id`, `.ics`, Google link | D1 → public | Per request | occurrence_id, event_id | `Cache-Control: public, max-age=60` |
| F12 | Link previews `/`, `/event/:id`, `/events/:id` | D1 → HTML meta | Per request | Same | 60 s cache. Any status of occurrence gets a preview |
| F13 | Service worker | Caches `/api/events*`, `/api/occurrences/*` | Network-first | URL | **Offline fallback serves the last cached diary**, filtered only by client code |
| F14 | Bookings `/api/bookings` | Public → D1 | Per request | `RTD-BK-…` + token hash | Capacity checked in the insert |
| F15 | Cancel a date `/api/host/occurrences/:id/cancel` | Host (own) / approver / admin → D1 + outbox | Click | occurrence_id | 409 on repeat. Late bookers swept up |
| F16 | RTD Outbox | D1 → Gmail (`ATech GMAIL`) | 5 min | `message_id`, `dedupe_key` | Gmail failure: run stops with an error and retries every 5 min **forever**. "Mark sent" failure: possible **duplicate**. Unknown placeholder: **silently never sent** |
| F17 | Event alerts (anonymous push) | D1 → push services | Cron every minute | endpoint | Dropped after 5 failures; 404/410 deletes |
| F18 | Approver push | D1 → push services | On submit | endpoint + user | Same |
| F19 | Studio: Error Handler / Notify | n8n → email to Dan | On workflow error | execution | Cooldown-deduplicated |

### 1.3 Every writer and reader of event data

| Writer | Writes | Where |
| --- | --- | --- |
| Humans (café) | Every column | Logic Engine sheet |
| RTD Event Sync | Event ID / App Visibility / App Category for new or copied rows | Sheet (by row_number) |
| Master V1 roll-forward | Event Date (weekly/fortnightly), Date (Standard Diary weekly/bi-weekly/monthly at 28 days) | Sheet (by row_number) |
| Event Guard | Status → Inactive | Sheet (by row_number, chosen by Event Name) |
| Event Date Change | Event Date + Status → Active | Sheet (by row, found by Event Name) |
| Host Sessions To Diary | New rows (B), Status / Event Date for cancellations (C) | Sheet (append; by Event ID) |
| `applySync` | `events` (full overwrite of sheet-owned columns), `occurrences` (insert / status changes), `audit_log`, `sync_runs`, links `host_sessions` / `markets` | D1, `src/sync/apply.ts:163-283` |
| `cancelDate` | `occurrences.status = cancelled`, bookings cancelled, outbox | D1, `src/bookings/bookings.ts:458-507` |
| `setSessionPlaces` / `setDatePlaces` / event places | `events.capacity_override`, `occurrences.capacity` | D1, `src/bookings/places.ts` |
| Host session decision | `host_sessions` only (an event appears after n8n appends it to the sheet and the next sync) | D1, `src/host/sessions.ts:219` |

| Reader | Reads | Past-event exposure |
| --- | --- | --- |
| `/api/events` | `LISTED AND status='scheduled' AND event_date BETWEEN today AND to` (`src/routes/public.ts:38-47`) | **Ended earlier today: shown** |
| `/api/events/:id` | `VISIBLE AND status='scheduled' AND event_date >= today` (`src/routes/public.ts:65-72`) | **Ended earlier today: shown** |
| `/api/occurrences/:id` | Any status, if the event is visible (`src/routes/public.ts:86-92`, `src/lib/queries.ts:62`) | **Completed or past: shown in full** |
| `.ics` / Google Calendar link | `status='scheduled'` only (`src/routes/public.ts:95-112`) | Ended today but still `scheduled` until the first sync after midnight: **served** |
| Link previews | `findOccurrence` (any status), `nextOccurrence` by date (`src/routes/pages.ts:85-95`, `src/lib/queries.ts:72`) | Same as above |
| Home / Diary / Book / Splash (client) | `notOver()` (`web/src/lib/events.ts:21`) | Hides ended-today using `end_time ?? start_time`. Two bugs: G-14 |
| Admin reminders, 8pm auto reminder | `status='scheduled' AND event_date >= today` / tomorrow onwards (`src/notify/alerts.ts:201-245`) | An admin can push about an event that ended earlier today |
| Booking availability | `started()` uses `starts_at` (`src/bookings/bookings.ts:80`) | Correct: closes at start |
| Posters / social / Google Calendar | The sheet directly | Calendar includes Inactive rows with future dates (G-12) |
| Event images | `readImage` checks the event is visible | Not occurrence-specific; fine |

### 1.4 Time and timezone handling

- **Storage** (`src/lib/time.ts`):
  - London calendar dates (`event_date`) and London wall times (`start_time`, `end_time`), plus UTC instants (`starts_at`, `ends_at`).
  - `londonToUtc` is BST-aware. It is tested for BST, for GMT and for the day the clocks go back (`test/time.test.ts:42-46`).
- **Past-midnight end:** an end at or before the start rolls into the next day (`time.ts:125`). This matches Master V1's calendar code.
- **No end time:** the event is treated as **start + 1 hour** (`time.ts:123`). Master V1's calendar uses the same rule.
  - Live data has **0** timed occurrences without an end time.
  - The rule has no "flag for admin correction".
- **No start time:** the event is all day, and `starts_at` / `ends_at` are NULL.
  - All Standard Diary rows are all-day: the sheet has no time columns for them.
  - Live: 5 scheduled all-day occurrences, 11 more projected.
  - They are visible until London midnight. That is a reasonable end-of-day rule, but it is undocumented. Example: GirlsGetOut Ladies Night shows all day today, including after it has finished.
- **Completion:** `occurrences.status` becomes `completed` only in `planSync`, when `event_date < today` (`src/sync/plan.ts:240`). That happens at the first sync after London midnight. Live evidence: completions are logged at 23:00 UTC = 00:00 BST.
- **Not tested:**
  - a wall time inside the skipped spring-forward hour, or the repeated autumn hour;
  - a public query at "end + 1 second";
  - offline service-worker staleness.
- **n8n timezones:**
  - Event Sync and Outbox set `Europe/London`.
  - **Master V1 sets no timezone.** Its 00:00 calendar refresh, 01:00 roll-forward and 01:15 Guard follow the instance default.
  - "Calculate next dates" compares against server-local midnight.
  - The instance timezone wasn't visible to this audit (§8).

### 1.5 Where expired or cancelled events can leak

| Path | Leak today | Severity |
| --- | --- | --- |
| `/api/events`, `/api/events/:id` | Until London midnight after it ends (date filter) | P0 (G-1) |
| `/api/occurrences/:id` + `/event/:id` page | Indefinitely, with full details and a "finished" banner | P0 (G-1) |
| `.ics` / Google Calendar link | Ended today until the next sync after midnight | P0 (G-1) |
| HTTP cache (`public, max-age=60`) | Up to 60 s after the server would hide it. Applies to browsers and intermediaries (workers.dev has no zone cache rules) | P1 (needed to pass the "1 second" test) |
| Service worker | Offline: the last diary, however old. Client `notOver` filters by end time, with bugs (G-14) | P1 |
| Push links (alerts) | The link opens the event page. A reminder sent hours before still opens it after the event (deep link shows the finished state) | P2 |
| Google Calendar mirror | Inactive rows with future dates (live: BookClub 27 Oct, Writing Club 24 Oct), and private sessions by name. Whether the calendar is public **was not verified** | P1 (G-12) |
| Posters / social posts | Read the sheet. A cancellation in the app reaches the sheet only for Event Index one-off/weekly/fortnightly. **Monthly and Standard Diary cancellations stay advertised** until someone edits the sheet | P1 (G-13) |
| Search / widgets | No search index, sitemap or external widget found. `robots.txt` was not reviewed for event URLs | — |

### 1.6 Roles, permissions, guests, retention

- **Roles** (`users.role`):
  - `host`: plans sessions;
  - `staff`, shown in the app as "approver": approves sessions and join requests, cancels any date, sets café places;
  - `admin`: everything, plus approvers, reminders, markets, the game library and stats.
- **Sign-in:** Cloudflare Access email one-time PIN. The `users` table decides the role (`src/lib/auth.ts:73-86`).
- **"Admin approval" today** means approver or admin (`requireRole('staff')` admits both). The brief says "admin". [§7 D-9](#7-decisions-blocked-on-the-owner) asks whether approvers count.
- **Guests:** they book with no account. A Manage / Cancel link carries a 24-byte secret, and only its SHA-256 is stored. Guests can view or cancel until the start. One booking contact covers 1–10 places (`party_size`); there are no per-attendee records.
- **Retention:**
  - booking contact details: erased 12 months after the event;
  - IP hashes: 2 days;
  - sent outbox emails: deleted after 90 days.
  - The erasure runs daily at 03:23 UTC (`src/lib/privacy.ts:61`).
- **Email consent:** every email is transactional. No marketing list exists; event alerts are an opt-in push, not tied to bookings.

---

## 2. Schema inventory and migrations needed

### 2.1 Existing tables that touch events (all 16 migrations applied live)

| Table | Event-control columns today | Missing for the brief |
| --- | --- | --- |
| `events` | `event_id`, `source`, `frequency`, `repeatable`, `requires_redating` (derived, **unused**), `visibility`, `sheet_status`, `active`, `default_capacity`, `capacity_override`, `price_display`, `host_session_id`, `market_id`, `source_hash`, `last_synced_at`, `updated_at` | `booking_mode`, `revision`, `updated_by`, `origin`, `timezone`, the sheet's raw date when it is past or invalid, a sync base snapshot |
| `occurrences` | `occurrence_id` (immutable), `event_date`, times, `starts_at`, `ends_at`, `all_day`, `projected`, `status` (scheduled / completed / cancelled / rescheduled), `rescheduled_to`, `capacity`, `booking_enabled` (**unused, always 0**), `booking_deadline` (**unused**), `visibility`, overrides, `cancelled_at`, `cancelled_by` | `booking_mode` override, `cancellation_reason` (only on bookings today), `end_inferred` flag, `revision`, `updated_by`, `rescheduled_from` |
| `bookings` | `booking_id`, `occurrence_id`, contact, `party_size`, `status`, `cancelled_by`, `cancel_message`, `cancellation_token_hash`, `erased_at` | A link to a device for push (opt-in) |
| `outbox` | `dedupe_key` UNIQUE, `kind`, `to_email`, `subject`, `html`, `sent_at` | `status`, `attempts`, `last_error`, `next_attempt_at`, `channel`, `booking_id`, `occurrence_id` |
| `sheet_fixes` | `event_id` PK, `fix_key`, `sent_at` | Reusable as the outbound path for renewals (see §6) |
| `alert_subscriptions` / `push_subscriptions` | Anonymous devices / approver devices | No booking link |
| `host_sessions` | Proposal → decision → published | No "change request against a published session" |
| `audit_log` | Append-only, actor types system/n8n/staff/host/customer | Fine. Sheet edits are recorded as `n8n` + run id; the human sheet editor is unknown |
| `settings` | Key/value | Feature flags would live here |

### 2.2 Proposed additive migrations (Stage B, each needs approval)

These are all `ALTER TABLE … ADD COLUMN` or new tables. Nothing is renamed or dropped, and legacy columns are kept. Old code keeps working against the new schema, so each migration can be applied **before** the code that uses it. Migrations are applied by hand, separately from Workers Builds deploys (`docs/RTD_DEPLOYMENT.md:55`).

| Proposed file | Contents | Why |
| --- | --- | --- |
| `0017_event_control.sql` | **`events`:** `booking_mode TEXT CHECK (IN ('none','optional','required'))` (NULL = legacy behaviour until backfilled), `revision INTEGER NOT NULL DEFAULT 1`, `updated_by TEXT`, `origin TEXT`, `timezone TEXT NOT NULL DEFAULT 'Europe/London'`, `sheet_date_raw TEXT`, `sheet_date TEXT`. **`occurrences`:** `booking_mode TEXT` (override), `cancellation_reason TEXT`, `end_inferred INTEGER NOT NULL DEFAULT 0`, `rescheduled_from TEXT`, `revision INTEGER NOT NULL DEFAULT 1`, `updated_by TEXT`. Index `occurrences (status, ends_at)`. **Settings:** feature flags, all `off` | G-1, G-5, versioning |
| `0018_attention.sql` | `attention_items (item_id, kind CHECK (IN ('expired','no_date','sync_conflict','sync_error','notification_failure')), event_id, occurrence_id, status ('open','resolved'), opened_at, resolved_at, resolved_by, resolution ('renewed','archived','completed_no_renewal','dismissed'), resolution_note, new_occurrence_id, first_notified_at, last_reminded_at, reminder_count)` + **partial unique index** `(kind, COALESCE(occurrence_id, event_id)) WHERE status = 'open'` | G-2: exactly one open item per occurrence |
| `0019_delivery.sql` | **`outbox`:** `status` ('queued','sending','sent','failed','dead'; existing sent rows backfilled `sent`), `attempts`, `last_error`, `last_attempt_at`, `next_attempt_at`, `channel` DEFAULT 'email', `booking_id`, `occurrence_id`. New `push_outbox (dedupe_key UNIQUE, booking_id, occurrence_id, action, endpoint, status, attempts, last_error, created_at, sent_at)`. New `booking_devices (booking_id, endpoint, p256dh, auth, created_at, PRIMARY KEY (booking_id, endpoint))`, erased with the booking | G-3, G-4 |
| `0020_change_requests.sql` | `event_change_requests (request_id 'RTD-CR-…', event_id, occurrence_id, origin ('host','sheet','admin'), requested_by, base_revision, proposed JSON, published_snapshot JSON, status ('pending','approved','rejected','superseded','withdrawn'), decided_by, decided_at, decision_note, created_at)` | G-7 |
| `0021_sheet_sync.sql` | **`events`:** `sheet_base TEXT` (JSON of last-synced canonical sheet values), `sheet_hash TEXT`, `synced_revision INTEGER`, `last_inbound_at`, `last_outbound_at`. New `sheet_outbound (event_id, revision, fields JSON, status, attempts, next_attempt_at, last_error, created_at, done_at, UNIQUE (event_id, revision))`. New `sync_conflicts (conflict_id, event_id, field, base_value, sheet_value, app_value, status, resolution, merged_value, resolved_by, resolved_at, detected_at)`. New `sync_errors (run_id, event_id, row, code, detail, status, created_at)` | G-6 |

**No speculative replacements.** Event "series" are already modelled by `events`, and dated occurrences by `occurrences` with immutable IDs that are never re-dated. That already meets the brief's series/occurrence split (§2 of the brief). No new series table is proposed.

**State model.** I don't recommend a single overloaded status. Each of these is a separate field:
- **Temporal / lifecycle:** keep `occurrences.status`. Add a derived "ended" check at read time.
- **Publication:** `events.active` (sheet Status) plus `visibility`. Archive = Inactive + an archived resolution.
- **Approval:** `host_sessions.status` and `event_change_requests.status`.
- **Needs attention:** an open `attention_items` row, not a status value.

The public visibility rule becomes:

```
e.active = 1
AND COALESCE(o.visibility, e.visibility) IN ('public','app_bookable')
AND o.status = 'scheduled'                      -- excludes cancelled, rescheduled, completed
AND CASE WHEN o.ends_at IS NOT NULL THEN o.ends_at > :now_utc
         ELSE o.event_date >= :today_london END   -- all-day: visible to London midnight
-- approval: only approved host sessions ever reach `events`; pending changes live in event_change_requests
```

---

## 3. Gap analysis

Severity: **P0** is a non-negotiable requirement broken now, or broken on first use. **P1** is required before app-first editing or production cutover. **P2** is hardening.

| ID | Req | Sev | Finding | Evidence | Impact | Remediation |
| --- | --- | --- | --- | --- | --- | --- |
| G-1 | 1 | **P0** | Public filters use `event_date >= today`, not `ends_at > now`. Deep links return completed and past occurrences in full. `.ics` / Google links are served while the status is still `scheduled`, which lasts until the first sync after midnight. | `src/routes/public.ts:38-47, 65-72, 86-112`; `src/lib/queries.ts:62-83`; `src/routes/pages.ts:85-95` | Today's finished events stay public until midnight. Old links keep showing a finished event in full | Use the end-time predicate (§2.2) in every public query. Deep link to a finished or cancelled occurrence: minimal stub (`410`, name + "finished", link to the event's next date), with no description, image or price ([D-2](#7-decisions-blocked-on-the-owner)). Previews get generic meta |
| G-1a | 1 | P1 | `Cache-Control: public, max-age=60` on lists; the service worker's offline fallback serves stale lists | `src/routes/public.ts:19`; `src/routes/pages.ts:77`; `web/public/sw.js:27-41` | Up to 60 s stale online; unbounded offline | `max-age = min(60, seconds until the earliest ends_at in the response)`. Client filter on `ends_at` (UTC), applied to cached responses too |
| G-2 | 2, 3 | **P0** | No expiry or Needs Attention in the app. Expiry lives in the n8n Guard: Event Name identity, Event Index only, one-offs/monthlies only, refuses all if >3 in a night. One email to one hard-coded personal address; no reminders; no resolution tracking ("ignore if not coming back"). **Bingo** expired 10 Oct 00:15 UTC; the Date Change log shows `NO_RESPONSE` at 06:53 UTC the same day (the execution data is pruned, so the cause is unknown); 6 days unresolved, with no alert to info@ or Dan | n8n `RTD Event Guard (sub)` CONFIG; `RTD Event Date Change (sub)`; "RTD Event Automation Log" rows 441/465; D1 `RTD-EVT-00002` inactive, last occurrence 2026-10-09 | Expired events vanish silently; renewals are missed | `attention_items`, an hourly idempotent detector, admin Needs Attention with renew / archive / mark completed, an initial notice plus a daily digest to **both** required recipients (§5). Retire the Guard's date-picker once live ([D-4](#7-decisions-blocked-on-the-owner)) |
| G-2a | 2 | P1 | Active events with **no usable date** are invisible publicly and appear nowhere in admin. Live: Dungeons & Dragons, Magic: The Gathering (blank), Cleeples, Wednesdays (free text), DM Alfie, MoreThanABitDicey, Brownies & Guides (Standard Diary, never had a current or future date since the first sync: blank or past in the sheet) | D1 query, §0; sync warnings | Events quietly missing from the diary | `no_date` attention items. Store the sheet's raw date on `events` |
| G-3 | 4 | **P0** | Cancellation: email per booking (`date-cancelled:<occ>:<booking>`, idempotent), **no push**. No booking↔device link exists. The outbox has no failure state; n8n stops the run on a Gmail error and retries forever; a lost "mark sent" call causes a duplicate send | `src/bookings/bookings.ts:458-507`; `migrations/0014_event_alerts.sql`; `src/notify/outbox.ts:12-62`; n8n `RTD Outbox` | Bookers with push aren't pushed; failures are invisible in admin; delivery can't be evidenced | Opt-in `booking_devices` at booking; `push_outbox` + email outbox with status / attempts / dead letter; `/internal/outbox/:id/failed`; an admin failures view (§5) |
| G-4 | 4, B6 | **P0** (latent: 0 bookings) | When the sheet moves a booked date, the occurrence becomes `rescheduled`; only the café gets an `orphaned:` email; bookers aren't told, their booking stays `confirmed`, and their manage page shows "closed" | `src/sync/plan.ts:249`; `src/bookings/bookings.ts:531-570` | Customers turn up on the wrong day | Hold: show the moved booked occurrence in Needs Attention; admin chooses "notify bookers of the new date" (preserve the original, never move bookings automatically) or "cancel bookings". Both go through the outbox |
| G-5 | 5 | P1 (urgent per the current-state doc) | No booking mode. `bookable` = public and not a market (+ host size set). Standard Diary groups (live: National Coastguard Institute, GirlsGetOut Ladies Night, DM Olivia…) are bookable. `occurrences.booking_enabled` / `booking_deadline` exist but are unused | `src/lib/queries.ts:26-27`; `src/bookings/bookings.ts:105-116` | Misleading "Book" buttons; no way to say "booking required" | `booking_mode` on the event + an occurrence override; UI labels Not required / Optional / Required; server validation; impact warning when changing mode with bookings; backfill defaults ([D-6](#7-decisions-blocked-on-the-owner)) |
| G-6 | 7 | P1 | One-way sheet→app full overwrite every 15 min; no base snapshot, revision or conflict record. App→sheet writes are narrow (IDs, appended host rows, cancellation fixes). ID write-back and Guard / roll-forward writes match on `row_number`; sorting or inserting rows between read and write can hit the wrong row | `src/sync/apply.ts:176-186`; n8n `RTD Event Sync` "Write … IDs" (matching `row_number`); Guard "Set Status Inactive" | Not two-way; possible wrong-row writes; no concurrent-edit detection | Three-way merge with `sheet_base`, `sync_conflicts`, `sheet_outbound` by Event ID, echo suppression, a reconciliation scan (§4). Re-verify Event Name before any row_number write |
| G-7 | 6 | P1 | Hosts can't edit a live session (only withdraw before approval, or resubmit after a decline). They **can** change places on live dates and cancel their own dates **immediately, without approval**. A sheet editor can change any host session's public fields with no approval | `src/host/sessions.ts:160-165`; `src/routes/host.ts:73-98`; `src/bookings/places.ts:73-140` | Brief requires admin approval for host public changes | `event_change_requests` with a side-by-side diff, approve / reject / revise, the published version preserved. Decide whether host cancellation stays immediate ([D-7](#7-decisions-blocked-on-the-owner)) |
| G-8 | 8 | P1 | n8n retains **one** version per workflow. Documented rollback IDs (e.g. Guard `fe0eeae3…`, Host Sessions To Diary `c0738021…` / `c5b53881…`) are gone. `rtd-poster-automation` (Guard / Date Change / Poster source) is still not in Git | n8n history for Master V1, Guard, Event Sync: 1 version each; `docs/RTD_RECOVERY.md:25-26` | Rollback plans in the docs can't be executed | Export workflow JSON before every change to **private** storage; correct the recovery docs |
| G-9 | 3 | P1 | No daily reminder mechanism exists anywhere. The Guard's recipient address is hard-coded in generated code (a Phase 0 finding, still open) | Guard / Date Change CONFIG | — | Recipients come from config (D1 settings set live, or `rtd_config`), never from code |
| G-10 | 1 | P1 | No time-precise "end" for Standard Diary (no time columns), and no admin flag for inferred ends | `src/sync/normalise.ts:134-135` | All-day rows visible to midnight; no way to correct | Document the all-day rule; `end_inferred`; admin "missing time" list; optional Standard Diary time columns ([D-1](#7-decisions-blocked-on-the-owner)) |
| G-11 | 8 | P1 | **No staging environment.** One D1 database (prod); Workers Builds deploys `main` on every push; n8n workflows point at prod; outbound Gmail is live | `wrangler.jsonc`; `RTD_APP_CURRENT_STATE.md` | Can't rehearse migrations or sync safely | Staging Worker + D1 + KV, a sheet copy, n8n staging copies with Gmail and push disabled ([D-12](#7-decisions-blocked-on-the-owner)) |
| G-12 | 1, B7 | P1 | The Google Calendar mirror ("Roll The Dice Cafe") filters only on name + date: Inactive rows with future dates and private sessions (by name) are published there | Master V1 `Filter Valid Rows` → `Create Calendar Event` | Leak, if the calendar is public (not verified) | Filter on `Status = Active` and visibility in Master V1, or feed the calendar from the app later ([D-14](#7-decisions-blocked-on-the-owner)) |
| G-13 | B7 | P1 | Cancelled monthly or Standard Diary dates aren't written back to the sheet, so posts and posters may still advertise them | `src/bookings/bookings.ts:446-452, 581-622` | Advertising a cancelled event | Extend sheet fixes (monthly: Status Inactive + an attention item to renew; Standard Diary: move to the next date or flag) |
| G-14 | 1 | P2 | Client `notOver()`: an end past midnight (e.g. 19:00–01:00) is hidden from 01:00 **on the start day** ("01:00" < now); with no end time, it is hidden at the **start** time | `web/src/lib/events.ts:21-25` | Hides running events early (not a leak) | Compare `ends_at` (UTC) with `Date.now()` |
| G-15 | 1 | P2 | DST edge cases untested (skipped / repeated hour); Master V1 has no workflow timezone | `test/time.test.ts`; Master V1 settings | Small risk at the two changeovers | Add tests; set `Europe/London` on Master V1 (needs approval and an export) |
| G-16 | 2 | P2 | `RTD Outbox` silently ignores any recipient placeholder it doesn't know (`to` starting with `@` is filtered out and never marked) | n8n `RTD Outbox` "Split Emails" | A new placeholder would never send | Deploy order: n8n learns any placeholder first. Or queue literal addresses |
| G-17 | DP | P1 | **Public repo** docs contain Google file IDs (sheet backups, Market Vendors sheet), a personal email address, n8n host and workflow IDs, and infrastructure IDs | `docs/RTD_N8N_WORKFLOWS.md`, `docs/RTD_AUDIT.md`, `docs/RTD_RECOVERY.md` | Data-protection and reconnaissance exposure; conflicts with the brief | Make the repo private, or move identifiers to private docs. Removing them from history needs a rewrite ([D-16](#7-decisions-blocked-on-the-owner)) |
| G-18 | — | P2 | Doc drift: `RTD_APP_CURRENT_STATE.md` says the game library is off; D1 `game_library_live = on` since 2026-10-16 05:28 UTC (audit `games.library_live`) | D1 settings / audit_log | Regression baselines must use the live state | Update the state doc in Stage B |

---

## 4. Sheet ↔ App conflicts and resolution rules

### 4.1 Constraints that shape the design

- **The sheet is per event, the app is per occurrence.** A sheet row holds an event's *next* date only, so the sheet can express "next date / times / status" but not "the third Thursday is cancelled". Occurrence-level changes beyond the next date (cancellations, capacity, booking mode overrides) stay **app-only**. Only their effect on the next date is written back, as `sheet_fixes` does today.
- **Automated sheet writers are not human editors.** Roll-forward (01:00), Guard (01:15), Date Change, ID write-back and the host-row append all write to the sheet. Inbound sync must recognise the *expected* automated changes, so they never raise false conflicts. Example: a roll-forward date that equals the app's projection.
- **Downstream consumers read the sheet.** Posts, posters and the calendar do, so the sheet must be kept correct after any app edit. Outbound sync isn't optional once the app is the place where edits happen.

### 4.2 Proposed mechanism

| Element | Rule |
| --- | --- |
| Identity | Event ID only (never Event Name or row number). Rows without a valid ID are set aside as sync errors. Duplicate IDs are refused (already done) |
| Field map | Explicit list of synced columns: Event Name, Frequency, Event Date / Date, Event Time, End Time, Status, Base Details, App Visibility, App Category, App Price, App Capacity. Every other column (prompts, post log, formulas) is never written |
| Canonical form | Dates `DD/MM/YYYY`, times `HH:MM`, trimmed text, visibility and category as the canonical words. Hashes are computed on canonical values, so `6:30 PM` and `18:30` are equal |
| Base | `events.sheet_base` = the canonical values both sides last agreed on |
| Inbound (each snapshot) | Per field: if sheet = base, the sheet hasn't changed. If sheet ≠ base and app = base, it's an **inbound change**: apply it, or queue it as a change request if the event is host-owned ([D-10](#7-decisions-blocked-on-the-owner)). If sheet ≠ base and app ≠ base: **equal** values mean both edited to the same thing (adopt it as the base); **different** values mean a **conflict** |
| Outbound | An admin edit bumps `events.revision` and enqueues `sheet_outbound (event_id, revision, fields)`. n8n writes **by Event ID**, RAW, only the mapped cells, then calls `done` |
| Echo prevention | When the next inbound sync sees the sheet equal to the app's pending outbound values, it marks that revision synced and moves the base. Nothing is re-applied. An optional hidden `App Sync Rev` column makes this explicit |
| Conflict | One `sync_conflicts` row per field. **Neither side is overwritten:** the app keeps its published value, and the sheet is left as edited. Admin chooses accept app (queue outbound), accept sheet (apply inbound) or manual merge |
| Malformed | Bad date, unknown status, invalid capacity or visibility: a `sync_errors` row; the published data is untouched (today these become warnings, with fallbacks to Hidden/Other) |
| Outage recovery | Outbound: exponential backoff (5 m, 15 m, 1 h, 4 h, 12 h), then `dead` and an attention item. Nightly reconciliation compares every mapped field and reports drift; it never auto-fixes |
| Cancellation from the sheet | Status → Inactive on a row with **booked** future occurrences isn't applied silently. It opens a "cancel booked date?" attention item. Accepting it runs the same `cancelDate` flow (public suppression, outbox per booking) |

### 4.3 Conflict examples

| # | Scenario | Today | Proposed |
| --- | --- | --- | --- |
| C1 | Michelle changes Quiz's End Time in the sheet; nobody touched it in the app | Applied at the next sync | Same, plus the base moves |
| C2 | Admin edits Quiz's description in the app; Michelle edits Base Details in the sheet before outbound runs | (No app edit exists today) | Conflict on `description`; both kept; admin picks |
| C3 | Admin edits the app title; the sheet changes only End Time | — | Non-overlapping fields: both applied (merge) |
| C4 | Roll-forward moves Kids Chess Club from 15/10 to 22/10 at 01:00 | New occurrence; the old one is already completed | Expected automated change (matches the projection): no conflict |
| C5 | Sheet Event Date for a booked weekly date is moved by hand | Old occurrence → `rescheduled`; café email only | G-4 hold: attention item, admin notifies bookers or cancels |
| C6 | A host session row's Base Details are edited in the sheet | Overwrites public text | `event_change_requests` (origin `sheet`), if the owner wants sheet edits to host sessions approved ([D-10](#7-decisions-blocked-on-the-owner)) |
| C7 | A row is copied in the sheet (duplicate Event ID) | First row keeps the ID; the copy gets a new one at the next sync | Same, plus a `sync_errors` entry for the admin to confirm it's a new event |
| C8 | The sheet is sorted between the Event Sync read and the ID write-back | ID may land on the wrong row (row_number) | Re-read and verify Event Name before writing; otherwise skip and retry |
| C9 | Status set Inactive in the sheet on an event with bookings | Event hidden; bookings orphaned silently | Attention item "cancel booked dates?" → cancellation flow |

---

## 5. Notification delivery design

### 5.1 Expiry and renewal (P0)

- **Definition of expired:** an occurrence of a listed, active event whose effective end has passed, **and** which is not followed by a later scheduled occurrence of the same event. This covers one-offs, Event Index monthlies, and any series that has gone dark. Weekly occurrences that roll forward don't create items. A projected occurrence is never an item.
- **Detector:** the Worker's existing every-minute cron, gated to run hourly at :10. It is idempotent: it inserts into `attention_items` under the partial unique index and does nothing if an item is already open.
- **Recipients:** both addresses required by the brief: the café's info@ and Dan's. They're stored in live config (a D1 `settings` row set in the database, or `rtd_config`), **never in the public repo**. Each recipient gets its **own** outbox row, so per-recipient delivery is tracked.
- **Emails:**
  - **Initial notice:** one per detector run that found new items, listing every new item with its event name, past date and time, and admin links (Confirm new date · Archive · Mark completed). `dedupe_key = expiry-new:<item_id>:<recipient-key>`, so an item is announced once per recipient however often the job reruns.
  - **Daily digest at 09:00 London:** every open item, with its age, when it was last reminded, and action links. `dedupe_key = expiry-digest:<YYYY-MM-DD>:<recipient-key>`: **at most one per address per day**. It is skipped when no items are open. Each listed item's `last_reminded_at` and `reminder_count` are updated in the same batch.
- **Resolution:** only an explicit admin action resolves an item. Opening the email does not. The actions are:
  - **renewed:** creates the new date. For Event Index rows this reuses the existing sheet-fix path (Status Active, Event Date new; matched on Event ID), so the sheet, posters and calendar follow. A new occurrence is created; the old one keeps its identity and bookings.
  - **archived:** the series is retired (Status Inactive).
  - **completed with no renewal:** for one-offs. This **suppresses future prompts** for that event.

  Every resolution is written to `audit_log`.
- **Volume estimate:** from the live sheet, about 4 monthly and 2–4 one-off events a month, plus host one-offs. That gives roughly **5–10 new items a month**. Worst case is about 2 initial notices + 2 digests = **4 emails a day**; typical is 2 a day while anything is open, and 0 otherwise. That's well inside Gmail limits.
- **Backlog at enable time:** about 8 `no_date` events plus Bingo, in one digest. Long-inactive history (BritQuiz, MicNight, …) is **not** imported ([D-5](#7-decisions-blocked-on-the-owner)).
- **Flood guards:**
  - the unique open-item index;
  - per-day digest dedupe keys;
  - a cap of **50 new items per detector run**. More than that alerts Dan once and holds the rest: it's treated as a parsing fault, mirroring the Guard's circuit breaker.
  - The feature flag `expiry_emails` starts off.

### 5.2 Cancellation and reschedule (P0)

- **Atomic in intent.** One D1 batch, which extends today's `cancelDate`:
  - status → `cancelled` (immediate public suppression via the predicate);
  - store the `cancellation_reason`;
  - snapshot the confirmed bookings and cancel them;
  - enqueue **one email per booking contact**: `date-cancelled:<occ>:<booking>` (existing key);
  - enqueue **one push per (booking, device)**: `push:date-cancelled:<occ>:<booking>:<endpoint-hash>`, only where `booking_devices` holds an opted-in device;
  - enqueue the café or host notice;
  - write the audit row.

  A repeat click returns 409 and enqueues nothing. Late bookers are swept up, as today.
- **Push eligibility.** At booking, if the browser already has notification permission, or the customer ticks "notify this device about changes to this booking", the client sends its subscription and a `booking_devices` row is stored. Push is never required to book. An invalid push (404/410) marks that device invalid and **doesn't affect email**.
- **Content:** event name, original date and time, the cancellation or new date, the café contact and booking reference. Nothing about other attendees. Push bodies carry the event name, date and "Cancelled" only.
- **Reschedule:** preserve the original occurrence (`rescheduled_to`, `rescheduled_from`). Booked contacts are notified only through an admin decision (G-4). Bookings are **never moved** to a different occurrence.
- **Zero bookings:** no attendee messages; the café or host notice only.

### 5.3 Delivery states, retries and evidence

| State | Meaning |
| --- | --- |
| `queued` | Written in the same batch as the change |
| `sending` | Claimed by a worker (claim timestamp; reclaimed after 5 min) |
| `sent` | **Provider accepted:** Gmail returned a message ID, or the push service returned 2xx. This isn't "delivered": Gmail via n8n gives no delivery or bounce receipts ([D-11](#7-decisions-blocked-on-the-owner)) |
| `failed` | An attempt failed: retry at 5 m, 15 m, 1 h, 4 h, 12 h |
| `dead` | 5 failed attempts, or a permanent error (invalid address; push 404/410). Opens a `notification_failure` attention item |

**Duplicate guards:**
- unique dedupe keys;
- idempotent `sent` / `failed` endpoints;
- n8n calls `/failed` instead of stopping the whole run, so one bad address doesn't hold up the queue.

**Residual risk:** Gmail succeeds but the "mark sent" call is lost, and the email is sent again. Mitigation: a short `sending` claim. A provider idempotency key would need a transactional email provider (D-11).

### 5.4 GDPR / PECR

- **Lawful basis:** cancellation, reschedule and expiry emails are transactional (contract or legitimate interest). They need no marketing consent, and they never carry promotion.
- **Booking-device push:** opt-in, scoped to that booking, and erased with it under the 12-month retention.
- **Anonymous event-alert subscriptions:** stay separate. They are opt-in marketing-style pushes and are never used for booking notices.
- **Privacy notice:** `/privacy` needs a sentence about booking push.

---

## 6. Staged change plan

Each stage ends with: changed files, migrations, test results, deployment status, open issues, rollback steps and owner actions. Nothing is claimed as working without runtime evidence.

**Before any production change, at every stage:**
1. Take a D1 Time Travel bookmark (`wrangler d1 time-travel info rtd-app`). The free plan keeps 7 days.
2. Run `wrangler d1 export rtd-app --remote` to **private** storage.
3. Export the n8n workflow JSON to private storage. History keeps only one version (G-8).
4. Take a Drive copy of the sheet if columns change.

| Stage | Scope | Depends on | Migration safety | Tests | Downtime risk | Rollback checkpoint |
| --- | --- | --- | --- | --- | --- | --- |
| **2. Staging groundwork** | Staging Worker `rtd-app-staging`, D1, KV; a copy of the Logic Engine; n8n staging copies of Event Sync and Outbox with Gmail and push disabled (pinned data); a backup-and-restore rehearsal into staging; feature-flag plumbing; private env doc for IDs | Owner approval (D-12); Cloudflare and Google access | Nothing on prod | Restore rehearsal: row counts match prod | None | Delete the staging resources |
| **3a. P0 visibility** (code only) | End-time predicate in every public query; `.ics` / Google links; previews; the admin reminder picker; deep-link stub for finished or cancelled; cache clamp; client `ends_at` filter, including SW cached responses; `notOver` fixes | D-1, D-2 | No schema | New: "ended 1 s ago excluded" across `/api/events`, `/api/events/:id`, `/api/occurrences/:id`, `.ics`, Google, previews; UTC/BST, midnight, both DST days, past-midnight end, all-day; cache header ≤ seconds-to-end; SW fixture. Plus the 313 existing tests | None | `wrangler rollback` to the previous Worker version |
| **3b. Needs Attention** | `0017` + `0018`; hourly detector; admin Needs Attention (renew / archive / complete); renewal through `sheet_fixes`; `no_date` items | 3a; D-4, D-5 | Additive; apply before the deploy; flags off | Exactly one open item per occurrence over N reruns; resolution stops prompts; renewal creates a new occurrence and keeps the old bookings | None | Flags off; tables stay (additive); Time Travel if needed |
| **3c. Expiry emails** | Initial plus daily digest to both recipients; recipients from live config; Guard date-picker retired in a coordinated n8n change | 3b; D-3, D-4; the n8n export | Additive | Both recipients on the initial notice; one digest per address per day; stops after resolution; reruns and retries don't multiply | None | Flag `expiry_emails` off; re-import the Guard export |
| **4. Booking and communications** | `0019`; `booking_mode` + UI + validation + backfill; opt-in booking push; push outbox drained by cron (sharing the subrequest budget with alerts); outbox states + `/failed`; n8n Outbox calls `/failed`; failures view; G-4 hold for moved booked dates; G-13 sheet fixes | 3b; D-6, D-7, D-11 | Additive; existing bookings untouched (0 today); mode change with bookings needs confirmation | Modes render and validate; capacity and party size; old bookings survive; cancel with bookings: email + eligible push per contact, no duplicates after retries, invalid push doesn't block email; zero bookings → no attendee messages | None | Flags off; `wrangler rollback`; re-import the Outbox export (app first accepts `/failed`, harmless to old n8n) |
| **5. App-first editing + host approvals** | `0020`; admin editor (create / edit / duplicate / publish / unpublish / reschedule / cancel / archive) for **app-owned** fields; host change requests with a side-by-side diff; approve / reject / revise; published version preserved | 4; D-7, D-9, D-10 | Additive | Host edit doesn't change public content until approved; reject with reason; audit rows | None | Flags off |
| **6. Two-way Sheets sync** | `0021`; canonical normalisation; three-way merge; conflicts and errors queues; outbound writer (new n8n "RTD Sheet Writer", by Event ID, mapped cells only, RAW); echo suppression; nightly reconciliation; row_number write verification; sheet-owned fields become editable in the admin editor | 5; staging sheet copy; D-10, D-13 | Additive; outbound starts on staging, then read-only "shadow" on prod (compute conflicts, write nothing) for ≥ 1 week, then enable | Uncontested sheet edit applies; app edit reaches the sheet; concurrent edits → conflict with neither overwritten; recovery after a simulated n8n/Google outage; no echo loop; no duplicate events | None | Disable the Sheet Writer workflow; flag off; shadow data is harmless |
| **7. Enhancements** | Waitlist, check-in, recurrence templates, per-edit rollback, health panel (last sync, backlog, failures), pre-event reminders, impact preview, accessibility pass | 6 | Additive | Per feature | None | Per-feature flags |
| **8. Production cutover** | Reconcile counts and IDs (D1 ↔ sheet); confirm the rollback point; owner sign-off; progressive enable; defined observation period | All | — | Reconciliation report = 0 drift | None planned | Time Travel bookmark + Worker rollback + n8n exports |

**Regression scope, every stage:**
- the game chooser and library (live since today), Game of the Week, bookings, the host organiser, onboarding, markets, alerts and stats;
- the public PWA and its install and update flow;
- link previews, the poster and Guard paths, the Master V1 posts, the calendar refresh.

The existing suite covers most app paths. n8n paths need dry runs (the Guard has a dry-run trigger) and pinned-data simulations.

---

## 7. Decisions blocked on the owner

**2026-10-16: the owner approved the staged plan and every recommendation below** ("Approved, go with your recommendations"). Owner follow-ups: **D-15: Bingo archived** (2026-10-16). It stays Inactive in the Logic Engine, as it already was, so it's hidden everywhere and gets no posts or posters; Stage 3b records it as resolved (archived) rather than prompting for it. **D-16:** the owner is making the repository private.

| # | Decision | Recommendation |
| --- | --- | --- |
| D-1 | Unknown end time rule | Keep **start + 1 h** (matches the calendar mirror). Mark `end_inferred` and list those rows in admin. All-day = visible until London midnight. Live: 0 timed rows lack an end; all Standard Diary rows are all-day |
| D-2 | Deep link to a finished occurrence | Minimal "This event has finished" stub with a link to the next date; no details. Alternative: 404 |
| D-3 | Expiry recipients | Both addresses from the brief, held in live config. Confirm whether Michelle should also get them, and from which address |
| D-4 | Event Guard after app expiry is live | Stop its date-picker email and keep posters. Later, stop its Inactive flip (the app handles visibility). Needs `rtd-poster-automation` in Git, or a documented local edit. **Done 2026-10-16 (date-picker email stopped; local edit, see [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#2026-10-16-the-event-guard-no-longer-emails-the-date-picker)).** |
| D-5 | Backlog at enable | Import Bingo + active events with no usable date (about 9). Exclude long-inactive history |
| D-6 | Booking mode defaults | Event Index café events: **Optional**. Standard Diary groups: **Not required**. Open host sessions (capacity set): **Required**. Markets: **Not required** |
| D-7 | Host self-service | Keep **host cancellation immediate** (a host who can't run it can't be made to), with admin notification. Place increases: immediate. Text / time / date changes: approval |
| D-8 | Digest time | 09:00 London |
| D-9 | Does "admin approval" include approvers (Michelle)? | Yes: approvers + admins, as today. Expiry emails go to the two fixed addresses regardless |
| D-10 | Sheet edits to host-owned events | Treat sheet editors as admins (no approval queue), but log a change request for audit. Alternative: route them through approval |
| D-11 | Transactional email provider (Phase 0 item 11, still open) | Keep Gmail via n8n for now (state `sent` = accepted, never "delivered"). Consider Resend or Postmark for bounce webhooks and idempotency before cutover |
| D-12 | Staging | Approve creating staging Cloudflare resources and a sheet copy. Who owns the copy? |
| D-13 | Outbound writes to the Logic Engine | Approve a new n8n writer limited to mapped columns, by Event ID |
| D-14 | Google Calendar "Roll The Dice Cafe" | Is it public? If so, approve the Status / visibility filter in Master V1 |
| D-15 | Bingo (expired 9 Oct, unresolved) | Renew with a date, or archive. Separately: why did the date-picker close as `NO_RESPONSE` within hours? (Possibly a mail scanner opening the form link; execution data is pruned) |
| D-16 | Public repo with identifiers | Make the repo private (simplest), or scrub the docs going forward. A history rewrite needs explicit approval |
| D-17 | Cloudflare plan | Confirm the plan tier (Time Travel 7 vs 30 days; cron and subrequest limits for push batches) |

---

## 8. Not inspected (the audit is incomplete here)

- **The Google Sheet itself:** formulas, protected ranges, sharing, edit history and tab list were **not opened**. No Sheets connector was used. Its structure comes from n8n node configuration, the Event Sync payload and Guard log rows.
- **Google Calendar sharing and visibility**, and Drive folder sharing.
- **Gmail sent and bounce history** for the ATech account, and Gmail sending limits on that account type.
- **n8n instance settings:** `GENERIC_TIMEZONE`, execution pruning, editor exposure, and the Studio error-handler and notify workflows (not re-read).
- **n8n workflows read from repo docs only, not node by node:** RTD Host Sessions To Diary, Team Notices, Host Follow-up, Event Images, Event Reminders To Facebook, Market Vendors To Sheet, Poster Generator.
- **Execution 32123** (Bingo's date-change run): pruned, so the cause of the early `NO_RESPONSE` is unknown.
- **`rtd-poster-automation`** (source of the Guard, Date Change and Poster code): not in any repo available to this session.
- **Cloudflare:** Access policy configuration, Workers Builds settings, account plan, and whether any cache rules apply (workers.dev).
- **Real-device push and offline behaviour:** not exercised. A push or email test send would break the read-only rule.

## Appendix A. Live evidence queries (read-only)

- **D1, row counts:** `SELECT (SELECT COUNT(*) FROM events) …` → 32 events, 56 occurrences, 0 bookings, 0 outbox rows.
- **D1, occurrence shape:** `SELECT status, projected, all_day, … FROM occurrences GROUP BY …` → 12 completed (10-05…10-15), 1 rescheduled (11-04), 43 scheduled (10-16…11-26).
- **D1, sync history:** `SELECT status, COUNT(*) FROM sync_runs GROUP BY status` → 1,024 `ok`, 0 rejected.
- **D1, audit:** `SELECT action, actor_type, COUNT(*) FROM audit_log GROUP BY …`. `occurrence.completed` runs at 23:00 UTC (London midnight). No `occurrence.cancelled` ever.
- **n8n, "RTD Event Automation Log":** filtered on `stage = DATE_CHANGE` or `EXPIRY_ACTION = DEACTIVATED` → 2 rows, both Bingo (`DEACTIVATED` 10-10 00:15 UTC; `NO_RESPONSE` 10-10 06:53 UTC).
- **n8n, version history:** Master V1, Event Guard and Event Sync each return 1 version.
