# Event-specific social master prompt: Phase A audit

18 October 2026. Read-only: nothing in the app, the Logic Engine or n8n was changed for this audit. It answers §4 and Phase A of the owner's brief ("RTD App — Event-Specific Social Media Master Prompt Integration"). Spreadsheet, Drive and secret IDs are deliberately left out (this repository is public); n8n workflow and credential IDs are not secrets.

## 1. Summary

- **The Logic Engine (Google Sheet `Logic Engine_RTD`) is the master for café events, and RTD Master V1 (n8n) is the social pipeline.** The RTD app mirrors the sheet every 15 minutes and is the master only for hosts' sessions, bookings and places. Nothing in the app generates or publishes social posts, apart from admin-written reminders.
- **Per-event prompts already exist, as free text in the sheet:** Event Index has `Michelle's Standard Prompt`, `Michelles KPI Hook Prompt`, `TikTok Video Blueprint` and `Banned Phrases`. They are hand-written, and some require claims that aren't in the event's `Base Details` (see §5). There is no generated, validated or versioned prompt.
- **Posts go out unreviewed:**
  - Every RTD post is published straight away (`shareNow` through Buffer).
  - There is no approval step.
  - The Facebook guardrail nodes are disabled.
  - The caption model is never given `Base Details`.
  - The Mon/Thu and Sunday round-ups put many events into one prompt.
  - Every join uses the **event name**, not the Event ID.
- **Unsupported claims are already being published.** Today's 19:00 Quiz post promises "cash prizes" and "book a table with us or simply drop in"; the approved description is "A family quiz night with prizes at stake!". The 19:30 Wednesdays post offers to "book a table or couch". Older Post Log rows are logged against the wrong event (a "Spooky Market" row holds a July Quiz post; a "Writing Club" row holds a Blood on the Clocktower post with an invented Storyteller and prizes).
- **There's no structured place for people or roles.** Names such as DM Liv, DM Alfie and MoreThanABitDicey live only inside `Base Details` prose. There is no "Forgotten Levels" event and no `setup_by` field in the live data.
- **Michelle has no account in the app yet.** The active staff accounts are Dan (admin) and Dan Hill (approver). An admin role for Michelle can't be "resolved from RBAC" until she joins.

## 2. Where the facts live today

### Logic Engine (Google Sheet), tabs used by social

| Tab | Columns (in order) | Used by |
|---|---|---|
| **Event Index** (24 rows) | Event Name, Frequency, Day, Event Date, Event Time, End Time, Post Frequency (Days), Last Post, Next Post, Target Post Time, Photo Folder ID, Base Details, Michelle's Standard Prompt, Michelles KPI Hook Prompt, TikTok Video Blueprint, Status, Banned Phrases, Organiser Email, Event ID, App Visibility, App Category, App Price, App Capacity, App Host Session | App sync (dates, times, details, visibility, price, capacity, host link); Master V1 (everything to the left of Event ID, plus App Visibility) |
| **Standard Diary** | Group, Day, Date, Notes, Frequency, Event ID, App Visibility, App Category | App sync; Master round-ups |
| **Daily Post** | Daily Prompt, Upcoming Prompt, Weekly Prompt (global "Michelle" personas) | Master round-ups |
| **Post Log** | Event Name, Script / Copy Content, Date Posted, Asset used, BufferID, Target Platform, Automation Status, Time Posted, metrics… | Master (append) |
| Meta Insights Log, Performance Sync, Event Performance, 30-Day Metrics Table | Metrics by **event name** / post ID | Master |

- **Event IDs:** `RTD-EVT-00001` and up, given once by n8n RTD Event Sync and written back. Never reused. They're immutable in practice, but nothing stops a person editing the cell.
- **Approval:**
  - **Café events have no approval state.** A row exists once Dan or Michelle types it, and runs while `Status` is `Active`. The `Organiser Email` on most rows is Dan's.
  - **Hosts' sessions** are approved in the app (`host_sessions`, `event_change_requests`), then written to Event Index by n8n RTD Host Sessions To Diary.
- **Schedule:**
  - one `Event Date` and `Event Time` per row (UK date format)
  - weekly and fortnightly rows are rolled forward by Master V1 at 01:00
  - monthly and one-off rows are expired by RTD Event Guard at 01:15
  - the app projects weekly dates itself (`src/sync/plan.ts`) and stores each date as an `occurrences` row (`RTD-OCC-<event>-<yyyymmdd>`), in London time with UTC instants (`src/lib/time.ts`)

### RTD app (Cloudflare Worker `rtd-app`, D1 `rtd-app`)

- **Tables:**
  - `events`: mirror of sheet rows, plus `sheet_values` (Stage 6), `booking_mode`, `capacity_override`
  - `occurrences`: dates
  - `host_sessions`
  - `event_change_requests`
  - `sheet_edits` (app → sheet writes, conflict-checked; RTD Sheet Writer is **unpublished**)
  - `audit_log` (append-only)
  - `settings`
  - `sync_runs`
  - …the latest migration applied in production is `0022`; `0023_enquiries` is built but not applied.
- **Sync in** (`src/sync/normalise.ts`): reads Event Name/Group, Frequency, Event Date/Date, Event Time, End Time, Base Details/Notes, Status, Photo Folder ID, Event ID, App Visibility, App Category, App Price, App Capacity, App Host Session. It **does not** read the prompt columns, Banned Phrases or posting cadence.
- **Roles** (`src/lib/auth.ts`, `users.role`): `host`, `staff` (approver), `admin`. Cloudflare Access proves the email address; the `users` table decides the role. Admin-only screens are checked on the server (e.g. `adminOnly` in `src/events/admin.ts`).
- **Social in the app:** only admin-written event reminders (`src/notify/alerts.ts`). n8n "RTD Event Reminders To Facebook" posts them through Buffer every minute. No AI is involved.

## 3. n8n workflows in the social path

The single Gemini credential is **"Google Gemini(PaLM) Api account"** (`googlePalmApi`, id `7ogDwZye4Zp9WpOc`). Buffer posts use **RTD Buffer** (`RQOwar11orSbD5ji`); the app calls use **rtd-app** (`PveFQOiLEm52Hy2G`). Every live RTD workflow sends errors to Studio: Error Handler (`IClMUs9ByRmVBYJf`).

| Workflow (id) | State | What it does for social |
|---|---|---|
| **RTD Master V1** (`yPhchrcwuJSt3RLI`, 178 nodes) | Active | See the breakdown below |
| **RTD Event Guard (sub)** (`RtdEventGuardSub1`) | Active, 01:15 | Expires past one-off and monthly rows (Status → Inactive, by row). Asks RTD Poster Generator for each Active future event's poster. "Request New Date (Sub)" is disabled. Matches events by **name** |
| **RTD Poster Generator (sub)** (`PVo8OZ59Qh5LA263`) | Active | Gemini image edit (`gemini-3.1-flash-image-preview`) from the event's `.Stable` image, with name, date, time and Base Details. Its prompt says the only text on the poster is the quoted text. Keyed by name + date, so a poster is **never redone when the time or details change**. Has locks |
| **RTD Auto-Draft Event Copy** (`Wo2tQEn5T9l2yQlF`) | Inactive | Gemini JSON copy for a separate Render_Engine › Events tab, with a per-event "Reel Brief" guardrail. Matched on **Event ID**. Doesn't publish |
| **RTD Render Engine V1** (`Ys5WB7lokdyZfPCy`) | Inactive | Reels with an **Approved By** gate, staleness and lead-time checks, and one orphaned Gemini script node |
| **RTD Seats Check** (`cDEhmPvkCRenA6fA`) | Inactive | Emails for seat counts; rows are queued unapproved |
| **RTD Event Reminders To Facebook** (`2BLoRwo7Fvtdu2ya`) | Active | Admin reminders from the app, through Buffer |

### RTD Master V1 in detail

- **Facebook event post:**
  - Runs every 30 minutes from 19:00 to 22:30 and picks at most one event per run (`Is Event Due Right Now?`: Next Post ≤ today).
  - **"Gemini Engine: Michelle Voice"** (`gemini-3.6-flash`, plain text) is given the row's `Michelle's Standard Prompt`, or the KPI Hook Prompt when Facebook views are under 500, plus a Day/Date/Time block. **`Base Details` is not passed.**
  - "Guardrail Check (Master)" is **disabled**.
  - It posts with shareNow, attaching the poster, theme photos and 2–5 random photos from the Photo Folder.
  - It then advances Next Post and appends to Post Log, which records "Failed" even when the post worked (today's two posts).
- **Mon/Thu Prospectus and Sunday Weekly round-ups** (`Find Next 2 Diary Days & Build Prompt`, `Find Next 7 Days Events & Build Prompt`): many events go into one Gemini prompt with no times and no per-event rules, then are posted with no guard.
- **Instagram:**
  - "Priority" (Mon, Wed and Sat at 20:15) and "Food" (daily at 09:15) carousels.
  - Captions are checked only for banned words.
  - The Priority caption gets **no date** and doesn't advance Next Post. The priority list is a fixed list of event **names**.
- **Food and café posts** use generic prompts with no event facts.
- **Housekeeping:**
  - 00:00 Google Calendar rebuild (doesn't filter Inactive or Private rows)
  - 01:00 date roll-forward
  - 01:15 Event Guard
  - every-4-days Meta metrics
- **Identity:** event **names** are used throughout. Event ID is read but never used. Writes go by row number.
- **Security:** the read-only review reports a Meta Graph access token and an ImageKit authorisation header typed into node parameters rather than stored as credentials. **To confirm and move into credentials.**

## 4. Existing guardrails worth keeping

- Per-row **Banned Phrases** (for example "open table, dropping in, drop in" on the D&D rows).
- The sheet prompts' "Event-accuracy guardrails (mandatory)" paragraph: "Only describe this specific event… do not invent extra details, prizes, guests, offers, or dates… Never describe this session as an 'open table'…".
- The Poster Generator's text-only-what's-quoted rule.
- Private rows are skipped by the Facebook event post and both round-ups (they aren't skipped by Instagram Priority).
- Event Guard's refusal to run when columns are missing or when more than 3 rows would expire at once.
- The app's own patterns, all tested:
  - change queues with conflict checks (`sheet_edits`)
  - approvals (`event_change_requests`)
  - the append-only audit log
  - feature switches in `settings` (`sheet_writes`, `needs_attention`)

## 5. Findings that decide the design (need the owner)

1. **What counts as an "approved fact"?**
   - `Base Details` is short: "A family quiz night with prizes at stake!", "A weekly get together to play silly games and learn something new".
   - The hand-written prompts *require* extra claims: "open to all experience levels, including first-time adventurers", "booking a seat in advance is essential" (D&D). Today's Quiz post adds "cash prizes" and drop-in.
   - Under the brief, a validator would block those claims unless they're approved somewhere structured.
2. **People and roles have no field.** To name "Trixie, setting it up", the Logic Engine needs a structured column, for example `People & Roles` such as "Trixie — sets up". Adding columns to Event Index is a Logic Engine change that the owner should approve, and RTD Event Sync and the app sync would need to carry it.
3. **Café events have no approval.** "Approved" can only mean "Active in the sheet, typed by the café". Host-submitted descriptions are approved in the app already.
4. **Round-ups blend events by design** (Prospectus, Weekly). The brief allows a set of events only "when explicitly promoting that verified set". They need per-event blocks drawn from each event's own approved prompt, or they need to stop.
5. **Where the validator runs.**
   - The brief requires a deterministic validator that is independent of Gemini.
   - The app (TypeScript, with tests, owning dates and occurrences in London time) is the natural place: n8n would call it before every Buffer post and treat a failure as fail-closed.
   - The master prompt and its state would still be stored against the Event ID in the Logic Engine, with history in the app's audit log.
6. **Michelle needs an account** before she can review exceptions. She joins at `/organise` and Dan approves her as admin, if that's intended.

## 6. Integration points (where the master prompt must be applied)

1. Master V1 → "Pair With Event Metrics" → **"Gemini Engine: Michelle Voice"** (Facebook event post).
2. "Find Next 2 Diary Days & Build Prompt" → "Gemini: Prospectus Post"; "Find Next 7 Days Events & Build Prompt" → "Gemini: Weekly Recap Post".
3. "Match Events & Build Prompt" → "Gemini: Daily Recap Post" (trigger disabled).
4. "Select Priority Content" / "Aggregate Images (Priority)" → "Generate Caption (Priority)" (Instagram).
5. Posters: Event Guard "Evaluate Events (Guard)" → "Ensure Poster (Sub)" → Poster Generator "Set Target Folder" → "Gemini: Generate Poster".
6. Inactive paths to keep closed, or to put through the gate if they're ever revived: Auto-Draft "Draft Event Copy", Render Engine captions and "Gemini: Messenger Script", "Gemini: Video Hook Text".
7. **The publishing gate:** immediately before each "Post to Buffer (…)" and "Buffer: Instagram Carousel (…)" node, with the final caption, the image prompt and the target occurrence.

Food and café-vibes rows (Food1–3, Drinks, Cafe Vibes) aren't events. They'd keep their current prompts, unless the owner wants them included.

## 7. Risks

| Risk | Where | Effect |
|---|---|---|
| Unsupported claims published | Master Facebook post (no Base Details, guardrail off), round-ups | Live today (cash prizes, drop-in, couch) |
| Cross-event contamination | Round-ups, name-based joins, Post Log rows on the wrong event | Facts, dates or photos attributed to the wrong event |
| Stale schedule | Roll-forward changes the date only; posters keyed by name + date; Instagram Priority has no date | An old time on a poster or in a post |
| No approval or fail-closed path | shareNow everywhere | Nothing stops a bad post |
| Renaming an event breaks links | Names used as keys in Master, Guard, metrics and photos | Silent mismatches |
| Logging bugs | Post Log "Failed" on success; "Facebook Posted Food Today?" date-format mismatch | Wrong records, possible repeats |
| Secrets in node parameters | Meta token, ImageKit header (reported) | Exposure through exports and version history |
| Rate limits | Up to 8 Facebook posts a night, plus round-ups, plus Instagram; Gemini calls unthrottled | Spam-like volume |

## 8. Backups and rollback available today

- **n8n:** version history on every workflow. Earlier stages recorded before and after version IDs; publishing an old version is the rollback.
- **Logic Engine:** whole-sheet backup copies made by the one-off workflows (the 5 October backups), plus the staging copy (16 October) for tests. Google's own version history.
- **App:** D1 Time Travel restore points (used before migrations 0021 and 0022), `npx wrangler rollback`, and additive migrations only.
- **Monitoring:** Studio: Error Handler → Studio: Notify (one email per key per 6 hours); RTD Event Automation Log; `sync_runs` and `audit_log` in the app.

## 9. Proposed next step (Phase B, after the owner answers §5)

1. A minimal design:
   - new Event Index columns, keyed by Event ID: master prompt, prompt status, version, source fingerprint, people and roles
   - a Gemini JSON contract
   - an app validator endpoint
   - n8n diffs for the seven integration points
   - a feature switch, defaulting to shadow mode (generate and validate, but publish as today), then enforce
2. A written spec for the owner's review, before any change.
