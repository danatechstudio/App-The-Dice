# RTD App Changelog

## 2026-10-05 (open or private sessions; private sessions in the diary)
- **Organiser:** a new "Who can come?" choice on the session form. **Open** is the default; **Private** is for a host's own group. Cards and the staff queue show "Private".
- **Diary:**
  - **Private events now show as busy:** Logic Engine rows with App Visibility `Private` appear as "Private session" with their time, on a purple, striped ticket you can't open. Before, they didn't appear at all.
  - **Their details never leave the server:** not the name, description, photo or price.
  - **Never promoted:** they have no event page, link preview or calendar file, and are never featured on Home, Coming Up, Book or the splash screen.
- **Home:** a "Plus 2 private sessions today" line under the main event.
- **Database:** migration `0005_host_session_access.sql` (`access`), applied to the live database.
- **Tests:** 152 (was 150).

## 2026-10-05 (organiser sign-in, weekly sessions, host follow-up)
- **Sign-in fixed:** the organiser's Sign in button looped, because `/organise` and `/api/host` weren't behind Access. It now goes through `/api/staff/sign-in`, which is behind the RTD Staff application; Access's cookie then covers the organiser. No dashboard change is needed.
  - **Failed sign-ins are explained:** if a sign-in still doesn't stick, the page explains, with a reason (`missing` or `invalid`), instead of looping.
  - **Sign out fixed:** the Sign out link opened the app's not-found page. It now reaches Cloudflare.
- **One-off or weekly:** a new "How often?" choice on the session form. Weekly sessions show "Every Tuesday" and their next date.
- **After a one-off:** n8n **RTD Host Follow-up** emails the host the day after an approved one-off session. Endpoints: `/internal/host-sessions/followups` and `/internal/host-sessions/:id/followup-sent`.
- **Database:** migration `0004_host_session_frequency.sql` (`frequency`, `followup_sent_at`), applied to the live database.
- **Tests:** 150 (was 145).

## 2026-10-05 (host organiser)
- **`/organise`, the host organiser, is built** (behind Cloudflare Access; the `users` table decides roles).
  - **Hosts** create sessions (event name, date, start and end time, cost per player, max players, description), see their status, and withdraw them.
  - **Staff** approve or decline (with a note for the host) and add hosts.
- **API:** `/api/host/*` and `/api/staff/host-sessions`, `/api/staff/hosts`. Changes must be same-origin JSON.
- **Database:** migration `0003_host_sessions.sql`, applied to the live database. Sessions are numbered `RTD-HS-00001`, and every change is audited.
- **Docs:** `docs/RTD_HOST_PORTAL.md`.
- **Tests:** 145 (was 137).

## 2026-10-05 (event photos)
- **Event photos from Drive:** the new n8n workflow **RTD Event Images** (`GeafnErtRe5ZMbiD`, every 6 hours) copies the newest 8 photos from each visible event's Photo Folder ID into the app.
  - Google resizes them to 1400px WebP first.
  - Files with `noapp` or `private` in their name are skipped.
- **App:**
  - **New endpoints:** `/internal/images/plan`, `/sync` and `PUT /internal/images/:event/:file` (bearer token); `/images/:id` serves the photos.
  - **Storage:** photos are kept in Workers KV (`rtd-app-images`). Migration `0002_event_images.sql` adds the `event_images` table.
  - **Where photos appear:** event cards, event pages (new "From past sessions" gallery with a full-screen viewer), the splash and link previews.
  - **Variety:** each date of a weekly event shows a different photo.
- **Tests:** 136 (was 125).

## 2026-10-05 (install banner)
- **"Install the app" now sits at the top of every page.**
  - It opens the install dialog on Android/Chrome.
  - It shows Add to Home Screen steps on iPhone.
  - In Facebook/Instagram's built-in browser, it says to open the page in a real browser.
- **When it hides:** once installed, and for 14 days after "Not now". The footer keeps an Install button.
- **Home's install card removed:** the banner replaces it.
- **Tests:** 125 (was 120).

## 2026-10-05 (theme and Phase 2 app)
- **Visual theme from the café's logo:** extracted from `RTDLogo.jpg`, documented in `docs/RTD_APP_THEME.md`.
  - Navy `#123F68` measured from the image; orange accent from existing RTD posters.
  - Arvo display type, Figtree interface type, sticker-outline shapes.
  - Central tokens in `web/src/theme/`, with customer, host and staff intensities.
- **Branded PWA (Phase 2) served by the Worker:**
  - **Screens:** Home, Diary, Event pages, splash, Roll Me a Game (3D dice, Chaos Roll), Games, Book, Become a Host, and a `/styleguide` page.
  - **App features:** installable, offline diary, Add to Calendar (`.ics` and Google), Share, and event-specific link previews.
- **New API:**
  - `GET /api/occurrences/:id/calendar.ics`
  - `GET /api/occurrences/:id/google-calendar`
- **New config:** `VENUE_LOCATION` var.
- **Logo assets:**
  - Logo cut-out, dice mark, PWA/maskable/Apple icons, favicon and share image, generated by `scripts/brand-assets.py`.
  - The logo is not redrawn.
- **Tests:** 120 (was 84). New tests cover calendar files, link previews and theme contrast.

## 2026-10-05 (Cloudflare)
- **RTD Event Sync is live** (every 15 min).
  - First sync: 31 events, 40 occurrences. A repeat sync makes no changes.
- **Sync refusals now name their cause:** no secret (503), missing or non-Bearer header, or wrong token (401). `keep_vars` stops Git deploys deleting dashboard variables.
- **App deployed** at https://rtd-app.dan-289.workers.dev from GitHub (Workers Builds). Staff Access is on `/api/staff`.
- **RTD Event Sync** n8n workflow built (switched off until its credential exists). `rtd_config` gained `RTD_APP_BASE_URL`.
- **Fix:** a retried run of a refused sync now stays refused (`409`), instead of coming back as a "duplicate" success.
- **D1 database `rtd-app` created** (WEUR) through the Cloudflare connector.
  - `0001_foundation.sql` applied and recorded in `d1_migrations`.
  - First admin user added.
- **`wrangler.jsonc`** now points at the real database id.
- **Added `scripts/cloudflare-setup.sh`,** a one-command setup for running it from your own machine.

## 2026-10-05 (later)

### n8n / Logic Engine (live)
- **Logic Engine backup** taken: "Logic Engine_RTD BACKUP 2026-10-05 1200 (before app ID columns)".
- **New sheet columns** `Event ID`, `App Visibility` and `App Category` added at the end of Event Index and Standard Diary.
  - IDs backfilled: `RTD-EVT-00001`–`00031`.
  - One-off workflow: `RTD One-Off: Add App ID Columns`.
- **RTD Master V1:** `Calculate next dates` no longer auto-rolls Monthly events.
- **RTD Event Guard (sub):** new node `Monthly: Ask For Next Date`, so a passed Monthly event expires and the date-picker email goes to Michelle. Published; two dry runs passed.
- **`rtd_config`** data table created, holding `RTD_CAFE_NOTIFICATION_EMAIL`.

### App (repo)
- **Phase 1 data foundation** on Cloudflare Workers + D1: schema migration, Logic Engine sync with occurrence history, public diary API, staff API behind Cloudflare Access, append-only audit log, 82 tests.
- **Docs added:**
  - `RTD_APP_ARCHITECTURE.md`
  - `RTD_DATABASE_SCHEMA.md`
  - `RTD_N8N_WORKFLOWS.md`
  - `RTD_DEPLOYMENT.md`
  - `RTD_RECOVERY.md`
- **Audit updated** with your decisions, the hard-coded Meta token (S1), and the poster title rule bug.

## 2026-10-05
- Repository created with the build specification.
- Phase 0 audit completed (read-only): `docs/RTD_AUDIT.md`. No changes made to n8n, Google Sheets or Drive.
