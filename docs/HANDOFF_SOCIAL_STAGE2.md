# Handoff: event social prompts, Stage 2 (n8n)

Use this to pick the work up in a new Claude Code session, on any account. Last updated 20 Oct 2026, around 13:00 UTC.

## Paste this into the new session

> Continue Stage 2 of the event social prompts for the RTD app. Read `docs/HANDOFF_SOCIAL_STAGE2.md` on branch `ccr-b9b076a7-f9fv6q` first. Then carry on the plan `docs/superpowers/plans/2026-10-19-social-master-prompt-n8n.md` from Task 4, using subagent-driven development: a fresh implementer per task, then a task review, then fix rounds. Recreate the ledger from the "Ledger" section below at `.superpowers/sdd/2026-10-19-social-master-prompt-n8n/progress.md`. Respect every gate and constraint listed. Never publish Master V1, Event Guard or Poster Generator, never publish the Builder, and never change the app's social_prompts switch without my go-ahead.

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
| 1. RTD Social Prompt Builder | Complete. Unpublished, dry run on staging. | `lh9MzioBdpBpBIVo` |
| 2. Context and Gate sub-workflows | Complete. Published; nothing calls them yet. | Context `QCjohGtBuld6k5R8`, Gate `NqC8fZUoIWWuvDnt` |
| 3. Master V1 Facebook event post, plus the Post Log fixes | Complete, in the **draft** only. | Master V1 `yPhchrcwuJSt3RLI`: draft `f544db43-1f9c-4194-8c43-647bd34bfc28`; **published `38b1d6d1-ee8f-4683-aea1-0b94c5a1351b` is unchanged and is the rollback point** |
| 4. Master V1 round-ups (Prospectus, Weekly) and Instagram Priority | **Next.** The first attempt stopped at a usage limit before making any edits. Check that the Master V1 draft is still `f544db43` before starting. | — |
| 5. Posters (Poster Generator, Event Guard, Master V1 attach) | To do. | Poster Generator `PVo8OZ59Qh5LA263`, Event Guard `RtdEventGuardSub1` |
| 6. "Facebook Posted Food Today?" fix, rollout record, G5 hand-off | To do. | — |

The test reports for each task are in `docs/RTD_N8N_WORKFLOWS.md`, in the Builder and "Every post" sections.

## Constraints (binding)

- **Gates need the owner's go-ahead at the time:**
  - G4: publish the Builder, after the 3-event dry run, which waits on G3.
  - G5: publish the Master V1, Event Guard and Poster Generator edits with the switch Off, then Shadow for about a week.
  - G6: Enforce.
- **Master V1 edits go in the draft only.** Use `update_workflow`; never publish, unpublish or restore. After every edit, confirm `activeVersionId` is still `38b1d6d1…`.
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

**For the owner:**
- Move the inline Meta token and ImageKit header into n8n credentials.
- Fill in Approved Facts and People & Roles (G3).
- To run the 3-event rehearsal, add the rtd_config key `SOCIAL_BUILDER_LIMIT=3`, then remove it afterwards.

## After Task 6

1. Run the final whole-branch review on the most capable model, covering the n8n workflows and the docs.
2. Make one fix wave.
3. Give the owner the "Rulings I made" list.
4. Stop for G4 and G5.
