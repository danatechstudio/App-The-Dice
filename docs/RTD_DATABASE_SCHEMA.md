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
| `visibility` | `public`, `app_bookable`, `private`, `hidden` (sheet `App Visibility`; blank or unknown = hidden). `private` is listed in the diary only as "Private session" with its time. |
| `sheet_status`, `active` | Raw Status. `active` = Status is exactly "Active" (Standard Diary: always active) |
| `default_image`, `default_host_id` | App-owned, later phases |
| `default_capacity` | Places, from the sheet's `App Capacity` (host sessions fill it in) |
| `capacity_override` | Places set in the organiser: by the host for their session, or by an approver for a café event. Wins over `default_capacity`; the sync clears it when App Capacity changes in the sheet, so the last change wins (0012) |
| `price_display` | The sheet's `App Price` ("Free", "£5"). Added in `0006_host_publishing.sql`. |
| `booking_mode` | Whether people need to book: `none` (Not required), `optional`, `required`; NULL = the default for its kind (café events Optional, hosts' sessions Required, Standard Diary groups and markets Not required). Set by approvers in the organiser; the sync never changes it (0019, [RTD_BOOKINGS.md](RTD_BOOKINGS.md#booking-modes)) |
| `host_session_id` | The sheet's `App Host Session`: the organiser session this row came from (0006) |
| `market_id` | The same column holding `RTD-MKT-…`: a market set up in the organiser (0013). Customers don't book these. |
| `photo_folder_id` | Drive folder used by the poster generator |
| `sheet_date_raw` | The sheet's date cell as written ("Every Thursday", a past date; NULL when blank), so Needs attention can say why an event has no date (0017) |
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
| `capacity` | Places on this date alone, set in the organiser. Wins over the event's number; the sync never changes it ([RTD_BOOKINGS.md](RTD_BOOKINGS.md#places)) |
| `visibility`, `price_display`, `description_override` | App-owned, for this date only (Stage 5b, **Dates in the app**): `visibility` is only ever `hidden` or NULL (the event's); the others NULL mean the event's own. The sync never writes them. Audit `occurrence.edited`, with the values before and after. |
| `host_id`, `booking_enabled`, `booking_deadline`, `image_override` | Unused so far |
| `approved_at`, `completed_at`, `cancelled_at` | Lifecycle timestamps |

## audit_log (append-only)

`audit_id, entity_type, entity_id, occurrence_id, actor_type (system|n8n|staff|host|customer), actor_id, action, previous_value (JSON), new_value (JSON), source, created_at`.

Triggers abort any `UPDATE` or `DELETE`. Actions so far:
- `event.created`, `event.updated`, `event.activated`, `event.deactivated`, `event.missing_from_source`
- `occurrence.created`, `occurrence.time_changed`, `occurrence.completed`, `occurrence.rescheduled`, `occurrence.reinstated`
- **Host sessions:** `host_session.*` (source `organiser`)
- **Booking:** `event.places_changed`, `occurrence.places_changed`, `event.booking_mode_changed`, `occurrence.moved_bookings_cancelled` (source `organiser`)
- **Dates in the app:** `occurrence.edited` (source `organiser`)
- **Onboarding:**
  - **Requests:** `application.host.submitted`, `application.staff.submitted`, `application.withdrawn`, `application.approved`, `application.declined`
  - **Access:** `user.granted_host`, `user.granted_staff`, `user.removed_host`, `user.removed_staff`
  - **Source:** `organiser` (see [RTD_ONBOARDING.md](RTD_ONBOARDING.md#audit))

## sync_runs

One row per sync attempt: `run_id` (idempotency key, the n8n execution id), `status` (`ok` or `rejected`), `reason`, counts, `warnings` (JSON), `received_at`.

## users

`user_id, email (unique, case-insensitive), display_name, role (host|staff|admin), active`.

**How rows get here:**
- **Approved join requests:** approving a request (see [RTD_ONBOARDING.md](RTD_ONBOARDING.md)) adds the row, or re-activates an old one.
- **Staff adding a host directly:** also adds the row.
- **Admins:** added in the database (see [RTD_DEPLOYMENT.md](RTD_DEPLOYMENT.md)).

**Removing access:** sets `active = 0`. Rows are never deleted.

## settings

Key/value pairs for the app:
- `projection_weeks` = 6
- `splash_window_days` = 14
- `waitlist_offer_hours` = 12
- `reminder_lead_minutes` = 240
- `privacy_controller`: who the privacy notice names (0012)
- `booking_retention_months` = 12 (0012)
- `privacy_contact_email`: the notice's contact address, set only in the live database

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
| `access` | `open` (default) or `private`: a private session goes to Event Index with App Visibility `Private`. Added in `0005_host_session_access.sql`. |
| `cafe_notified_at`, `published_at` | When n8n emailed the café about the submission, and when it added the session to Event Index (0006) |
| `status` | `submitted` → `approved` / `declined`; `withdrawn` by the host; `published` once it's in the Logic Engine |
| `decision_note`, `decided_by`, `decided_at` | The staff decision |
| `event_id` | The Logic Engine event, once published |
| `host_notified_at` | When n8n emailed the host the café's decision. Added in `0007_onboarding.sql`. |
| `deleted_at` | Set when the host deletes a declined or withdrawn session: hidden from every list, never erased (0010) |
| `resubmissions` | Times it was sent again after a decline or withdrawal (0010) |
| `sheet_fix_sent`, `sheet_fix_sent_at` | No longer used since 2026-10-07: replaced by `sheet_fixes`, which covers café events too (0008) |

## applications

Added in `0007_onboarding.sql`. These are requests to host games or join the café team; see [RTD_ONBOARDING.md](RTD_ONBOARDING.md).

| Column | Notes |
| --- | --- |
| `application_id` | `RTD-APP-00001` upwards, assigned in one statement |
| `email` | The signed-in email address (case-insensitive) |
| `display_name`, `about` | As entered: 2–60 and 3–500 characters |
| `role` | Always `host` since 2026-10-06 (`staff` = an old "café team" request) |
| `status` | `pending` → `approved` / `declined`; `withdrawn` by the applicant |
| `decision_note`, `decided_by`, `decided_at` | The decision, by an approver or admin |
| `approver_notified_at`, `applicant_notified_at` | When n8n emailed the approver about the request, and the applicant about the outcome |
| `erased_at` | Declined or withdrawn requests: when the name, email, what they wrote and the note were erased, 12 months after the decision (0012) |
| `created_at`, `updated_at` | |

**Indexes:** `(email, created_at)` for "my latest request" and the 3-a-day limit, and `(status, role)` for the approval queue.

## bookings

Added in `0008_bookings.sql`: places booked on public café events and open host sessions ([RTD_BOOKINGS.md](RTD_BOOKINGS.md)). Never deleted.

| Column | Notes |
| --- | --- |
| `booking_id` | `RTD-BK-00001` upwards, assigned in the same statement that checks capacity |
| `occurrence_id` | The date booked |
| `lead_name`, `email`, `mobile` | Who booked. `mobile` is optional. A host sees only the name; the café (info@ and approvers) sees all three. |
| `party_size` | 1–10 places. Places taken are the sum of `party_size` over confirmed bookings, checked against the event's App Capacity (none means no limit) or the session's Max players. |
| `notes` | Optional note for the café and the host (300 characters) |
| `status` | `confirmed` or `cancelled` |
| `cancelled_by`, `cancel_message`, `cancelled_at` | `customer`, `host` or `staff`, and the host's or café's message when they cancelled the date |
| `cancellation_token_hash` | SHA-256 of the secret in the Manage / Cancel link. The secret itself is never stored. |
| `ip_hash` | First 32 hex characters of SHA-256 of the requester's IP and the day, only for the 10-an-hour limit. Erased after 2 days. |
| `source` | `app` |
| `erased_at` | When the name, email, mobile and note were erased, 12 months after the event (0012, [RTD_PRIVACY.md](RTD_PRIVACY.md)). The email becomes `erased-RTD-BK-…`. |

**Indexes:** `(occurrence_id, status)` for capacity, `(email, created_at)` and `(ip_hash, created_at)` for the limits.

## outbox

Added in `0008_bookings.sql`: emails the app has written, waiting for n8n **RTD Outbox** to send them.

| Column | Notes |
| --- | --- |
| `message_id` | Order of sending |
| `dedupe_key` | Unique: each email is queued once (e.g. `booking-confirmed:RTD-BK-00001`, `booking-new-cafe:RTD-BK-00001`, `cafe-numbers:RTD-OCC-…`) |
| `kind` | `booking_confirmed`, `cafe_new_booking`, `cafe_booking_cancelled`, `cafe_numbers`, `cafe_orphaned_bookings`, `host_new_booking`, `host_booking_cancelled`, `host_numbers`, `attendee_date_cancelled`, `cafe_date_cancelled`, `host_date_cancelled` |
| `to_email`, `reply_to` | The café's addresses are placeholders, which only n8n fills in (`rtd_config`): NULL means the café's general address, and `@bookings` the bookings inbox (info@) |
| `subject`, `html` | The finished email |
| `sent_at` | Set by n8n. Sent emails are deleted after 90 days. |
| `booking_id` | The booking a customer's email is about (0020), so a failure can say who to contact |
| `attempts`, `last_error`, `last_attempt_at`, `next_attempt_at` | Failed attempts reported by n8n (`/internal/outbox/:id/failed`); tried again after 5 m, 15 m, 1 h, 4 h, 12 h (0020) |
| `claim`, `claimed_at` | Held by the collection that returned it, for 10 minutes (0020) |
| `dead_at` | Given up on after the sixth failed attempt; an admin can try again (0020) |

**States** (derived, 0020): sent (`sent_at`), given up (`dead_at`), sending (claimed in the last 10 minutes), being tried again (`attempts` > 0), queued.
**Also in 0020** (outbox `kind`): `attendee_date_moved` (dedupe `date-moved:<occurrence_id>:<booking_id>`), `attention_moved`, `attention_undelivered`; and from Stage 4c (no migration) `attention_cancelled`.

**Also in 0008:** `occurrences.cancelled_by` (`host` or `staff`) for a date cancelled in the organiser. A cancelled occurrence keeps its status through every sync.

## sheet_fixes

Added in `0011_cafe_bookings.sql`: the last Event Index change n8n made for a cancelled date, one row per event, so each change is made once.

| Column | Notes |
| --- | --- |
| `event_id` | The Logic Engine event (primary key) |
| `fix_key` | `inactive`, or `date:YYYY-MM-DD` for the date the row was moved on to |
| `sent_at` | When n8n reported it done |

## markets

Added in `0013_markets.sql` ([RTD_MARKETS.md](RTD_MARKETS.md)). One row per market an admin sets up.

| Column | Notes |
| --- | --- |
| `market_id` | `RTD-MKT-00001` upwards |
| `name`, `description`, `event_date`, `start_time`, `end_time` | As set up |
| `pitches` | 1–200. Can't go below the vendors approved |
| `pitch_fee_pence` | 0 = no fee |
| `applications_close` | The last day vendors can apply |
| `payment_details` | Typed by the admin; only sent to approved vendors |
| `status` | `scheduled` until n8n adds it to Event Index, then `published` |
| `event_id`, `published_at` | Its Logic Engine event, once the sync links it |
| `created_by` | The admin's email |

### market_applications

| Column | Notes |
| --- | --- |
| `application_id` | `RTD-MV-00001` upwards: the vendor's reference |
| `stall_name`, `contact_name`, `email`, `mobile`, `products`, `links`, `notes` | As typed |
| `insured`, `insurer`, `insurance_expiry` | Public liability insurance |
| `photo_count` | 0–3 |
| `status` | `pending` → `approved` / `declined`; `withdrawn` = dropped out (marked by an approver) |
| `waitlisted` | Every pitch was approved when they applied |
| `decision_note`, `decided_by`, `decided_at` | The approver's decision |
| `ip_hash` | Only for the 5-an-hour limit; erased after 2 days |
| `submit_key` | Random, so the photos and emails saved in the same batch find the new row |
| `sheet_hash` | What n8n last wrote to the RTD Market Vendors spreadsheet |
| `erased_at` | Personal details erased, 12 months after the market |

**Indexes:** `(market_id, status)`, `(email, created_at)`, `(ip_hash, created_at)`.

### market_photos

`photo_id` (random, 32 hex characters; the KV key is `vendor:<photo_id>`), `application_id`, `position` (1–3), `content_type` (JPEG, PNG or WebP), `bytes`. Deleted, with the KV copies, when the application is erased.

## Event alerts

Added in `0014_event_alerts.sql` ([RTD_ALERTS.md](RTD_ALERTS.md)).

| Table | Columns |
| --- | --- |
| `alert_subscriptions` | `endpoint` (primary key: one browser's push address; never shown), `p256dh`, `auth`, `device_label`, `ip_hash` (only for the 20-an-hour limit; erased after 2 days), `created_at`, `last_sent_at`, `failures` (5 in a row and it's dropped) |
| `push_sends` | `send_id`, `kind` (`manual` by an admin, `auto` at 8pm), `event_id`, `occurrence_id`, `title`, `body`, `url`, `sent_by` (the admin's email, or `auto`), `devices`, `delivered`, `failed`, `social` (`pending` / `posted` / `failed`, or NULL for no Facebook post), `social_text`, `social_image`, `social_post_id`, `social_error`, `social_at`, `created_at` |
| `push_deliveries` | `send_id`, `endpoint`, `claim`, `claimed_at`: a reminder waiting for one device; deleted once sent |

**Indexes:** `alert_subscriptions (ip_hash, created_at)`, `push_sends (event_id, created_at)`, `push_sends (kind, created_at)`.

## Game library

Added in `0016_game_library.sql` ([GAME_LIBRARY_AUDIT.md](GAME_LIBRARY_AUDIT.md)). Additive.

| Table | Holds |
| --- | --- |
| `games` | Confirmed holdings only: `game_id` (`RTD-GAME-00001`), `slug`, `title`, `edition`, `category`, `audiences` (JSON), `min_age`, `min_players`, `max_players`, `play_time_min`, `play_time_max`, `synopsis`, `verification_status`, `available_for_chooser`, `available_for_gotw`, `copies` (NULL = not counted), cover and thumbnail image IDs with `image_source_url`, `image_attribution`, `image_rights_status`, `image_status`, `image_checked_at`; `source_key` (normalised title and edition), `source_title`, `source_evidence`, `ownership_evidence`, `confirmed_by`, `confirmed_at`, `import_batch_id`, `admin_edited_at`, `retired_at` |
| `game_review` | Titles held back (`provisional` or `uncertain`), with their parsed details, reasons, and the decision |
| `game_import_batches` | Each dry run or import: mode, SHA-256 of the manifest, counts, who, when |
| `gotw_weeks` | One row per week (`week_key` = Monday, primary key): the game, a snapshot of its title, edition and cover, mode (`random` or `least_recent`), pool size |

**Settings:** `game_library_live` (`off` until cutover) and `gotw_avoid_weeks` (12).

## Stats

Added in `0015_stats.sql` ([RTD_STATS.md](RTD_STATS.md)).

| Table | Columns |
| --- | --- |
| `stats_daily` | `day` (London date), `metric` (`event_view`, `book_tap`, `app_open`…), `event_id` (`''` for the whole app), `count`. Primary key `(day, metric, event_id)`; `WITHOUT ROWID`. Nothing about anyone. |

The same migration added `push_sends.opened`: taps on each event reminder.

## push_subscriptions and push_keys

Added in `0009_push.sql`: push notifications for approvers ([RTD_PUSH.md](RTD_PUSH.md)).

| Table | Columns |
| --- | --- |
| `push_subscriptions` | `endpoint` (primary key: the push service address for one device; only its owner sees it), `user_id`, `p256dh` and `auth` (the browser's key and secret for encryption), `device_label`, `created_at`, `last_sent_at`, `failures` (5 in a row and the device is dropped) |
| `push_keys` | One row: the app's VAPID `public_key` and `private_jwk`, made by the Worker on first use |

## attention_items

Added in `0017_attention.sql`: **Needs attention** ([RTD_EVENT_CONTROL_AUDIT.md](RTD_EVENT_CONTROL_AUDIT.md) G-2), for approvers and admins in the organiser.

| Column | Notes |
| --- | --- |
| `item_id` | Shown as `RTD-ATT-00001` |
| `item_key` | Unique: `expired:<occurrence_id>`, or `no_date:<event_id>:<sheet_date_raw>`. One item per situation, ever: once resolved, the same one never reopens |
| `kind` | `expired` (its latest date ended with nothing after it), `no_date` (active and listed, nothing to come, no usable date in the sheet), `moved` (a booked date the Logic Engine moved; key `moved:<occurrence_id>`), `undelivered` (an email to a customer about their booking failed; key `undelivered:<message_id>`) or `cancelled` (the date in the sheet of a monthly event or a Standard Diary group was cancelled in the app; key `cancelled:<occurrence_id>`, Stage 4c) |
| `event_id`, `occurrence_id` | The event, and (expired) the date that ended |
| `detail` | no_date: the sheet's date cell, as written |
| `status` | `open` or `resolved` |
| `resolution` | `renewed`, `archived`, `completed` (a one-off, no new date needed), `dismissed` (left as it is), `notified` (moved: told it has moved), `cancelled` (moved: bookings cancelled) or `sent` (undelivered: it went on a later try) |
| `renew_date` | The new date an approver set; it reaches Event Index through `/internal/sheet-fixes` |
| `new_occurrence_id` | The date that arrived from the Logic Engine, when that settled it |
| `resolved_by` | The approver's email, `sheet` (the Logic Engine answered it) or `system` (a one-off host session or market, closed straight away) |
| `resolution_note`, `opened_at`, `resolved_at` | |
| `first_notified_at` | expired: when its notice was queued, or (already waiting when emails were switched on) when it joined the morning reminder (0018) |
| `last_reminded_at`, `reminder_count` | The morning reminders it has been in, counted once a day (0018) |

**Settings:**
- `needs_attention`: `off` until an admin switches it on.
- `attention_emails` (`off` / `on`) and `attention_email_to` (addresses, comma-separated; set in the organiser, never in this repository) (0018).

**Emails** (outbox `kind`): `attention_expired` (dedupe `expiry-new:<item_id>:<address>`), `attention_digest` (`expiry-digest:<date>:<address>`) and `attention_test`.
**Audit:** `attention.opened`, `attention.resolved`, `attention.switched_on` / `attention.switched_off`.

## event_change_requests

Added in `0021_change_requests.sql` (Stage 5a; [RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md#changing-a-live-session)): a host's change to their live session, which an approver decides.

| Column | Notes |
| --- | --- |
| `request_id` | `RTD-CR-00001` upwards |
| `session_id`, `event_id` | The session, and the Event Index row the change is written to |
| `origin`, `requested_by` | `host`, and the host's sign-in email |
| `published` | JSON: what the diary showed when it was asked for (name, description, event_date, start_time, end_time, price, access) |
| `proposed` | JSON: only the fields that change (with `price_pence` when the price does) |
| `note` | The host's note to the café |
| `status` | `pending`, `approved`, `declined`, `withdrawn`, or `superseded` (asked again before a decision) |
| `decided_by`, `decided_at`, `decision_note` | Who decided; the note is the reason when declined |
| `applied_at` | n8n wrote it to Event Index |

**Emails** (outbox `kind`): `cafe_change_request` (to `@approvals`, dedupe `change-request:<id>`), `host_change_decided` (`change-decided:<id>`), `attendee_time_changed` (`time-changed:<id>:<booking_id>`).
**Audit:** `host_session.change_requested`, `.change_approved`, `.change_declined`, `.change_withdrawn`, `.change_applied`.

## booking_devices and push_outbox

Added in `0020_delivery.sql` (Stage 4b; [RTD_BOOKINGS.md](RTD_BOOKINGS.md#telling-this-device)).

**`booking_devices`:** devices someone asked to be told on about one booking. `device_id`, `booking_id`, `endpoint` (works like a password; never shown), `p256dh`, `auth`, `device_label`, `created_at`, `invalid_at` (the push service said it has gone). Unique per (booking, endpoint); at most 3 a booking. Deleted the day after the booked date.

**`push_outbox`:** a notification to one booking device, written in the same batch as the change. `dedupe_key` (unique: `push:date-cancelled:<occurrence_id>:<device_id>`, `push:date-moved:…`), `kind`, `device_id`, `booking_id`, `occurrence_id`, `title`, `body`, `url`, `tag` (`booking-<booking_id>`), `attempts`, `last_status` (the push service's answer; 0 unreachable, -1 the device was turned off first), `last_error`, `last_attempt_at`, `next_attempt_at`, `claim`, `claimed_at`, `sent_at`, `dead_at`, `created_at`. Same retries as the outbox; a 404 or 410 is given up on at once. Kept 90 days.

## Food & Drinks menu

Added in `0023_food_menu.sql` ([RTD_FOOD_MENU.md](RTD_FOOD_MENU.md)). Additive: no existing table changes. Browse only; nothing about customers.

| Table | Columns |
| --- | --- |
| `menu_categories` | `category_id` (primary key, a slug that is also the page anchor: `hot-food`), `name`, `description`, `alcohol` (1: the over-18s note), `image_url`, `image_alt` (reserved for a photo), `sort_order`, `visible`, `created_at`, `updated_at` |
| `menu_items` | `item_id` (`RTD-MENU-00001`; never reused), `category_id`, `name`, `options` (the choices), `description`, `price_pence` (NULL when there's no single price; checked 0–100000), `price_note` (what to show instead: "Individually priced"), `alcohol` (1: marked 18+; 0% drinks are 0), `image_url`, `image_alt`, `sort_order`, `visible` (0: off the menu), `available` (0: listed as not available right now), `source_text` (the line as transcribed from the photographed menu), `created_at`, `updated_at` |
| `menu_item_variants` | `variant_id`, `item_id`, `label` (`Single`, `Double`), `price_pence`, `sort_order`; unique `(item_id, label)`. When an item has these, they are its prices |

**Index:** `menu_items (category_id, sort_order)`.

**Setting:** `food_menu_status`: `off`, `preview` (where it starts) or `live`. Admins change it in the organiser; anything else reads as off.

**Data:** 8 sections and 59 lines from the brief, with single £4 / double £6 for each of the 8 spirits. Three cold-food lines are "Individually priced", and Mixers' soft drinks point to Cold drinks.

## Coming in later phases

`waitlist`, `hosts` profile fields, `games`, `game_of_week`, `notifications` (customer push). They are designed in the spec (§15, §18, §24, §29, §47) and will be added as new numbered migrations.
