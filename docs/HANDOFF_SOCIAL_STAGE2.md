# Handoff: event social prompts, Stage 2 (n8n)

Use this to pick the work up in a new Claude Code session, on any account. Last updated 21 Oct 2026, around 06:30 UTC. **Tasks 1 to 6 are done.** What's left: the final whole-branch review (with its fix wave), then the owner's gates.

## Paste this into the new session

> Finish Stage 2 of the event social prompts for the RTD app. Read `docs/HANDOFF_SOCIAL_STAGE2.md` on branch `ccr-b9b076a7-f9fv6q` first. All six tasks of the plan `docs/superpowers/plans/2026-10-19-social-master-prompt-n8n.md` are done. Recreate the ledger from the "Ledger" section below at `.superpowers/sdd/2026-10-19-social-master-prompt-n8n/progress.md`, then run the final whole-branch review (the n8n workflows through the n8n tools, and the docs), make one fix wave, give me the "Rulings I made" list, and stop for the gates. Respect every gate and constraint listed. Never publish Master V1, Event Guard or Poster Generator, never publish the Builder, and never change the app's social_prompts switch without my go-ahead.

The new session needs these connectors: n8n, Google Sheets and Drive, Cloudflare (for read-only D1 checks), and GitHub. It also needs the repo `danatechstudio/App-The-Dice`.

## Where things stand

**Done and live:**
- **App, Stage 1:** merged to `main` and live since 19 Oct, 10:30 UTC.
  - Migrations 0023 and 0024 are applied.
  - The switch `social_prompts` is **Off**.
  - Admin screens: Organise › Events & dates › Social prompts, plus a Social prompt section on each event.
- **G2:**
  - Logic Engine backup taken: "Logic Engine_RTD BACKUP 2026-10-19 1050 (before social prompt columns)".
  - Four columns added: Event Index Y–AB and Standard Diary I–L.
  - RTD Event Sync (`fOYrFBOElFkWx7R3`) now sends Banned Phrases, Approved Facts and People & Roles. It is published.
- **G3:** waiting on the owner. The suggested facts are in the doc "Social prompts: facts to confirm". The owner and Michelle fill in Approved Facts and People & Roles in the sheet.

**Stage 2 tasks (plan `docs/superpowers/plans/2026-10-19-social-master-prompt-n8n.md`):**

| Task | State | n8n IDs |
|---|---|---|
| 1. RTD Social Prompt Builder | Complete. Unpublished, dry run on staging. | `lh9MzioBdpBpBIVo` (draft `8be0614a` after the final fixes) |
| 2. Context and Gate sub-workflows | Complete. Published; at Off they do nothing. | Context `QCjohGtBuld6k5R8` (live `013e6526`, draft `dfa485a4`), Gate `NqC8fZUoIWWuvDnt` (live `d71d6ebe`, draft `8767fea0`); the drafts are published at G5 |
| 3. Master V1 Facebook event post, plus the Post Log fixes | Complete. **Live** in `37f21195` (G5 part 1, 20 Oct, switch Off). | Master V1 `yPhchrcwuJSt3RLI` |
| 4. Master V1 round-ups (Prospectus, Weekly) and Instagram Priority | Complete. **Live** in `37f21195`. | — |
| 5. Posters (Poster Generator, Event Guard, Master V1 attach) | Complete, in the **drafts** only. | Poster Generator `PVo8OZ59Qh5LA263`: live `e75815a7`, draft `beafe8be`; Event Guard `RtdEventGuardSub1`: live `4f73e19b`, draft `6f83b30c` |
| 6. "Facebook Posted Food Today?" fix, rollback record, G5 checklist | Complete. The fix is in the Master V1 **draft** only. | Master V1: live `37f21195` (unchanged), draft `1c0677ca` (Tasks 5 and 6) |
| Final fix wave (Important 1–4 and the minors) | Complete, in the **drafts** only. See [the change entry](RTD_N8N_WORKFLOWS.md#2026-10-21-stage-2-final-fixes-drafts-only-not-published). | Master V1 draft **`3164d3c3-329d-437a-8925-315fcb6de6d2`**; Gate `8767fea0`; Context `dfa485a4`; Builder `8be0614a` |

**Master V1 versions:** before Stage 2 `38b1d6d1-ee8f-4683-aea1-0b94c5a1351b`; live `37f21195-a767-4ee2-96a8-09770c3703a2`; pending draft `3164d3c3-329d-437a-8925-315fcb6de6d2` (Tasks 5, 6 and the final fixes). Every workflow's versions and rollback steps are in the [Stage 2 rollback record](RTD_N8N_WORKFLOWS.md#stage-2-rollback-record). The owner's next steps are the [G5 checklist](RTD_HANDOFF.md#event-social-prompts-stage-2-the-owners-g5-checklist).

**G5 part 1 evening check (20 Oct):** 8 Master V1 runs, all successful; 4 Facebook posts went out; Post Log rows `Success` with Buffer IDs; nothing held; D1 `social_checks` 0 rows; switch Off. No rollback.

The test reports for each task are in `docs/RTD_N8N_WORKFLOWS.md`, in the Builder and "Every post" sections.

## Constraints (binding)

- **Gates need the owner's go-ahead at the time:**
  - G4: publish the Builder, after the 3-event dry run, which waits on G3.
  - G5: publish the Master V1, Event Guard and Poster Generator edits with the switch Off, then Shadow for about a week.
  - G6: Enforce.
- **Master V1 edits go in the draft only.** Use `update_workflow`; never publish, unpublish or restore. After every edit, confirm `activeVersionId` is still the live version (now `37f21195…`).
- **No test may post.** Never execute Master V1 itself. Test in archived copies with every Buffer, Meta, Instagram, ImageKit and Sheets write node disabled, using pinned input.
- **Off must be byte-identical.** With no layer block, Gemini's input must equal today's. Prove it with a sha256 of the before and after inputs.
- **The app switch stays Off.** Test Shadow and Enforce by pinning the subs' answers.
- **Callers branch on the Gate's `post` only.**
  - Pass `targets` as a real array and `sheet_dates` as a real object.
  - With no usable Gate answer, post unless this run's Context mode is `enforce`.
- **Held at Enforce:** log `Held: <reason>` in Post Log Automation Status. For the Facebook event post only, also set Next Post to tomorrow as ISO `yyyy-MM-dd`, written RAW. Is Event Due Right Now? reads ISO first.
- **Inline Meta token and ImageKit header** (4 Meta nodes, 2 ImageKit nodes): leave them alone. Moving them into n8n credentials is the owner's job.
- **No sheet IDs, tokens or secrets in the repo.** Commits end with the session attribution lines, and contain no model names.
- **Read-only D1 checks:** database `6c948ad3-0311-459b-895d-facb14d5697d`.

## Task 4 rulings (already decided)

- **Round-ups:**
  - Call Context once with every event in the round-up.
  - Put one block per event that has a non-empty block ahead of today's prompt: `### <event name>\n<block>\n<date_block>`. With no blocks, use exactly today's prompt.
  - Gate: `kind:'roundup'`, with one target per event, including events with no block or no occurrence.
  - Any `post:false` holds the whole round-up as Held, with no Buffer and no retry write.
- **Instagram Priority:**
  - Gate: `kind:'event_post'`, `platform:'instagram'`. The `date_block` goes after today's prompt, and only when a block exists.
  - Map the priority names to Event IDs from the Event Index row. An item with no ID gets no layer and still goes to the Gate.
  - Holds work as above, with no Next Post retry.
- **Daily Recap:** stays disabled. Add a sticky note saying it must be wired through the gate if it's ever re-enabled.
- **Tests, per path:** Off byte-identical with the real subs called; Enforce holds the whole post (pinned answers); Shadow-fail still reaches the post node.

## Ledger (copy of `.superpowers/sdd/…/progress.md`, which git doesn't keep)

**Rulings:**
- **Task 1:** complete through Steps 1, 2 and 4, plus a 1-event dry run; the 3-event G4 rehearsal comes after G3.
  - Staging never calls `/written`.
  - 5xx answers are retried; 409, 400 and 404 are not.
  - Gemini runs per item.
  - `/written` is called only after reading back a matched row.
  - `RTD_LOGIC_ENGINE_ID` is in rtd_config.
- **The production switch stays Off** throughout the build.
- **Task 2:** the subs are published (nothing calls them until G5).
- **Task 3:**
  - A Held Facebook event post moves to tomorrow, so it doesn't block the evening.
  - The Food log fix is in scope.
  - The Held retry date is ISO, and the parser reads ISO first; this was proven on 23 real rows, and every Next Post reader was traced as fine.
  - With no usable Gate answer, post unless Context says enforce.
- **Task 4:** Instagram Priority items that are Hidden, or café rows (Cafe Vibes, Food1–3, Drinks), skip Context and Gate and post as today. A blank App Visibility goes through the gate.
- **G5 part 1 (owner, 20 Oct):** Master V1 `37f21195` published with the switch Off.
- **Task 5:** a poster with no recorded text is reused (never mass-regenerated); the old poster is renamed on the reuse path too, and a rename failure is reported; a dropped poster is logged `Success; posted without poster: …`; per-item poster lookup; an unreadable Event Time is counted, never regenerated; at most 5 time-change regenerations per Guard run. Publish Poster Generator and Event Guard together.
- **Task 6:** "Facebook Posted Food Today?" normalises both dates to London `yyyy-MM-dd` (Post Log `Date Posted` read as UK `dd/MM/yyyy`). Status isn't checked, as before.

**Deferred minors, for the final review to triage:**
- **Task 1:**
  - A to-write item whose Event ID is on neither tab isn't counted in the end-of-run alert.
  - The read-back may give a false alert if Sheets reformats the text.
  - A Mark Written failure loses that run's tally alert.
- **Task 2:**
  - An unreadable rtd_config in the Gate posts unchecked.
  - `SOCIAL_MODE_LAST` has a race on rapid switch flips.
  - Add one retry on 502, 503 and 504 before G6.
  - The Gate trigger's array and object types are untested with JSON text.
- **Task 3:** Off latency can reach about 64 s if the app hangs, and Master V1 has no workflow timezone.
- **Task 4:** round-up captions naming events outside the round-up will fail at Enforce (watch in Shadow); the Priority date block sits after the prompt's "above" wording; duplicate-name rows; a round-up with no Event IDs sends `targets: []`; a Gate sub returning zero items would drop silently (no alwaysOutputData).
- **Task 5:** a reuse-path retire is logged as "appeared while waiting for the lock"; an empty Event Time with a recorded time regenerates once (capped); over-cap or rename-failing posters stay attached until a later run (dropped at Enforce by the Gate).
- **Task 6:** the food check counts any Facebook food row, so a Facebook food post that really failed still skips Instagram that day.

**Final review (21 Oct) and the fix wave:**
- **Important 1 (fixed in the drafts):** café rows (Hidden, Cafe Vibes, Food1–3, Drinks) on the Facebook event post would have been held forever at Enforce. They now skip Context and Gate there, as on Instagram Priority, and post as today at every setting.
- **Important 2 (fixed):** Gate fallbacks were invisible in Shadow. A post that goes out without a usable check now logs `Success; unchecked: <reason>` (event post, round-ups, Instagram Priority). Off stays plain `Success`.
- **Important 3 (fixed; ruling: fail closed):** an unreadable rtd_config in the Gate (no app URL or no SOCIAL_MODE_LAST) now returns `post: false`, "settings unreadable", which callers hold. At Off this only bites if n8n's own data table is broken.
- **Important 4 (owner decision, pending):** the food fix changes what posts (Instagram food about every other day). It is G5 checklist step 1.
- **Minors fixed:** one retry on 502/503/504 in both subs; alwaysOutputData on the four Gate calls; the Builder counts an Event ID on neither tab and a `/written` failure in its end-of-run alert.
- **Dungeons & Dragons has no Event Date:** no occurrence, so at Enforce every D&D post is held unless its rows get dates.
- **Not in this wave:** the food decision (owner's) and the end time / Base Details poster redo (noted for G6).

**For the owner** (the full list is in the [G5 checklist](RTD_HANDOFF.md#event-social-prompts-stage-2-the-owners-g5-checklist)):
- Decide on the food fix (G5 step 1).
- Fix D&D's missing dates, or decide how it's handled, before G6.
- Move the inline Meta token and ImageKit header into n8n credentials.
- Fill in Approved Facts and People & Roles (G3).
- The round-up's diary-row duplication fix (24× reads) needs a go-ahead.
- Hidden real events skip the check on Instagram Priority: confirm before G6.
- Existing posters are left off at Enforce until they are regenerated; a backfill is optional.
- Mirror the poster changes in the `rtd-poster-automation` source.
- Delete the Drive folder "RTD poster test (delete)".
- To run the 3-event rehearsal, add the rtd_config key `SOCIAL_BUILDER_LIMIT=3`, then remove it afterwards.

## What's left (Tasks 1 to 6, the final review and the fix wave are done)

1. Give the owner the "Rulings I made" list.
2. Stop for the owner's gates, in the order of the [G5 checklist](RTD_HANDOFF.md#event-social-prompts-stage-2-the-owners-g5-checklist): the food decision, check and publish the five drafts with the switch Off, watch one of each post, G3 and G4, Shadow, review, then G6.
