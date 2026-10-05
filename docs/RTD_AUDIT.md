# RTD Phase 0 Audit

_Audit date: 2026-10-05. Read-only: nothing in n8n, Google Sheets or Drive was changed._

Scope: every workflow, data table and credential on the n8n instance (`n8n.arkham-survey.com`, running on the Pi), plus the RTD Logic Engine data as seen through recent workflow runs. The Google Sheets were not opened directly; their structure comes from node configuration and execution data.

## 1. Summary

- **The RTD Logic Engine is a Google Sheet**, `Logic Engine_RTD`. Its `Event Index` tab (dated, timed events) and `Standard Diary` tab (recurring groups, no times) drive everything live: social posting, the Google Calendar, recurring date roll-forward, posters and expiry.
- **Live and working well:** social posting through Buffer, the Event Guard (expiry + posters), the poster generator, the date roll-forward and the shared Studio error handling. These should be kept.
- **No booking, approval or host system is live.** The approval design the spec refers to exists only in the inactive `RTD — Master Booking Workflow`, which has never run on this instance and points at an old n8n Cloud URL. Its *design* is reusable; the workflow itself is not.
- **There are no event IDs.** Event Name is the identity everywhere. One event is split across two rows by a letter on the end of its name, and free text sits in the date column.
- **Recurring events overwrite their date in place.** The sheet only ever holds the *next* date, so the app must derive occurrences itself and never treat a date change as an edit of history.
- **There are three event stores, joined by name:** Logic Engine, `RTD_Booking` (inactive) and `Render_Engine_RTD` (an .xlsx, inactive).
- **Security issues need fixing regardless of the app:**
  - A hard-coded ImageKit private key in two nodes.
  - Public, unauthenticated approval forms (inactive) and an open website webhook (active).
- **Fragility:** one Google OAuth client powers every RTD workflow. Its deletion on 2 October stopped all RTD automation for about 34 hours.

## 2. Current architecture

```
                 Google Sheet "Logic Engine_RTD"
                 ├─ Event Index      (dated events + social content rows)
                 ├─ Standard Diary   (recurring groups, all-day)
                 ├─ Post Log / Performance Sync / Meta Insights Log
                 └─ Daily Post / weekly prompt tabs
                          │
                          ▼
   RTD Master V1  (178 nodes, 10 schedule triggers, active)
   ├─ 00:00  Calendar Refresh ──► Google Calendar "Roll The Dice Cafe" (delete + recreate 30 days)
   ├─ 01:00  Calculate next dates ──► overwrites Event Date / Date in place
   ├─ 01:15  Event Guard (sub) ─┬─► Status → Inactive for past one-off events
   │                            ├─► RTD Event Date Change (sub) ──► email date-picker form
   │                            └─► RTD Poster Generator (sub) ──► Gemini ──► Drive <Event>/Posters/
   ├─ 19:00–22:00 every 30 min  Master Content Flow ──► Gemini copy ──► Buffer (Facebook)
   ├─ Mon/Thu 20:00  Prospectus post   ├─ Sun 20:30  Weekly post
   ├─ every 2 days 08:30  Food Ad Flow ├─ Mon/Wed/Sat 20:15 + daily 09:15  Instagram carousels (ImageKit + Buffer)
   └─ every 4 days  Meta Graph metrics ──► Meta Insights Log
          │
          └─ errors ──► Studio: Error Handler ──► Studio: Notify (emails Dan only) ──► Studio: Log Event

   Inactive, never live here:
   RTD — Master Booking Workflow ── Google Sheet "RTD_Booking" (Events / Bookings / Config / Responses)
   RTD Seats Check, RTD Render Engine V1, RTD Auto-Draft ── "Render_Engine_RTD" (.xlsx)

   Active, prototype only:
   RTD Cafe Website Requests ── public webhook ──► data table + email to Dan
```

## 3. Component verdicts

| Component | Status | What it does | Verdict | Why |
| --- | --- | --- | --- | --- |
| `Logic Engine_RTD` sheet | Live | Master event data, prompts, post log | **KEEP + MODIFY** | Stays authoritative. Add `Event ID`, `App Visibility` and `App Category` columns at the end, so no existing column letters move. **Done 2026-10-05.** |
| RTD Master V1 → Calendar Refresh | Live | Rebuilds Google Calendar daily | **KEEP**, modify later | Works, but delete-then-recreate leaves the calendar empty if the create step fails. Later: upsert with stable IDs from the app DB. |
| RTD Master V1 → Calculate next dates | Live | Rolls recurring dates forward | **MODIFY** | "Monthly" means same day-of-month in Event Index but every 28 days in Standard Diary. Standard Diary ignores `Two-Weekly`. |
| RTD Master V1 → social / Instagram / metrics flows | Live | Facebook, Instagram, Meta metrics | **KEEP** | Outside the app's scope. Fix the hard-coded key (§8) and the unfilled `REPLACE_WITH_CAFE_VIBES_FOLDER_ID`. |
| RTD Master V1 disabled nodes | Off | Creatomate render chain, Daily Recap trigger, Master guardrail | **RETIRE** | Remove after an export. They add weight to a 178-node workflow. |
| RTD Event Guard (sub) | Live | Expires past one-off events, ensures posters | **KEEP + MODIFY** | Already does the spec's "Event Expiry & Redating". Modify: key on Event ID; take the recipient from config; tell the app when an occurrence completes. |
| RTD Event Date Change (sub) | Live, never fired | Emails a date-picker form; writes the new date back | **KEEP + MODIFY** | Matches spec §12, but the expire path has never run in production. Recipient is hard-coded. |
| RTD Poster Generator (sub) | Live | Gemini poster per event date, with locking | **KEEP** | Solid: idempotent filename, lock, re-check, validation. Posters can feed app event images. |
| RTD Event Automation Log (data table) | Live | Per-run guard log | **KEEP** | Becomes one source for the app's audit view. |
| Studio: Error Handler / Notify / Log Event | Live | Error capture, deduplicated alerts to Dan | **KEEP, reuse** | Matches spec §36. Café-facing notices need a separate RTD path (§11). |
| RTD — Master Booking Workflow | Inactive, 0 runs | Google Form requests → approve/reject/suggest time → organiser reply → day-3 check → attendee emails | **REPLACE** (reuse design) | Links point at `danatechstudio.app.n8n.cloud`; forms are unauthenticated; IDs are timestamps; bookings are sheet rows with no capacity enforcement. |
| `RTD_Booking` sheet | Unknown | Events / Bookings / Config / Responses | **REPLACE** | May hold real history. Check before retiring (§12). |
| RTD Seats Check | Inactive | Emails the organiser to ask how many seats are left | **RETIRE** | The app will know real headcount. |
| RTD Render Engine V1, `Render_Engine_RTD` | Inactive | Reel rendering queue | **KEEP parked** | Out of app scope. Later, read capacity and seats from the app instead of its own Events tab. |
| RTD Auto-Draft Event Copy | Inactive | Gemini reel copy | **KEEP parked** | Out of app scope. |
| RTD Cafe Website Requests | Active | Prototype website booking/contact webhook | **MODIFY now, RETIRE booking later** | Open webhook with PII and HTML injection (§8). Holds only 2 test rows. |
| RTD Cafe Site Update / Site Images | Inactive | Website rebuild tooling | Out of scope | Not part of the app. |
| Spooky Market '26 workflows | Inactive | One-off vendor mail merge | **RETIRE** after 17 Oct | One-off event tooling. |
| — | — | App DB, API, PWA, push, games, GotW, host portal, staff control, booking, digest | **NEW** | Nothing exists today. |

## 4. Event data review

### Stores

| Store | Holds | Identity | Live? |
| --- | --- | --- | --- |
| `Logic Engine_RTD` → Event Index | 23 rows: events and social content | Event Name | Yes |
| `Logic Engine_RTD` → Standard Diary | Recurring groups (e.g. Arkham Horror Card Game, weekly) | Group name | Yes |
| `RTD_Booking` → Events / Bookings | Host requests and bookings | `RTD-yyMMdd-HHmmss` | No |
| `Render_Engine_RTD` → Events | Capacity, seats, price label, reel copy | `Event ID` (own scheme), joined to Logic Engine by name | No |
| Google Calendar "Roll The Dice Cafe" | Rebuilt daily from Logic Engine | None (recreated daily) | Yes |
| Google Calendar "Roll The Dice Public Events" | Written by the booking workflow | Stored back in `RTD_Booking` | No |

### Event Index columns (confirmed from a 5 Oct run)

`Event Name`, `Frequency`, `Day`, `Event Date` (DD/MM/YYYY text), `Event Time`, `End Time`, `Post Frequency (Days)`, `Last Post`, `Next Post` (date cells rendering as US M/D/YYYY), `Target Post Time`, `Photo Folder ID`, `Base Details`, `Michelle's Standard Prompt`, `Michelles KPI Hook Prompt`, `TikTok Video Blueprint`, `Status`, `Banned Phrases`, `Organiser Email`.

Nothing for capacity, visibility, category or a public description.

### Current rows (Event Guard log, 5 Oct)

- **Active with a valid future date (7):** Quiz, Bingo, Kids Chess Club, Blood on the Clocktower, Home Education Support ClubM, Home Education Support ClubT, Spooky Market.
- **Active, no usable date (9):**
  - Social content: Cafe Vibes, Food1, Food2, Food3, Drinks.
  - Real events with no date set: Dungeons & Dragons, Magic: The Gathering.
  - Text in the date column: Cleeples ("Every Thursday"), Wednesdays ("Open Wednesdays!").
- **Inactive (7):** BritQuiz, MicNight, SazLou, DM Alfie's DnD, DM Liv's DND, plus BookClub and Writing Club, which still carry future dates.

### Data-quality issues

1. **No permanent IDs.** The name is the key, so renaming an event breaks posters, the guard log and date changes. Duplicate names make the date-change sub refuse to act.
2. **Name hacks:** "Home Education Support Club**M**" / "Club**T**" are one event on two weekdays. The poster prompt strips the trailing capital to hide it.
3. **Free text in `Event Date`** ("Every Thursday", "Open Wednesdays!").
4. **Mixed date formats:** Event Date is UK text; Last/Next Post render as US. The posting code has to guess the order per row.
5. **Events and social-content rows share one tab.** Food1–3, Drinks and Cafe Vibes must never reach the diary.
6. **Status semantics differ:**
   - Posting treats anything except `Inactive` as live.
   - The guard requires an exact `Active` for posters.
   - Inactive rows can still hold future dates.
7. **Monthly recurrence is inconsistent** (calendar month vs 28 days). Blood on the Clocktower moved 4 Oct → 4 Nov. That is only right if it really runs on the 4th, not "first Sunday".
8. **Placeholder data:** `Organiser Email` for Quiz is `dan@atechstudio.co.uk`.
9. **Poster title rule.** The poster prompt strips any trailing capital after a lower-case letter, to hide the "ClubM" workaround. That would also print "DM Alfie's Dn" for "DM Alfie's DnD". The app limits the rule to weekday initials (M/T/W/F/S). The same fix belongs in `rtd-poster-automation`.

## 5. Booking review

- **Nothing is live.** The only active booking path is the website prototype webhook, which stores a request and emails Dan. It holds 2 test rows and does no capacity check.
- The inactive `RTD_Booking` design:
  - Bookings come from a Google Form into a `Bookings` tab.
  - `Booked Attendees` is a sheet formula.
  - Nothing stops overbooking, and there is no cancellation, waitlist or tokens.
  - Attendee emails are read from a column literally named `Email Address ` (trailing space).
- **Conclusion:** build booking new in the app DB with transactional capacity control (spec §19–24). There is nothing to migrate except any real rows in `RTD_Booking` (§12).

## 6. Approval review (spec §27 determination)

The spec assumes an existing approval process that is "already close to the desired model". **The design is close, but nothing is running.**

| Spec step | Existing design (inactive workflow) | Decision |
| --- | --- | --- |
| Host submits | Google Form → `Responses` tab | Replace with Host Portal form |
| Staff approve / reject | `Cafe Decision Form`: Approved / Rejected / Suggest New Time | **Reuse the decision model**, including "Suggest New Time" |
| Host responds to a suggested time | `Organiser Time Response Form` | **Reuse** |
| Pre-event go-ahead | Day-3 check: Go Ahead / Cancel, emails attendees on cancel | **Reuse** as an optional host confirmation |
| Approved → public | Writes `Public Calendar Event ID`, creates a calendar event | Replace: on approval, n8n appends the event to Logic Engine Event Index; sync brings it to the app |

**Do not reactivate the workflow.** Its forms are public URLs that take `eventId` as a query parameter, so anyone with the link can approve, reject or cancel any event. Its links also point at an n8n Cloud instance that is no longer used. Rebuild the same states in the app, with signed, single-use action links and Staff Control buttons. Keep n8n for the notifications.

## 7. Spec coverage

| Requirement | Existing | Gap |
| --- | --- | --- |
| Master event source | ✅ Logic Engine | Needs IDs, visibility, category |
| Recurring roll-forward | ✅ Live | Inconsistent monthly rules; overwrites in place (app must derive occurrences) |
| Expiry + redating email (§12) | ✅ Live (untested path) | Hard-coded recipient; keys on name; recurring events never ask for redating (they auto-roll) |
| Posters / promo artwork | ✅ Live | App can reuse Drive posters as event images |
| Social automation | ✅ Live | — |
| Error handling / alert policy (§36) | ✅ Studio workflows | Alerts go to Dan only |
| Audit log (§34) | ⚠️ Partial (guard log, Post Log) | No app or booking audit |
| Event approval (§27) | ⚠️ Design only | Rebuild |
| Event IDs / occurrences (§9) | ❌ | New |
| App DB / API / PWA / diary / splash | ❌ | New |
| Booking, waitlist, cancellation | ❌ | New |
| Host portal, Become a Host, Staff Control | ❌ | New |
| Push notifications, reminder scheduler | ❌ | New |
| Game library, Roll Me a Game, Game of the Week | ❌ | New |
| Daily staff digest (§33) | ❌ | New (copy the `Studio: Publication Digest` pattern) |
| Central config `RTD_CAFE_NOTIFICATION_EMAIL` (§38) | ❌ | New |

## 8. Security findings

| # | Severity | Finding | Action |
| --- | --- | --- | --- |
| S1 | **High** | Secrets are hard-coded in RTD Master V1, where anyone who can read or export the workflow can see them:<br>• the ImageKit **private API key**, as a Basic auth header in `Upload to ImageKit (Priority)` and `Upload to ImageKit (Food)`;<br>• the Meta (Facebook) page **access token**, as an `access_token` query parameter in the four `Get Recent Posts (Meta)` / `Get Post Metrics (Meta)` nodes (found by n8n's validator on 5 Oct). | Rotate both (ImageKit dashboard; Meta Business settings), store them as n8n credentials (Header Auth; Query Auth), and reference those. |
| S2 | High (if reactivated) | Master Booking forms are unauthenticated, with `eventId` in the URL, so decisions can be forged. | Do not reactivate. Use signed, expiring action tokens (spec §42). |
| S3 | Medium | `RTD Cafe Website Requests` webhook is active and public: `Access-Control-Allow-Origin: *`, no auth, no rate limit, no validation. User input goes straight into an HTML email (HTML injection), and PII is stored in an n8n data table. | Deactivate until the website launches, or add a shared secret, validation and HTML escaping. Retire its booking path once the app takes bookings. |
| S4 | Medium | Recipient addresses are hard-coded in workflow code (`shellyandrews@ntlworld.com` in the guard and date-change logic; `dan@atechstudio.co.uk` in Notify and Website Requests). | Move them to one RTD config source (§11). |
| S5 | Medium | The `RTD Buffer` credential is also used to post Ninth Archive / Ninth Volume content to TikTok (per those workflows' descriptions). | Confirm this is intended. Otherwise separate the accounts so RTD's channels can't carry other brands' posts. |
| S6 | Unverified | Whether the n8n editor at `n8n.arkham-survey.com` is publicly reachable couldn't be checked from this environment. | Confirm the editor and REST API sit behind auth or an access proxy, with only `/webhook/*` and `/form/*` exposed (spec §42). |
| S7 | Info | Personal data (organiser emails, booking requests) lives in Google Sheets and n8n data tables with no retention rule. | Define retention before production (spec §49). |

## 9. Reliability findings

- **Single OAuth dependency.** "The OAuth client was deleted" (`EAUTH`) failed every Logic Engine read from 2 Oct 08:15 to 3 Oct 18:30, about 19 failed runs. All posting and calendar sync stopped. The app must not depend on this path at page-load time (spec §3); sync can lag but must never break the public app.
- **Monolith.** RTD Master V1 holds 178 nodes and 10 triggers, so any edit risks every flow. Split it into separate workflows later, after an export, without changing behaviour.
- **Non-idempotent calendar rebuild** (§3).
- **Untested expiry path.** No `DEACTIVATED` or `DATE_CHANGE` rows exist since the guard went live on 26 Sep. Exercise it with the dry-run trigger before relying on it.
- **Source of truth outside Git.** Guard, date-change and poster code is generated from `~/projects/rtd-poster-automation` on the Pi ("edit there, not here"). It isn't in any repo this session can see, so it needs to be under version control before it is modified.
- **Good patterns to copy:** dry-run mode, the "refuse if more than 3 expiries" circuit breaker, data-table locks, retry on Sheets nodes, the Studio notify cooldown.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| App shows content rows or stale events | New `App Visibility` column defaults to hidden. Only explicit `Public` / `App Bookable` / `Private` rows sync. |
| Date roll-forward erases history | App derives occurrences keyed on (event_id, date) and never updates a past occurrence (§11). |
| Renaming an event duplicates it | Permanent `Event ID` column, backfilled once. Sync keys on ID only. |
| Google auth outage | App DB is off-Pi and serves the last good data. Sync records failures in `sync_runs`; Studio alerts. |
| Hosts write straight to the master sheet | Hosts write to the app only. n8n appends to Event Index after staff approval. |

## 11. Target architecture and migration plan

```
Logic Engine_RTD (Sheet, authoritative for schedule)
   │  ▲ approved host events appended by n8n
   ▼  │
n8n (Pi)  ── RTD Event Sync (every 15 min + on demand) ──► App API /internal/sync (HMAC-signed, idempotent upsert)
   │      ── Event Guard / Date Change / Posters (existing, modified)
   │      ── RTD Notify (café channel; Discord later)  ── reads rtd_config
   │      ── Daily Digest, Reminder Scheduler, Game of the Week
   ▼
App DB + API (hosted off-Pi; Postgres, e.g. Supabase)
   ├─ events, occurrences, bookings, waitlist, hosts, host_applications,
   │  games, game_of_week, notifications, audit_log, sync_runs, settings
   └─ PWA (customer), Host Portal, Staff Control
```

**Field ownership:**
- **Logic Engine owns:** identity, name, schedule, frequency, status, base details, photo folder, and the new `App Visibility` / `App Category`.
- **App DB owns:** occurrences, capacity and booking settings, bookings, waitlist, hosts, games, notifications, audit.

**Occurrence rule:**
- `occurrence_id = RTD-OCC-<event_id>-<yyyymmdd>`.
- A new sheet date creates a new occurrence.
- When the previous date has passed, that occurrence is marked `completed`.
- If the previous date is still in the future, it is a reschedule:
  - With no bookings, the occurrence moves to the new date.
  - With bookings, it is flagged in Staff Control and the booked customers are notified.

**Migration steps.** Each is non-destructive and reversible.

1. **Export before touching anything.** Save JSON exports of every RTD workflow (and a copy of both RTD sheets) into a dated backup. **Done for the changes made so far:** n8n version history holds the rollback points, and a Drive copy of the Logic Engine was taken.
2. **Fix S1 and S3** (key rotation, webhook protection). These are independent of the app.
3. **Add three columns** to the end of Event Index and Standard Diary: `Event ID`, `App Visibility`, `App Category`. Backfill IDs (`RTD-EVT-00001`…). No existing workflow reads these columns, so nothing breaks. **Done 2026-10-05.**
4. **Create `rtd_config`**, an n8n data table (key/value) holding `RTD_CAFE_NOTIFICATION_EMAIL` and other RTD settings. Point the guard and date-change recipient at it, in the `rtd-poster-automation` source. **Table created 2026-10-05; the recipient change waits on that source.**
5. **Phase 1 build (in this repo):**
   - DB schema and migrations, auth (Staff/Host roles), audit log, and the `/internal/sync` endpoint.
   - The `RTD Event Sync` workflow, which reads only; the sheet is never written.
   - Test against a copy of the sheet first.
6. **Switch the guard to key on `Event ID`** and post `occurrence.completed` to the app.
7. **Later phases** as in the spec. Retire RTD Seats Check, Master Booking and the website booking path once app booking is live.

**Rollback:** steps 3–6 are additive. Disabling `RTD Event Sync` returns the system to today's behaviour, and the new sheet columns can be hidden.

## 12. Decisions needed from you

1. **Hosting:** OK to host the app on Supabase (DB + auth) with a static PWA host (Vercel or Cloudflare Pages), off the Pi? Which domain should it live on?
2. **Café email:** what is the fixed café notification address? Date-change requests currently go to `shellyandrews@ntlworld.com`.
3. **Sheet changes:** may I add `Event ID`, `App Visibility` and `App Category` columns to the end of Event Index and Standard Diary?
4. **Monthly events:** for Quiz, Bingo, Blood on the Clocktower and BookClub, is each a fixed date (e.g. the 23rd) or an "Nth weekday" (e.g. the 4th Friday)?
5. **`RTD_Booking` sheet:** does it hold real events or bookings worth keeping? Is its Google Form still public?
6. **Website prototype webhook:** may it be deactivated or locked down now (S3)?
7. **ImageKit key (S1):** you'll need to rotate it in ImageKit. I can then move it to a credential.
8. **`rtd-poster-automation` source:** can it be pushed to GitHub, so the guard logic is versioned and I can change it?
9. **Shared Buffer account (S5):** is posting Ninth Archive content through `RTD Buffer` intended?
10. **Diary contents:**
    - Should Standard Diary groups (e.g. Arkham Horror Card Game) appear in the app diary?
    - Should BookClub and Writing Club, which are inactive but have future dates, show?
11. **Booking emails:** which transactional email provider should send booking confirmations, so bookings work even when the Pi is down? Options: Supabase SMTP, Resend or Postmark.

### Answers (2026-10-05)

| # | Decision | Action taken |
| --- | --- | --- |
| 1 | Use Cloudflare (already in use with the Pi); Pi reliance is acceptable where needed | App on **Cloudflare Workers + D1**, Staff/Host sign-in via **Cloudflare Access**. n8n on the Pi remains for automation only. See [RTD_APP_ARCHITECTURE.md](RTD_APP_ARCHITECTURE.md). |
| 2 | Café email confirmed | Stored once in n8n data table `rtd_config` (`RTD_CAFE_NOTIFICATION_EMAIL`) |
| 3 | Yes, add the columns | Added and backfilled, after a Drive backup ([RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md)) |
| 4 | Monthly dates vary: ask Michelle for each new date | Master V1 no longer auto-rolls Monthly. The Guard now expires passed monthly events and sends the date-picker email. Published and dry-run tested. |
| 5 | `RTD_Booking` holds only test/prototype data | Nothing to migrate. The workflow can be retired when app booking is live. |
| 8 | `rtd-poster-automation` may go into GitHub | Waiting for it to be pushed. Then: mirror the Guard edit, read the recipient from `rtd_config`, fix the poster title rule. |
| 6, 7, 9, 10, 11 | Not yet answered | 6: website webhook (S3). 7: ImageKit and Meta key rotation (S1). 9: Buffer account sharing (S5). 10: diary contents (current default: Standard Diary groups Public, inactive events hidden). 11: booking email provider. |
