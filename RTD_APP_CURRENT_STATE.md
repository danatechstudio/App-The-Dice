# RTD App: Current State

_Last updated: 2026-10-06_

## Live
- **Logic Engine:** every event row now has a permanent `Event ID`, plus `App Visibility` and `App Category` (backup taken first).
- **Monthly events:** no longer auto-rolled. When one passes, Michelle gets the date-picker email.
- **`rtd_config`** n8n data table holds the café notification email.

## Cloudflare (deployed)
- **App:** https://rtd-app.dan-289.workers.dev, deployed from GitHub `main` on every push (Workers Builds).
- **Sync:** **RTD Event Sync** runs every 15 minutes, copying the Logic Engine into the app. It is live, with 31 events and 40 occurrences.
- **Database:** D1 `rtd-app` with the schema applied; Dan is admin.
- **Staff sign-in:** Access application "RTD Staff" protects `/api/staff` only (team `solitary-thunder-9de0`).

## Phase 1 Worker
- Cloudflare Worker + D1.
  - Schema, idempotent Logic Engine sync with occurrence history, public diary API, staff API behind Cloudflare Access, append-only audit log.
  - Verified live against the real sheet.

## Theme and Phase 2 app (built 2026-10-05)
- **Theme** taken from the café's logo (`docs/brand/RTDLogo.jpg`): navy `#123F68`, white, RTD poster orange as the accent, warm paper background, Arvo + Figtree, die-cut sticker shapes. Full reference in [`docs/RTD_APP_THEME.md`](docs/RTD_APP_THEME.md); every component is live at `/styleguide`.
- **Central tokens** in `web/src/theme/` (colours, type, spacing, radii, shadows, motion, breakpoints), with customer / host / staff intensities.
- **PWA served by the Worker:**
  - **Screens:**
    - Home: Tonight, Coming Up, Roll, Game of the Week, Book.
    - Diary: Today, This week and This month, with category filters and ticket-style rows.
    - Event pages: Add to Calendar (.ics or Google) and Share.
    - Evergreen `/events/RTD-EVT-…` links.
    - Event splash, at most once per visit.
    - Roll Me a Game: 3D dice, filters, Chaos Roll.
    - Games, Book, Become a Host, and not found.
  - **App plumbing:** installable (manifest, icons, service worker with an offline diary), and shared links get event-specific previews.
  - **Install banner** at the top of every page: Install on Android/Chrome, step-by-step help on iPhone, and "open in your browser" in Facebook/Instagram. "Not now" hides it for 14 days.
- **Logo assets** cut from the reference without redrawing: logo, dice mark, app/maskable/Apple icons, favicon, share image (`npm run brand:assets`).
- **Checked:**
  - **Tests:** 145 passing at the time (192 now), including WCAG contrast for 24 colour pairings.
  - **Screens:** screenshots at 320 / 375 / 430 / 768 / 1280px, no horizontal scroll or console errors.
  - **Accessibility:** reduced motion makes the roll instant, keyboard skip link, no tap target under 40px.

## Event photos (added 2026-10-05)
- **What it does:** **RTD Event Images** (n8n, every 6 hours, live) copies the newest 8 photos from each visible event's Drive **Photo Folder ID** into the app, resized by Google to 1400px (WebP; PNG posters as JPEG).
  - **Live now:** 65 photos across 9 events, about 10.6 MB.
- **Where they show:** cards, event pages (with a "From past sessions" gallery), the splash and shared-link previews.
- **Storage:** Workers KV (`rtd-app-images`).
- **Photos from previous runs** are removed when they leave the folder, or when the event is hidden.
- **To keep a photo out:** put `noapp` (or `private`) in its file name.
- **Events without photos keep the navy panel.** Home Education's folder is empty, and Standard Diary groups have no folder.

## Host organiser (started 2026-10-05)
- **`/organise`:** hosts create sessions, see their status, and withdraw them. A declined or withdrawn one can be edited and sent again, or deleted.
  - **Session fields:** event name, one-off or weekly, open or private, date, start and end time, cost per player, max players, description.
  - **Staff:** an approvals queue (approve, or decline with a note), plus adding hosts.
- **Sign-in:** works through the existing RTD Staff Access application. No dashboard change is needed for staff. For hosts, its policy must let them in (Include → Everyone recommended); see [docs/RTD_HOST_PORTAL.md](docs/RTD_HOST_PORTAL.md#signing-in).
- **After a one-off:** n8n **RTD Host Follow-up** emails the host the day after, inviting them to run it again.
- **Into the diary:** n8n **RTD Host Sessions To Diary** emails the café about each new submission. It adds approved sessions to Event Index (Public or Private), and the sync puts them in the diary.
  - **Open sessions** show in full, with price and max players.
  - **Private sessions** show as "Private session" only.
- **Advertising:** open sessions appear in the evening and weekly round-up posts. Private ones never appear in posts or get posters: RTD Master V1 and Event Guard were changed to skip `App Visibility = Private`.
- **Tested live:** Dan signed in, created a session and withdrew it (5 Oct). A real approval through to the diary hasn't happened yet.

## Onboarding (2026-10-06)
- **One way in:** hosts and café staff sign in at `/organise` and ask to host. Everyone approved is a host and can only plan sessions. See [docs/RTD_ONBOARDING.md](docs/RTD_ONBOARDING.md).
- **Who approves:** approvers (Michelle) and admins (Dan) approve join requests and every session. Dan chooses approvers.
- **Emails:** n8n **RTD Team Notices** (every 15 minutes, live): join requests to the café, outcomes to applicants, and session decisions to hosts.
- **Not yet tried with a real request.**

## Push notifications for approvals (2026-10-06)
- **What they are:** approvers and admins turn on **Notifications on this device** in the organiser. They then get a push for every session and join request to approve, as well as the email. See [docs/RTD_PUSH.md](docs/RTD_PUSH.md).
- **On iPhone:** the app must be added to the Home Screen first (Apple's rule).
- **Not yet tried on a real phone.**

## Bookings (2026-10-06; café events since 2026-10-07)
- **Booking:** people book places on every public event (the café's own and open host sessions) from the event page, with no account and a Manage / Cancel link by email. Places are set by hosts (their sessions) and approvers (café events), or App Capacity in the sheet; none means no limit. See [docs/RTD_BOOKINGS.md](docs/RTD_BOOKINGS.md).
- **The café's info@:** a copy of every booking and cancellation, the numbers two days before each booked café event, and a warning if a booked date leaves the sheet. Customers' replies go there.
- **Places (2026-10-07):** hosts change their own live sessions' places; approvers set café events' places under **Places for café events**, or any single date's. Never below what's booked.
- **Privacy (2026-10-07):** notice at `/privacy`; booking details erased 12 months after the event. See [docs/RTD_PRIVACY.md](docs/RTD_PRIVACY.md).
- **Hosts:**
  - **Emails:** one for every booking and cancellation, and the numbers two days before each date.
  - **In the organiser:** they see who's coming and can cancel a date. Everyone booked is emailed, and the date is taken out of the Logic Engine.
- **Approvers:** **Bookings coming up** shows three weeks of hosted dates and booked café events, with contact details. They can cancel any of those dates, and everyone booked is emailed.
- **Emails:** n8n **RTD Outbox** (every 5 minutes, live) sends what the app queues.
- **Tested:**
  - **Automated:** 235 tests.
  - **Screens:** checked at 320, 375 and 1280px.
  - **Workflows:** live and simulated n8n runs.
  - **Not yet:** a real booking, and a real cancelled date changing the sheet.

**What's left for production:** see [docs/RTD_PRODUCTION_READINESS.md](docs/RTD_PRODUCTION_READINESS.md).

## Incomplete
- **Phase 2 leftovers:** privacy-friendly analytics (needs a Cloudflare Web Analytics token, or we use our own counts).
- **Phases 3–9.**
- **Roll Me a Game and Game of the Week** use a labelled *preview shelf* of sample games until Phase 4 brings the café's inventory.

## Known issues
- **Secrets in RTD Master V1:** the ImageKit private key and the Meta page access token are hard-coded. Rotate both (S1).
- **Website webhook:** `RTD Cafe Website Requests` is public and unvalidated (S3).
- **Event Guard local edit:** the new Monthly node must be mirrored in `rtd-poster-automation`, or its next build will undo it.
- **Blood on the Clocktower:** auto-rolled from 4 Oct to **4 Nov** before the monthly change, and a poster was generated for that date. Please confirm the date with Michelle.

## Next actions
0. You: set the RTD Staff Access policy to **Include → Everyone**, so new hosts and café staff can sign in and ask. Then have Michelle sign in at `/organise` and ask to host. Approve the request under **Join requests**, then press **Make approver** next to Michelle. Then try one open session end to end: approve it, book a place, check the emails, cancel the date. Turn on **Notifications on this device** (on iPhone, from the Home Screen app) and press **Send a test**.
1. You: open https://rtd-app.dan-289.workers.dev on your phone (and `/styleguide`) and tell me what to change. Add it to your home screen to try the installed app.
2. You: check which Standard Diary groups should appear publicly. **Now urgent, because every Public row can be booked.** They all default to Public: National Coastguard Institute, GirlsGetOut Ladies Night and DM Olivia are bookable today. Set private group bookings to `Private` in the sheet's `App Visibility` column: the diary then shows "Private session" at that time, so the café still looks busy. Use `Hidden` to leave a row out entirely.
3. You: push `rtd-poster-automation` to GitHub, so I can fold in the Guard and poster fixes.

## Required user input
- The café's **street address** for calendar entries (currently "Roll The Dice Board Game Café, Cleethorpes", `VENUE_LOCATION` in `wrangler.jsonc`).
- A **vector or higher-resolution logo**, if one exists. The current assets come from a 1423px JPEG, which is fine for screens; a vector would sharpen the large icons.
- The **initial game inventory** (name, players, play time, difficulty, style), for Phase 4.
- Answers to audit §12 items 6, 7, 9, 10 and 11.
