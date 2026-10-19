# Event Social Prompts, Stage 2 (n8n) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** n8n builds each event's master prompt through the app. Every RTD Master V1 caption is written from its event's layer and checked by the app before it's posted. All of it does nothing while the app's switch is Off.

**Architecture:** Two small sub-workflows hold all the app calls:
- **RTD Social Context (sub)** fetches the event layers and builds the prompt blocks.
- **RTD Social Gate (sub)** checks a post and returns post or hold.

RTD Master V1 calls them at each integration point (audit §6), so its own edits stay small: one call before a caption, one before a post, and one Held branch. A new **RTD Social Prompt Builder** talks to the builder endpoints. Every workflow is built unpublished and tested with manual runs that can't post: the Buffer nodes are pinned or disabled in test copies. Publishing is a gate.

**Tech Stack:** n8n (MCP tools: `create_workflow_from_code`, `update_workflow`, `validate_workflow`, `execute_workflow`, `get_workflow_execution`, `publish_workflow`, `get_workflow_version`). The app's `/internal/*` endpoints use the `rtd-app` credential (`PveFQOiLEm52Hy2G`). Also: Google Sheets `ATECHGoogleSheets` (`WiF8f0ixTk1gIl3i`), Gemini `Google Gemini(PaLM) Api account` (`7ogDwZye4Zp9WpOc`), the rtd_config data table (`nMs33jJTorVuKLsp`), and Studio: Error Handler (`IClMUs9ByRmVBYJf`).

**Spec:** `docs/superpowers/specs/2026-10-18-social-master-prompt-design.md` §2, §3, §6 and "Changes during build". The as-built contract is `docs/RTD_N8N_WORKFLOWS.md`, sections "The builder" and "Every post". It is the source of truth for every request and answer.

## Global Constraints

- **Gates (spec §6).** These need the owner's go-ahead at the time, not this plan:
  - publishing the Builder (G4), after a dry run on 3 events with no sheet writes
  - publishing the Master V1, Event Guard and Poster Generator edits (G5); the switch stays Off, then Shadow for about a week
  - Enforce (G6)
- **Before any Master V1 edit**, record its current active version ID in `docs/RTD_N8N_WORKFLOWS.md`. Rollback restores that version.
- **At Off, behaviour is identical to today.** The context answers `events: []` and the check answers `allow: true`. With no layer, every caption node must send Gemini exactly today's prompt, byte for byte.
- **When the app can't be reached:**
  - The Gate holds only when the last known setting is `enforce`. The Context sub stores each answered `mode` in rtd_config as `SOCIAL_MODE_LAST`.
  - Otherwise it posts as today.
  - A context failure never stops a caption: no layer is used.
- **No test run may post.** Manual runs use pinned data, or a copy with the Buffer and Meta nodes disabled. Never execute Master V1 itself in manual mode.
- **Gemini never gets more than `/due`'s `request.system` and `request.user`.** No dates, no other rows, no hand-written prompts. Model `gemini-3.6-flash`, JSON output, temperature 0.2, 2 tries.
- **The Builder writes only two cells:** `Social Prompt` and `Social Prompt Status`, matched on `Event ID`, on whichever tab holds that ID.
- **Staging first.** G4 runs against the staging copy (`RTD_STAGING_LOGIC_ENGINE_ID` in rtd_config) before the live sheet.
- **No sheet IDs, tokens or secrets in the repo.** Workflow IDs are fine.
- **Workflow conventions:** every new workflow gets the error workflow `IClMUs9ByRmVBYJf`, timezone `Europe/London`, a `Run By Hand` manual trigger, and a description.

## Review Focus

1. **Off really is a no-op.** Run each changed caption path with the switch Off. The Gemini input must be identical to the pre-edit execution's input for the same row. Pin both and diff them in Task 3.
2. **A post whose check fails at Shadow still goes out, and is recorded.** At Enforce, the same post is held with a Post Log `Held` row and doesn't go out. Covered in Task 2 and Task 3.
3. **A round-up with one bad event block.** At Enforce, the whole round-up is held, not just that block. Task 4.
4. **The poster wording doesn't match the caption's time.** At Enforce, the poster isn't attached and Event Guard regenerates it. Task 5.
5. **A stale `/due` answer, where the facts change mid-run.** The `409` is dropped silently: no cells written, no error-workflow email. Task 1.

---

### Task 1: RTD Social Prompt Builder (new, unpublished)

**Files:**
- Create: n8n workflow `RTD Social Prompt Builder`
- Modify: `docs/RTD_N8N_WORKFLOWS.md` (its ID, and the dry-run switch)

**Interfaces:**
- Consumes: `GET /internal/social-prompts/due`, `POST /internal/social-prompts/:id`, `/written` and `/to-write`, as in the contract.
- Produces: nothing for other tasks.

The flow:
1. A schedule trigger every 15 minutes, plus `Run By Hand`.
2. Read rtd_config for `RTD_APP_BASE_URL`, `SOCIAL_BUILDER_DRY_RUN` and `SOCIAL_BUILDER_SHEET`. A missing dry-run value means `true`. The sheet value is `staging` or `live`; missing means `staging`.
3. Read the target sheet's `Event Index` and `Standard Diary`, and map each Event ID to its tab and row.
4. `GET due?limit=5`. For each event:
   - Gemini with `request.system` as the system instruction, `request.user` as the message, and JSON response type.
   - On success, POST `{fingerprint, job_id, model, output}`. On a Gemini error, POST `{fingerprint, job_id, error}`.
   - On a 200 with cells, and when not a dry run: update the two cells on the mapped tab and row, then POST `/written {version}`.
   - A 409 or a `status: 'failed'` answer ends that item quietly. Set `onError: continueRegularOutput` on the app calls and branch on the status code.
5. Then `GET to-write`, and write each the same way.

- [ ] **Step 1: Write the workflow code.** Follow the n8n MCP rules: SDK reference, `search_nodes`, `get_node_types`, `validate_node_config` per node. Then run `validate_workflow` until it's valid. Create it unpublished.
- [ ] **Step 2: Check the wiring with nothing due.** Pin the `/due` node's output to `{ "events": [] }` and run by hand. Expected: success, no Gemini call, and the to-write branch runs. `/due` ignores the switch, so without the pin every eligible event would be due.
- [ ] **Step 3: Dry run, the G4 rehearsal.** This waits for G3, because prompts are built from the facts the owner fills in.
  - Set `SOCIAL_BUILDER_DRY_RUN=true` and `SOCIAL_BUILDER_SHEET=staging`. Run by hand once with the `/due` limit set to 3; it takes the 3 soonest events.
  - Expected: 3 Gemini calls and 3 POSTs answering 200, with no sheet writes and no `/written` calls.
  - In D1, `SELECT event_id, version, status, substr(validation_errors,1,200) FROM social_prompts`: 3 rows.
  - The admin screen lists any that need review.
  - Record the results for the owner.
- [ ] **Step 4: Prove the stale path.** Pin a `/due` item with a wrong fingerprint. Expected: a 409, the item dropped, the run succeeds, and no error email.
- [ ] **Step 5: Stop for G4.** Report the 3 results to the owner. With their go-ahead:
  - set `SOCIAL_BUILDER_DRY_RUN=false` on staging and run once; check that only the two cells changed
  - then switch to `live` and publish
- [ ] **Step 6: Commit the docs.** Message: "Docs: RTD Social Prompt Builder".

### Task 2: RTD Social Context (sub) and RTD Social Gate (sub) (new)

**Files:**
- Create: n8n workflows `RTD Social Context (sub)` and `RTD Social Gate (sub)`, each with an Execute Workflow Trigger. Caller policy: `workflowsFromSameOwner`.
- Modify: `docs/RTD_N8N_WORKFLOWS.md`

**Interfaces:**
- **Context.** Input: `{ events: [{ event_id, sheet_date }] }`. Output: one item, `{ mode, layers: { [event_id]: { block, occurrence_id, prompt_version, date_block } }, ok: boolean }`.
  - `block`: the event layer text that goes before the persona prompt. It is `prompt`, then `Approved facts: …` and `People & roles: …` when they're non-empty. It is `""` when the prompt is empty or the mode is `off`.
  - `date_block`: `Date: <label>`, or `""` when there is no occurrence.
  - On a failure: `{ mode: 'unknown', layers: {}, ok: false }`.
  - Every answered `mode` is written to rtd_config `SOCIAL_MODE_LAST`.
- **Gate.** Input: `{ kind, platform, targets, text, image_text?, workflow, execution_id, sheet_dates? }`. Output: one item, `{ post: boolean, held_reason: string }`.
  - On a 200: `post = allow`.
  - On any other answer: `post = (SOCIAL_MODE_LAST !== 'enforce')`, with `held_reason` set to "app unreachable" or the answer's error.

- [ ] **Step 1: Build both**, validate them, and create them unpublished.
- [ ] **Step 2: Test the Context sub at Off.** Manual run with `[{event_id:'RTD-EVT-00001'}]`. Expected: `{mode:'off', layers:{}, ok:true}`, and `SOCIAL_MODE_LAST=off`.
- [ ] **Step 3: Test the Gate at Off.** Manual run with the real 18 Oct Quiz caption. Expected: `post: true`, and no `social_checks` row.
- [ ] **Step 4: Test with the app unreachable.** Point the URL at a bad host in a test copy.
  - With `SOCIAL_MODE_LAST=off`: `post: true`.
  - With it set to `enforce`: `post: false`, "app unreachable".
  - Put `SOCIAL_MODE_LAST` back afterwards.
- [ ] **Step 5: Publish both.** Sub-workflows called only by unpublished callers do nothing, so this is safe. Commit the docs: "Docs: social context and gate sub-workflows".

### Task 3: Master V1, the Facebook event post (integration point 1) and the Post Log fix

**Files:**
- Modify: n8n `RTD Master V1` (`yPhchrcwuJSt3RLI`): the nodes around `Pair With Event Metrics`, `Gemini Engine: Michelle Voice`, `Post to Buffer (…)` (Facebook event) and `Write Execution Transaction Log`
- Modify: `docs/RTD_N8N_WORKFLOWS.md` (the pre-edit version ID; what changed)

**Interfaces:**
- Consumes: Task 2's Context and Gate.

The changes:
1. Before Gemini, call Context with the row's Event ID and Event Date. The prompt becomes `layer.block + '\n\n' + <today's prompt> + '\n\n' + layer.date_block` when a block exists. Otherwise it is today's prompt, unchanged.
2. Before Buffer, call Gate with `kind:'event_post'`, `targets:[{event_id, occurrence_id, prompt_version}]` and the final caption.
3. On `post:false`, append a Post Log row with Automation Status `Held` and the reason, and skip Buffer.
4. Fix `Write Execution Transaction Log` so a successful post logs a success.

- [ ] **Step 1: Record Master V1's active version ID** in the docs.
- [ ] **Step 2: Make the edits** with `update_workflow` (the draft only). Run `validate_workflow`.
- [ ] **Step 3: Prove Off is a no-op.** Copy Master V1 with all Buffer, Meta and Sheets-write nodes disabled. Run the Facebook path on pinned Quiz data. Expected: Gemini's input is byte-identical to the pre-edit run's input on the same pin.
- [ ] **Step 4: Test Shadow, then Enforce, in the copy.**
  - Set the switch to `shadow` for the test only, and back to `off` straight after.
  - A known-bad caption pinned at Gemini's output: a `social_checks` row with `result=fail`, and the Buffer node reached.
  - At `enforce`: the Held branch is reached.
- [ ] **Step 5: Stop.** Publishing waits for G5. Commit the docs.

### Task 4: Master V1, the round-ups (Prospectus, Weekly) and the Instagram Priority caption

**Files:**
- Modify: `RTD Master V1`: `Find Next 2 Diary Days & Build Prompt`, `Find Next 7 Days Events & Build Prompt`, `Select Priority Content` / `Generate Caption (Priority)`, and their Buffer and Instagram post nodes
- Leave alone: the Daily Recap (disabled). Add a note on it.

**Interfaces:**
- Consumes: Task 2's Context and Gate.

The changes:
- **Round-ups.** Call Context with every event in the round-up. Build one block per event, as `### <name>\n<layer.block>\n<layer.date_block>`, ahead of today's prompt. The Gate gets `kind:'roundup'` and one target per event.
- **Instagram Priority.** This is a single-event path, so it uses `kind:'event_post'`, and its date block now comes from the layer.
- **Holds.** Any Gate `post:false` holds the whole post.

- [ ] **Step 1: Make the edits**, then validate.
- [ ] **Step 2: Test Off** in the disabled-posting copy. The Gemini inputs are unchanged.
- [ ] **Step 3: Test Enforce** in the copy. A round-up with one bad block is held whole. Then put the switch back to `off`.
- [ ] **Step 4: Commit the docs.**

### Task 5: Posters (Poster Generator, Event Guard, Master V1 attach)

**Files:**
- Modify: `RTD Poster Generator (sub)` (`PVo8OZ59Qh5LA263`)
  - After `Gemini: Generate Poster`, write the quoted poster text and the time used into the Drive file's description, as `RTD poster text: <text> | time: <HH:MM>`.
  - Add the event layer's Approved Facts to the poster prompt. The "only the quoted text appears" rule stays.
- Modify: `RTD Event Guard (sub)` (`RtdEventGuardSub1`) so a poster whose recorded time differs from the row's Event Time is regenerated.
- Modify: `RTD Master V1`, before attaching a poster: read the description and pass it as `image_text` to the Gate.
  - At Enforce, a Gate reason starting `Poster:` means: drop the poster and post the rest only if there are no other reasons. Otherwise hold.

- [ ] **Step 1: Make the edits**, then validate.
- [ ] **Step 2: Test.** A test run of Poster Generator in a copy, writing to a test folder. Expected: the description is written.
- [ ] **Step 3: Test the Gate** with a pinned description holding `8PM` against a 6:30pm event. Expected: a reason starting `Poster:`.
- [ ] **Step 4: Commit the docs.**

### Task 6: The "Facebook Posted Food Today?" fix, rollout record and G5 hand-off

**Files:**
- Modify: `RTD Master V1`. `Facebook Posted Food Today?` compares two date formats, so it never matches. Normalise both to `yyyy-MM-dd` in Europe/London.
- Modify:
  - `docs/RTD_N8N_WORKFLOWS.md`: the workflow IDs, version IDs before and after, and the rollback steps
  - `docs/RTD_HANDOFF.md`
  - `RTD_CHANGELOG.md`

- [ ] **Step 1: Fix and test** in the disabled-posting copy with a pinned Post Log row from today. Expected: matched.
- [ ] **Step 2: Write the G5 checklist** in the handoff, in this order:
  1. Publish Master V1, Event Guard and Poster Generator with the switch Off.
  2. Watch one evening's posts.
  3. Set Shadow.
  4. A week later, the owner reviews the results.
- [ ] **Step 3: Commit.** Message: "Docs: social prompts Stage 2". Push, and stop for G5.
