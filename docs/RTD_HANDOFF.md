# RTD App: Handoff (updated 2026-10-19)

Read this first. Stage 6 (Event Control) has its own, longer handoff: [RTD_EVENT_CONTROL_HANDOFF.md](RTD_EVENT_CONTROL_HANDOFF.md).

> **This repository is public.** No sheet, Drive or credential IDs here; they're in n8n (`rtd_config`, and the workflow nodes).

## Where things stand

**`main` (deployed by Workers Builds on every push) has everything up to PR #11:**

| PR | What | Live? |
| --- | --- | --- |
| #1–#8 | Event control Stages 3a–5b | Yes (earlier sessions checked each deploy) |
| #9 | **Food & Drinks menu, kept in a Google Sheet** | **Yes, checked:** the live app took the sheet's 59 lines (`{ ok: true, items: 59, changed: true }`, n8n execution 58572), and the first scheduled run at 22:00 was ok (58582) |
| #10 | Join request emails to info@ and Dan; organiser shows **Dan (Admin)** and **Name (Host)** (the 12 October branch `claude/roll-dice-app-updates-ansgbx`, brought up to date) | **Yes, checked 17 Oct:** the deployed Worker contains `JOIN_REQUEST_RECIPIENTS` |
| #11 | **Stage 6**: change Logic Engine events from the organiser, plus this handoff | **Yes, checked:** live Worker has the new code; the 09:00 sync on it was ok. Switched **Off** |

**Branches not in `main`:**
- None with work left. `claude/new-session-qt4dd9` (Stage 6), `game-library`, `claude/roll-dice-app-updates-ansgbx` and `ccr-eb6d0278-tfndjm` are all fully in `main` and can be deleted.

## The food menu

- **The menu is the "RTD Food Menu" Google Sheet**, in Atechstudio's Drive under *Roll The Dice › Business*. It has three tabs: **Menu**, **Sections** and **How to use** (for the café). It started from the 59 transcribed lines. How it works, the columns and rollback: [RTD_FOOD_MENU.md](RTD_FOOD_MENU.md).
- **n8n RTD Menu Sync** (`Oq7gMVsYGOn9HS3Z`): **published**, every 15 minutes. It reads both tabs and posts to `POST /internal/menu`. It has the error handler (`IClMUs9ByRmVBYJf`). Rolling back = unpublishing it.
- **No database change:** the latest good copy is the setting `food_menu`, and how the latest copy went is `food_menu_sync`. A copy with any bad row is refused whole (422); the app keeps the last good menu and the organiser lists the rows to fix.
- **The menu is Live.** Dan switched it to Preview at 22:07 and Live at 22:07 on 16 Oct (audit log). The sync has run ok since (last checked 06:15 on 17 Oct). **The café's checks before Live (step 2 below) haven't been confirmed yet,** so the alcohol measures are still missing from the price list.

**Not yet tried for real:**
- the organiser's **Food & drinks menu** card on the live site (sheet link, "last changed", the problems box);
- a refused copy (a deliberate typo in the sheet, then put it back);
- `/menu` in Preview on a phone.

## Organiser hub (17 Oct, built)

`/organise` for approvers and admins is a hub of section cards with what's waiting, each opening its own page ([RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md#the-organiser-for-approvers-and-admins-2026-10-17); spec and plan in `docs/superpowers/`). It's in the PR after #11; once merged, check it on the live app as an admin and as an approver.

## Admin event editor (18 Oct, built on branch `ccr-b9b076a7-f9fv6q`)

Admins change or cancel **every** event from Organise › Events & dates › **All events**. That covers café events, host sessions and markets, any visibility, running or stopped, including details, who can see it, places, need to book, cancelling a date, and Stop running ([changelog](../RTD_CHANGELOG.md), spec and plan in `docs/superpowers/`). Hosts and approvers are unchanged.

**Blocker for café details:** RTD Sheet Writer has never been published, although Logic Engine changes are set to Live. Until the owner says go and it's published (test copy first, [RTD_EVENT_CONTROL_MIGRATION.md](RTD_EVENT_CONTROL_MIGRATION.md#admin-event-editor-2026-10-18-no-migration)), café detail changes wait in the queue. Everything else in the editor works without it.

## Event social prompts, Stage 1 (19 Oct, built on branch `ccr-b9b076a7-f9fv6q`)

The app side of event-specific social master prompts ([changelog](../RTD_CHANGELOG.md); spec and plan in `docs/superpowers/`, dated 2026-10-18).
- **What's built:** storage of each event's prompt versions, the fixed-rule checks (on prompts and on every post), the endpoints n8n will call, the **Off / Shadow / Enforce** switch, and the admin screens (Organise › Events & dates › **Social prompts**, and a **Social prompt** section on each event's edit page).
- **Switched Off.** Nothing posts differently until Stage 2's n8n changes are made and the switch is changed.
- **The n8n contract for Stage 2** (six endpoints, and what n8n does at each setting): [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#event-social-prompts-contract-for-stage-2).
- **Known limits:** it's a safety net built from fixed rules, not a guarantee. It's why Shadow comes first ([the list](RTD_N8N_WORKFLOWS.md#known-limits)).
- **Database:** `0024_social_prompts.sql`, **not applied**. It goes after `0023` ([RTD_EVENT_CONTROL_MIGRATION.md](RTD_EVENT_CONTROL_MIGRATION.md#0024_social_promptssql-event-social-prompts-stage-1)).
- **Found while writing the docs:** RTD Event Sync sends a fixed list of columns. It must be changed to send Approved Facts, People & Roles and Banned Phrases, or the app sees them as blank. This isn't in the spec's gates; it fits with G2, with its own go-ahead.

**The owner's to-dos:**
1. Fill in **Approved Facts** and **People & Roles** in the Logic Engine, with Michelle (G3, once the columns exist).
2. Give the go-ahead for **0023**, then **0024**.
3. Publish **RTD Sheet Writer** (test copy first). For now the two columns are edited in the sheet, and the edit page says so. Editing them from the app also needs a small app change later: adding both to the list of columns the app may change.
4. Say when to start **Stage 2**.

**Gates (spec §6), each with the owner's go-ahead:**

| Gate | What happens | Rollback |
| --- | --- | --- |
| G1 | Apply **0023**, then **0024**, to production (each with the owner's go-ahead), check them, and only then merge the app code (switch Off). Merging first would break the live app: the sync, the organiser hub and the daily privacy clean-up all need 0024's tables | `wrangler rollback`; the tables can stay |
| G2 | Back up the Logic Engine; a one-off workflow adds the 4 columns to both tabs (staging copy first); RTD Event Sync sends the new columns  **Done 19 Oct 10:52–11:00 UTC:** backup "Logic Engine_RTD BACKUP 2026-10-19 1050 (before social prompt columns)"; headers added to the staging copy, then live (Event Index Y–AB, Standard Diary I–L), no column moved; RTD Event Sync's Build Snapshot now sends Banned Phrases, Approved Facts and People & Roles (tested by hand, run n8n-68902: 32 events, 0 changed; published) | The columns can stay (the app ignores empty ones); the backup is there |
| G3 | Dan and Michelle fill in Approved Facts and People & Roles, from suggested wording in a doc they confirm | — |
| G4 | The builder runs by hand for 3 events (a dry run that writes no cells), reviewed on the screen; then it's published | Unpublish |
| G5 | Master V1 and poster changes published with the switch Off, then Shadow for about a week | Switch Off; restore Master V1's previous version |
| G6 | The owner reviews the Shadow results, then switches to Enforce | Switch back to Shadow |

## Next steps

1. ~~Owner: switch the menu to Preview~~ (done; it's Live).
2. **Owner and the café, as soon as possible now that it's Live** ([audit §6](RTD_FOOD_MENU_AUDIT.md#6-before-launch-for-the-café)), all in the sheet:
   - check every price, especially the Coke float (£1.75), Cheesy fries and Guinness / 0%;
   - add the **alcohol measures** the law needs on the price list: spirits 25 or 35ml, wine 125/175/250ml, draught pint or half;
   - confirm the **"gluten-free cakes"** wording (a regulated claim), or change it to "cakes (ask about gluten)";
   - confirm the allergen note ("speak to the team before ordering") and the over-18s wording (Challenge 25?).

   Until then, switching back to **Preview** puts the "still being checked" note back.
3. ~~Check PR #10's deploy~~ (done). The join request change only shows on the next real request.
4. **Stage 6 is live and switched Off** (PR #11; `0022` applied 08:38, the 09:00 sync on the new code ok, `sheet_values` filled for all 32 events; [RTD_EVENT_CONTROL_MIGRATION.md](RTD_EVENT_CONTROL_MIGRATION.md)). Next, each with the owner's go-ahead: the **test copy** (publish RTD Sheet Writer, set Test copy), then at least a week's **trial**, then Live.
5. **Tidy up:** delete the merged branches listed above (owner's call).
6. **Next food menu stage:** offers (Stage 3 in [RTD_FOOD_MENU_AUDIT.md](RTD_FOOD_MENU_AUDIT.md#5-delivery)). It waits for the owner.
7. **Event social prompts:** merge Stage 1 (with 0023 and 0024 applied first), then Stage 2 gate by gate, as above.

## Blockers and gotchas

- **The Cloudflare connector** was on the wrong account on 16 Oct; **fixed on 17 Oct.** It reaches `rtd-app` (D1 and the Worker). If it lists no databases again, it's been reconnected to another account.
- **This session's container can't reach the live app.** `curl` to `rtd-app.dan-289.workers.dev` gets a proxy 403. Check it through n8n executions instead, or the Cloudflare connector once it's on the right account.
- **The "Workers Builds: rtd-app" check on PR commits shows an instant failure** (#8 and #9 alike). It's the branch build, not the production deploy, which worked both times. Don't read it as a broken deploy; check the live Worker or an n8n call instead.
- **The plugin Cloudflare MCP server** (`plugin:cloudflare`) fails to connect (proxy 403). The **Cloudflare Developer Platform** connector is the one that connects.

## Standing rules (from the owner; they still apply)

- **No production migrations, mass notifications or destructive edits without the owner's explicit go-ahead.** Ask before each one.
- **Don't make new events or delete old ones** while the app is being tested.
- **Never claim deployed or working without runtime evidence** (the live Worker's code, an n8n execution, the next sync).
- **No sheet IDs or secrets in this repository.**
- Commits end with the attribution lines; no model names in commits or PRs; no PR unless the owner asks.

## Live counts (17 Oct, 06:20 UTC, before any Stage 6 change)

events 32, occurrences 74, bookings 0, audit_log 301; last migration `0021_change_requests.sql`.

## Checks at the end of 16 Oct

- `main` at `5c7a67b`: `npm test` 29 files, 410 passed (on the merged tree before #10 went in); `npm run typecheck` clean.
- Menu code: `src/menu/sheet.ts` (reading the sheet), `src/menu/menu.ts` (storing and serving), `POST /internal/menu` in `src/routes/internal.ts`, `web/src/pages/OrganiseMenu.tsx`, `test/menu.test.ts` (with `test/fixtures/menuSheet.ts`, the sheet's starting rows).
