# RTD Database Schema

D1 (SQLite). Source of truth: [`migrations/`](../migrations). Times are ISO-8601 UTC strings. Dates are London calendar dates (`YYYY-MM-DD`), and clock times are London wall time (`HH:MM`).

## events

One row per permanent event identity, synced from the Logic Engine.

| Column | Notes |
| --- | --- |
| `event_id` PK | `RTD-EVT-00001`, from the sheet's `Event ID` column |
| `source` | `event_index`, `standard_diary` or `app` (host-created, Phase 6) |
| `source_row` | Sheet row number at last sync (informational only, never used as identity) |
| `event_name` / `display_name` | Raw sheet name / public name (trailing weekday initial removed, e.g. "ClubM" → "Club") |
| `category` | Gaming, Quiz, Social, Club, Tournament, Market, Workshop, Other (sheet `App Category`) |
| `description` | Sheet `Base Details` (Event Index) or `Notes` (Standard Diary) |
| `frequency` | `weekly`, `fortnightly`, `monthly`, `one-off` |
| `repeatable`, `requires_redating` | Derived. Event Index one-offs and monthlies need a new date by hand |
| `visibility` | `public`, `app_bookable`, `private`, `hidden` (sheet `App Visibility`; blank or unknown = hidden) |
| `sheet_status`, `active` | Raw Status. `active` = Status is exactly "Active" (Standard Diary: always active) |
| `default_image`, `default_capacity`, `default_host_id` | App-owned, later phases |
| `photo_folder_id` | Drive folder used by the poster generator |
| `source_hash`, `last_synced_at` | Change detection |

## occurrences

One row per dated occurrence. **Never re-dated, never deleted.** `UNIQUE (event_id, event_date)`.

| Column | Notes |
| --- | --- |
| `occurrence_id` PK | `RTD-OCC-00001-20261023` (event number + date) |
| `event_date`, `start_time`, `end_time`, `all_day` | London date and times; no start time = all day |
| `starts_at`, `ends_at` | UTC instants (BST-aware); ends after midnight roll to the next day |
| `projected` | 1 = generated from a weekly/fortnightly cadence, not yet the sheet's date |
| `status` | `scheduled`, `completed`, `cancelled`, `rescheduled` |
| `rescheduled_to` | The replacement occurrence, or null while a new date is awaited |
| `host_id`, `capacity`, `booking_enabled`, `booking_deadline`, `visibility`, `price_display`, `image_override`, `description_override` | App-owned overrides, Phases 5–8 |
| `approved_at`, `completed_at`, `cancelled_at` | Lifecycle timestamps |

## audit_log (append-only)

`audit_id, entity_type, entity_id, occurrence_id, actor_type (system|n8n|staff|host|customer), actor_id, action, previous_value (JSON), new_value (JSON), source, created_at`.

Triggers abort any `UPDATE` or `DELETE`. Actions so far:
- `event.created`, `event.updated`, `event.activated`, `event.deactivated`, `event.missing_from_source`
- `occurrence.created`, `occurrence.time_changed`, `occurrence.completed`, `occurrence.rescheduled`, `occurrence.reinstated`

## sync_runs

One row per sync attempt: `run_id` (idempotency key, the n8n execution id), `status` (`ok` or `rejected`), `reason`, counts, `warnings` (JSON), `received_at`.

## users

`user_id, email (unique, case-insensitive), display_name, role (host|staff|admin), active`. Rows are added by an admin (see [RTD_DEPLOYMENT.md](RTD_DEPLOYMENT.md)).

## settings

Key/value pairs for the app:
- `projection_weeks` = 6
- `splash_window_days` = 14
- `waitlist_offer_hours` = 12
- `reminder_lead_minutes` = 240

n8n's own settings (café email) live in the n8n data table `rtd_config`.

## event_images

Added in `0002_event_images.sql`. These are event photos copied from each event's Google Drive photo folder by the n8n workflow **RTD Event Images**.
- **Where things live:** the bytes are in Workers KV (binding `IMAGES`, key `img:<image_id>`); this table links photos to events.

| Column | Notes |
| --- | --- |
| `event_id` | The event the photo belongs to |
| `source`, `source_id` | `drive` and the Drive file id. Together with `event_id`, this is the primary key. |
| `source_name` | The Drive file name, for people reading the table |
| `sort` | Display order: newest first |
| `image_id` | The first 32 hex characters of the SHA-256 of the stored bytes. It is NULL while the photo is listed but not yet uploaded. |
| `content_type`, `bytes` | What was stored (sniffed from the bytes, not trusted from headers) |

**Rules:**
- **Up to 8 photos per event.**
- **Shared photos:** two events sharing a folder share stored bytes. Bytes are deleted only when no event uses them.
- **Self-cleaning:** each image sync also sweeps stored bytes that nothing references once they are over an hour old (for example after an interrupted upload).
- **Visibility:** photos of hidden or inactive events are removed at the next image sync. They are never served meanwhile.
- **Audit:** additions and removals are written to `audit_log` (`image.added`, `image.removed`, source `drive_images`).

## host_sessions

Added in `0003_host_sessions.sql`. These are sessions proposed by hosts in the organiser; see [RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md).

| Column | Notes |
| --- | --- |
| `session_id` | `RTD-HS-00001` upwards, assigned in one statement |
| `host_user_id` | The `users` row of the host who proposed it |
| `name`, `description` | As entered |
| `event_date`, `start_time`, `end_time` | London date and wall-clock times. `end_time` is optional. |
| `price_pence` | 0 = free; otherwise paid at the café, up to £100 |
| `max_players` | 1–100 |
| `frequency` | `one-off` (default) or `weekly`, the Logic Engine's Frequency words. Added in `0004_host_session_frequency.sql`. |
| `followup_sent_at` | When n8n emailed the host after a one-off session (0004) |
| `status` | `submitted` → `approved` / `declined`; `withdrawn` by the host; `published` once it's in the Logic Engine |
| `decision_note`, `decided_by`, `decided_at` | The staff decision |
| `event_id` | The Logic Engine event, once published |

## Coming in later phases

`bookings`, `waitlist`, `hosts` profile fields, `host_applications`, `event_requests` (host submissions before approval), `games`, `game_of_week`, `push_subscriptions`, `notifications`. They are designed in the spec (§15, §18, §24, §29, §47) and will be added as new numbered migrations.
