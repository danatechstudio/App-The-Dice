# RTD App Changelog

## 2026-10-08 (stats for admins)
- **The app counts how it's used:** event page views; book, Add to calendar and Share taps; taps on event reminders; installs and opens from the Home Screen; visits in a browser; and views of the diary, Book, Games, Become a host and Markets pages, Roll Me a Game rolls and picks, and Apply to host taps.
  - **Daily totals only:** no network address, device ID or cookie, so a count says how many, never who.
  - **Not counted:** the café team and hosts (signed in to the organiser), robots, and floods (10 counts a request, 60 a minute from one address).
- **Stats** in the organiser, for admins: 7, 30 or 90 days against the period before, with headline numbers, event page views per day (with a table), the most viewed, most booked and most tapped events, every event (with bookings per view), and other counts around the app. Bookings, join requests, stall applications and reminders come from their own records.
- **Latest reminders** now shows how many people tapped each one.
- **Privacy notice:** a new **Counting visits** section.
- **Database:** migration `0015_stats.sql`, applied to the live database.
- **Tests:** 279 (was 270).
- **Docs:** new [`docs/RTD_STATS.md`](docs/RTD_STATS.md).

## 2026-10-08 (event alerts and reminders)
- **Get event alerts:** anyone can turn them on, with no account, from the home page or any event page. One switch covers everything. On iPhone, the card explains adding the app to the Home Screen first.
- **Admins send reminders** in the organiser (**Event reminders**):
  - **Pick an event:** the next date of every public event in the next fortnight, with when each last had a reminder.
  - **The words:** a suggested title and message to change as you like, with a preview.
  - **Facebook:** the same words, a link to the event and its photo go on the café's Facebook page through Buffer, unless you choose **No**.
  - **A second reminder within 24 hours** about the same event shows a warning (when, what and who), and needs **Send another anyway**.
  - **Latest reminders:** how many devices each reached, and whether the Facebook post went.
- **The automatic reminder:** at 8pm, about a random public event in the next three days, at most once every 48 hours. Admins' reminders don't count towards the 48 hours. No Facebook post.
- **Sending:** queued per device and sent 20 at a time by a new every-minute Cron Trigger (the free plan's limits). The daily erasing job now runs from the same trigger, at 03:23 UTC.
- **Approvers:** turning approval notifications off no longer unsubscribes a browser that has event alerts on.
- **Privacy:** the notice covers event alerts; the scrambled network code is erased after 2 days.
- **n8n:** new workflow **RTD Event Reminders To Facebook**.
- **Database:** migration `0014_event_alerts.sql`, applied to the live database.
- **Tests:** 270 (was 248).
- **Docs:** new [`docs/RTD_ALERTS.md`](docs/RTD_ALERTS.md).

## 2026-10-08 (markets: vendors apply for pitches)
- **Admins set up markets** in the organiser (**Markets** → **New market**):
  - **The details:** name, date and times, description, pitches, pitch fee, closing date, and how approved vendors pay.
  - **Into the diary:** it reaches the Logic Engine within 15 minutes, through the same n8n branch as host sessions (App Host Session `RTD-MKT-…`).
- **Vendors apply at `/markets`** without an account:
  - **The form:** stall, contact, what they sell, links, public liability insurance, and up to 3 photos (shrunk in the browser, kept privately, seen only by approvers).
  - **Waiting list:** once every pitch is approved, new applicants join a waiting list.
- **Approvers decide** under **Market applications**:
  - **Approve:** needs a free pitch, and emails the vendor the pitch fee, the payment details and their reference.
  - **Decline:** emails the vendor, with an optional note.
  - **Mark as dropped out:** frees the pitch.
  - **Alerts:** every application emails the approvers' inbox (info@) and sends a push.
- **The RTD Market Vendors spreadsheet** holds every application, kept up to date by the new n8n workflow **RTD Market Vendors To Sheet**.
- **Privacy:**
  - **Erasing:** applications are erased 12 months after the market, photos included, and the sheet row with them.
  - **The notice:** the privacy notice now covers vendors.
- **Markets set up in the app aren't booked by customers;** their diary page links vendors to the form.
- **n8n:**
  - **RTD Outbox:** fills in `@approvals`.
  - **RTD Host Sessions To Diary:** adds the year when a market's name clashes.
  - **New workflows:** the spreadsheet workflow, and a one-off that created the sheet.
- **Database:** migration `0013_markets.sql`, applied to the live database.
- **Tests:** 248 (was 235).
- **Docs:** new [`docs/RTD_MARKETS.md`](docs/RTD_MARKETS.md).

## 2026-10-07 (privacy notice; places for hosts and approvers)
- **Privacy notice** at `/privacy`:
  - **Where it's linked:** the booking form, the join form, the booking page, the footer and the booking confirmation email.
  - **What it says:** what is collected and why, who sees it, how long it's kept, people's rights, and how to complain to the ICO.
  - **Settings, not code:** the business name and contact address come from the app's settings, so they change without a release. The contact is the café's info@.
- **Erasing old details:** a daily job (Cron Trigger, 03:23 UTC):
  - **Bookings:** erases the name, email, mobile and note 12 months after the event.
  - **Network codes:** erases the scrambled code after 2 days.
  - **Join requests:** erases declined or withdrawn ones after 12 months.
  - **The audit log:** it can't be erased, so it now records bookings and requests by number, not by person.
- **Places:**
  - **Hosts:** **Change places** on their live session, for every date or one date, with no new approval.
  - **Approvers:** a new **Places for café events** section sets each café event's places instead of App Capacity in the sheet. **Change places** sets any single date in **Bookings coming up**.
  - **Rules:** never below what's already booked. A number set in the app holds until App Capacity changes in the sheet.
- **Bookings check the places as they're saved,** so lowering the places can't let a booking through on the old number.
- **Database:** migration `0012_places_privacy.sql`, applied to the live database.
- **Tests:** 235 (was 215).
- **Docs:** new [`docs/RTD_PRIVACY.md`](docs/RTD_PRIVACY.md).

## 2026-10-07 (customers book café events; every booking copied to info@)
- **Every public event can be booked:**
  - **Which ones:** the café's own events (Event Index and Standard Diary rows with App Visibility Public or App Bookable), as well as open host sessions.
  - **Limit:** App Capacity on the row; blank means no limit.
  - **Booking closes:** when the event starts.
  - **Where:** the booking form is on every event page. The Book page lists the next date of each bookable event, and Home now says booking is open.
- **The café's info@ address gets:**
  - **Each booking:** a copy of every booking, with contact details. Replying reaches the customer.
  - **Each cancellation:** a copy of every cancellation.
  - **Numbers:** two days before each booked café event.
  - **Warnings:** a "Check bookings" warning when a booked date disappears from the Logic Engine.
  - **Customer replies:** customers' replies to their confirmation go there too.
- **Approvers can cancel any date,** café events included, from **Bookings coming up** in the organiser (it was "Hosted sessions coming up"). Everyone booked is emailed.
- **Cancelled dates leave the Logic Engine** for café events too. A one-off goes Inactive, and a weekly or fortnightly row moves on. Monthly and Standard Diary dates are left to the café, and the email says so. n8n now matches rows on **Event ID**.
- **n8n:**
  - **`rtd_config`:** new key `RTD_BOOKINGS_EMAIL`.
  - **RTD Outbox:** fills in the app's `@bookings` placeholder.
  - **RTD Host Sessions To Diary:** branch C uses `/internal/sheet-fixes`.
- **Database:** migration `0011_cafe_bookings.sql` (`sheet_fixes`), applied to the live database.
- **Tests:** 215 (was 208).

## 2026-10-06 (approval alerts to info@)
- **Where they go:** the "new host session to approve" email now goes to the café's info@ address (`RTD_APPROVAL_ALERT_EMAIL` in `rtd_config`, read by n8n RTD Host Sessions To Diary).
- **Unchanged:** other café emails still use `RTD_CAFE_NOTIFICATION_EMAIL`.

## 2026-10-06 (send again or delete a declined session)
- **Hosts can re-propose a declined or withdrawn session:**
  - **The button:** **Edit and send again** opens the form filled in, with the café's note at the top.
  - **What happens:** the session goes back for approval with the same number. The café is emailed again, approvers get a "Session sent again" push, and Michelle sees a **Sent again** chip.
- **Hosts can delete a declined or withdrawn session.** It disappears from every list. The record and audit trail are kept, and session numbers are never reused.
- **Database:** migration `0010_resubmit.sql` (`host_sessions.deleted_at`, `resubmissions`), applied to the live database.
- **Tests:** 208 (was 203).

## 2026-10-06 (push notifications for approvals)
- **Approvers and admins can get push notifications** on their phone or computer, as well as the email:
  - **What triggers one:** a host sending a session to approve, or someone asking to host.
  - **Where to turn them on:** **Notifications on this device** in the organiser, with **Send a test** and **Turn off**.
  - **On iPhone:** the card explains adding the app to the Home Screen first.
- **Sent by the Worker itself:**
  - **Security:** each message is encrypted for its device (RFC 8291) and signed with the app's own key (RFC 8292), made on first use and kept in D1.
  - **No setup:** there's no third-party service and no secret to set.
- **Service worker:** shows the notification, and opens the organiser at the right place when it's tapped.
- **Database:** migration `0009_push.sql` (`push_subscriptions`, `push_keys`), applied to the live database.
- **Tests:** 203 (was 192), including decrypting each push the way a browser does.
- **Docs:** new [`docs/RTD_PUSH.md`](docs/RTD_PUSH.md).

## 2026-10-06 (bookings for hosted sessions; one way in)
- **Hosts and café staff join the same way.**
  - **What they can do:** one form, "Ask to host games". Everyone approved is a host, so they can only plan sessions.
  - **Approvers:** Michelle (an "approver") approves join requests and every session. Dan, as admin, chooses approvers (**Make approver** / **Stop approving**).
  - **No direct adding:** the "Add a host" form is gone.
- **Booking open host sessions** on their event page, without an account:
  - **The form:** name, email, optional mobile, how many places, and a note for the host.
  - **Capacity:** counted in people, checked inside the database insert, so the last places can't be double-booked. There are per-email and per-network limits.
  - **Confirmation email:** includes a Manage / Cancel link (`/booking/:id`). Only a hash of its secret is stored.
  - **Where it shows:** a **Book in the app** chip on cards. The Book page now lists hosted sessions to book.
- **Hosts:**
  - **In the organiser:** they see who's booked on each upcoming date.
  - **Emails:** one for every booking and cancellation, plus "N of M places booked" **two days before** each date.
  - **Cancelling a date:** a host can cancel one date, with a message. Everyone booked is emailed, and so is the café.
  - **Approvers:** they see every hosted date for the next three weeks, with contact details, and can cancel too.
- **Cancelled dates:**
  - **In the app:** they leave the diary, stay cancelled through syncs, and are taken out of the Logic Engine (one-off → Inactive; weekly → its next date), so they're never advertised.
- **Emails:**
  - **How they're sent:** the app writes booking emails to an outbox in the same transaction as the change. The new n8n **RTD Outbox** sends them every 5 minutes.
  - **The sheet:** **RTD Host Sessions To Diary** gained the sheet branch for cancelled dates.
- **Database:** migration `0008_bookings.sql` (`bookings`, `outbox`, `occurrences.cancelled_by`, `host_sessions.sheet_fix_*`), applied to the live database.
- **Tests:** 192 (was 171).
- **Docs:** new [`docs/RTD_BOOKINGS.md`](docs/RTD_BOOKINGS.md); [`docs/RTD_ONBOARDING.md`](docs/RTD_ONBOARDING.md) rewritten.

## 2026-10-06 (onboarding for hosts and café staff)
- **People ask for access themselves:** anyone who signs in at `/organise` without access sees **Join Roll The Dice**, where they ask to **Host games** or join the **Café team**. They can see where their request is, and withdraw it.
- **Approvals, in the organiser under Join requests:**
  - **Host requests:** staff (Michelle) or an admin.
  - **Café team requests:** admins only (Dan). Staff never see them.
  - **What approval does:** it gives access immediately. Declining can include a note the applicant sees.
- **Removing access:**
  - **Hosts:** staff remove them from the Hosts table.
  - **Café team:** admins remove them from the new Café team table.
  - **Limits:** nobody can remove themselves or an admin.
  - **Coming back:** someone removed can ask again, and keeps the same user record.
- **Emails,** by the new n8n **RTD Team Notices** (every 15 minutes):
  - **To the approver:** about each new request (host requests to the café address, café team requests to the admins).
  - **To the applicant:** the outcome.
  - **To hosts:** whether the café approved their session.
- **Become a Host page:** now has **Apply to host** and **Open the organiser**.
- **Audit:** requests, decisions, access granted and access removed are all in `audit_log`.
- **Database:** migration `0007_onboarding.sql` (`applications`, `host_sessions.host_notified_at`), applied to the live database.
- **Tests:** 171 (was 157).
- **Docs:** new [`docs/RTD_ONBOARDING.md`](docs/RTD_ONBOARDING.md).

## 2026-10-05 (host sessions into the diary)
- **Approved host sessions reach the diary:**
  - **How:** n8n **RTD Host Sessions To Diary** (every 15 minutes) adds them to Event Index, and the sync links each row back to its session, which then shows as Live.
  - **The rows:** open sessions are Public, private ones Private. New columns App Price, App Capacity and App Host Session were added, after a backup of the sheet.
- **The café is emailed about each new submission,** with a link to `/organise`. Replies go to the host.
- **Event pages** show "£5 per player, paid at the café" and "Up to N players" when known.
- **Private sessions are never advertised:**
  - **RTD Master V1:** the evening round-up, Sunday weekly post and hourly event post skip `App Visibility = Private`.
  - **Event Guard:** it makes no posters for Private rows, and doesn't ask the café for a new date when a host one-off passes.
  - Rollback versions are in `docs/RTD_N8N_WORKFLOWS.md`.
- **Database:** migration `0006_host_publishing.sql`, applied to the live database.
- **Tests:** 157 (was 152).
- **Follow-up email:** a test email went to Dan using a dummy session, which was then removed.

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
