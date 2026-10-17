# RTD App: Handoff (updated 2026-10-17, 09:05 UTC)

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
