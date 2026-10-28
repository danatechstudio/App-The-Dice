# RTD n8n Workflows

n8n runs on the Pi at `n8n.arkham-survey.com`. The full inventory and verdicts are in [RTD_AUDIT.md §3](RTD_AUDIT.md#3-component-verdicts). This file tracks what the app relies on and every change made.

## Changes made

### 2026-10-21: Stage 2 final fixes (drafts only, not published)

The final whole-branch review's fixes, in drafts only. The owner publishes them at G5 (and the Builder at G4), with the switch Off.

**Versions recorded before any edit** (the rollback points; nothing below is published):

| Workflow | Published before this wave (unchanged) | Draft before this wave |
| --- | --- | --- |
| RTD Master V1 `yPhchrcwuJSt3RLI` | `37f21195-a767-4ee2-96a8-09770c3703a2` | `1c0677ca-0f17-4c87-9e53-c9bdfdf63883` |
| RTD Social Gate (sub) `NqC8fZUoIWWuvDnt` | `d71d6ebe-2fda-45a9-922f-02767f7bd5f1` | same as published |
| RTD Social Context (sub) `QCjohGtBuld6k5R8` | `013e6526-407b-4da7-99a1-5f550a0c2cfb` | same as published |
| RTD Social Prompt Builder `lh9MzioBdpBpBIVo` | not published | `4714d38a-fe06-40f8-aab5-c68e47cf12ea` |

**After** (every published version checked again at the end, unchanged; nothing published, the app's switch stayed Off):

| Workflow | Published | New draft (publish at G5 / G4) |
| --- | --- | --- |
| RTD Master V1 | `37f21195-…` | **`3164d3c3-329d-437a-8925-315fcb6de6d2`** (`8fd60ce4-…` was the same change before the two new nodes were moved into place on the canvas) |
| RTD Social Gate (sub) | `d71d6ebe-…` | **`8767fea0-852b-4c8b-848d-8c37a5ad14f9`** |
| RTD Social Context (sub) | `013e6526-…` | **`dfa485a4-230b-4a32-b766-3cc97548a01b`** |
| RTD Social Prompt Builder | not published | **`8be0614a-4b08-4881-bce7-c57689005497`** (via `920b6e3c-…`) |

The Gate and Context subs are now part of G5: publish their drafts with the Master V1, Poster Generator and Event Guard drafts. Manual test runs call the subs' drafts, so the Off proof below already ran against these drafts.

**What changed**
1. **Café rows skip the check on the Facebook event post** (Master V1). Two IF nodes, the same test as Instagram Priority's (App Visibility `Hidden`, or the name is Cafe Vibes, Food1, Food2, Food3 or Drinks, ignoring case; a blank visibility still goes through the check): **Cafe Row? (Event Post)** between Pair With Event Metrics and Social Context (true → Gemini with exactly today's prompt), and **Cafe Row Skips Gate? (Event Post)** between Build Photo Context and Social Gate (true → Post to Buffer as today). Such a row posts as today at every setting.
2. **Unchecked posts are visible.** When the Gate gives no usable check but the post goes out (`post: true` with a `held_reason`), the success Post Log row reads `Success; unchecked: <reason>`: Write Execution Transaction Log, Log Successful Post1 (Prospectus), Log Successful Post2 (Weekly) and Log Success (Priority IG). The round-up logs had no Automation Status before; they now write it, but only in this case (otherwise an empty cell, as before). At Off the app answers 200, so nothing changes.
3. **The Gate fails closed on unreadable settings.** Check Request flags `settings_unreadable` when the rtd_config read failed, or there is no `RTD_APP_BASE_URL` or no `SOCIAL_MODE_LAST`. **Settings Readable?** then skips the app call, and Gate Answer returns `post: false`, `held_reason: 'settings unreadable'`. Callers treat it as a usable answer, so the post is held (logged `Held: settings unreadable`). At Off this only bites if n8n's own data table is broken.
4. **One retry on 502/503/504** in both subs: **Retry On 502/503/504?** → **Wait 5 s** → **Ask App To Check (Retry)** / **Ask App For Context (Retry)** → the same answer node. Other errors go straight to the fallback, as before. A Gate fallback after the retry says `(after one retry)`.
5. **alwaysOutputData on the four Social Gate call nodes** (Event Post, Prospectus, Weekly, Instagram Priority), so a Gate that returns zero items still reaches Merge Gate Answer and its no-usable-answer rule (post unless this run's Context mode is enforce).
6. **Builder** (before G4): Prompts To Write passes an Event ID found on neither tab on with `tab: 'none'` (Which Tab drops it, nothing is written) and End Of Run Check counts it. Mark Written In App now continues on error after its 3 tries, and End Of Run Check reads every run of it (one per tab) and counts the failures. Both go into the one end-of-run alert; the versions stay in `/to-write`.

**Off evidence** (no-post copy `dIs0mDgziX5p5x0n` of the Facebook event path, real Dungeons & Dragons row `RTD-EVT-00007` and caption from live run `74415`; real Context and Gate subs at Off; sha256 taken in n8n):

| Run | Execution (subs) | Gemini input | Buffer body |
| --- | --- | --- | --- |
| Before (nodes as in `1c0677ca`) | `76644` (`76645`, `76646`) | 2827 chars, `2c8786da2f87d11114247d0ee4cbae6ac49fe42152fbfe63553ebec44e8f1c94` | 1470 chars, `7586c5879aab4205f9f63b728d47b9dc2e7f5d42acd4873b209835583e134b13` |
| After (nodes as in `3164d3c3`, sub drafts) | `77329` (`77330`, `77331`) | identical | identical |

Post Log stand-in: `Success`, BufferID `TEST-NOT-POSTED-0` in both. The Gemini hash also matches a local sha256 of the row's KPI Hook prompt + `\n\n`.

**Tests** (all copies archived: event path `dIs0mDgziX5p5x0n`, Gate `XuyvghGlURCGxFUV`, Context `DQZ1EEoqozm6rGh3`, zero-item Gate `BnhGsrWKg9f34U7T`, Post Log expressions `R7U8weXLbAOFvMvt`, Builder `b6VCR64Rp57OEPwS`; no Buffer, Meta, Instagram, ImageKit or sheet-write node in any of them; the subs' app URL was an invalid host or the HTTP answers were pinned):

| Item | Execution | Test | Result |
| --- | --- | --- | --- |
| 1 | `76671` | Before: Cafe Vibes (Hidden), Context and Gate pinned to Enforce / `post: false` | **Held** (the bug) |
| 1 | `77332` | After: the same pins | Context and Gate **not run**; Gemini got exactly today's prompt; **Buffer stand-in reached**, `Success` |
| 1 | `77333` | After: D&D, Context pinned Enforce with a layer, Gate `post: false` | **Held**, Retry Held Post Tomorrow `2026-10-22`; Buffer not reached |
| 2 | `76750` | Gate copy: last mode shadow, app pinned **400** | `post: true`, `held_reason` = the app's error |
| 2 | `77334` | Event path: Context Shadow, Gate answer as in `76750` | Post Log `Success; unchecked: occurrence_id is required …` |
| 2 | `77366` / `77367` / `77368` | Round-up and IG log expressions: unchecked / checked / IG café path (Merge not run) | `Success; unchecked: …` on all three / round-ups empty, IG `Success` / `Success` |
| 3 | `76738`, `76749`, `76764` | Gate copy: rtd_config empty / an error item / no SOCIAL_MODE_LAST | `post: false`, `settings unreadable`; the app was **not** asked |
| 3 | `77335` | Event path at Off, Gate pinned `settings unreadable` | **Held** (`Held: settings unreadable`) |
| 4 | `76751` | Gate: 503, then 200 allow | Waited 5.0 s, retried, `post: true` |
| 4 | `76752` | Gate: last mode enforce, 503 twice | `post: false`, `Service Unavailable (after one retry)` |
| 4 | `76756` | Gate: enforce, 400 | No retry, held |
| 4 | `76769` / `76773` / `76798` | Context: 502 then 200 / 504 twice / 500 | Retried, mode off / no layer after the retry / no retry, no layer |
| 5 | `77339` | Event path at Off, Gate pointed at a sub that returns zero items | Merge Gate Answer reached: posted, `Success; unchecked: the social gate gave no answer (context mode off)` |
| 5 | `77342` | The same, Context pinned Enforce | **Held** (`the social gate gave no answer (context mode enforce)`) |
| 6 | `77381` | Builder copy: dry run off, live, `/to-write` with one Event Index, one Standard Diary and one unknown ID; `/written` to an invalid host | Unknown ID: nothing written; both `/written` calls failed after 3 tries (~10 s each) and the run still reached End Of Run Check, which raised one error naming `RTD-EVT-09999 v3` and both `/written` failures |

### 2026-10-21: RTD Master V1, the "Facebook Posted Food Today?" fix (draft, not published)

Stage 2, Task 6. **Only the draft changed; nothing is published.** It goes live with the poster changes at G5, and the app's switch stays Off. The full list of versions and how to undo each one is in the [Stage 2 rollback record](#stage-2-rollback-record).

| | Version |
| --- | --- |
| Published (unchanged, checked after the edit and the tests) | `37f21195-a767-4ee2-96a8-09770c3703a2` |
| Draft this task started from | `b3e51f75-7178-4464-aade-def648f17233` (Task 5's last draft) |
| New draft (not published) | `1c0677ca-0f17-4c87-9e53-c9bdfdf63883`. Only the one Code node changed; no connection changed (checked with n8n's version diff). |

**The bug.** The 09:15 Instagram food slot (IG Food Slot → Read Post Log for FB Food Check → **Facebook Posted Food Today?** → Skip If FB Posted Food Today?) should skip Instagram when the morning Facebook food post (Food1, Food2, Food3 or Drinks) already went out that day. The node compared the Post Log's `Date Posted`, which every log node writes as `dd/MM/yyyy` (`$now.format('dd/MM/yyyy')`, for example `20/10/2026`), with today as `yyyy-MM-dd` (`2026-10-20`). The two never matched, so Instagram posted food every day. The Post Log shows it: on 13, 15, 17 and 19 Oct a Facebook food row at about 08:31 is followed by an Instagram food row at 09:15.

**The fix.** Both sides are turned into `yyyy-MM-dd` in Europe/London before they are compared. `Date Posted` is read as `dd/MM/yyyy` (UK order, as the Post Log writes it), and also as a plain ISO date, an ISO timestamp (its London date), a sheet serial number, or the older `August 11th 2026, 5:30:42 pm` form. A value it can't read never matches, as before. All 918 rows of the 20 Oct Post Log read cleanly. The rest of the node (Facebook only, the four food names, any status) is unchanged.

**What changes when it is published (an owner decision, still pending; see the G5 checklist step 1):** on a day the Facebook food post has gone out, the 09:15 run goes to Already Covered by Facebook Today and posts **no Instagram food post**. On other days it posts as now. On the Sept–Oct pattern (Facebook food every other day), Instagram food posts drop from daily to about every other day. No other path is touched: the event post, round-ups, Instagram Priority, posters and every Gemini prompt are exactly as in `b3e51f75`, so the Off byte-identical proofs from Tasks 3 to 5 still stand.

**Tests** (archived no-post copy `ijPXNkh26VSswb1U`: Run By Hand → a pinned stand-in for the Post Log read → the node's exact code → the same IF → two No-Op ends; no sheet, Buffer or Meta node):

| Execution | Pinned Post Log rows | Result |
| --- | --- | --- |
| `76566` | A Facebook `Food3` row dated today (`21/10/2026`), plus a Facebook Quiz row and an Instagram `Food1` row from today | `fbPostedFoodToday: true`, ends at Already Covered by Facebook Today (**matched**) |
| `76568` | The same, but the Facebook `Food3` row dated yesterday (`20/10/2026`) | `false`, ends at the would-post stand-in (**not matched**) |
| `76570` | As `76566`, with the old (live) code | `false`: the bug, reproduced |

### 2026-10-20: RTD Master V1, the round-ups and the Instagram Priority caption through the social gate (draft, not published)

Stage 2, Task 4. The Mon/Thu **Prospectus** and Sunday **Weekly** round-ups and the **Instagram Priority** caption now go through the Context and Gate sub-workflows, the same way as the Facebook event post. **Only the draft changed; nothing is published.** Publishing waits for the owner (G5), and the app's switch stays Off. The Daily Recap stays disabled, with a note that it must go through the gate if it is ever turned back on.

| | Version |
| --- | --- |
| **Rollback point** (still the published version, checked after the edits and after the tests) | `38b1d6d1-ee8f-4683-aea1-0b94c5a1351b` |
| Draft this task started from | `f544db43-1f9c-4194-8c43-647bd34bfc28` (Task 3's last draft) |
| New draft (not published) | `4ef9c552-7dfe-412d-b7bd-f79e01c3ed86`. It was saved in four steps: `557e0f29-…`, `cbcb6d0b-…` and `9a6e5299-…` only added the new nodes, unconnected, so they behave like `f544db43`; `4ef9c552` changed the prompts and connected them. |
| Follow-up draft (not published), the latest | `37f21195-a767-4ee2-96a8-09770c3703a2`: Instagram Priority café rows skip the context and the gate |

See [As built: Master V1, the round-ups and the Instagram Priority caption](#as-built-master-v1-the-round-ups-and-the-instagram-priority-caption) under the contract below.

### 2026-10-19: RTD Master V1, the Facebook event post through the social gate (draft, not published)

Stage 2, Task 3. The Facebook event post now goes through the Context and Gate sub-workflows, and the Post Log records a real success as `Success`. **Only the draft changed; nothing is published.** Publishing waits for the owner (G5), and the app's switch stays Off.

| | Version |
| --- | --- |
| **Rollback point** (recorded before any edit; still the published version) | `38b1d6d1-ee8f-4683-aea1-0b94c5a1351b` |
| New draft (not published) | `df78f5ec-b1eb-49b1-a300-9785aa7c1b75`, then `7361e5e3-3dfb-4dd0-b1a5-ac23e6b4e24f` after the follow-up (held retry, Food log fix), then `f544db43-1f9c-4194-8c43-647bd34bfc28` after review round 1 |

To roll back after G5, publish `38b1d6d1-…` again. See [As built: Master V1, the Facebook event post](#as-built-master-v1-the-facebook-event-post) under the contract below.

### 2026-10-19: RTD Social Context (sub) and RTD Social Gate (sub) (new, published)

Stage 2, Task 2. Two new sub-workflows hold every call RTD Master V1 will make to the app before and after a caption: **RTD Social Context (sub)** (`QCjohGtBuld6k5R8`) and **RTD Social Gate (sub)** (`NqC8fZUoIWWuvDnt`). Both are **published**, which is safe because nothing calls them yet. They add the rtd_config key `SOCIAL_MODE_LAST`. The app's switch stayed Off. See [As built](#as-built-the-context-and-gate-sub-workflows) under the contract below.

### 2026-10-19: RTD Social Prompt Builder (new, not published)

Stage 2, Task 1. A new workflow, **RTD Social Prompt Builder** (`lh9MzioBdpBpBIVo`). It is **unpublished** and in a dry run against the staging copy, with rtd_config keys `SOCIAL_BUILDER_DRY_RUN=true` and `SOCIAL_BUILDER_SHEET=staging`. Writing to the sheet and publishing wait for the owner (G4). See [As built](#as-built-rtd-social-prompt-builder-lh9mziobdpbpbivo) under the contract below.

### 2026-10-16 (evening): RTD Sheet Writer (new, not published)

Approved by the owner (D-13): a new writer limited to mapped columns, by Event ID, on the staging copy first. **Created unpublished**; it does nothing until the app has migration `0022_sheet_edits.sql` and the Stage 6 code, an admin sets **Logic Engine changes** to something other than Off, and the workflow is published (owner's go-ahead). See [RTD Sheet Writer](#rtd-sheet-writer-taa4f7wkzzeidkm8) below.

### 2026-10-16 (evening): a staging copy of the Logic Engine

At the owner's request (Stage 6, D-12), a one-off workflow, **RTD Make Staging Copy (one-off)**, copied the Logic Engine spreadsheet with the `ATECHGoogleDrive` credential, then was archived.
- **The copy:** "Logic Engine_RTD (STAGING COPY - not live, for testing the app sync)", in the same folder and owned by the same account. Nothing live reads or posts from it.
- **Its ID** is in `rtd_config` as `RTD_STAGING_LOGIC_ENGINE_ID` (kept out of this public repository).
- **Never point a live workflow at it,** and never point a test workflow at the live sheet.

### 2026-10-16 (evening): approved host changes into Event Index

The owner approved this (Stage 5a). It was made after migration `0021_change_requests.sql` and the Stage 5a app were live.

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| RTD Host Sessions To Diary (`rdS8LF56B9k170BY`) | **New branch D**, beside C and from the same start: **Get Host Changes From App** (`GET /internal/host-changes`), **Host Changes To Apply** (keeps only items with a real Event ID and request number, whose `row['Event ID']` matches), **Row Cells** (just the cells), **Update Event Index Row (Host Change)** (Google Sheets update on Event Index, matched on **Event ID**, columns mapped automatically from the row so only the cells in it are written, RAW, an unknown column is an error rather than a new column), **Mark Host Change Applied In App** (`POST /internal/host-changes/:id/applied`). The version diff shows only these 5 nodes and their connections were added; A, B and C are unchanged. | `7ef4429d-cb2f-44b4-bc2f-c8fa43278607` (published 18:38 UTC) | `d9cad8de-364c-4c03-9849-ec626861fca7` |

**The cells it can write:** Event Name, Base Details, Event Date and Day, Event Time, End Time, App Price, App Visibility, each only when that field changes. Never Status, Frequency, App Capacity or App Host Session.

**Verified:** the 18:45 run succeeded; the app answered `{ changes: [] }`, so the branch stopped there. **Not yet seen live:** a real write. Check the first approved change's row in the sheet: only its changed cells should differ.

### 2026-10-16 (evening): RTD Outbox reports failed emails to the app

The owner approved this (Stage 4b). It was made after migration `0020_delivery.sql` and the Stage 4b app were live, so `/internal/outbox/:id/failed` existed first.

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| RTD Outbox (`dJU9NJOh7aisAiFF`) | **Email Not Sent** (Stop and Error) is replaced by **Mark Failed In App**: `POST /internal/outbox/{message_id}/failed` with `{ "error": <Gmail's error, up to 300 characters> }` (header auth `rtd-app`, retries 3 times). Then **Given Up?**: only if the app answers `dead: true` does the run stop with an error (**Email Given Up**), so `Studio: Error Handler` emails Dan once per email given up on, not every 5 minutes. The version diff shows only these nodes and their connections changed. | `e50af06e-0bd5-4e48-b63b-960a3ea3e343` (published 17:23 UTC) | `a1b77acb-fb1d-4f07-a8e1-a8e34a2ef125` |

**Why:** one failed email used to fail the whole run every 5 minutes, forever, and the app couldn't tell it had failed. Now the app retries it (5 m, 15 m, 1 h, 4 h, 12 h), gives up visibly under **Delivery**, and opens a Needs attention item at once when the email was to a customer.

**Verified:** the 17:25 and 17:30 runs on the new version succeeded (nothing was waiting). The failure branch hasn't run live yet: no email has failed since. The app side of it is covered by `test/delivery.test.ts`.

**Built with the n8n connector, not generated from a repository,** so there's nothing to mirror locally.

### 2026-10-16: the Event Guard no longer emails the date-picker

The owner approved this (decision D-4 in [RTD_EVENT_CONTROL_AUDIT.md](RTD_EVENT_CONTROL_AUDIT.md#7-decisions-blocked-on-the-owner)). The RTD app's **Needs attention** now covers what the date-picker did:
- it lists each event whose date has passed with nothing after it;
- it emails a notice to the addresses set in the organiser, then a reminder every morning until someone sets a new date, archives it or marks it finished.

The date-picker went to one personal address, never reminded anyone, and its only live use (Bingo, 10 Oct) closed as "no response" within hours.

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| RTD Event Guard (sub) (`RtdEventGuardSub1`) | **Local edit:** the node `Request New Date (Sub)` is **disabled**. The version diff shows that this is the only change. | `4f73e19b-0f69-4abe-ae3e-2aa1b94c71c8` | `d3c74b27-dfa8-4e02-8f1d-d609751f9537` (publish it, or re-enable the node) |

**What still happens when a one-off or monthly event passes:** the Guard sets it Inactive at 01:15, logs it in the RTD Event Automation Log, and makes posters as before. Only the date-picker email (RTD Event Date Change) no longer starts.

**New dates** are set with **Set a new date** under Needs attention in the organiser; it reaches Event Index within 15 minutes. They can still be set in the sheet by hand.

> **Local edit.** Mirror this in `rtd-poster-automation` (don't start the date change from the Guard), or its next build will bring the email back.

### 2026-10-08 (later): event reminders on Facebook

Dan's request: admins send a push reminder about an event whenever they like, and "this should also trigger a social post at the same time". Dan chose Facebook, with the same text and the event's photo. See [RTD_ALERTS.md](RTD_ALERTS.md).

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| **New:** RTD Event Reminders To Facebook (`2BLoRwo7Fvtdu2ya`) | See [below](#rtd-event-reminders-to-facebook-2blorwo7fvtdu2ya). Published **after** the app change. | `12a8096a-81b0-4d3f-a2ed-cfe1b1f23d08` | Unpublish it (reminders still reach phones; posts wait as `pending`) |

**Checked:**
- **Live run** (`26137`): the app answered with nothing to post.
- **Not yet tested:** a real post to Facebook. It happens with the first admin reminder that has **Post on Facebook too?** set to **Yes**. If Buffer refuses it, admins see the reason under **Latest reminders**, and nothing is retried.

### 2026-10-08: markets (vendors apply for pitches)

Dan's request: admins set up market events; vendors apply in the app; every detail goes in a special spreadsheet; approvals go to the usual approvers; approved vendors are emailed confirmation and payment details. See [RTD_MARKETS.md](RTD_MARKETS.md).

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| RTD Outbox (`dJU9NJOh7aisAiFF`) | New node **Read Approval Alert Email (rtd_config)**. **Split Emails** now also turns `@approvals` into `RTD_APPROVAL_ALERT_EMAIL` (info@). Published **before** the app change. | `a1b77acb-fb1d-4f07-a8e1-a8e34a2ef125` | `d38fef8d-571b-4835-8721-6754ff25cc95`, but only while no `@approvals` emails are queued, or they'd fail |
| RTD Host Sessions To Diary (`rdS8LF56B9k170BY`) | **Build Rows:** markets come through the same feed (App Host Session = `RTD-MKT-…`). A clashing name gets the app's `clash_suffix`, which is the market's year ("Christmas Market (2026)"), instead of "(hosted)". | `d9cad8de-364c-4c03-9849-ec626861fca7` | `c0738021-829c-484e-97f7-31ec7260ae61` (markets still work; clashes just get "(hosted)") |
| **New:** RTD One-Off: Create Market Vendors Sheet (`t9yI90E2siGL3FEZ`) | Manual only. Created the spreadsheet **RTD Market Vendors** (`1Fxq3DKarxuVdUkV71aUuIEgcO0e5W34FGfVWBPtX8Pc`, tab **Applications**, gid `268107876`) with its header row, bold and frozen. Run once (`25712`); don't run again, or it makes a second file. | — | — |
| **New:** RTD Market Vendors To Sheet (`gpm3eaxYJf9m4hRd`) | See [below](#rtd-market-vendors-to-sheet-gpm3eaxyjf9m4hrd). | `364e1135-59d2-426e-92fe-ffdbf6ecfcec` | Unpublish it (the app keeps everything; the sheet catches up when it's back) |

**Checked:**
- **Outbox simulated run** (`25637`): `@approvals` and `@bookings` went to info@; empty went to the café address.
- **To Diary simulated run** (`25656`): a market called "Spooky Market" became "Spooky Market (2026)", and a host session "Quiz" still became "Quiz (hosted)".
- **Market Vendors To Sheet:**
  - **Live run** (`25783`): the app answered with nothing to write.
  - **Simulated run** (`25788`): two rows, each carrying its own reference and hash.
  - **Not yet tested:** a real write to the sheet happens with the first application. If it fails, the error handler emails Dan, and the row is tried again 15 minutes later.

### 2026-10-07: customers book café events; every booking copied to info@

Dan's decision: "prepare the app to enable customers to book on. Ensure any bookings are emailed to info@… as per other confirmations." Every public event is bookable; replies from customers go to info@.

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| `rtd_config` | New key `RTD_BOOKINGS_EMAIL` = the café's info@ address | — | Delete the row (bookings mail falls back to `RTD_CAFE_NOTIFICATION_EMAIL`) |
| RTD Outbox (`dJU9NJOh7aisAiFF`) | New node **Read Bookings Email (rtd_config)**. **Split Emails** turns the app's `@bookings` placeholder into that address. Published **before** the app change, so no email was ever left with nowhere to go. | `d38fef8d-571b-4835-8721-6754ff25cc95` | `a5990c68-8523-4393-bf71-6a225f39da09` (only once the app stops writing `@bookings`, or those emails won't send) |
| RTD Host Sessions To Diary (`rdS8LF56B9k170BY`) | Branch C now covers café events as well as host sessions: `GET /internal/sheet-fixes` → update the row matched on **Event ID** → `POST /internal/sheet-fixes/:eventId/done`. Fixes without a real `RTD-EVT-…` ID are dropped. Branches A and B unchanged. | `c0738021-829c-484e-97f7-31ec7260ae61` | `c5b53881-4436-4eb6-8487-6727baefdcf1` (harmless: the old feed now always comes back empty) |

**Checked:**
- **Outbox simulated run** (`23447`): an email to `@bookings` went to info@; an empty address still went to the café address.
- **Branch C simulated run** (`23452`): a weekly café event moved on a week and a one-off went Inactive, both matched on Event ID. A fix with a blank Event ID was dropped.
- **Before publishing:** the live database had no cancelled upcoming dates, so the first live run changed nothing in the sheet.

**Order of the change:**
1. The Outbox learnt `@bookings`.
2. The app was deployed. The old `/internal/host-sessions/sheet-fixes` feed now always answers empty, so the old branch C (which matched on App Host Session) couldn't touch café rows, which have no App Host Session.
3. Branch C was switched to the new feed.

### 2026-10-06 (later still): session approval alerts to the café's info@ address

Dan's decision: "Have the cafe event approval alert set to info@…".

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| `rtd_config` | New key `RTD_APPROVAL_ALERT_EMAIL` = the café's info@ address | — | Delete the row (the alert falls back to `RTD_CAFE_NOTIFICATION_EMAIL`) |
| RTD Host Sessions To Diary (`rdS8LF56B9k170BY`) | New node **Read Approval Alert Email (rtd_config)** before branch A. **Email The Café** now sends to it, falling back to `RTD_CAFE_NOTIFICATION_EMAIL` if the key is missing. Branches B and C unchanged. | `c5b53881-4436-4eb6-8487-6727baefdcf1` | `f7a6d7b7-8077-4b67-a5a0-24a53a16104c` |

**Checked:** a simulated run (`21045`). The new node read the info@ address from `rtd_config`, and the email step was simulated, so no email went to the café.

**Unchanged:** every other café email (join requests, replies from customers and hosts, cancellation notices, date requests) still uses `RTD_CAFE_NOTIFICATION_EMAIL`.

### 2026-10-06 (later): bookings and cancelled dates

Dan's decisions: hosts and café staff join the same way; "email the event host whenever a person books… 2 days before the event to confirm numbers… option to cancel… email any attendees".

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| **New:** RTD Outbox (`dJU9NJOh7aisAiFF`) | See [below](#rtd-outbox-dju9njoh7aisaiff). Sends every booking email the app queues. | `a5990c68-8523-4393-bf71-6a225f39da09` | Unpublish it (emails wait in the outbox until it's back) |
| RTD Host Sessions To Diary (`rdS8LF56B9k170BY`) | **New branch C:** takes cancelled host dates out of Event Index (`GET /internal/host-sessions/sheet-fixes` → update the row matched on `App Host Session` → `POST …/sheet-fixed`). Branches A and B unchanged. | `f7a6d7b7-8077-4b67-a5a0-24a53a16104c` | `58fb14a4-db75-4973-bc8c-efae1b210ff7` |
| RTD Team Notices (`diKojCurHeRWQjAR`) | No change. Every join request is now a host request, so they all go to the café address. | — | — |

**How it was verified:**
- **RTD Outbox:**
  - **First live run** (`20675`): the app answered, and nothing was queued.
  - **Simulated run** (`20676`): an email meant for the café got the café's address from `rtd_config`, and each email was marked sent.
- **Branch C:**
  - **Live run** (`20682`): nothing to fix.
  - **Simulated run** (`20684`): a one-off went Inactive and a weekly row moved to its next date.
  - **Not yet run against the real sheet:** the sheet-update node passed n8n's validator. If it ever fails, the error handler emails Dan, and the app offers the same change again on the next run.

### 2026-10-06: onboarding and decision emails

Dan's decision: "I will be the approving party for staff, Michelle for game hosts and booking requests."

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| **New:** RTD Team Notices (`diKojCurHeRWQjAR`) | See [below](#rtd-team-notices-dikojcurherwqjar). No existing workflow was changed. | `383adf40-39d4-4990-b024-c7f6c10dcd81` | Unpublish it (it only sends emails) |

### 2026-10-05 (evening): host sessions into the diary; private sessions never advertised

Dan's decision: "Private sessions don't advertise, public yes please."

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| RTD Master V1 (`yPhchrcwuJSt3RLI`) | **Local edits to three code nodes:** `Find Next 2 Diary Days & Build Prompt` (evening round-up), `Find Next 7 Days Events & Build Prompt` (Sunday weekly post) and `Is Event Due Right Now?` (hourly event post) now skip rows whose `App Visibility` is `Private`, in both Event Index and Standard Diary. Hidden social-content rows (Food1–3, Drinks, Cafe Vibes) are unaffected. | `c8485b62-c318-47f6-bb0f-bee99a670e5c` | `95b638b5-11f4-47ce-91ec-db77c3eb4f89` |
| RTD Event Guard (sub) (`RtdEventGuardSub1`) | **Two new local-edit nodes:** **App: Private Rows Get No Poster** (before `Evaluate Events`) relabels a Private row's Status in memory, so it gets no poster but still expires. **App: No Date Request For Host Sessions** (before `Request New Date`) drops rows with an `App Host Session`: they still go Inactive when they pass, but the café isn't asked for a new date, because the host gets the follow-up email instead. | `d3c74b27-dfa8-4e02-8f1d-d609751f9537` | `fe0eeae3-49f9-4e20-94d6-a342208809b0` |
| RTD Event Sync (`fOYrFBOElFkWx7R3`) | `Build Snapshot` also sends `App Price`, `App Capacity` and `App Host Session`. | `a6de4b57-6675-4061-8bea-8b981128ea56` | `1d43463b-e143-413c-ad1a-c2c012063725` |
| Logic Engine sheet | **Backup first:** "Logic Engine_RTD BACKUP 2026-10-05 2157 (before host session columns)" (`1bMrXUUYfFHP0l-Y-WozCe2ovfzvApVeKyn51EanUTyM`). **Then:** `App Price`, `App Capacity` and `App Host Session` were added as Event Index columns V–X, after App Category. No column moved. Workflow: `RTD One-Off: Add Host Session Columns` (`jgEBveDZA5Dg4Iif`), manual-only and safe to re-run. | — | — |
| **New:** RTD Host Sessions To Diary (`rdS8LF56B9k170BY`) | See [below](#rtd-host-sessions-to-diary-rds8lf56b9k170by). | | |

**How it was verified:**
- **Master V1:** the three patched code nodes were run locally against sample rows. Both round-ups left out a Private Event Index row and a Private Standard Diary group, and kept the public ones; the hourly post picked only the public event. The draft was then diffed against the live version: only those three `jsCode` values changed.
- **Guard:** both new nodes were run locally against sample rows. A dry run through `Event Guard Dry Run (Manual)` (executions 19339/19340) then succeeded, and every existing event took the same path as before.

> **Local edits.**
> - **Guard:** its code is generated from `~/projects/rtd-poster-automation`, so mirror both Guard nodes there (skip posters when App Visibility is Private; no date request for rows with an App Host Session), then delete them.
> - **Master V1:** its nodes aren't generated, but keep the three edits if it's ever rebuilt.
> - **Known limit:** the Guard still refuses to act if more than 3 rows expire in one night, and host one-offs count towards that.

### 2026-10-05: Monthly events re-dated by Michelle, not auto-rolled

Dan's decision: "dates can vary, ask Michelle for a new date".

| Workflow | Change | New active version | Roll back to |
| --- | --- | --- | --- |
| RTD Master V1 (`yPhchrcwuJSt3RLI`) | `Calculate next dates` no longer advances **Monthly** Event Index rows. Weekly and Bi/Two-Weekly unchanged. Standard Diary untouched. Sticky note updated. | `95b638b5-11f4-47ce-91ec-db77c3eb4f89` | `03601fc5-c0c9-402a-a988-26ac3b6192fa` |
| RTD Event Guard (sub) (`RtdEventGuardSub1`) | New node **Monthly: Ask For Next Date** between the sheet read and `Evaluate Events (Guard)`. It blanks Frequency for Monthly rows, so a passed monthly event is expired like a one-off: Status → Inactive, and the date-picker email asks for the next date. | `fe0eeae3-49f9-4e20-94d6-a342208809b0` | `20a1ffc4-e334-42fb-8a7f-420e90a569fc` |

How it was verified: two dry runs of the Guard (executions 18094/18095 and 18115/18116). Both succeeded, the new node ran, and Quiz (Monthly, future date) still took the normal poster path. The first live expiry will be **Bingo, after 9 Oct**.

> **Local edit.** The Guard's code is generated from `~/projects/rtd-poster-automation` (`build.py`). Make the same change there (remove `'monthly'` from `CONFIG.recurringFrequencies` in `logic.js`), then delete the extra node. Otherwise the next build will undo it.

### 2026-10-05: App ID columns added to the Logic Engine

- **Backup first:** a Drive copy named "Logic Engine_RTD BACKUP 2026-10-05 1200 (before app ID columns)" (file id `1W5RLKtd9eYoiE15mckGl-DkIkrkFmPwWblag9EN7Tkc`), saved next to the original.
- **New columns at the end of Event Index and Standard Diary:** `Event ID`, `App Visibility`, `App Category`. No existing column moved. Every existing write to these tabs maps columns by name and row number, so nothing else was affected; this was confirmed by a Guard dry run after the change.
- **Values backfilled:**
  - Event Index rows got `RTD-EVT-00001`–`00023`.
  - Standard Diary rows got `RTD-EVT-00024`–`00031`.
  - Food1–3, Drinks and Cafe Vibes were set to `Hidden`; everything else to `Public`.
  - Categories were guessed from event names. Michelle can change any of them.
- **Workflow:** `RTD One-Off: Add App ID Columns` (`6XN4fpSvTk5t5OW9`). Manual-only, never activated, safe to re-run (it fills blanks only and never renumbers). It can be archived: RTD Event Sync now assigns IDs to new rows.

| Event ID | Event Index row |
| --- | --- |
| 00001 Quiz · 00002 Bingo · 00003 Blood on the Clocktower · 00004 Kids Chess Club | rows 2–5 |
| 00005 Home Education Support ClubM · 00006 …ClubT · 00007 Dungeons & Dragons · 00008 Cafe Vibes | rows 6–9 |
| 00009 Cleeples · 00010 Magic: The Gathering · 00011 DM Liv's DND · 00012 DM Alfie's DnD | rows 10–13 |
| 00013 Wednesdays · 00014 Food1 · 00015 Food2 · 00016 Food3 · 00017 Drinks | rows 14–18 |
| 00018 SazLou · 00019 BookClub · 00020 Writing Club · 00021 Spooky Market · 00022 MicNight · 00023 BritQuiz | rows 19–24 |

**Rules for the sheet from now on:**
- Never change or reuse an `Event ID`. Rename events freely; the ID keeps their history together.
- New rows, including copied rows, get an ID automatically within 15 minutes.
- `App Visibility` accepts: `Public`, `App Bookable`, `Private`, `Hidden`. A blank cell means Hidden. `Private` shows in the app's diary only as "Private session" with its time (no name or details), so the café still looks busy.
- `App Category` accepts: Gaming, Quiz, Social, Club, Tournament, Market, Workshop, Other.

### 2026-10-05: `rtd_config` data table

`rtd_config` (`nMs33jJTorVuKLsp`), key / value / notes. It is the single configuration source for RTD workflows (spec §38).

| key | purpose |
| --- | --- |
| `RTD_CAFE_NOTIFICATION_EMAIL` | Fixed café address for the digest, date requests and change notices. Also gets join requests and cancellation notices, and is the Reply-To on emails to hosts and customers. |
| `RTD_APPROVAL_ALERT_EMAIL` | Added 2026-10-06: the café's info@ address. Gets the email for each new host session to approve (RTD Host Sessions To Diary). |
| `RTD_BOOKINGS_EMAIL` | Added 2026-10-07: the café's info@ address. RTD Outbox sends it a copy of every booking and cancellation, the two-day numbers for café events and the "Check bookings" warnings; customers' replies go there too. The app writes it as `@bookings`. |

Still to do: point the Guard's date-change recipient at this instead of its hard-coded copy. That change goes in `rtd-poster-automation`.

## Instant triggers

**App side built 25 Oct 2026, not deployed. The n8n side (three Webhook triggers) isn't built yet.** The owner wants an admin's edit in the Logic Engine in about 20 s, and the event's new social prompt and example in 1 to 2 minutes, instead of waiting up to 25 minutes for timers. So the app asks n8n to run a workflow straight away. **Every schedule stays** as the safety net: a call that is skipped, refused or lost is picked up by the next timed run.

**The chain:**
1. An admin saves a change (the event editor, Logic Engine changes, Stop, or Retry / Write mine on a conflict) and it is queued → the app calls **RTD Sheet Writer**.
2. The Sheet Writer writes it to the live sheet and calls `POST /internal/sheet-edits/:id/written` → the app calls **RTD Event Sync**. Not for a change written to the test copy.
3. Event Sync posts its snapshot (`POST /internal/sync/logic-engine`). If any event then wants a new prompt (changed details or facts, or a new event: the same rule as `/due`) → the app calls **RTD Social Prompt Builder**.
4. An admin presses **Regenerate** on a social prompt → the app calls the **Prompt Builder**.

**Contract:**
- **Address:** Worker var `N8N_WEBHOOK_BASE` = `https://n8n.arkham-survey.com/webhook` (in `wrangler.jsonc`; public, not a secret). Blank or unset switches the calls off; the app then relies on the schedules.
- **Paths, all `POST`:** `/rtd-sheet-writer-run`, `/rtd-event-sync-run`, `/rtd-prompt-builder-run`.
- **Auth:** header `Authorization: Bearer <INTERNAL_SYNC_TOKEN>`, the token the app already checks on `/internal`. Each Webhook node uses **Header Auth** with the existing `rtd-app` credential (`PveFQOiLEm52Hy2G`).
- **Body:** `{ "reason": "edit_queued" | "edit_written" | "prompts_due" | "regenerate", "event_id"?: "RTD-EVT-…" }`. n8n only logs it.
- **n8n answers at once:** Respond Immediately, 200. The app never waits for the run.

**How the app calls** (`src/n8n/trigger.ts`):
- After the response (`waitUntil`), with a 5 s timeout. A failure, including a **404** (the workflow isn't published yet), is a `console.warn` only. It never changes the admin's answer or what an `/internal` route answers n8n.
- **Sheet Writer and Prompt Builder:** a call is skipped if the last one was under 15 s ago **and** that run hasn't started yet (no `/sheet-edits/claim` or `/social-prompts/due` since). That run will read the queue and take this change too. Once a run has started, the next change calls again, so a burst of edits still ends with a run after the last one. A call that failed doesn't count, so the next change tries again.
- **Event Sync:** skipped only while the last call's run may still be going (a call under 30 s ago with no snapshot since). A snapshot that has arrived is a finished run, so the next call goes at once. Two syncs at once could give the same new Event ID to two different rows (rows added in between). A scheduled run starting at the same moment as a call is the one overlap left, and is rare. Whatever is skipped is picked up by the schedule.
- The times are kept in the `settings` table (`trigger_last_<target>`, `trigger_seen_<target>`).

**Owner checks before relying on it:**
- [ ] n8n's public `https://n8n.arkham-survey.com/webhook/*` is reachable from the internet (Cloudflare Workers call it), not only on the Pi's network. A quick check: `curl -X POST https://n8n.arkham-survey.com/webhook/rtd-event-sync-run` from outside answers 401/403 (no token), not a timeout.
- [ ] Each of the three workflows has its Webhook trigger added beside its schedule, and is published. Until then the app's calls get 404, logged as a warning, and nothing else changes.

## RTD Event Sync (`fOYrFBOElFkWx7R3`)

**Live since 2026-10-05 13:40.**
- **First run** (`n8n-18419`): 31 events, 40 occurrences. The two expected `invalid_date` warnings were Cleeples ("Every Thursday") and Wednesdays ("Open Wednesdays!").
- **Repeat run** (`n8n-18421`): 0 changes, which confirms a repeat sync is a no-op.

- **Triggers:** every 15 minutes (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read the app URL from `rtd_config` (`RTD_APP_BASE_URL` = `https://rtd-app.dan-289.workers.dev`).
  2. Read Event Index and Standard Diary.
  3. **Build Snapshot.** A row with no `Event ID`, or carrying a copy of another row's ID (a copied row), gets the next free `RTD-EVT` number. The first row holding an ID keeps it. New rows default to `App Visibility` = Public, and `App Category` = Other (Event Index) or Club (Standard Diary).
  4. Write any new IDs back to the sheet.
  5. `POST /internal/sync/logic-engine` with only the fields the app uses (no prompt columns yet: see [the change needed](#change-needed-for-app-driven-events-23-oct-2026-not-made-yet)). `run_id` = `n8n-<execution id>`.
- **Errors:** retried 3 times, then passed to `Studio: Error Handler`. A `409` means the app refused a suspicious snapshot (for example an empty sheet read), and the data in the app is left untouched.
- **Credential `rtd-app` (Header Auth):** header name `Authorization`, value `Bearer <INTERNAL_SYNC_TOKEN>`.

Payload shape:

```json
{
  "run_id": "n8n-18200",
  "sources": {
    "event_index":    [{ "row_number": 2, "Event Name": "Quiz", "Frequency": "Monthly", "Event Date": "23/10/2026",
                         "Event Time": "18:30", "End Time": "22:00", "Status": "Active", "Base Details": "...",
                         "Photo Folder ID": "...", "Event ID": "RTD-EVT-00001", "App Visibility": "Public", "App Category": "Quiz" }],
    "standard_diary": [{ "row_number": 2, "Group": "...", "Date": "05/10/2026", "Notes": "...", "Frequency": "Weekly",
                         "Event ID": "RTD-EVT-00024", "App Visibility": "Public", "App Category": "Club" }]
  }
}
```

### Change needed for app-driven events (23 Oct 2026, not made yet)

The owner wants every event set up from the app ("I want everything to be app driven", option A). The app can now change every Logic Engine column a person fills in by hand, but the editor offers a column only once this snapshot carries it. Until then it shows **Not synced yet** for that column, and an edit to it is refused. Nothing breaks in the meantime. Full list: [RTD_EVENT_CONTROL_MIGRATION.md](RTD_EVENT_CONTROL_MIGRATION.md#app-driven-events-2026-10-23-no-migration).

**Checklist for Build Snapshot** (each with the owner's go-ahead):
- [ ] **Event Index:** add `Post Frequency (Days)`, `Target Post Time`, `Michelle's Standard Prompt` (straight apostrophe), `Michelles KPI Hook Prompt` (no apostrophe), `TikTok Video Blueprint` and `Organiser Email`.
- [ ] **Event Index:** check these are still sent: `Frequency`, `Photo Folder ID`, `App Capacity`, `Banned Phrases`, `Approved Facts`, `People & Roles`.
- [ ] **Standard Diary:** check `Frequency`, `Approved Facts` and `People & Roles` are still sent. It needs nothing new.
- [ ] **Send every one of these keys on every row, even when the cell is blank** (`""`). The app reads a missing key as "not synced yet" and a blank one as blank. That's what stops an edit taking a value it never saw for a blank.
- [ ] Still **never send** `Social Prompt` or `Social Prompt Status`. `Last Post`, `Next Post` and `Day` aren't needed either.
- [ ] **Size:** the app refuses a snapshot over 1 MB (413). With the prompts in, check the body size of one hand run (the prompts are the bulk of it).
- [ ] **Expected result:** a hand run shows `events_changed: 0`. These columns are kept out of each event's change hash (`source_hash`), as `sheet_values` always has been. Then each event's editor shows the new columns' values.

**Rollback:** take the six columns out of Build Snapshot again. The editor goes back to "Not synced yet" for them after the next sync. Nothing else changes.

## RTD Sheet Writer (`TAa4F7wKzzeIDKm8`)

**Not published yet.** Writes the changes admins make under **Logic Engine changes** in the organiser to the Logic Engine ([RTD_EVENT_CONTROL_AUDIT.md §4.4](RTD_EVENT_CONTROL_AUDIT.md#44-as-built-stage-6-sheet-first-editing)). The app decides everything; the workflow only reads, writes what it's told and reports back.

1. **Every 5 Minutes** (and **Run By Hand**) → read rtd_config: `RTD_APP_BASE_URL`, `RTD_STAGING_LOGIC_ENGINE_ID`, `RTD_LOGIC_ENGINE_ID` (not set until the trial).
2. **Claim Edits From App:** `POST /internal/sheet-edits/claim` → `{ mode, edits: [{ edit_id, claim, event_id, target, tab }] }`. Off: none.
3. **Edits To Work On** picks each change's spreadsheet from its target: **staging** → the test copy only (refused if that ID is the live sheet); **shadow** and **live** → `RTD_LOGIC_ENGINE_ID` (refused if it isn't set). A refusal goes to the app as a failed try.
4. **Loop Over Edits**, one at a time: **Read Tab** (the whole tab, by name) → **Rows For This Event** (the rows with its Event ID) → **Check With App** (`POST /internal/sheet-edits/:id/check` with `{ claim, rows }`).
5. **Write It?** only when the app answers `write` **and** the target isn't shadow. **Cells To Write** refuses cells for another Event ID or any column outside the mapped list. **Update Row (by Event ID):** Google Sheets update, matched on **Event ID**, columns mapped from the cells, RAW, an unknown column is an error. **Read Tab Again** → **Rows After Writing** → **Mark Written In App** (`POST /:id/written`).
6. **Report Failure To App** (`POST /:id/failed` with `{ claim, error }`) takes every error output (reading, the guard, writing, reading back). The app retries at 5 m, 15 m, 1 h, 4 h and 12 h, then gives up visibly.

**The columns it may write** (its mapped list, matched by exact header). The letters are as the docs record the tabs (the 5 Oct App columns S–X and the 19 Oct social columns Y–AB); check them against the header row before changing the node.

| Tab | Written today | Added for app-driven events (23 Oct 2026, **not in the workflow yet**) |
|---|---|---|
| Event Index | A `Event Name`, C `Day` (with a date), D `Event Date`, E `Event Time`, F `End Time`, L `Base Details`, P `Status`, T `App Visibility`, U `App Category`, V `App Price`; S `Event ID` to match on | B `Frequency`, G `Post Frequency (Days)`, J `Target Post Time`, K `Photo Folder ID`, M `Michelle's Standard Prompt`, N `Michelles KPI Hook Prompt`, O `TikTok Video Blueprint`, Q `Banned Phrases`, R `Organiser Email`, W `App Capacity`, Y `Approved Facts`, Z `People & Roles` |
| Standard Diary | A `Group`, B `Day` (with a date), C `Date`, D `Notes`, G `App Visibility`, H `App Category`; F `Event ID` to match on | E `Frequency`, I `Approved Facts`, J `People & Roles` |

Never written: `Last Post`, `Next Post` (H, I), `App Host Session` (X), `Social Prompt`, `Social Prompt Status` (AA, AB; K, L on Standard Diary).

**Checklist for the Sheet Writer** (each with the owner's go-ahead):
- [ ] Add the new columns above to **Cells To Write**'s allowed list. Until then a change to one of them fails at that guard, is retried and then given up on where admins can see it (Sheet sync). Nothing is written.
- [ ] **Update Row** stays RAW. Long text keeps its line breaks (the app sends `\n`, never `\r`).
- [ ] The app sends every cell as text: `Target Post Time` as `18:00`, `Post Frequency (Days)` and `App Capacity` as `"3"`. RAW stores those as text. Check that RTD Master V1's **Is Event Due Right Now?** reads a text `Post Frequency (Days)` and an `HH:MM` `Target Post Time`. If not, write those two as numbers or change the reader first.
- [ ] Test on the staging copy: one prompt (with line breaks and an apostrophe), one Frequency and one People & Roles change. Check only those cells changed, and the edit is marked synced after the next Event Sync.

**Credentials:** `rtd-app` (header auth), `ATECHGoogleSheets`. **Settings:** error workflow `Studio: Error Handler` (`IClMUs9ByRmVBYJf`), Europe/London, executions saved, 300 s timeout.
**Version:** `308a5e79-d71b-4fa6-8153-7282beb2b0f1` (the run settings didn't change the version ID). Rolling back = unpublishing it.
**Verified:** a test run with the sheet and app calls simulated (see [RTD_EVENT_CONTROL_TESTS.md](RTD_EVENT_CONTROL_TESTS.md#stage-6-changing-events-from-the-organiser-2026-10-16)). **Not yet:** a real write to the test copy.

## RTD Menu Sync (`Oq7gMVsYGOn9HS3Z`)

**Live since 2026-10-16 22:00** (published after the hand run `58572` returned `{ ok: true, items: 59, changed: true }`).
- **Triggers:** every 15 minutes (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read the app URL from `rtd_config` (`RTD_APP_BASE_URL`).
  2. Read the **Sections** and **Menu** tabs of the RTD Food Menu sheet (Atechstudio Drive › Roll The Dice › Business; the document ID is in the nodes).
  3. **Build Menu Copy:** `{ sections, items, sheet_url }`, the rows as read (`row_number` included).
  4. `POST /internal/menu`. The app checks every row: `200 { ok, items, changed }`, or `422` listing every problem, and the app keeps its last good menu.
- **Errors:** retried 3 times, then `Studio: Error Handler` (`IClMUs9ByRmVBYJf`), which emails. A `422` fails the same way, so a mistake in the sheet is emailed; the organiser lists the rows too.
- **Credentials:** `ATECHGoogleSheets`, `rtd-app` (Header Auth). **Settings:** Europe/London, executions saved, 300 s timeout.
- **Rolling back** = unpublishing it; the app keeps the last menu it was sent.

## RTD Event Images (`GeafnErtRe5ZMbiD`)

This workflow copies event photos from Drive into the app. Each Event Index row's **Photo Folder ID** (the folders the poster automation already uses) is the source.

- **Triggers:** every 6 hours (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read `RTD_APP_BASE_URL` from `rtd_config`.
  2. `GET /internal/images/plan`. The app lists the events that want photos: active, Public or App Bookable, and with a folder.
  3. **One Drive search** across all those folders (images only, not in the bin). This uses the existing `ATECHGoogleDrive` credential.
  4. **Choose Photos:** the newest 8 per event. Files with **`noapp`** or **`private`** in their name are skipped.
  5. `POST /internal/images/sync` with each event's chosen files. The app drops photos no longer chosen, and answers with the ones it hasn't got yet.
  6. **Fetch and upload the missing photos:**
     - It fetches each missing photo through Drive's own thumbnail link, so Google resizes it to 1400px: WebP for photos (`=s1400-rw`, about 100–210 KB against 2–5 MB originals), JPEG for PNG posters (`=s1400-rj`), because WebP from a PNG is lossless and several MB.
     - It uploads each one with `PUT /internal/images/:eventId/:fileId`.
- **Repeat runs:** a run with no folder changes uploads nothing.
- **Live since 2026-10-05 18:40** (published; runs every 6 hours).
- **First run** (`18869`): 10 folders searched, 65 photos stored.
  - Quiz, Bingo, Blood on the Clocktower, Kids Chess Club, D&D, Cleeples, Magic: The Gathering and Wednesdays got 8 each; Spooky Market got its poster.
  - The poster came through as a 2.3 MB lossless WebP, so PNGs now use JPEG. Re-run `18903` replaced it with a 525 KB JPEG.
  - The store is about 10.6 MB in total.
- **Errors:**
  - HTTP steps retry 3 times, then failures go to `Studio: Error Handler`.
  - The app refuses (409) a photo list with no eligible events, so a failed Drive read never wipes the photos.
- **Execution data:** successful runs aren't stored, which avoids keeping photo bytes in n8n.

**For the café team:**
- **New photos:** drop them in the event's photo folder. The 8 newest appear within 6 hours.
- **Keep a photo out of the app:** rename it to include `noapp`, or move it out of the folder.
- **Hidden events never show photos:** Food, Drinks and Cafe Vibes are Hidden, so their folders aren't read.

## RTD Host Follow-up (`FFy0lBTZCm4A5p08`)

This workflow emails the host of each approved **one-off** session the day after it ran, inviting them to run it again ([RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md#after-a-one-off-session)).

- **Triggers:** every day at 10:00 (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read `RTD_APP_BASE_URL` and `RTD_CAFE_NOTIFICATION_EMAIL` from `rtd_config`.
  2. `GET /internal/host-sessions/followups`: approved or live one-offs from the last 14 days whose date has passed and whose host hasn't been emailed.
  3. **Write Email:** a short thank-you with a link to `/organise`. Host-typed names are HTML-escaped.
  4. **Email The Host:**
     - **Sent from:** the `ATech GMAIL` account, as "Roll The Dice".
     - **Replies:** they go to the café address (Reply-To).
  5. `POST /internal/host-sessions/:id/followup-sent`, so each host gets it once.
- **Live since 2026-10-05 21:25** (published).
- **Checks:**
  - **First live run** (`19236`): nothing due, so nothing was sent.
  - **Simulated run with sample data** (`19238`): the email text and escaping are correct.
- **Errors:** HTTP steps retry 3 times and Gmail twice; failures go to `Studio: Error Handler`. If Gmail fails partway through a run, a host already emailed in that run may get the email again the next day, because their session wasn't marked sent.
- **Execution data:** successful runs are kept, so you can see who was emailed.

## RTD Host Sessions To Diary (`rdS8LF56B9k170BY`)

This workflow does two jobs for the host organiser ([RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md)).

- **Triggers:** every 15 minutes (Europe/London), plus **Run By Hand**.
- **A. Telling the café about new submissions:**
  1. `GET /internal/host-sessions/new-submissions`.
  2. One email per submission to `RTD_APPROVAL_ALERT_EMAIL` (the café's info@ address; falls back to `RTD_CAFE_NOTIFICATION_EMAIL`):
     - **Contents:** the session name, when, time, cost, max players, open or private, and the description.
     - **Link:** a link to `/organise` to approve or decline it.
     - **Sender:** `ATech GMAIL`, shown as "Roll The Dice app".
     - **Replies:** they go to the host (Reply-To).
  3. `POST /internal/host-sessions/:id/cafe-notified`, so each submission is emailed once.
- **B. Approved sessions into Event Index:**
  1. `GET /internal/host-sessions/to-publish`. The app returns each session's finished row.
     - **Row values:** Frequency `One-off`/`Weekly`, Day, Event Date as DD/MM/YYYY text, Event Time, End Time, Base Details, Status `Active`, Organiser Email, App Visibility `Public`/`Private`, App Category `Gaming`, App Price, App Capacity and App Host Session.
  2. **Reading the sheet:** only when something is waiting, it reads Event Index.
  3. **Already in the sheet:** a session whose `App Host Session` is already there is only marked Live, so a retry never adds a row twice.
  4. **Name clashes:** Event Name is the poster and guard automations' key, so a clashing name gets " (hosted)" added.
  5. **Appending:** it appends the rows as RAW text. It stops with an error rather than create a column if a header was renamed.
  6. **Marking Live:** `POST /internal/host-sessions/:id/published`. The next Event Sync then gives each row an Event ID, and the app links it back to the session.
- **What happens to the rows afterwards:**
  - **Weekly rows:** `Calculate next dates` rolls them forward.
  - **One-offs:** they go Inactive after their date. Event Guard doesn't send the "pick a new date" email for host sessions; the host gets RTD Host Follow-up instead.
  - **Open sessions:** they appear in the evening and weekly round-up posts.
  - **Private sessions:** they never appear in posts. The diary shows them only as "Private session".
- **C. Cancelled dates out of Event Index** (added 2026-10-06; café events too since 2026-10-07):
  1. `GET /internal/sheet-fixes`. The app works out the change for each cancelled date still in the sheet, for café events and host sessions alike (Event Index rows only):
     - **A one-off:** Status `Inactive`.
     - **A weekly or fortnightly event whose next date is cancelled:** Event Date moves on to the next date that isn't.
     - **A monthly event whose date in the sheet is cancelled** (from Stage 4c): Status Inactive, with the Event Date written back as it was. Its next date is set under Needs attention, which comes through here as Status Active and the new Event Date. Same shape as before, so the workflow needed no change.
     - **Standard Diary groups:** never changed here (this branch writes Event Index only). Needs attention asks the café to change the tab.
  2. **Sheet Fixes To Apply:** keeps only fixes with a real Event ID (`RTD-EVT-` and digits), so a blank cell can never be matched.
  3. **Update Event Index Row:** updates `Status` and `Event Date` (RAW text) on the row whose `Event ID` matches.
  4. `POST /internal/sheet-fixes/:eventId/done` with the change's key, so it's made once.
  - **Why:** RTD Master V1's posts read the sheet, so a cancelled date must leave it.
  - **Timing:** if Master V1 rolls a weekly row onto a date that's already cancelled, this moves it on again within 15 minutes.
  - **Retired:** `GET /internal/host-sessions/sheet-fixes` (matched on App Host Session) now always answers empty.
- **Individual promotion:** a session gets its own hourly Facebook post or a poster only if Michelle adds a prompt (and a photo folder) to its row, as for any other event.
- **Live since 2026-10-05 22:15** (published).
- **Errors:** HTTP steps retry 3 times; failures go to `Studio: Error Handler`.
- **Checks:**
  - **First live run** (`19322`): nothing pending, so nothing was sent or written.
  - **Simulated run with sample data** (`19323`): a clashing "Quiz" became "Quiz (hosted 2)", a session already in the sheet was only marked Live, and the café email escaped host-typed text.

## RTD Team Notices (`diKojCurHeRWQjAR`)

This workflow sends the onboarding emails and tells hosts what the café decided about their sessions ([RTD_ONBOARDING.md](RTD_ONBOARDING.md)).

- **Triggers:** every 15 minutes (Europe/London), plus **Run By Hand**.
- **Setup:** reads `RTD_APP_BASE_URL` and `RTD_CAFE_NOTIFICATION_EMAIL` from `rtd_config`, then runs three branches.
- **A. New join requests, to the approvers:**
  1. `GET /internal/applications/new`.
  2. **Who gets it:** the addresses the app lists in `notify`: since 2026-10-12, info@rollthedicecafe.co.uk and dan@atechstudio.co.uk (`notify_cafe` is false). Since 2026-10-06 every request is a request to host, café staff included.
  3. **The email:** subject "New host request: …" or "New café team request: …", with a link to `/organise`. It's sent as "Roll The Dice app", and replies go to the applicant.
  4. `POST /internal/applications/:id/approver-notified`.
- **B. Outcomes, to the applicant:**
  1. `GET /internal/applications/decided`: approved or declined in the last 14 days, and not yet emailed.
  2. **The email:**
     - **Subject:** "You are now a Roll The Dice host", or "Your Roll The Dice request" (declined, with the note).
     - **Sender and replies:** sent as "Roll The Dice"; replies go to the café.
  3. `POST /internal/applications/:id/applicant-notified`.
- **C. Session decisions, to the host:**
  1. `GET /internal/host-sessions/decided`: approved, live or declined in the last 14 days, and not yet emailed. Withdrawn sessions are never emailed.
  2. **The email:**
     - **Subject:** "Approved: …" or "Not approved: …", with the café's note.
     - **Approved and private:** says the diary shows it only as "Private session" and it won't be advertised.
     - **Approved and open:** says it will be in the diary within 15 minutes.
     - **Replies:** they go to the café.
  3. `POST /internal/host-sessions/:id/host-notified`.
- **Shared behaviour:**
  - **Escaping:** text people typed is HTML-escaped in every email.
  - **Credentials:** HTTP steps use the `rtd-app` credential; Gmail uses `ATech GMAIL`.
- **Live since 2026-10-06 07:23** (published).
- **Errors:** HTTP steps retry 3 times and Gmail twice; failures go to `Studio: Error Handler`. If Gmail fails partway through a run, someone already emailed in that run may get the email again on the next run, because it wasn't marked sent.
- **Checks:**
  - **First live run** (`20485`): all three app feeds answered and were empty, so nothing was sent.
  - **Simulated run with sample data** (`20486`):
    - **Routing:** a host request went to the café address and a café team request to the admin; a café team request with no admin was skipped.
    - **Content:** the outcome and session emails had the right wording for approved, declined and private.
    - **Escaping:** HTML in names and notes was escaped.

## RTD Outbox (`dJU9NJOh7aisAiFF`)

This workflow sends the emails the app writes for bookings ([RTD_BOOKINGS.md](RTD_BOOKINGS.md#the-outbox-and-the-bookings-inbox)). The app decides who gets what and writes each email; this workflow only delivers them.

- **Triggers:** every 5 minutes (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read `RTD_APP_BASE_URL`, `RTD_CAFE_NOTIFICATION_EMAIL` and `RTD_BOOKINGS_EMAIL` from `rtd_config`.
  2. `POST /internal/outbox/collect`. The app first queues any emails now due (the two-day numbers from 09:00, and "Check bookings" warnings), then returns up to 50 unsent emails.
  3. **Split Emails:** fills in the café's addresses:
     - **`@bookings`:** `RTD_BOOKINGS_EMAIL` (info@), or the café address if that key is missing.
     - **Empty `to` or `reply_to`:** the café address.
  4. **Send Email:** Gmail (`ATech GMAIL`), sent as "Roll The Dice". If one email fails, the rest still go.
  5. `POST /internal/outbox/:id/sent` for each one sent.
  6. **Mark Failed In App** (since 2026-10-16): `POST /internal/outbox/:id/failed` with Gmail's error, for each one that failed. The app tries it again after 5 minutes, 15 minutes, 1 hour, 4 hours and 12 hours.
  7. **Given Up? / Email Given Up:** only when the app says that was the last try does the run stop with an error, so `Studio: Error Handler` emails Dan once. The email is listed under **Delivery** in the organiser, with **Try again now**.
  - **Collecting claims:** the app holds each email it returns for 10 minutes, so an overlapping or half-finished run doesn't send it twice.
- **What it sends:**
  - **To the person who booked:** the booking confirmation (replies go to info@).
  - **To info@:** a copy of every booking and cancellation, the numbers two days before each booked café event, and a warning when a booked date leaves the Logic Engine.
  - **To the host:** each new booking and cancellation on their session, and the numbers two days before each date.
  - **When a date is cancelled:** an email to everyone booked, plus a notice to info@ or the host.
- **Live since 2026-10-06 08:55** (published); `@bookings` since 2026-10-07.
- **Errors:** collecting and marking retry 3 times; Gmail retries twice.

## RTD Market Vendors To Sheet (`gpm3eaxYJf9m4hRd`)

Keeps the **RTD Market Vendors** spreadsheet in step with the app's market applications ([RTD_MARKETS.md](RTD_MARKETS.md#the-spreadsheet)).

- **Triggers:** every 15 minutes (Europe/London), plus **Run By Hand**.
- **Steps:**
  1. Read `RTD_APP_BASE_URL` from `rtd_config`.
  2. `GET /internal/market-applications/sheet`: each application whose row is out of date (up to 100), with the whole row.
  3. **Write Row To Market Sheet:** Google Sheets **append or update**, matched on **Application ID**. RAW cells, so nothing a vendor typed can become a formula, and extra fields are ignored.
  4. `POST /internal/market-applications/:id/sheet-synced` with the row's hash, so each change is written once.
- **Erasing:** erased applications (12 months after the market) come through as erased, so the sheet is cleared too.
- **Credentials:** `rtd-app` and `ATECHGoogleSheets`.
- **Errors:** every step retries 3 times; failures go to `Studio: Error Handler`.
- **Live since 2026-10-08 09:30** (published).

## RTD Event Reminders To Facebook (`2BLoRwo7Fvtdu2ya`)

Posts each admin's event reminder on the café's Facebook page ([RTD_ALERTS.md](RTD_ALERTS.md#how-it-works)).

- **Triggers:** every minute (Europe/London), plus **Run By Hand**. Successful runs aren't saved, so the list of runs isn't flooded; failed ones are.
- **Steps:**
  1. Read `RTD_APP_BASE_URL` from `rtd_config`.
  2. `GET /internal/social-posts`: up to 5 reminders waiting for their post. Usually none, and the run stops there.
  3. **Posts To Send:** one Buffer request each: `createPost` to the café's Facebook channel (`6a4034035ab6d2f1067c890a`), shared now, as a Facebook post. With a photo when the event has one (the app's `/images/<id>` address).
  4. **Post To Facebook Via Buffer:** `POST https://api.buffer.com`. Tried twice; a failure carries on to the next step rather than stopping.
  5. **Posted?** Buffer gave a post ID → `POST /internal/social-posts/:id/done` with it. Otherwise → `POST /internal/social-posts/:id/failed` with Buffer's reason, which admins see under **Latest reminders**.
- **Not retried:** a failed post stays failed, so a broken post is never repeated every minute.
- **Credentials:** `rtd-app` and `RTD Buffer`.
- **Errors:** the app calls retry 3 times; failures go to `Studio: Error Handler`.
- **Live since 2026-10-08 13:10** (published).

## Event social prompts (contract for Stage 2)

**Stage 2 has started:** the Builder exists, unpublished (see [As built](#as-built-rtd-social-prompt-builder-lh9mziobdpbpbivo)), and the Context and Gate sub-workflows are published, not yet called (see [As built](#as-built-the-context-and-gate-sub-workflows)). Stage 1 was the app side only. It ships with the switch (setting `social_prompts`) at **Off**, so every post goes out exactly as it does today. The n8n side is Stage 2: the new **RTD Social Prompt Builder**, and edits to **RTD Master V1** and the poster path. Each step needs the owner's go-ahead (gates G1–G6 in the [spec §6](superpowers/specs/2026-10-18-social-master-prompt-design.md#6-rollout-each-gate-needs-the-owners-go-ahead-and-rollback)). This section is what those workflows must do, matched to the code in `src/routes/internal.ts`, `src/social/prompts.ts` and `src/social/check.ts`.

**The idea, in short:**
- Each event gets its own master prompt, written by Gemini from the facts the café wrote down: Base Details (Notes on Standard Diary), **Approved Facts** and **People & Roles**.
- The app checks the prompt with fixed rules, stores each version, and approves it only when every check passes. Otherwise it goes to an admin for review.
- Before every post, n8n asks the app for each event's prompt, facts and the date to use. Just before posting, it sends the finished caption back to be checked.
- Gemini never sees dates, times, other events, emails or posting history. The prompt never holds a date; the date comes fresh from the app at posting time.

**For every endpoint:**
- Authentication: the `rtd-app` header-auth credential (`Authorization: Bearer <INTERNAL_SYNC_TOKEN>`), as for every other `/internal/*` route. A missing, malformed or wrong token gets **401**; **503** means the app has no token set.
- Bodies are JSON. A body over 1 MB gets **413**, and one that isn't JSON gets **400**.
- Refusals are `{ "error": "…" }` in plain words, sometimes with `errors: [ … ]`.

### First, RTD Event Sync must carry the new columns

**Build Snapshot** in RTD Event Sync (`fOYrFBOElFkWx7R3`) sends only a fixed list of columns. Until **Approved Facts**, **People & Roles** and **Banned Phrases** are added to its Event Index list, and **Approved Facts** and **People & Roles** to its Standard Diary list, the app sees them as blank. Every prompt would then be built from Base Details alone, and every post naming a person or a booking rule would fail its check.
- This goes after G2 (once the columns exist), with its own go-ahead.
- The app keeps these columns out of each event's change hash, so the first sync that carries them changes no event and writes no audit noise.
- **Social Prompt** and **Social Prompt Status** must never be sent. The app wouldn't read them anyway, so a generated prompt can't feed back into its own facts.

### The builder: RTD Social Prompt Builder (Stage 2)

Every 15 minutes, created **unpublished**, with `Studio: Error Handler`.

**1. `GET /internal/social-prompts/due?limit=5`**
- Answers `{ "events": [{ "event_id", "fingerprint", "request": { "system", "user" }, "instruction_version": 3 }] }`, soonest first.
- `limit` is 1 to 20; anything else means 5.
- `request.system` is the instruction (the brief's §7 wording, plus the tone guidance rules below) and the JSON shape Gemini must return. `request.user` is the event's whitelisted fields as quoted JSON data. Send both to Gemini exactly as given, asking for JSON.
- **Tone guidance (from 25 Oct 2026, instruction version 2):**
  - `request.user` also holds `tone_guidance`: the event's **Michelle's Standard Prompt** from the sheet, as the app last synced it. It's left out when there is none (Standard Diary groups never have one).
  - The instruction tells Gemini to use it only for tone, voice and style. Every fact (names, dates, times, prices, activities, claims) must come from the approved fields, each person is described only with the role words in People & Roles, and field labels are written in plain words.
  - **No n8n change is needed:** the builder already passes `request.system` and `request.user` to Gemini unchanged (see **Write Prompt (Gemini)** below).
  - **Existing prompts aren't regenerated.** Tone guidance isn't part of the fingerprint or the stored snapshot, and the instruction version is only recorded on each version; neither decides whether an event is due. So an approved prompt stays in use. The change applies only to prompts made from now on: a new event, changed facts, or **Regenerate**. Changing Michelle's Standard Prompt alone doesn't make an event due.
- **Repairs (from 28 Oct 2026, instruction version 3):**
  - When the checks fail a prompt Gemini wrote (problems the app found, not only Gemini's own questions), the event stays due and is sent again with its last draft. `request.user` then also holds `previous_attempt: { "prompt": <that draft>, "problems": [<what the checks found>] }`.
  - The instruction gained a short paragraph: rewrite that draft so every listed problem is gone, change only what's needed, keep to the approved fields, and never invent facts to get past a check. `previous_attempt` is not an approved field and is never a source.
  - **Three attempts** for the same facts, then the version waits for an admin and the event isn't due any more. A pass ends it straight away. A version where Gemini only asked a question isn't repaired.
  - An admin's **Fix** (or **Fix all**, for the whole review list) starts a fresh count of three: the request carries `previous_attempt` from the latest version. **Regenerate** also starts a fresh count, without the draft.
  - Prompts made before version 3 aren't repaired by themselves (an admin can press Fix), and approved prompts never change.
  - **The facts never change by themselves.** The review card may suggest a change to People & Roles; it only goes to the sheet when an admin taps Apply (through Sheet sync, like any other change).
  - **No n8n change is needed:** the builder already passes `request.system` and `request.user` to Gemini unchanged.
- **An event is due when:**
  - it is running, Public or App Bookable, and has a scheduled, public date still to come;
  - nothing is on its way to the Logic Engine for it (an organiser's change, a host's request waiting for a decision, or an approved one not yet in the sheet);
  - and its current facts have no answer yet, an admin pressed **Regenerate** or **Fix**, or its last answer is being repaired (above).
- Market events and hosts' sessions are due like café events.
- Past, cancelled, private, hidden and stopped events are never due.

**2. Gemini**, then **`POST /internal/social-prompts/:eventId`**
- **Body:** `{ "fingerprint": <from /due>, "job_id": <the n8n execution ID>, "model": <the model name>, "output": <Gemini's answer, as JSON or as its text> }`.
- **When the generation failed** (a timeout or a quota error), send `{ "fingerprint", "job_id", "error": <the error, as text or the error object> }` instead.
- **Answers (200):**
  - `{ "ok": true, "status": "approved" | "review_required" | "blocked", "version": 3, "cells": { "Social Prompt": "…", "Social Prompt Status": "…" } }`: write the two cells (step 3).
  - `{ "ok": true, "status": "failed", "failures": 1, "version": null, "cells": null }`: the generation failed and nothing was stored. **Write nothing.** The event stays due and is tried on the next run.
    - Malformed output counts as a failure too: not JSON, the wrong shape, or a prompt over 3,000 characters.
    - On the **third** failure for the same facts, the app stores a `blocked` version ("generation failed") and answers with its cells. The event then stops being due until an admin presses Regenerate.
  - The same answer sent twice gets back the stored answer. Nothing is added. (While a prompt is being repaired, a later post is taken as the next attempt.)
- **Refusals:**
  - **409, stale:** the event's facts changed since `/due`. Drop it and write nothing; the event is due again from its latest facts.
  - **409, no longer due:** it stopped running, lost its last date, or a change is on its way. Drop it.
  - **409, "another answer is being stored just now":** a rare race. Drop it.
  - **404:** no event with that ID.
  - **400:** no fingerprint, or neither `output` nor `error`.

**3. Write the cells, then `POST /internal/social-prompts/:eventId/written`**
- Write **only** Social Prompt and Social Prompt Status, on the row matched on **Event ID** (Google Sheets update, `ATECHGoogleSheets`).
- Then send `{ "version": 3 }`. It answers `{ "ok": true }`. Saying so twice is fine. **400** means a missing or bad version; **404** means there's no such version for that event.
- **What the cells say:**
  - **Social Prompt** is always the prompt in use: the approved text, or blank when there is none. A version that needs review never replaces a working prompt.
  - **Social Prompt Status** is `approved · v3`, `review · v3: <the first question or problem>` or `blocked · v3: <the reason>`. The reason is one line, up to 200 characters.

**4. `GET /internal/social-prompts/to-write`** on the same run
- Answers `{ "prompts": [{ "event_id", "version", "cells" }] }`: each event's newest version whose cells aren't in the sheet yet (up to 50).
- It picks up versions an admin approved on the screen, and any write that didn't finish. Write them as in step 3, then call `/written`.
- A version just returned by step 2 also appears here until `/written` is called. Writing it twice is harmless.

**What the app adds itself:** the fixed schedule rule is appended by code to every stored prompt, exactly once: "Use ONLY the date and time supplied for the target occurrence at posting time; never state any other date or time." Gemini isn't trusted to include it.

#### As built: RTD Social Prompt Builder (`lh9MzioBdpBpBIVo`)

**Created 2026-10-19, not published, in dry run against the staging sheet.** Credentials: `rtd-app` (header auth), `ATECHGoogleSheets`, the Gemini API credential. Settings: error workflow `Studio: Error Handler` (`IClMUs9ByRmVBYJf`), Europe/London, executions saved, 900 s timeout.

**Nodes, in order:**
1. **Every 15 Minutes** and **Run By Hand** → **Read rtd_config** (every row) → **Builder Settings** (the app URL, dry run, which sheet, the limit; it refuses a staging ID that is the live sheet).
2. **Read Event Index** and **Read Standard Diary** on the chosen sheet.
3. **Get Due Events** (`GET /due?limit=<limit>`) → **Due Events** (one item each) → **Loop Over Events**, one event at a time, so each gets its own tries:
   - **Write Prompt (Gemini)**: `request.system` as the system message, `request.user` as the only message, JSON output, temperature 0.2, 2 tries. Errors are carried on as items.
   - **Answer For App** builds `{ fingerprint, job_id, model, output }`, or `{ fingerprint, job_id, error }` when Gemini failed or answered nothing.
   - **Prepare Try** → **Send Prompt To App** (`POST /:eventId`; the status code is read, never thrown) → **Check Answer** → **Try Again?**
   - A 5xx or no answer goes through **Wait Before Retry** (5 s) and is sent again, up to 3 tries. That is safe because a repeated POST gets the stored answer back. A 409, 400 or 404 is never retried.
4. When the loop is done, **Tally Answers** counts the final answers:
   - **stored**: a 200 with cells, written in step 5 of the same run.
   - **failed**: a 200 with `status: 'failed'`. Ends quietly; the event stays due.
   - **409**: stale, no longer due, or a race. Ends quietly.
   - **unexpected**: 400, 401, 404, 413, a 5xx after 3 tries, or no answer. The other events and step 5 still run.
5. From Get Due Events, a second branch, placed below so it runs after the first has finished:
   - **Get Prompts To Write** (`GET /to-write`) → **Prompts To Write** maps each trimmed Event ID to its tab (Event Index first, then Standard Diary). In a dry run it outputs nothing. An ID on neither tab is skipped and stays in `/to-write`.
   - **Which Tab** → **Update Event Index Cells** or **Update Standard Diary Cells**: Google Sheets update, matched on the Event ID exactly as the sheet holds it, only **Social Prompt** and **Social Prompt Status**, RAW.
   - **Read Back …** → **Confirm … Writes**: a version counts as written only when the row with its trimmed Event ID now holds both cells.
   - **Live And Matched** → **Mark Written In App** (`POST /:eventId/written { version }`). It runs **only on the live sheet**: `/written` marks the version written for the event, not for one sheet, so a staging write must never call it.
6. **End Of Run Check**, the lowest branch, so it runs last, raises **one** error for the run (the error workflow emails it) when:
   - any answer was unexpected;
   - every Gemini call in the run failed (for example a revoked key);
   - or cells weren't found on the sheet after writing.
   Otherwise it outputs a summary of the run's counts.

Versions answered in step 3 are written by step 5, because `/to-write` lists them until `/written` is called. So one write path covers new answers, an admin's approvals and unfinished writes.

**rtd_config keys** (none of the sheet IDs belong in this repository):

| key | value | meaning |
| --- | --- | --- |
| `SOCIAL_BUILDER_DRY_RUN` | `true` (added 2026-10-19) | Anything but `false`, or missing, is a dry run: Gemini runs and the app stores its answers, but no sheet cell is written and `/written` is never called. |
| `SOCIAL_BUILDER_SHEET` | `staging` (added 2026-10-19) | `staging` (or missing) uses `RTD_STAGING_LOGIC_ENGINE_ID`; its writes are tests and never call `/written`. `live` uses `RTD_LOGIC_ENGINE_ID`, or the sheet RTD Event Sync reads when that isn't set. |
| `RTD_LOGIC_ENGINE_ID` | the live sheet (added 2026-10-19) | The live Logic Engine, the same sheet RTD Event Sync reads. RTD Sheet Writer reads it too, for its shadow and live targets. |
| `SOCIAL_BUILDER_LIMIT` | not set | Events per run, 1 to 20. Missing means 5 on the schedule and **1 for Run By Hand**. |

**How to run it:**
- **Dry run, by hand:** keep `SOCIAL_BUILDER_DRY_RUN=true` and `SOCIAL_BUILDER_SHEET=staging`, open the workflow and click **Run By Hand**. It takes the single soonest due event. For the G4 rehearsal of 3 events, add `SOCIAL_BUILDER_LIMIT=3` first and delete it afterwards. Check D1: `SELECT event_id, version, status, substr(validation_errors,1,200) FROM social_prompts`.
- **Write to staging (G4, owner's go-ahead):** set `SOCIAL_BUILDER_DRY_RUN=false`, run by hand once, and check that only Social Prompt and Social Prompt Status changed on the staging copy.
  - Staging writes are **test-only**: `/written` is never called, so the versions stay in `/to-write` for the live sheet.
  - **Before going live, set `SOCIAL_BUILDER_DRY_RUN=true` again** (or go straight to live). Otherwise every scheduled run rewrites the staging cells.
- **Go live (owner's go-ahead):** set `SOCIAL_BUILDER_SHEET=live` and `SOCIAL_BUILDER_DRY_RUN=false`, make sure `SOCIAL_BUILDER_LIMIT` is gone (or 5), then publish. Rolling back means unpublishing it, or setting `SOCIAL_BUILDER_DRY_RUN=true`.
- The app's `social_prompts` setting has no effect here: `/due` ignores it.

**Tested 2026-10-19** (the app's setting stayed Off throughout):
- **Wiring with nothing due** (execution `68976`): `/due` pinned to `{ "events": [] }`; everything else ran for real. Success. No Gemini call; the to-write branch ran (`{ prompts: [] }`) and wrote nothing.
- **Write path, simulated** (execution `68983`): rtd_config pinned with the dry run off, `/to-write` pinned with three prompts, the sheet updates and `/written` pinned. The Event Index ID went to the Event Index update, the Standard Diary ID to the Standard Diary update, and an unknown ID was skipped. Nothing was written.
- **One-event dry run** (execution `68994`): staging, dry run, limit 1, nothing pinned. One Gemini call, which returned JSON. The app answered **200** `review_required`, version 1, for RTD-EVT-00005 (Home Education Support Club). D1 holds one `social_prompts` row, with `written_at` empty. Its review reasons: "Monday" and "Thursday" from Base Details, and "open play", "booking", "child" and "families" with no Approved Facts behind them. `/to-write` listed it; no sheet cell changed and `/written` wasn't called.
- **Stale answer** (execution `68996`): `/due` pinned with a wrong fingerprint for RTD-EVT-00001, and Gemini pinned. The app answered **409** "Stale: …". It went to the 409 output and the run succeeded. D1 gained no row and no audit entry. (Manual runs never call the error workflow; in production a 409 doesn't either, because nothing fails.)
- **Fix round 1** (after review):
  - `68976` and `68983` above predate the fixes.
  - **Wiring with nothing due** (`69061`): success. No Gemini call; to-write ran (dry run, nothing written); End Of Run Check reported due 0.
  - **Stale answer** (`69514`): 409 after 1 try, no retry, counted as dropped. The run succeeded.
  - **A 5xx doesn't stop the run** (`69520`): two events pinned, with Gemini and the POST pinned to answer 503; the dry run was off on staging, and `/to-write` and the sheet were pinned.
    - Each event was sent 3 times, with two 5 s waits.
    - The second event still ran after the first failed.
    - The to-write branch ran, and the read-back matched an Event ID that has a trailing space. On staging nothing went to `/written`.
    - Then End Of Run Check raised one error: "The app did not take 2 answer(s): … 503 after 3 tries".
  - **Every Gemini call failed** (`69522`): Gemini pinned to a key error, and the POST pinned to `status: 'failed'`. One error at the end of the run.
- **Not yet:** a real sheet write, a live `/written`, the 3-event rehearsal (it waits for the owner's facts), and publishing.

### Example posts beside each prompt (contract for the builder, 23 Oct 2026)

**App side built** on branch `ccr-b9b076a7-f9fv6q`; **not deployed**, and it needs **migration `0025_social_prompt_examples.sql`** (seven new columns on `social_prompts`), applied first with the owner's go-ahead. Until then both endpoints answer **503** with the reason. The n8n side isn't built yet.

**What it's for:** each prompt (approved, or waiting for review) gets one sample Facebook post beside it on Organise › **Social posts**, so the owner can see what the prompt writes before approving it. The example is written the way the live Facebook event post is, checked by the same check, and shown with its result ("would pass" or "would be held: …").
- **It never posts,** never goes to Buffer, never writes to the sheet or the Post Log, and doesn't change the prompt's status. The app adds no `social_checks` row for it.
- It works at **every** switch setting, Off included.

**For each run** (it can share the Builder's 15-minute schedule; same credential and error handling):

**1. `GET /internal/social-prompts/examples-due?limit=3`**
- `limit` is 1 to 10 (higher counts as 10, lower as 1); anything else means 3.
- Answers `{ "examples": [{ "event_id", "version", "occurrence_id", "layer", "date_block", "fallback_prompt" }] }`, soonest date first.
- **A version is listed when:**
  - its event could have a prompt made now (the same rule as `/due`: running, Public or App Bookable, a scheduled public date to come, nothing on its way to the Logic Engine), and has a confirmed date the public can see (not only a projected one);
  - it is the event's newest version (a waiting Regenerate request doesn't count), and it is `approved` or `review_required`, with prompt text;
  - it has no example yet, and fewer than 3 answers (examples and errors together).
- A new version (a regenerate, new facts, or an admin's approval) is listed again for its own example. An older one never is.

**2. Gemini** (the same model and settings as **Gemini Engine: Michelle Voice**), with the message built **exactly** as the live Facebook event post builds it:
```
layer + "\n\n" + <the event's Michelle's Standard Prompt from Event Index, matched on Event ID> + "\n\n" + date_block
```
- Use `fallback_prompt` in place of Michelle's Standard Prompt when the row has none (blank, or the row isn't found).
- **`layer`** is the same text RTD Social Context (sub) builds as `block` for that event: the prompt, trimmed; then, only when at least one isn't blank, a blank line and the lines `Approved facts: <Approved Facts, trimmed>` and `People & roles: <People & Roles, trimmed>` (each only when it isn't blank), joined by a single line break. It is built in the app (`layerBlock`, `src/social/check.ts`) from the version's own prompt, which may still need review, and the facts as the last sync read them.
- **`date_block`** is `Date: <label>`, as the live flow's `date_block`, for example `Date: Friday 23 October, 6:30pm`, or `Date: Wednesday 21 October` with no time (`dateBlock`, from the same next-date choice `/social/context` makes). `occurrence_id` is that date's.
- `fallback_prompt` is: "Write one friendly Facebook post for Roll The Dice Café about this event, using only the details above."
- **Don't** call `/social/context`, the Gate, Buffer or any sheet node for an example.

**3. `POST /internal/social-prompts/:eventId/example`**
- **Body:** `{ "version": <from step 1>, "job_id": <the n8n execution ID>, "model": <the model name>, "text": <Gemini's post> }`.
  - `text` is trimmed and may be up to 5,000 characters.
- **When Gemini failed** (a timeout, a quota error, an empty answer), send `{ "version", "job_id", "error": <the error, as text or the error object> }` instead.
- **Answers (200):**
  - For a text: `{ "ok": true, "passed": true | false, "problems": [ … ] }`. The problems are the reasons a live post would be held, in the same words. The prompt's own approval isn't one of them (a version waiting for review is checked as if it were in use), but "prompt out of date" is, when the facts changed since the version was made.
  - For an error: `{ "ok": true }`. The error is kept and shown to admins after the third try ("No example (n8n couldn't write one): <error>").
- **Refusals:**
  - **409:** that version isn't the event's newest any more (a new version came since step 1). Nothing is stored. Drop it; the new one is listed on a later run.
  - **404:** no event with that ID, or no such version for it.
  - **400:** the body isn't a JSON object, `version` is missing or not a whole number from 1, `text` is blank, not text or over 5,000 characters, or there's neither `text` nor `error`.
  - **503:** migration 0025 isn't applied yet.
- Sending the same text twice is harmless: the second replaces the first, and counts as another answer.

### Every post: RTD Master V1 and the poster path (Stage 2)

**5. `POST /internal/social/context`**, before Gemini writes a caption
- **Body:** `{ "event_ids": [1 to 50 Event IDs], "sheet_dates": { "<event_id>": <the Logic Engine's date as n8n read it> } }`. `sheet_dates` is optional; UK, ISO and sheet serial dates are all read.
- **At Off:** `{ "mode": "off", "events": [] }`. The body isn't even read. Caption nodes carry on exactly as today.
- **At Shadow or Enforce:** `{ "mode": "shadow" | "enforce", "events": [ <layer>, … ] }`. Each layer is:
  - `event_id`
  - `prompt`: the approved master prompt in use, or `""` when there is none for the current facts
  - `prompt_version`: its version, or `0` for none. Send it back with the check.
  - `base_details`, `approved_facts`, `people_roles`, `banned_phrases`: as the last sync read them
  - `occurrence`: the date the post is about, or `null` when there is none. That is `{ "occurrence_id", "date": "2026-10-23", "label": "Friday 23 October, 6:30pm", "start_time", "end_time", "is_today", "is_tomorrow" }`.
    - It is the event's next date that the public can see and that is still to come, or still running.
    - A date the app only **projected** from the event's cadence is never used: the Logic Engine hasn't confirmed it.
  - `sync_pending`: `true` when the sheet's date (from `sheet_dates`) isn't the app's date yet, because the sync can be up to 15 minutes behind. The check will fail it.
- An Event ID the app doesn't know is left out.
- **400:** `event_ids` missing, empty, over 50 or not IDs; or `sheet_dates` isn't an object of dates.
- **Where it goes:** the event layer before the global persona prompt, and the occurrence's date block after it. Round-ups get one block per event, each from its own layer.

**6. `POST /internal/social/check`**, immediately before every "Post to Buffer (…)" and "Buffer: Instagram Carousel (…)" node
- **Body:**
  ```json
  { "kind": "event_post | roundup | poster", "platform": "facebook",
    "targets": [{ "event_id": "RTD-EVT-00001", "occurrence_id": "…", "prompt_version": 3 }],
    "text": "the caption, exactly as it will be posted",
    "image_text": "the poster's wording, when there is a poster",
    "workflow": "RTD Master V1", "execution_id": "12345",
    "sheet_dates": { "RTD-EVT-00001": "23/10/2026" } }
  ```
  - `targets`: 1 to 50. Use the `occurrence_id` and `prompt_version` the context gave.
  - `text`: up to 20,000 characters, as is `image_text`.
  - `platform`, `workflow` and `execution_id` are kept for the record (up to 100 characters each).
  - `image_text` and `sheet_dates` are optional.
- **Answer (200):** `{ "allow": true | false, "result": "pass" | "fail" | null, "reasons": [ … ], "mode": "off" | "shadow" | "enforce" }`.
  - Reasons are plain sentences for admins. Those about an event or its date start with the event's name, such as `"Quiz: its date 2026-10-23 was cancelled"`. Those about the words quote them, such as `'"£5": not the price of …'`. Reasons about the poster start with `Poster: `.
- **400:** the body can't be checked (a bad `kind`, `targets`, `text` or `sheet_dates`). The app never answers "allowed" to a body it couldn't check, except at Off, where it doesn't read the body.

**What n8n does at each setting:**

| Setting | Context | Check | n8n posts when… |
| --- | --- | --- | --- |
| **Off** (now) | No layers | `{ allow: true, result: null, mode: "off" }`; nothing read or recorded | Always, as today |
| **Shadow** | Layers | Every post is checked and recorded; `allow` is always `true` | Always. A failure is only recorded, and shown to admins as "would have been held" |
| **Enforce** | Layers | Every post is checked and recorded; `allow` is `true` only on a pass | **Only on a 200 with `allow: true`.** Any other answer (`allow: false`, a 400, 401, 413, 5xx or a timeout) means **don't post**: append a Post Log row with Automation Status **`Held`** |

- The app lists held posts (and, in Shadow, the posts that would have been held) under Organise › Events & dates › **Social prompts** (once the 23 Oct change is deployed: Organise › **Social posts**).
- **When the app can't be reached at all** (decided in Stage 2): n8n uses the last setting the app answered, kept in rtd_config `SOCIAL_MODE_LAST`. It holds only when that is `enforce`; a missing key counts as not enforce. See the Gate below.

**Posters (Stage 2):**
- Poster Generator records the exact quoted poster text, and the time it used, in the Drive file's description.
- Master V1 reads it and sends it as `image_text`.
- At Enforce, a poster whose wording or time doesn't match, or that has none (as with older posters), isn't attached. Event Guard's poster step makes a new one when the recorded time differs from the row's Event Time. See [As built: posters](#as-built-posters-through-the-social-gate-task-5).

#### As built: the Context and Gate sub-workflows

**Created and published 2026-10-19.** Nothing calls them until the Master V1 edits (Tasks 3 to 5) are published at G5; the Facebook event post's calls are in the draft (see [Master V1, the Facebook event post](#as-built-master-v1-the-facebook-event-post)). Both: an **Execute Workflow Trigger** (`When Called`) with defined inputs, plus **Run By Hand** with a sample input; caller policy `workflowsFromSameOwner`; error workflow `Studio: Error Handler` (`IClMUs9ByRmVBYJf`); Europe/London; 120 s timeout. They read `RTD_APP_BASE_URL` from rtd_config and use the `rtd-app` header-auth credential.

**Neither throws on an app failure.** The app call has `onError: continueRegularOutput`, 2 tries (2 s apart) and a 15 s timeout, and reads the status code instead of failing on it. rtd_config is read with `continueRegularOutput` too.

**rtd_config `SOCIAL_MODE_LAST`** (added 2026-10-19, now `off`): the last `mode` the app answered (`off`, `shadow` or `enforce`). Both subs upsert it from every 200 answer, but only when the mode has changed, so there is no write on most calls.

**RTD Social Context (sub)** (`QCjohGtBuld6k5R8`)
- **Input:** `{ events: [{ event_id, sheet_date }] }`. `sheet_date` is optional and is sent as `sheet_dates` only when it is non-empty text or a number. Event IDs are trimmed and de-duplicated, up to 50.
- **Nodes:** When Called / Run By Hand → Sample Events → **Read rtd_config** → **Context Request** → **Ask App For Context** (`POST /internal/social/context`) → **Build Layers** → **Mode Changed?** → **Save SOCIAL_MODE_LAST** (Data Table upsert) → **Context Result**.
- **Output**, one item: `{ mode, layers: { [event_id]: { block, occurrence_id, prompt_version, date_block } }, ok }`.
  - `block`: the event's `prompt`, then a blank line and `Approved facts: …` and `People & roles: …` lines when they aren't empty. It is `""` when there's no prompt. At `off` there are no layers at all.
  - The schedule rule is already in the stored prompt, so it isn't added again. Banned Phrases aren't put in the block; the check looks for them.
  - `occurrence_id`: from the context, or `null` when the event has no date. `prompt_version`: as the context gave it (`0` for none). Both go back to the Gate unchanged.
  - `date_block`: `Date: <occurrence.label>`, or `""` with no date.
  - An event the app doesn't know has no layer.
- **On any failure** (no answer, a non-200, or an answer it can't read): `{ mode: 'unknown', layers: {}, ok: false }`, and `SOCIAL_MODE_LAST` is left alone. The caller then writes the caption exactly as today.

**RTD Social Gate (sub)** (`NqC8fZUoIWWuvDnt`)
- **Input:** `{ kind, platform, targets, text, image_text?, workflow, execution_id, sheet_dates? }`, as the check's body above. `targets` and `sheet_dates` may be passed as JSON text. `image_text` is sent only when it's non-empty, and `sheet_dates` only when it has entries. `text` is sent exactly as given.
- **Nodes:** When Called / Run By Hand → Sample Post (the real 18 Oct Quiz caption) → **Read rtd_config** → **Check Request** → **Ask App To Check** (`POST /internal/social/check`) → **Gate Answer** → **Mode Changed?** → **Save SOCIAL_MODE_LAST** → **Gate Result**.
- **Output**, one item: `{ post, held_reason }`.
  - **A 200 with `allow`:** `post = allow`. When it is `false`, `held_reason` is the reasons joined by `; `; otherwise it is `""`.
  - **Anything else** (a 400, 401, 413, 5xx, no answer or timeout, or a 200 it can't read): `post = (SOCIAL_MODE_LAST !== 'enforce')`. `held_reason` is `app unreachable` when there was no answer, or else the app's `error` text. It is set even when `post` is `true`, so the caller can log that the post went out unchecked.

**Tested 2026-10-19** (the app's switch stayed Off; Shadow and Enforce answers were pinned):

| Execution | Test | Result |
| --- | --- | --- |
| `69558` | Context, real call, Run By Hand (`RTD-EVT-00001`) | `{ mode: 'off', layers: {}, ok: true }`. `SOCIAL_MODE_LAST` was missing, so it was added as `off`. |
| `69559` | Context again | Same answer; Mode Changed? false, so no write. |
| `69560` | Gate, real call, the real 18 Oct Quiz caption | `{ post: true, held_reason: '' }`; the app answered `allow: true, result: null, mode: 'off'`. D1 `social_checks` still has 0 rows. |
| `69562` | Context via When Called, the answer pinned to Shadow with 3 events (prompt with facts and people; prompt with no date; no prompt) | Blocks, `occurrence_id` (`null` with no date), `prompt_version` and `date_block` as above. A serial `sheet_date` was sent as a number. `SOCIAL_MODE_LAST` → `shadow` (same row, updated). |
| `69563` | Gate, pinned Shadow 200 (`allow: true, result: 'fail'`) | `post: true`, `held_reason: ''`. No write (mode unchanged). |
| `69564` | Context, pinned Enforce answer | `SOCIAL_MODE_LAST` → `enforce`. |
| `69565` | Gate, pinned Enforce 200 (`allow: false`, two reasons), with `image_text` and `sheet_dates` | `post: false`, the two reasons joined by `; `. |
| `69567` | Gate, pinned **400**, last mode `enforce` | `post: false`, `held_reason` = the app's error text. |
| `69573` | Gate **test copy** with the app URL at a host that doesn't exist, last mode `enforce` | Two tries, then `post: false`, `app unreachable`. |
| `69581` | Context test copy, same bad host | `{ mode: 'unknown', layers: {}, ok: false }`; `SOCIAL_MODE_LAST` untouched. |
| `69582` | Context, real call | Put `SOCIAL_MODE_LAST` back to `off`. |
| `69583` | Gate test copy, bad host, last mode `off` | `post: true`, `held_reason: 'app unreachable'`. |

The two test copies are archived. D1 `social_checks` had 0 rows before and after.

#### As built: Master V1, the Facebook event post

**Edited 2026-10-19, in the draft only** (latest draft `f544db43-1f9c-4194-8c43-647bd34bfc28`; the published version is still `38b1d6d1-ee8f-4683-aea1-0b94c5a1351b`, the rollback point). Only the Facebook event path changed (integration point 1). The round-ups and the Instagram Priority caption followed in Task 4 (draft `4ef9c552-…`, [below](#as-built-master-v1-the-round-ups-and-the-instagram-priority-caption)); posters are Task 5.

**New nodes** (all named `… (Event Post)`):
- **Social Context (Event Post):** Execute Workflow → RTD Social Context (sub), once per due event, with `events: [{ event_id: <Event ID>, sheet_date: <Event Date> }]` as a real array. `onError: continueRegularOutput`, so a failed call means no layer.
- **Add Social Layer (Event Post):** Code. It copies Pair With Event Metrics' item unchanged and adds `social: { mode, ok, event_id, sheet_date, block, date_block, occurrence_id, prompt_version }`. With no layer, `block` is `''`. It never throws.
- **Social Gate (Event Post):** Execute Workflow → RTD Social Gate (sub), after Build Photo Context (Master). It sends `kind: 'event_post'`, `platform: 'facebook'`, `targets: [{ event_id, occurrence_id, prompt_version }]` (a real array, and `occurrence_id` may be `null`), `text` = the caption exactly as Buffer gets it, `workflow: 'RTD Master V1'`, `execution_id`, and `sheet_dates: { <Event ID>: <Event Date> }` (a real object). `image_text` is empty until Task 5. `onError: continueRegularOutput`.
- **Merge Gate Answer (Event Post):** Code. Build Photo Context's item (caption and photos, untouched), plus `social_post` and `social_held_reason`. When the Gate sub gives no usable answer (it errors or returns nothing), `post = (this run's Context mode !== 'enforce')`: `off`, `shadow` or `unknown` posts as today, and `enforce` holds. App failures are still handled inside the Gate, by `SOCIAL_MODE_LAST`.
- **Social Gate Says Post? (Event Post):** IF on `social_post === true` only, never on the reason. True → **Post to Buffer (Master)**, as before. False → **Log Held Post (Event Post)** and **Retry Held Post Tomorrow (Event Post)**.
- **Log Held Post (Event Post):** Google Sheets append to Post Log, like Write Execution Transaction Log. Automation Status is `Held: <reason>`; Script / Copy Content is the caption. It never reaches Buffer.
- **Retry Held Post Tomorrow (Event Post):** on the same false branch, alongside Log Held Post. A Google Sheets update of Event Index, matched on `row_number` the way Advance Next Post Date (Master) matches, sets **Next Post only** to tomorrow: `$now.setZone('Europe/London').plus({ days: 1 })`, written as **ISO text `yyyy-MM-dd`** with cell format **RAW**, so the sheet keeps it as text and doesn't turn it into a date shown as `M/d/yyyy`. Is Event Due Right Now? reads a strict `^\d{4}-\d{2}-\d{2}$` value as that date before it guesses between dd/MM and MM/dd. A dd/MM value wouldn't do: that guess checks Next Post − Last Post = Post Frequency, which a held retry breaks. It does not use the post frequency, and Last Post is not changed. When the event next posts, Advance Next Post Date writes its usual format again. A held event steps aside for the rest of the evening, so the next due event can post on the next run, and the held one is tried again tomorrow (after someone fixes its facts). Retries 3 times.
- **Social Gate Note (Event Post):** a sticky note.

**Changed nodes:**
- **Gemini Engine: Michelle Voice:** today's message expression is kept character for character, with one expression added before it and one after: `{{ block ? block + '\n\n' : '' }}` and `{{ block ? '\n\n' + date_block : '' }}`. With a layer block, Gemini gets `block + "\n\n" + today's prompt + "\n\n" + date_block`. Without one (Off, a failed context, an unknown event, or no approved prompt), it gets exactly today's prompt. Today's Day/Date/Time block stays as it is.
- **Write Execution Transaction Log** (the Post Log fix, below).
- **Is Event Due Right Now?:** in `parseNextPost`, a strict ISO check runs first, for the held retry. Every other value takes exactly the same path as before.

**Connections:** Pair With Event Metrics → Social Context → Add Social Layer → Gemini (it was Pair → Gemini). Build Photo Context → Social Gate → Merge Gate Answer → Social Gate Says Post? → Buffer or Log Held Post (it was Build Photo Context → Buffer).

**The Post Log fix.** Write Execution Transaction Log wrote `Failed` for every successful post. It read `$json.id`, which is what the old Facebook Graph node returned. Since the switch to Buffer, the node gets Buffer's GraphQL answer, `{ data: { createPost: { post: { id } } } }`, so `$json.id` was always empty. That left Automation Status at `Failed` and BufferID empty: for example, 18 Oct 19:00, execution `65927`. Now:
- **Automation Status:** `Success` when `data.createPost.post.id` is set. Otherwise `Failed`, plus Buffer's `MutationError` message or GraphQL error when there is one.
- **BufferID:** `data.createPost.post.id`.
- **Asset used:** read from Pair With Event Metrics. It read `$json.fbUnderperforming`, which Buffer's answer doesn't have, so it always said `Standard`.

Transport errors still go to Log Failed Post (Master), which is unchanged. The Food path's **Write Execution Transaction Log1** had the same `$json.id` bug and the same `Asset used` bug. It now has the same fix: Automation Status and BufferID read from `data.createPost.post.id` (it wrote no BufferID before), and Asset used is read from Pair With Event Metrics1. This is logging only, so nothing that is posted changes.

**Tested 2026-10-19** on two no-post test copies, both now archived:
- `IMkiWNALz3CAmkl9` is the pre-edit path.
- `j18rqVgTMTnwBUei` is the post-edit path, generated from the draft's own nodes.

In both, Post to Buffer was replaced by a code stand-in that sends nothing, and every Sheets write by a Set node with the same column expressions. The disabled guardrail nodes were left out (they pass items straight through). A manual trigger replaced the schedule. Is Event Due Right Now?, the Drive, poster and Performance Sync reads, and Gemini were pinned (the 18 Oct Quiz row and its real caption). A parallel **Capture Gemini Input (TEST)** node rendered Gemini's exact message expression. Master V1 itself was never run.

| Execution | Test | Result |
| --- | --- | --- |
| `69612` | (a) Pre-edit path | Gemini input: 1,884 characters, sha256 `89e82e67…7f6b09`. The Post Log stand-in showed the bug: `Failed`, with an empty BufferID, for a successful Buffer answer. |
| `69622` | (b) Post-edit path at **Off**; the real Context (`69623`) and Gate (`69624`) subs were called | The context answered `{ mode: 'off', layers: {}, ok: true }`. Gemini input was **byte-identical to (a)**: 1,884 characters, the same sha256. The Gate got `targets` as an array (`occurrence_id: null`) and `sheet_dates` as an object, and answered `post: true`. The Buffer stand-in was reached, and the Post Log row read `Success` with the BufferID. |
| `69626` | (c) **Shadow**, check fails; Context pinned (a layer with `RTD-OCC-00001-20261023`, v3) and Gate pinned (`post: true`) | Gemini input = block, a blank line, today's prompt, a blank line, `Date: Friday 23 October, 6:30pm`. Buffer was reached; Log Held Post was not. |
| `69628` | (c) **Enforce**, check fails; Gate pinned (`post: false`, 3 reasons) | **Log Held Post** was reached, with `Held: Quiz: "cash prizes": …`. Buffer, the Post Log success row and Advance Next Post did not run. |
| `69678` | Follow-up: a separate no-post test copy (`WhLP3TYABpkZVdT3`, archived). (1) Enforce: the gate is pinned to `post: false`. (2) The Food log: Buffer is a stand-in that answers success, and `fbUnderperforming` is true. | (1) The false branch ran: the Held log row stand-in, and **Retry Held Post Tomorrow**, which was disabled so its input shows (the held item; Buffer was not reached). A parallel capture of its column expressions gave `Next Post: 20/10/2026`, `row_number: 2`, run on 19/10/2026 (since review round 1 it is written as ISO, see `69752`). (2) Before the fix: `Failed`, `Standard`, no BufferID. After: `Success`, `KPI Hook`, BufferID `TEST-FOOD-NOT-POSTED-0`. |

| `69750` | Review round 1: a no-post test copy (`lzIsfQDmjYOTD5uX`, archived). The Gate call points at a workflow that doesn't exist; Context mode is `off` | The Gate answered `{ error: "Workflow does not exist." }`. Merge Gate Answer gave `social_post: true` ("the social gate failed: … (context mode off)"), and the Buffer stand-in was reached. |
| `69752` | The same, with Context mode `enforce` | `social_post: false`. The Held log row stand-in was reached, and so was Retry Held Post Tomorrow (disabled, so it passed through the held item). Its values: `Next Post: 2026-10-20` (ISO, RAW), `row_number: 2`. Buffer was not reached. |
| (pure function) | The old and new Is Event Due Right Now? code (taken word for word from the node), run on today's real Event Index Next Post, Last Post and Post Frequency values, plus 7 edge values (blank, `23/10/2026`, an ISO timestamp, `2026-1-5`, `5.11.2026`, `garbage`, a serial number), `TZ=Europe/London` | 30 of 30 parse identically, and the due list is identical. The ISO values `2026-10-20`, `2026-11-05` and `2026-05-11` read as 20 Oct, 5 Nov and 11 May. |

#### As built: Master V1, the round-ups and the Instagram Priority caption

**Edited 2026-10-20, in the draft only** (draft `4ef9c552-7dfe-412d-b7bd-f79e01c3ed86`, started from `f544db43-…`; the published version is still `38b1d6d1-ee8f-4683-aea1-0b94c5a1351b`, the rollback point). Integration points 2 and 4. The new nodes copy the Facebook event post's design: a layer added before Gemini, the Gate before Buffer, a Merge with the same no-usable-answer rule (post unless this run's Context mode is `enforce`), an IF on `social_post === true` only, and a `Held: <reason>` Post Log row.

**The round-ups** (Prospectus, Mon/Thu about 20:00–21:00; Weekly, Sun 20:30). The nodes are named `… (Prospectus)` and `… (Weekly)`:
- **Find Next 2 Diary Days & Build Prompt** and **Find Next 7 Days Events & Build Prompt** also output `social_events`: `[{ event_id, name, sheet_date }]`, one per Event ID in the round-up, earliest date first. It covers both Event Index rows (`Event Date`) and Standard Diary rows (`Date`). Rows with no Event ID are left out. `promptText` is built exactly as before.
- **Social Context:** one call per round-up, with every event in it. `onError: continueRegularOutput`, alwaysOutputData.
- **Add Social Layer:** the Find node's item, plus `social: { mode, ok, blocks, targets, sheet_dates }`.
  - `blocks` is one section per event with a non-empty block, as `### <event name>\n<block>\n<date_block>`, joined by a blank line.
  - `targets` has **every** event in the round-up, including one with no block or no date (`occurrence_id: null`, `prompt_version: 0`), so Enforce holds those.
- **Gemini: Prospectus Post / Gemini: Weekly Recap Post:** today's message is kept character for character, with `{{ $json.social && $json.social.blocks ? $json.social.blocks + '\n\n' : '' }}` in front. With no blocks (Off, a failed context, unknown events, no approved prompts), Gemini gets exactly today's prompt. The round-ups have no date block after the prompt: each event's date is inside its own section.
- **Social Gate:** `kind: 'roundup'`, `platform: 'facebook'`, the targets and `sheet_dates` above as a real array and object, `text` = Gemini's caption, exactly what Buffer gets. `onError: continueRegularOutput`.
- **Merge Gate Answer → Social Gate Says Post?** True → **Post to Buffer (Prospectus / Weekly Recap)**, unchanged. False → **Log Held Post**, a Post Log append with Event Name `Prospectus Post` / `Weekly Post`, the caption, Date Posted and Automation Status `Held: <reason>`.
- **Any `post: false` holds the whole round-up.** Round-ups don't advance Next Post, so there is no retry write.
- **Connections:** Any Upcoming Events? / Any Events This Week? (true) → Social Context → Add Social Layer → Gemini → Social Gate → Merge → IF. Before, the IF went straight to Gemini, and Gemini straight to Buffer.

**The Instagram Priority caption** (Mon, Wed and Sat at 20:15). The nodes are named `… (Instagram Priority)`:
- **The Event ID.** The priority list is a list of event names, so the Event ID comes from the Event Index row the path already read (Pull Event Index (Priority)). It is the first row that isn't Inactive with the same name, as Select Priority Content picks it.
  - With no Event ID, there is no layer, and the Gate gets `targets: []`. The app answers a 400 to that, which holds only at Enforce.
  - Cafe Vibes (the filler) has an Event ID (`RTD-EVT-00008`), but as a café row it skips the context and the gate (see "Café rows skip both steps" below).
- **Social Context:** after Aggregate Images (Priority), with `events: [{ event_id, sheet_date: Event Date }]`, or `[]` with no ID.
- **Add Social Layer:** Aggregate Images' item, plus **only** `social: { mode, ok, event_id, sheet_date, block, date_block, occurrence_id, prompt_version }`. It does not add `eventDate` and the other fields: today's prompt reads them but never gets them, so **today's Priority caption has no date**, and Off keeps it that way.
- **Generate Caption (Priority):** today's message is kept character for character, with `block + '\n\n'` in front and `'\n\n' + date_block` after it, **both only when the block is not empty**, as for the Facebook event post.
- **Social Gate:** after the banned-word guardrail's true branch, so the Gate checks only a caption that would otherwise be posted. `kind: 'event_post'`, `platform: 'instagram'`.
- **Merge → IF.** True → **Buffer: Instagram Carousel (Priority)**, unchanged. False → **Log Held Post (Instagram Priority)**: like Log Failed (Priority IG), with Automation Status `Held: <reason>` and Target Platform `Instagram`.
- **No Next Post retry:** Priority doesn't advance Next Post today.
- **Café rows skip both steps** (follow-up, draft `37f21195-…`). Spec §3 says food and café rows aren't events.
  - **Which rows:** the selected item's Event Index row has App Visibility `Hidden`, or its name is Cafe Vibes, Food1, Food2, Food3 or Drinks.
  - **Cafe Row? (Instagram Priority):** an IF after Aggregate Images. For a café row, it goes straight to Generate Caption, so there is no context call and Gemini gets exactly today's prompt.
  - **Cafe Row Skips Gate? (Instagram Priority):** an IF on the guardrail's true branch, with the same test. For a café row, it goes straight to Buffer, so there is no Gate call.
  - **Effect:** a café post goes out exactly as today at every setting, Enforce included.
  - **Exact match only:** a blank App Visibility is **not** treated as Hidden here, so such a row is still checked (fails safe).

**The Daily Recap** stays disabled. A sticky note, **Daily Recap Social Gate Note**, says it must go through Social Context and Social Gate (`roundup`) before it is ever turned back on.

**Checked:** the draft was diffed against `f544db43`. Exactly 22 nodes were added: 6 per path, 3 path notes and the Daily Recap note. Exactly 5 were changed: the two Find nodes and the three Gemini nodes. 6 connections were removed and 24 added, with no other change. `update_workflow` reported only the warnings that were already there.

**Tested 2026-10-20** on three no-post test copies, all now archived:
- `ErHmjo5cMf1vFyMw`: Prospectus
- `5FT3NsB57ZYqTZb9`: Weekly
- `xyNK2PXNtiGvLeTM`: Instagram Priority

How the copies were built:
- Each copy was first built from the pre-edit nodes, run, and then updated with the draft's nodes.
- The sheet reads were Code fixtures with the real rows from Master V1's 19 Oct runs (`70351`, `70380`).
- Buffer was a Code stand-in that sends nothing, and every Post Log write was a Set node with the same column expressions.
- Drive and ImageKit were replaced by a stand-in returning the 19 Oct ImageKit URLs.
- Gemini was pinned to the real captions from `70351`, `66198` and `70380`.
- A **Capture Gemini Input (TEST)** node rendered Gemini's exact message expression on Gemini's own input item, and **Hash Gemini Input (TEST)** took its sha256 in n8n.
- Master V1 itself was never run, and the app's switch stayed Off.

**Byte-identical at Off.** The before/after hashes match, and a local recomputation of each expression from the same rows gives the same hash.

| Path | Before (pre-edit) | After, at Off, real subs called | Length | sha256 |
| --- | --- | --- | --- | --- |
| Prospectus | `73625` | `73683` (Context `73684`, Gate `73685`) | 3,333 | `9df04f324c9f4ed52f7855be521f8aeabd034348058bf1bee3f65b845fcda15f` |
| Weekly | `73695` | `73698` (Context `73699`, Gate `73700`) | 3,944 | `a8339d60cd2e9aea3f5d495e32ea72b79ded0f2b0cdc52c6e35961321554015b` |
| Instagram Priority | `73714` | `73716` (Context `73717`, Gate `73718`) | 1,124 | `f654b889dca09cf82f61fde7d613ff8034d8af31e73c0c31dcd5893bd1aae9d1` |

At Off the context answered `{ mode: 'off', layers: {}, ok: true }`, and the Gate answered `post: true`. The Buffer stand-in and the success-log stand-in were reached, and the Held log was not. What the Gate's When Called received:
- **Prospectus:** `kind: 'roundup'`, three targets (`RTD-EVT-00013`, `00006`, `00009`) as an array, and `sheet_dates` as an object.
- **Instagram Priority:** `kind: 'event_post'`, `platform: 'instagram'`, `targets: [{ event_id: 'RTD-EVT-00003', … }]`, and `sheet_dates: { 'RTD-EVT-00003': '07/11/2026' }`.

**Enforce and Shadow**, with the context and gate answers pinned:

| Execution | Test | Result |
| --- | --- | --- |
| `73687` | Prospectus, **Enforce**: layers for Wednesdays and Home Education Support ClubT, none for Cleeples; Gate `post: false` | Gemini input = the two `###` sections + a blank line + today's prompt (3,695 characters). All three events were targets; Cleeples had `occurrence_id: null`. **Log Held Post** row `Held: Home Education Support ClubT: …; Cleeples: …`. Buffer and the success log did not run: the whole round-up was held. |
| `73689` | Prospectus, **Shadow**, check fails (Gate `post: true`) | Same Gemini input. Buffer reached, success log written, Held not reached. |
| `73701` | Weekly, **Enforce**: a bad Quiz block, Wednesdays fine, Cleeples no prompt; Gate `post: false` | Held whole: `Held: Quiz: …; Cleeples: …`. Buffer not reached. |
| `73702` | Weekly, **Shadow**, check fails | Buffer reached. Held not reached. |
| `73720` | Instagram Priority, **Enforce**: a layer for `RTD-EVT-00003`; Gate `post: false` | Gemini input = block + a blank line + today's prompt + a blank line + `Date: Saturday 7 November, 11am`. `Held: Blood on the Clocktower: "Marcus": …`. Buffer not reached. |
| `73721` | Instagram Priority, **Shadow**, check fails | Buffer reached. Held not reached. |
| `73722` | Instagram Priority at Off, an item whose name is on no Event Index row (no Event ID); real subs (`73723`, `73724`) | No layer. The Gate got `targets: []` and `sheet_dates: {}`, and Off answered `post: true`. Buffer reached. |

**Follow-up tests (café rows), 2026-10-20**, in the no-post copy `IplQWLWQDwhyu0s9` (archived). It was built from draft `37f21195`'s nodes, with the same stand-ins as above, Select Priority Content pinned, and a trimmed Event Index fixture.

| Execution | Test | Result |
| --- | --- | --- |
| `73761` | Off, Blood on the Clocktower, real subs (`73762`, `73763`) | Gemini input sha256 `f654b889…aae9d1`, 1,124 characters: **byte-identical** to the pre-edit `73714`. Context and Gate were called. Buffer reached. |
| `73768` | **Enforce pinned** (context `enforce`, Gate `post: false`), Cafe Vibes | Social Context and Social Gate **did not run**. Gemini input sha256 `5e6787eb…c8bd0f`, 1,104 characters, which equals today's prompt computed from the pre-edit node. **Buffer reached**, success log written. (An earlier run, `73764`, used a test caption containing "Vibes" and was stopped by the existing banned-word guardrail, as today.) |
| `73766` | Enforce pinned, Blood on the Clocktower, Gate `post: false` | Still held: `Held: Blood on the Clocktower: …`. Buffer not reached. |

#### As built: posters through the social gate (Task 5)

**Rollback points, recorded 2026-10-20 before any edit.** Each was the published version and the draft at the time.

| Workflow | Rollback (published) version |
| --- | --- |
| RTD Poster Generator (sub) (`PVo8OZ59Qh5LA263`) | `e75815a7-cd78-42f6-a086-06ecf2332b2f` |
| RTD Event Guard (sub) (`RtdEventGuardSub1`) | `4f73e19b-0f69-4abe-ae3e-2aa1b94c71c8` |
| RTD Master V1 (`yPhchrcwuJSt3RLI`) | `37f21195-a767-4ee2-96a8-09770c3703a2` (live since 14:33 UTC; before that `38b1d6d1-…`) |

**Edited 2026-10-20, in the drafts only.** Nothing was published, unpublished or restored. The app's switch stayed Off.

| Workflow | Published (unchanged) | Draft now |
| --- | --- | --- |
| RTD Poster Generator (sub) | `e75815a7-…` | `3b065f81-1472-4459-b4db-434df5d8c871` (30 nodes, was 26) |
| RTD Event Guard (sub) | `4f73e19b-…` | `2f4e8d13-ff6a-4689-8a24-61105e52bc3b` (15 nodes, was 14) |
| RTD Master V1 | `37f21195-…` | `3b121622-24fa-4eb4-a014-c25d6720191d` (210 nodes, unchanged count) |

Publishing all three is the owner's gate (G5). Publish order doesn't matter: until the Poster Generator draft is live, lookups return no description, so Master V1 omits `image_text` (and at Enforce leaves the poster off).

**RTD Poster Generator (sub)**, all marked LOCAL EDIT (mirror in `rtd-poster-automation`):
- **New input `approvedFacts`** (Poster Request, Normalise Request). Event Guard sends it; Master V1's lookup doesn't need it.
- **Set Target Folder:** when Approved Facts are present, one line goes into the prompt after the style line: `Background facts about this event, only to guide the imagery and mood. Never write any of them on the poster: <facts>` (quote marks turned into `'`, line breaks into spaces). Facts are never quoted, so the existing rule (the only text is the quoted text) keeps them off the poster. **With no facts the prompt is byte-identical to today's** (checked against the real prompt of execution `71285`). It also returns `posterText` (the quoted pieces exactly as sent, one per line), `posterTime` (Event Time as `HH:MM`, 24-hour; `''` if unreadable) and `description`.
- **Record Poster Text (new):** after Save Poster to Drive, an HTTP `PATCH https://www.googleapis.com/drive/v3/files/<saved file id>` with the existing **ATECHGoogleDrive** credential (the Drive node's Update has no description field), body `{ description }`. The description is `RTD poster text: <quoted text> | time: <HH:MM>`. Retries 3 times; on failure the poster is still kept and the result's reason says the text could not be recorded.
- **Decide Poster Action:** returns the found poster's description as `POSTER_DESCRIPTION`. In Event Guard's modes (`generate`, `dryRun`), a poster whose description starts `RTD poster text: ` and records a time different from the row's Event Time is replaced (`GENERATE` / `WOULD_GENERATE`, with `replaces`). **A poster with no description (every existing poster) is reused as before**, so nothing is mass-regenerated on publish. No `.Stable` image: the old poster is kept. Lookup mode never regenerates.
- **Drop Replaced Poster (new):** the re-check after the lock ignores the poster being replaced.
- **Replaces Old Poster? / Retire Old Poster (new):** after the new poster is saved and recorded, the old one is renamed `<date>-replaced-<HHMM>-noapp.<ext>` (Drive Update, nothing deleted), so it no longer matches `<date>.<ext>`.
- **Return Result:** adds `POSTER_DESCRIPTION` and `REPLACED`. Its helper now reads `$(node).first(0)`: with Record Poster Text on the success path, n8n's default output for Save Poster/Validate Poster became their (empty) error output, so a new poster was reported as `GENERATE` without its file (found in testing, fixed).

**RTD Event Guard (sub):** Ensure Poster (Sub) also sends `approvedFacts`, the row's Approved Facts looked up from Read Event Index (Guard) by row number (no app call; Evaluate Events is unchanged). Its poster check is still keyed by name + date; with the Poster Generator draft it now also replaces a poster whose recorded time differs from Event Time. A sticky note explains this. The workflow description was updated.

**RTD Master V1** (Facebook event post only; 3 nodes changed, connections unchanged):
- **Social Gate (Event Post):** `image_text` = the attached poster's recorded wording: the description from Lookup Event Poster's `POSTER_DESCRIPTION`, the part after `RTD poster text: ` and before ` | time: …`. No description: `''`, which the Gate leaves out of the app's body.
- **Merge Gate Answer (Event Post):** when the poster leads the photos:
  - the Gate held the post and **every** reason (split on `; `) starts with `Poster:` → post the caption and the other photos **without the poster** (`social_poster_dropped` carries the reasons);
  - at Enforce (this run's Context mode), a poster with no recorded text is left off (it can't be checked);
  - otherwise exactly as before: mixed reasons hold the post as before; at Off and Shadow the photos are untouched.
- **Social Gate Note (Event Post):** updated.

**Off is byte-identical** (no-post copy, the 18 Oct Quiz row, real Context and Gate subs at Off, sha256 taken in n8n by Crypto nodes):

| Run | Execution | Gemini input sha256 | Buffer body sha256 |
| --- | --- | --- | --- |
| Before: the live `37f21195` nodes, lookup as today (no description) | `74344` | `89e82e679a8e2eb82baffd4adb034696a81292c99c30d0a4149beca4547f6b09` | `b7b9fb98b4fd08bcf56360c909c6bb74a8a0ce2d962d00503900fb1a7eab9066` |
| After: draft `3b121622` nodes, lookup with a recorded description | `74352` (Context `74353`, Gate `74354`) | `89e82e67…f6b09` (identical; same as Task 3's `69612`) | `b7b9fb98…ab9066` (identical) |

In `74352` the Gate sent `image_text: "Quiz\nFriday, 23 October 2026\n18:30 - 22:00\nA family quiz night with prizes at stake!"` and Off answered `post: true`. In `74372` (no description) the app body had no `image_text`.

**Tests** (all in archived copies: Poster Generator `CIyWnQYDnCZXnEMM`, Event Guard `oUTCM9D6jAa0ZPGT`, Master V1 event post `abGYDNvcNvzbjEuS`, folder setup `uZnVIhPt5tHz1LI8`). The Poster Generator copy wrote only to the TEST Drive folder **"RTD poster test (delete)"** (in My Drive; delete when done); its lock-table nodes were code stand-ins. The Guard copy had no sheet or log writes. The Master V1 copy had Buffer and every sheet write replaced by stand-ins that send nothing. No live poster, sheet or post was touched, and no real workflow was executed.

| Execution | Test | Result |
| --- | --- | --- |
| `74247` | Generate Quiz 23 Oct 18:30 with Approved Facts | Prompt had the background-facts line; poster saved; description `RTD poster text: Quiz⏎Friday, 23 October 2026⏎18:30 - 22:00⏎A family quiz night with prizes at stake! \| time: 18:30` written. Showed the Return Result bug (`GENERATE`). |
| `74252` | Lookup (Master V1's mode) | `POSTER_DESCRIPTION` read back from Drive. |
| `74253` | Generate with Event Time 19:00 | Regenerated: new poster records `time: 19:00`; old renamed `2026-10-23-replaced-1830-noapp.jpg`. |
| `74250`, `74255`, `74261`, `74267`, `74269` | Return Result debugging | Pinned runs worked; real runs read Save Poster's empty error output. `74255` also shows a failed description write (404) still returns the poster. |
| `74276` | After the `first(0)` fix, 13 Nov | `GENERATED` with the file and its description. |
| `74284` | 13 Nov, time moved to 7:30pm | `GENERATED`, `REPLACED: true`, `time: 19:30`; old renamed `…-replaced-1830-noapp.jpg`. |
| `74286` | Poster with **no description**, different time (pinned Drive) | `REUSE`, Gemini not called. |
| `74287` | Same time as recorded | `REUSE` with its description. |
| `74291` (subs `74292`, `74293`) | Event Guard dry run: Quiz 23 Oct 18:30 with Approved Facts; Quiz 13 Nov 7:30pm | Row 1 `WOULD_GENERATE`: "Poster 2026-10-23.jpg records time 19:00 but Event Time is 18:30"; the sub got `approvedFacts`. Row 2 `REUSE`. |
| (app suite) | The app's check on Poster Generator–style wording: `8PM` against the 6:30pm Quiz, at Enforce (a temporary test, not committed) | `Poster: "8PM": not the start or end time of Quiz`; `18:30` passes. |
| `74356` | Enforce pinned, Gate held with only that `Poster:` reason | Posted **without the poster** (Buffer stand-in got the theme photo only). |
| `74357` | Enforce pinned, `Poster:` + a caption reason | Held (Log Held Post reached, Buffer not). |
| `74360` | Enforce pinned, Gate passed, poster with no description | Posted without the poster. |
| `74361` | Shadow pinned, poster with no description | Poster kept, as today. |

**Fix round 1 (review), 2026-10-20/21, drafts only.** Drafts now: Poster Generator `beafe8be-03b3-4ff1-9e83-775e1be85c36`, Event Guard `6f83b30c-37d9-47c5-b24b-135a4cdc4563` (19 nodes), Master V1 `b3e51f75-7178-4464-aade-def648f17233`. Published versions unchanged (`e75815a7`, `4f73e19b`, `37f21195`).
1. **A failed rename is retried.** Still Missing?'s "already there" branch now also goes through Replaces Old Poster? → Retire Old Poster, so when the new poster exists but the out-of-date one wasn't renamed, the next run renames it (no image-model call). Return Result adds `RETIRED` and, on failure, `RENAME FAILED: <file> could not be renamed (<error>) - retried on the next run` to the reason (and so to the RTD Event Automation Log).
2. **A dropped poster is logged.** Master V1's Write Execution Transaction Log (Post Log) Automation Status becomes `Success; posted without poster: <reason>` when the poster was dropped; BufferID unchanged. At Off it is exactly `Success`. Filters on the Post Log should use "starts with Success".
3. **The current item's poster.** Social Gate (Event Post) `image_text` and Merge Gate Answer read Lookup Event Poster's output for the same item index (not the first hit), and `image_text` is sent only when that poster leads the photos.
4. **Unreadable times and a cap.**
   - Poster Generator has a new input `timeRegen`. Only `allow` regenerates a stale-time poster; otherwise it is reported `TIME_STALE` (reason `TIME STALE: …`).
   - An Event Time it can't read (e.g. `7pm-late`) never regenerates: `TIME_UNREADABLE`, reason `… TIME UNREADABLE: Event Time '…' can't be read …`.
   - Event Guard: Ensure Poster sends `timeRegen: check`; new **Cap Time Regenerations** sends at most **5** stale posters per run to new **Regenerate Stale Poster (Sub)** (`timeRegen: allow`), via **Regenerate Stale Poster?**, and **Regenerated Poster Results** pairs the answers back before Shape Log Rows. The rest are logged "over this run's cap of 5 … left for the next run"; unreadable times carry `[unreadable Event Times this run: N]`.
   - Publishing the Poster Generator before the Guard means no time-change regeneration at all until the Guard is published (fails safe).
5. Facts drawn on the image: no change (the owner will review the first regenerated posters).

| Execution | Test (archived no-post copies `GB0M1zol4huabHAJ`, `DcySSigwdAcJgWRe`, `mc4jvgM1Binl2SPN`; Drive writes only to the TEST folder) | Result |
| --- | --- | --- |
| `76501` | Time moved to 20:00, Retire Old Poster's file id deliberately broken in the copy | New poster made (`time: 20:00`); reason `… RENAME FAILED: 2026-10-23.jpg could not be renamed (… not found) - retried on the next run` |
| `76503` | Same run again, file id restored | `REUSE` ("appeared while waiting"), image model **not** called; old poster renamed `2026-10-23-replaced-1900-noapp.jpg`, `RETIRED: true` |
| `76505` | Event Time `7pm-late`, poster recording 19:30, `timeRegen: allow` (pinned Drive) | `REUSE`, `TIME_UNREADABLE: true`, not regenerated |
| `76512` | Guard dry run: 6 stale posters + 1 unreadable (pinned sub answers) | 5 sent to Regenerate Stale Poster (`WOULD_GENERATE`); the 6th logged "over this run's cap of 5 … (6 found)"; the unreadable one logged with `[unreadable Event Times this run: 1]` |
| `76473` | Master V1 Enforce pinned, Gate held only for `Poster: "8PM": …` | Posted without the poster; Post Log stand-in `Success; posted without poster: Poster: "8PM": not the start or end time of Quiz`, BufferID `TEST-NOT-POSTED-0` |
| `76434` → `76470` | **Off re-check**: live `37f21195` nodes vs draft `b3e51f75` nodes (with a recorded description), real subs | Gemini input sha256 `89e82e67…f6b09` and Buffer body `b7b9fb98…ab9066` identical; Post Log `Success` / `TEST-NOT-POSTED-0` in both |

### What the check looks at

A post passes only when **every** one of these holds for each target:
- **The event:** it is running and Public or App Bookable, and no change is on its way to the Logic Engine.
- **The date:** it belongs to the event and is public. It is scheduled, not cancelled or moved, and hasn't happened yet. It is a real date in the app, not one only projected from the cadence, and the sheet's date matches (`sheet_dates`).
- **The prompt:** an approved prompt exists for the event's current facts, and the version sent is that one.
- **The words** (caption and poster):
  - **Dates:** every date is the target's date. A weekday is the target's weekday.
  - **Relative words:** "today", "tonight" and "tomorrow" must be true at the moment of the check, in London. "This week" passes only when every target falls within the next 7 days. "This weekend", "next week" and "next Friday" always fail.
  - **Times:** every time is the target's start or end time.
  - **Prices:** every £ amount, and "free", matches the date's own price, else App Price, or an Approved Facts `Price` line.
  - **Claims:** booking, drop-in, level, prize and age words need the matching Approved Facts line, or the same word in Base Details. Booking words are also allowed when the event's booking is set to Required or Optional in the app.
  - **People:** every name must be in People & Roles. A role word next to a name ("hosts", "DM", "runs", "sets up") must match that person's listed role.
  - **Other events:** no other running event's name appears, unless it's also a target (round-ups).
  - **Banned Phrases:** none of the targets' Banned Phrases appear.
- **Round-ups** are split into blocks at blank lines. A block naming exactly one target is checked against that target alone. Other blocks need every date, time and name to belong to some target, and every price, weekday and claim to suit every target.
- **Records:** each Shadow or Enforce call adds one row to the app's check log. The caption and poster wording are deleted after 90 days; the result and reasons are kept.

### Known limits

The check is a **safety net built from fixed rules, not a guarantee.** It can't understand a sentence the way a person does, which is why it runs in Shadow first: a week of real posts shows what it catches and what it gets wrong before anything is held. Where it isn't sure, it fails rather than guesses, so most of its mistakes hold a good post rather than let a bad one through.

**Things it can miss** (accepted during the build):
- **A stranger's name at the start of a sentence**, with no role word nearby. "Sam will be there too" isn't caught, because the first word of every sentence is capitalised anyway. With a role word ("Sam hosts…") it is caught.
- **Weekdays squashed into a hashtag**, such as "#frigames" for Friday. Hashtags are read for whole weekday names, dates, other events and the main claim words, not every abbreviation.
- **A role word along a list of names** is checked only when the list starts within three words of it. In a longer sentence, the names further away aren't checked against that role.
- **"At seven of the evening"** reads as no time at all, so it isn't checked. (Unlikely wording.)

**Things it holds although they're fine** (it fails safe):
- Everyday words that look like claims: "#adulting" reads as an age claim, "£2 two-for-one" as a second price, and wording such as "only five twenty-somethings" trips the number rules.
- Times written as "half seven" or "seven o'clock": they can't be matched to a time, so they fail. Write "7:30pm" or "7pm".
- "Next Friday" always fails, even when it's right. Use the date or "this Friday".
- Decimals such as 4.75 written without a £ read as a time it can't match.
- People named like months (May, June) read as dates.
- Phrases such as "no walk-ins", "#FreeParking" and "Christmas Quiz" can trip the drop-in, price or date rules.

**For prompts (the builder):**
- A prompt that quotes a longer phrase in a "don't say…" rule (more than six words, or one that carries on after the quote) goes to review rather than being approved automatically. So does one where the event's own wording reads like an instruction ("act as Dungeon Master", "don't ignore the house rules").
- An admin's own approved text gets the same checks on dates, times, prices, other events, names, claim words and roles. Claim tracing doesn't apply to it, because the admin is answering the questions.

**Other limits:**
- **Base Details goes to Gemini as written.** It's one of the approved fields, so if the café or a host puts a date, a time or an email address in it, Gemini sees that too. The prompt Gemini writes back is still checked for dates, times and prices before it's stored, so nothing like that ends up in a prompt. But keep dates, times and contact details out of Base Details.
- **A date with its own price:** the check uses that date's price, but the prompt only knows the event's App Price. A caption that repeats the App Price for a special-price date is held. Rare; fails safe.
- **The sheet's prompt cell can lag:** if the facts change between an admin's approval and n8n writing the cell, the sheet shows the older approved prompt until the next run. Posts aren't affected: they use the app's copy, which is checked against the current facts.
- If n8n retries a check, the log gets two rows for the same post. That's harmless.
- None of this has met real Gemini output or real posts yet. That happens in G4 (three events, a dry run) and G5 (the Shadow week).

## Spec §46 workflow map

| Spec workflow | Covered by |
| --- | --- |
| RTD – Event Sync | **RTD Event Sync** (above) |
| RTD – Event Approval | Approval happens in the app's organiser. **RTD Host Sessions To Diary** emails the café; **RTD Team Notices** emails the host the decision. |
| RTD – Event Expiry & Redating | **Existing** Event Guard + Event Date Change |
| RTD – Booking Daily Digest | Not built yet. Booking emails to hosts and customers go through **RTD Outbox** |
| RTD – Push Reminder Scheduler | New (Phase 3) |
| RTD – Game of the Week | New (Phase 4) |
| RTD – Host Application Notification | **RTD Team Notices** (join requests for hosts and café staff) |
| RTD – Event / Booking Audit Logger | Not needed as workflows: the app writes `audit_log` itself; n8n actions are recorded via the API |

### Master V1 published with the switch Off (20 Oct 2026, 14:33 UTC)

- With the owner's go-ahead, RTD Master V1 (`yPhchrcwuJSt3RLI`) was published as version `37f21195-a767-4ee2-96a8-09770c3703a2`. This is the reviewed draft with Tasks 3 and 4: the Facebook event post, the Prospectus and Weekly round-ups and Instagram Priority go through RTD Social Context and Gate, and the two Post Log fixes are included.
- **The app's switch is Off**, so captions and posting are exactly as before. The only visible changes are that Post Log now records `Success` with the Buffer ID, and the right "Asset used".
- **Rollback:** republish the previous version `38b1d6d1-ee8f-4683-aea1-0b94c5a1351b` (n8n › RTD Master V1 › Versions), or use `publish_workflow` with that `versionId`.
- **Not in this version:** posters (Task 5) and the "Facebook Posted Food Today?" date fix (Task 6). Both are in the draft, now `3164d3c3-…` (with the final fixes), which waits for G5.

### Stage 2 rollback record

Recorded 21 Oct 2026, after Task 6; pending drafts updated after the final fix wave. Every Stage 2 workflow, the version before Stage 2, what is live now, and what is waiting. The app's switch is **Off**. Whatever is rolled back, **set the switch to Off first** (Organise › Events & dates › Social prompts; Organise › Social posts once the 23 Oct change is deployed); at Off nothing is checked or held.

To publish an older version: n8n › the workflow › Versions › pick the version › Publish (or the n8n MCP `publish_workflow` with that `versionId`). Publishing a version doesn't delete the draft or any other version.

| Workflow | Before Stage 2 | Live now | Pending draft | How to roll back |
| --- | --- | --- | --- | --- |
| **RTD Master V1** (`yPhchrcwuJSt3RLI`) | `38b1d6d1-ee8f-4683-aea1-0b94c5a1351b` | `37f21195-a767-4ee2-96a8-09770c3703a2` (published 20 Oct 14:33 UTC with the switch Off: Tasks 3 and 4, the event post, round-ups and Instagram Priority through the gate, plus the two Post Log fixes) | `3164d3c3-329d-437a-8925-315fcb6de6d2` (adds Task 5 posters, the Task 6 food fix and the final fixes; built on `1c0677ca-…`) | Before G5: nothing to do, the draft isn't live. After G5, to undo only the posters and food fix: publish `37f21195-…`. To undo all of Stage 2: publish `38b1d6d1-…`. |
| **RTD Poster Generator (sub)** (`PVo8OZ59Qh5LA263`) | `e75815a7-cd78-42f6-a086-06ecf2332b2f` | `e75815a7-…` (unchanged) | `beafe8be-03b3-4ff1-9e83-775e1be85c36` (records the poster text and time; replaces a poster whose time changed) | Publish `e75815a7-…`, together with Event Guard's `4f73e19b-…`. Posters made meanwhile stay. Replaced posters are only renamed (`<date>-replaced-<HHMM>-noapp.<ext>`); rename one back to `<date>.<ext>` to use it again. |
| **RTD Event Guard (sub)** (`RtdEventGuardSub1`) | `4f73e19b-0f69-4abe-ae3e-2aa1b94c71c8` | `4f73e19b-…` (unchanged) | `6f83b30c-37d9-47c5-b24b-135a4cdc4563` (sends Approved Facts; regenerates up to 5 stale posters a run) | Publish `4f73e19b-…`, together with the Poster Generator's `e75815a7-…`. |
| **RTD Social Context (sub)** (`QCjohGtBuld6k5R8`) | Didn't exist | `013e6526-407b-4da7-99a1-5f550a0c2cfb` (published 19 Oct) | `dfa485a4-230b-4a32-b766-3cc97548a01b` (one retry on 502/503/504) | Before G5: nothing to do. After G5: publish `013e6526-…`. At Off it answers "no layers". Unpublish only after Master V1 is back on `38b1d6d1-…`, which doesn't call it. rtd_config `SOCIAL_MODE_LAST` can stay. |
| **RTD Social Gate (sub)** (`NqC8fZUoIWWuvDnt`) | Didn't exist | `d71d6ebe-2fda-45a9-922f-02767f7bd5f1` (published 19 Oct) | `8767fea0-852b-4c8b-848d-8c37a5ad14f9` (holds when rtd_config can't be read; one retry on 502/503/504) | Before G5: nothing to do. After G5: publish `d71d6ebe-…`. At Off it answers `post: true`. Unpublish only after Master V1 is back on `38b1d6d1-…`. |
| **RTD Social Prompt Builder** (`lh9MzioBdpBpBIVo`) | Didn't exist | Not published | `8be0614a-4b08-4881-bce7-c57689005497` (dry run, staging, by rtd_config; final fixes on top of `4714d38a-…`) | Before G4: nothing to do. After G4: unpublish it, and set rtd_config `SOCIAL_BUILDER_DRY_RUN=true`. Cells it wrote (Social Prompt, Social Prompt Status) can stay or be cleared; nothing reads them for posting. |
| **RTD Event Sync** (`fOYrFBOElFkWx7R3`) | The 5–19 Oct version (n8n's history no longer lists it) | `cb8c73dc-9bca-4506-a7df-ae8e110f0696` (published 19 Oct, G2: also sends Banned Phrases, Approved Facts, People & Roles) | None | Not expected: the app keeps the three extra fields out of each event's change hash, so they change no event. If ever needed, take the three fields out of Build Snapshot by hand. |

**Order to undo G5 in an emergency:** switch Off → Master V1 `37f21195-…` → Poster Generator `e75815a7-…` and Event Guard `4f73e19b-…` → Gate `d71d6ebe-…` and Context `013e6526-…`.

### Stage 2 published with the switch Off (21 Oct 2026, ~19:45 UTC)

With the owner's go-ahead (food fix accepted), published together with the app's switch Off:

| Workflow | Now live | Previous live (rollback) |
|---|---|---|
| RTD Social Gate (sub) `NqC8fZUoIWWuvDnt` | `8767fea0` | `d71d6ebe` |
| RTD Social Context (sub) `QCjohGtBuld6k5R8` | `dfa485a4` | `013e6526` |
| RTD Poster Generator (sub) `PVo8OZ59Qh5LA263` | `beafe8be` | `e75815a7` |
| RTD Event Guard (sub) `RtdEventGuardSub1` | `6f83b30c` | `4f73e19b` |
| RTD Master V1 `yPhchrcwuJSt3RLI` | `3164d3c3` | `37f21195` (before Stage 2: `38b1d6d1`) |

The prompt builder (`lh9MzioBdpBpBIVo`, draft `8be0614a`) stays unpublished until G4.

### G4: prompt builder published (21 Oct 2026, 21:49 UTC)

With the owner's go-ahead ("Go G4"), after three dry runs on staging and app fixes to the prompt checker (price as £, label and value words, negated mentions, abbreviations, recommended/preferred Booking facts):
- rtd_config `SOCIAL_BUILDER_DRY_RUN=false`, `SOCIAL_BUILDER_SHEET=live`, no `SOCIAL_BUILDER_LIMIT` (5 a run, every 15 minutes). The owner set these in n8n.
- Staging write (execution `79185`): only Social Prompt and Social Prompt Status changed, on 4 rows; nothing marked written.
- Live write (execution `79270`): only those two columns changed, on 5 Event Index rows (Quiz approved v4, Kids Chess review v1, Home Ed Mon review v2, Home Ed Thu approved v3, Writing Club approved v1); all 5 marked written.
- Published `8be0614a-4b08-4881-bce7-c57689005497`. Rollback: unpublish it, or set `SOCIAL_BUILDER_DRY_RUN=true`. The switch stays Off, so posting doesn't read these cells.

**Same day, Logic Engine (owner's request):**
- "Little Elves Christmas Club" (RTD-EVT-00033) was set to Status Inactive instead of being deleted, because workflows write back by row number.
- On "Christmas Workshop" (RTD-EVT-00034) and "Christmas Workshop (hosted)" (RTD-EVT-00035), Michelle's Standard and KPI Hook prompts were rewritten to cover only each row's own session, and the half-finished TikTok Video Blueprint text was cleared.
- **Cause:** on 20 Oct at 21:00 BST, a Christmas Workshop Facebook post went out with Gemini's assistant reply as its caption (Buffer `6ad7c850401eb284ae7953c9`). The rows came from the host-session flow, which wrote both sessions into each prompt and left half-finished text in the blueprint column.

