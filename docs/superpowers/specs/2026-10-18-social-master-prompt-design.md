# Event-specific social master prompts, with a fail-closed post check — design

18 October 2026. **Phase B** of the owner's brief "RTD App — Event-Specific Social Media Master Prompt Integration". It is built on the read-only audit `docs/RTD_SOCIAL_MASTER_PROMPT_AUDIT.md`. The design was approved in conversation ("yes"); this spec waits for the owner's review before planning.

## What the owner asked for, and decided

**From the brief:**
- Every approved event gets an event-specific, validated social master prompt. Gemini, through the existing n8n credential, writes it from the event's approved fields.
- It is stored against the Event ID in the Logic Engine.
- Every post for that event uses it, with fresh, authoritative dates and times injected when the post is made.
- Nothing invented. No cross-event facts. People only in their approved roles. Only the target date's schedule.
- A deterministic validator, independent of Gemini, which fails closed. Admin review for exceptions.
- Additive: no new or parallel Logic Engine, and existing workflows keep working.

**The owner's answers (18 October):**
1. Approved facts are **Base Details plus a new "Approved Facts" column**. The existing hand-written prompts are not approved facts.
2. A new **"People & Roles"** column. Posts may name only the people listed there, in their listed role.
3. **Round-ups stay, with one block per event**, each built from its own prompt, facts and date.
4. **Shadow first, then enforce.**

**From the brief's agreed decisions:**
- Regenerate when the relevant facts change, not on date changes.
- Approve automatically only when every check passes.
- Backfill active future events in batches.
- Admins only (Michelle and Dan, once Michelle has an account).
- Ambiguity blocks the prompt and asks a question.

## 1. Data

### Logic Engine (the master)

Four columns are appended to **Event Index** and to **Standard Diary**, after a whole-sheet backup copy. A one-off n8n workflow adds them, the same way the App columns were added on 5 October; it never overwrites a value.

| Column | Who writes it | Contents |
|---|---|---|
| **Approved Facts** | Dan or Michelle | One fact per line, `Key: value`. Keys from a fixed list: `Booking`, `Level`, `Age`, `Prizes`, `Format`, `Price`, `Bring`, `Food`, `Other`. For example `Booking: essential`, `Level: all levels, beginners welcome`, `Prizes: cash` |
| **People & Roles** | Dan or Michelle | One person per line, `Name — role`. For example `Trixie — sets up`, `Liv — DM` |
| **Social Prompt** | The system (n8n) | The current approved master prompt |
| **Social Prompt Status** | The system (n8n) | `approved · v3`, `review · v3: <one-line question>`, or `blocked · v3: <reason>` |

- **Dates and times are never stored in the prompt.** They stay in Event Date and Event Time (Date for Standard Diary) and in the app's `occurrences` table.
- **The app's sync reads the two owner columns** (`src/sync/normalise.ts`), so they're part of the event's mirrored facts.
- **The app's sync never reads Social Prompt or Social Prompt Status as facts**, so a generated prompt can never feed back into the facts it was built from.

### App (history, checks and the switch; it holds no event facts of its own)

Migration `0024_social_prompts.sql` (additive). It is applied to production only with the owner's go-ahead.

**`social_prompts`**: one row per generated or overridden version.

| Column | Contents |
|---|---|
| `prompt_id` | `RTD-SP-00001`, `RTD-SP-00002`, … |
| `event_id` | The event it belongs to |
| `version` | Per event, from 1 |
| `status` | `pending`, `validated`, `review_required`, `approved`, `superseded` or `blocked` |
| `schema_version`, `instruction_version` | Both `1` |
| `source_fingerprint` | SHA-256 of the canonical JSON of the whitelisted fields below |
| `source_snapshot` | JSON of those fields, approved facts only |
| `master_prompt` | The prompt text |
| `claims` | JSON: `{claim, source_field}`, as Gemini listed them |
| `ambiguities` | JSON |
| `validation_errors` | JSON |
| `generation_model`, `generation_job_id` | The n8n execution ID |
| `generated_at`, `validated_at`, `approved_at`, `approved_by` | Timestamps; `approved_by` is `system` or an admin's email |
| `override_text`, `override_reason` | Set when an admin overrides |
| `written_at` | When the Social Prompt cells were written to the sheet |
| `last_used_at` | When a post last used this version |
| `created_at` | |

**`social_checks`**: one row per check made before a post.

| Column | Contents |
|---|---|
| `check_id` | |
| `mode` | `shadow` or `enforce` |
| `kind` | `event_post`, `roundup` or `poster` |
| `platform` | |
| `targets` | JSON: `[{event_id, occurrence_id, prompt_version}]` |
| `text` | The final caption and the poster wording |
| `result` | `pass` or `fail` |
| `reasons` | JSON |
| `workflow`, `execution_id` | The n8n workflow and execution |
| `created_at` | |

Check text is deleted after 90 days; results are kept.

**Other app changes:**
- **Switch:** setting `social_prompts` = `off` (the default), `shadow` or `enforce`. Admins change it, and every change is audited.
- **Audit log:** every generation, approval, override, regeneration request and switch change.

**Whitelisted source fields** (the only event data Gemini ever sees):
- Event ID, name, source tab, frequency
- Base Details (Notes, for Standard Diary)
- Approved Facts, People & Roles
- category, visibility
- for hosts' sessions: price and places (App Price, App Capacity)

**Never sent to Gemini:** dates, times, other events, emails, posting history, or the existing hand-written prompts.

## 2. Making a prompt

The new n8n workflow is **"RTD Social Prompt Builder"**. It runs every 15 minutes, starts **unpublished**, and has the Studio error handler.

**Step 1: `GET /internal/social-prompts/due?limit=5`.** The app returns events that need a prompt, with their whitelisted fields, fingerprint and the instruction (version 1). An event is due when:
- it is active, Public or App Bookable, with a scheduled date still to come
- no open Logic Engine change and no waiting host request (the Stage 6 checks)
- and either there is no prompt row for its current fingerprint, or an admin pressed Regenerate.

Past, cancelled, private, hidden and inactive events are never due.

**Step 2: Gemini.**
- Node: "Gemini: Social Master Prompt", credential **Google Gemini(PaLM) Api account** (`7ogDwZye4Zp9WpOc`), model `gemini-3.6-flash`, JSON output, low temperature, 2 tries.
- The system instruction is the brief's §7 baseline, kept in the app as `instruction_version` 1, with event fields passed as quoted data.
- The response schema:
  ```json
  { "status": "ok | review_required",
    "master_prompt": "string, at most 3000 characters",
    "claims": [{ "claim": "string", "source_field": "name | base_details | approved_facts.<Key> | people_roles | category | price | capacity" }],
    "ambiguities": ["string"], "questions": ["string"] }
  ```

**Step 3: `POST /internal/social-prompts/:eventId`** with `{fingerprint, job_id, model, output}`. The app:
1. Refuses with **409 stale** if the fingerprint is no longer current. n8n drops the result, and the event is due again next run, from the latest facts.
2. Validates the output (§4A), stores the version, and appends the **fixed schedule rule**: "Use ONLY the date and time supplied for the target occurrence at posting time; never state any other date or time." The rule is appended by code, not trusted to Gemini.
3. Decides the result:
   - All checks pass and there are no ambiguities: `approved`. The previous approved version becomes `superseded`.
   - Otherwise: `review_required` (it can be answered) or `blocked` (malformed, or unsafe input).
   - **The last approved version stays in use only if its fingerprint still matches the event.** Otherwise the event has no usable prompt and its posts are held while the switch is set to enforce.
4. Returns the cells to write.

**Step 4: write the cells.** n8n writes Social Prompt and Social Prompt Status to the row matched on **Event ID** (Google Sheets update, ATECHGoogleSheets; only those two cells), then calls `POST …/written`. The same workflow also writes versions an admin approved (`GET /internal/social-prompts/to-write`).

**Failures:**
- Malformed JSON, a timeout or a quota error: no row, so the event is due again next run.
- After 3 failed runs for the same fingerprint, the event is `blocked` ("generation failed") and appears for review.
- The (event, fingerprint) pair is unique, so a duplicate write is harmless.

## 3. Every post goes through it

These are edits to RTD Master V1 and the poster path. At `off`, behaviour is identical to today.

**`POST /internal/social/context`** with `{event_ids, sheet_dates?}` returns, for each event, the **event layer**:
- the approved master prompt and its version
- Base Details, Approved Facts, People & Roles, Banned Phrases (passed through)
- the **target occurrence**: its date and time in London, formatted ("Friday 23 October, 6:30pm"), its occurrence ID, and whether it's today or tomorrow at the moment of the request.

If the sheet's date in n8n differs from the app's synced date (the sync can be up to 15 minutes behind), the layer is marked `sync_pending`, and the check will fail closed.

**Insertion points** (from audit §6). Each caption node's code puts the event layer before the global persona prompt, and the event's date block after it:

| Integration point | What changes |
|---|---|
| Facebook event post ("Gemini Engine: Michelle Voice") | Event layer added |
| Prospectus round-up | One block per event |
| Weekly round-up | One block per event |
| Daily recap (disabled) | Gated if it's ever re-enabled |
| Instagram Priority caption | Event layer added, including its date |
| Posters (Event Guard → Poster Generator) | See posters, below |

**`POST /internal/social/check`**, immediately before every "Post to Buffer (…)" and "Buffer: Instagram Carousel (…)" node:
- Request: `{kind, platform, targets:[{event_id, occurrence_id, prompt_version}], text, image_text?, workflow, execution_id}`.
- Response: `{allow, result, reasons, mode}`.
- At `shadow`, `allow` is always true and the result is recorded. At `enforce`, `allow` is true only when the result is `pass`.
- When `allow` is false, n8n doesn't post. It appends a Post Log row with Automation Status `Held`, and the app lists the held post for review.

**Posters:**
- Poster Generator records the exact quoted poster text, and the time it used, in the Drive file's description.
- Before attaching a poster, Master V1 reads that description and passes it as `image_text`.
- At `enforce`, a poster whose recorded text or time doesn't match (or that has none, like older posters) isn't attached, and Event Guard's poster step regenerates it.
- The event layer's facts are added to the poster prompt. The rule that only the quoted text appears stays as it is.

**Bugs fixed while in these nodes** (found in the audit):
- Post Log records "Failed" for successful posts ("Write Execution Transaction Log").
- "Facebook Posted Food Today?" compares two date formats, so it never matches.

**Left as they are** (noted for the owner):
- Instagram Priority doesn't advance Next Post.
- Up to 8 Facebook posts a night.
- The calendar sync includes Private and Inactive rows.
- Food posts aren't events, so they get no event layer.

## 4. Deterministic validation (`src/social/validate.ts`, pure functions, with tests)

**General rules:**
- Text is normalised for matching (lower case, punctuation folded).
- Anything the rules can't verify is a **fail**, with a reason. The validator never guesses that something is fine.
- No claim of a 100% guarantee is made anywhere. Uncertain results go to review.

### A. A generated prompt

1. The output is valid JSON matching the schema. `master_prompt` is not empty and at most 3,000 characters.
2. `status = review_required`, or any ambiguity or question → `review_required`, keeping the questions.
3. **Claims are traceable:**
   - every `source_field` is whitelisted
   - each claim's distinctive words and numbers appear in that field's actual value
   - a claim that can't be traced → `review_required` ("claim not found in <field>")
4. **The prompt text itself contains:**
   - no explicit date, time, weekday, "tonight" or "tomorrow"
   - no £ amount other than the event's own price
   - no other active event's name
   - no capitalised name that isn't allowed

   The allowed names are: the event's own name, People & Roles names, words in Base Details or Approved Facts, category labels, and a fixed venue and brand list ("Roll The Dice", "Cleethorpes", "Meridian Point", platform names). Sentence-initial words and a common-word list are exempt. Breaking any of these rules → `review_required`.
5. **Instruction-like source text:**
   - Source fields that look like instructions ("ignore", "system prompt", "you are", "disregard the rules") are flagged as an ambiguity, "the description contains instructions", and the prompt goes to review.
   - They're always passed to Gemini as quoted data.
6. **Format confusion:** Base Details or Approved Facts that contradict each other on format (e.g. `Booking: essential` with "drop in" in Base Details) → `review_required`, with the question.

### B. The final post (and poster wording), against its target occurrence(s)

| Check | Passes only if |
|---|---|
| Target state | Each target event is active and Public/App Bookable; the occurrence is scheduled, still to come and not cancelled; there is no open sheet change; it isn't `sync_pending` |
| Prompt | Each target has an `approved` prompt whose fingerprint is current, and the version sent is that version |
| Dates | Every explicit date (numeric, "23 October", "23rd", "Oct 23") is a target occurrence's date. Weekday names are the target's weekday. "Tonight", "today" and "tomorrow" are true at check time in London; other relative phrases ("this weekend", "next week") fail |
| Times | Every time ("18:30", "6:30pm", "6pm", "6.30") is a target's start or end time |
| Prices | Every £ amount, and "free", matches the target's App Price or an Approved Facts `Price` line |
| Claims | Booking words ("book", "booking", "reserve", "secure a seat", "places", "spaces", "sell out") need a `Booking` fact, or booking set to Required/Optional in the app. Drop-in words ("drop in", "walk in", "just turn up", "open table", "no booking") need a `Booking` fact saying so. Level words ("beginner", "no experience", "all levels", "learn to play", "first-timers") need a `Level` fact. Prize words ("prize", "win", "cash") need a `Prizes` fact. Age words ("kids", "family", "all ages", "18+", "adults") need an `Age` fact or Base Details wording |
| People | Every capitalised name outside the allowed list must be in a target's People & Roles. A role word next to a name ("host", "DM", "organiser", "runs", "sets up") must match the role listed for that person |
| Other events | No other active event's name appears unless it is a target (round-ups) |
| Banned Phrases | None of the targets' Banned Phrases appear |

**Round-ups:** the check runs per event block, and on the whole text for dates, times and names (each must belong to one of the targets).

## 5. Admin screen

This goes in the existing **Edit event** page (`web/src/pages/OrganiseEventEdit.tsx`), admins only.

- **Approved Facts and People & Roles:**
  - Shown, and editable through the existing Logic Engine change queue. That requires adding both columns to `EDITABLE`, and RTD Sheet Writer to be published, which needs its own go-ahead.
  - Until then they're edited in the sheet, and the page says so.
- **Social prompt:**
  - Shows the current prompt, status, version, when it was generated and validated, who approved it, any questions or problems, and the history of versions.
  - **Regenerate:** the event is due on the next builder run.
  - **Approve with a note:** the admin's edited text is validated exactly like a generated prompt (§4A). If it passes, it becomes the approved version with `approved_by` set, and the builder writes it to the sheet.
- **Recent checks:** the last 10 pre-post checks for the event, with reasons.
- **Social prompts panel** (Organise › Events & dates, admins only):
  - The switch (Off / Shadow / Enforce).
  - Events needing review.
  - Held posts, and shadow results that would have been held.
  - The hub card's count adds `social_review` (prompts to review plus posts held).
- **Hosts** never see prompts. Their descriptions keep going through their existing approval path, and an approved change changes the fingerprint, so the prompt is regenerated and validated before use.

## 6. Rollout (each gate needs the owner's go-ahead) and rollback

| Gate | What happens | Rollback |
|---|---|---|
| G1 | Merge the app code (switch at `off`); apply migration 0024 | `wrangler rollback`; tables can stay |
| G2 | Back up the Logic Engine; the one-off workflow adds the 4 columns to both tabs | Columns can stay (the app ignores empty ones); the backup copy is there |
| G3 | Dan and Michelle fill in Approved Facts and People & Roles. I prepare suggested text from Base Details in a doc for them to confirm; nothing is written to the sheet by me | — |
| G4 | Builder: run it manually for 3 representative events (dry run: it writes no sheet cells), review in the admin screen; then publish (5 per run backfills the rest) | Unpublish |
| G5 | Master V1 and poster edits published, with the switch at `off`, then `shadow` for about a week | Switch `off`; restore Master V1's previous version from n8n history (version IDs recorded) |
| G6 | Owner reviews the shadow results, then switches to `enforce` | Switch back to `shadow` |

**First tested against the staging Logic Engine copy** (G2 and G4 run there first).

**Owner actions outside the build:**
- Give Michelle an account and approve her as admin, if intended.
- Move the Meta Graph token and ImageKit header typed into Master V1's nodes into n8n credentials.
- Decide on the noted items in §3.

## 7. Testing

Vitest (app):
- the validator: §4A and §4B, one test per rule
- the endpoints: due, propose (including stale), written, to-write, context, check (each mode)
- the switch and its audit log
- admin permissions (403 for approvers and hosts)
- regression: the full suite stays green

n8n:
- the builder, with pinned-data test runs for: ok, review_required, malformed JSON, timeout, stale fingerprint
- Master V1 edits checked with local runs of the code nodes and a diff against the live version, as for the 16 October edits

The brief's acceptance cases map like this:

| # | Case | Test |
|---|---|---|
| 1 | Organised D&D described as organised | Check fails "open table/drop-in" unless the fact allows it; prompt validation flags format confusion |
| 2 | Forgotten Levels with `Trixie — sets up` | "Trixie sets it up" passes; "Trixie hosts" fails (role mismatch); other names fail |
| 3 | No person listed | Any name fails |
| 4 | Two similar events at the same time | The other event's name, date or time in the text fails; context and check are keyed by Event ID and occurrence ID |
| 5 | Date edited after the prompt was made | Context returns the new date; the old date in text fails; the prompt isn't regenerated (fingerprint has no dates) |
| 6 | Recurring series | Only the target occurrence's date passes; another week's date fails |
| 7 | Expired, cancelled, unapproved or conflicted event | Check fails on target state; never due for a prompt |
| 8 | Ambiguous description | `review_required` with the question; no approved prompt |
| 9 | Malicious text in the description | Flagged as instructions, review; passed only as quoted data |
| 10 | Gemini outage, malformed JSON or quota | No row and retry; blocked after 3; no duplicate (unique event + fingerprint) |
| 11 | Simultaneous host and admin edits | Stale fingerprint is refused (409); only the latest facts are approved |
| 12 | Admin override | Validated like a generated prompt; versioned and audited |
| 13 | Regressions | Full app suite; Master V1 at `off` behaves as before (diff) |
| 14 | Final post with an unsupported fact, even with a good prompt | The check catches it (cash prizes, drop-in, couch, extra names) |

## 8. Out of scope

- Food and café-vibes posts: they aren't events and keep their prompts.
- The inactive workflows: Render Engine, Auto-Draft Event Copy, Seats Check, and the Creatomate branch. They stay inactive, and the plan notes that each must call the check before it's re-enabled.
- Metrics, cadence and volume changes.
- Changing who owns event facts: the Logic Engine stays the master.

## Changes during build (Stage 1, 18–19 October)

The sections above are the design as approved. The build changed these points; where they differ, this list wins. The as-built contract for n8n is in `docs/RTD_N8N_WORKFLOWS.md` ("Event social prompts (contract for Stage 2)").

1. **Uniqueness (§1, §2, §7 case 10).** `social_prompts` is `UNIQUE (event_id, version)`, with an index on `(event_id, source_fingerprint)`. It is not unique on (event, fingerprint): several versions can share one set of facts (a Regenerate, or an admin's approval), and the newest one for the facts counts. A duplicate answer is made harmless by the code: a version is added only if no other has been added for those facts since.
2. **Poster wording (§1).** `social_checks.image_text` holds the poster wording, and `text` holds only the caption. Both are cleared after 90 days.
3. **Synced owner columns (§1).** `events.social_values` (JSON) holds Approved Facts, People & Roles and Banned Phrases as the last sync read them. It is kept out of `source_hash`.
4. **RTD Event Sync (§1, §6 G2).** Its Build Snapshot sends a fixed list of columns, so it must be changed to send Approved Facts, People & Roles and Banned Phrases (Event Index), and the first two on Standard Diary. Until then the app sees them as blank. Not in the original gates; it belongs with G2.
5. **Projected dates (§3, §4B).** A date the app only projected from the event's cadence is never a target. The context skips it, and a check on it fails with "date not in the app yet".
6. **The context's target date (§3).** It is the next date that is public (the event and the date), not projected, and still to come or still running (its end time hasn't passed). `sheet_dates` is also accepted on the check.
7. **Price (§4B).** A date's own price overrides App Price.
8. **"This week" (§4B).** It is allowed when every target falls within the next 7 days (today to six days ahead, London). "This weekend", "next week" and "next <weekday>" still fail.
9. **Claim words (§4B).** A booking, drop-in, level, prize or age word is also supported when the same word is in that target's Base Details. The owner made Base Details an approved source.
10. **Round-ups (§4B).** Blocks are split at blank lines. A block naming exactly one target is checked against that target alone. Other blocks need dates, times and names in some target, and prices, weekdays and claims suited to every target.
11. **Roles (§4B).** A role word near any capitalised name, sentence-initial ones included, must match that person's listed role. A role is matched along a list of names only when the list starts within three words.
12. **Quoted prohibitions (§4A).** Prompts may quote short forbidden phrases ("never say 'drop in'") without failing. A quoted item must be six words or fewer, carry no date, time, money or name, and end its sentence. Posts get no such exemption.
13. **Generation failures (§2).** Below three failures, `POST /internal/social-prompts/:eventId` answers 200 `{ status: 'failed', failures }` and stores nothing. Failures are counted from the audit log; malformed output counts as one.
14. **Due rule (§2).** A host's change approved but not yet in the sheet also keeps an event off `/due`, and fails its posts' check. Price and capacity are whitelisted for every event that has them, not only hosts' sessions.
15. **Market events (§5)** get prompts like any other event, and their edit page shows the Social prompt section.
16. **Hub (§5).** There are two parts, `social_prompts` (prompts to review) and `social_held` (posts held in the last 7 days), instead of one `social_review`. Both are admin-only and left out at Off.
17. **Review list (§5).** It counts only events still running and Public or App Bookable.
18. **Admin approval (§5).** The admin's text gets the same text checks as a generated prompt (dates, times, prices, other events, names, claim words and roles), but no claim tracing or ambiguity questions. A reason is required. The schedule rule is added exactly once.
19. **Endpoints.** There are six internal endpoints, not five: `/social-prompts/due`, `/social-prompts/:eventId`, `/social-prompts/to-write`, `/social-prompts/:eventId/written`, `/social/context` and `/social/check`.
20. **Known limits** of the fixed-rule check are listed in `docs/RTD_N8N_WORKFLOWS.md` ("Known limits").
