# RTD App: Handoff (end of 2026-10-16, for 17 October)

Read this first. The Stage 6 (Event Control) work has its own, longer handoff on its branch: `docs/RTD_EVENT_CONTROL_HANDOFF.md` on `claude/new-session-qt4dd9`.

> **This repository is public.** No sheet, Drive or credential IDs here; they're in n8n (`rtd_config`, and the workflow nodes).

## Where things stand

**`main` (deployed by Workers Builds on every push) has everything up to PR #10:**

| PR | What | Live? |
| --- | --- | --- |
| #1–#8 | Event control Stages 3a–5b | Yes (earlier sessions checked each deploy) |
| #9 | **Food & Drinks menu, kept in a Google Sheet** | **Yes, checked:** the live app took the sheet's 59 lines (`{ ok: true, items: 59, changed: true }`, n8n execution 58572), and the first scheduled run at 22:00 was ok (58582) |
| #10 | Join request emails to info@ and Dan; organiser shows **Dan (Admin)** and **Name (Host)** (the 12 October branch `claude/roll-dice-app-updates-ansgbx`, brought up to date) | Merged 21:59. **The deploy itself wasn't checked:** grep the deployed Worker for `JOIN_REQUEST_RECIPIENTS` |

**Branches not in `main`:**
- `claude/new-session-qt4dd9`: **Stage 6** (change Logic Engine events from the organiser), 4 commits ahead and 9 behind `main`. **Don't merge it until migration `0022_sheet_edits.sql` is applied to production**, or every 15-minute sync fails (its handoff, step 1). Merging `main` into it gives one conflict, in `RTD_CHANGELOG.md`.
- `game-library`, `claude/roll-dice-app-updates-ansgbx`, `ccr-eb6d0278-tfndjm`: fully in `main`; can be deleted.

## The food menu

- **The menu is the "RTD Food Menu" Google Sheet**, in Atechstudio's Drive under *Roll The Dice › Business*. It has three tabs: **Menu**, **Sections** and **How to use** (for the café). It started from the 59 transcribed lines. How it works, the columns and rollback: [RTD_FOOD_MENU.md](RTD_FOOD_MENU.md).
- **n8n RTD Menu Sync** (`Oq7gMVsYGOn9HS3Z`): **published**, every 15 minutes. It reads both tabs and posts to `POST /internal/menu`. It has the error handler (`IClMUs9ByRmVBYJf`). Rolling back = unpublishing it.
- **No database change:** the latest good copy is the setting `food_menu`, and how the latest copy went is `food_menu_sync`. A copy with any bad row is refused whole (422); the app keeps the last good menu and the organiser lists the rows to fix.
- **The menu is still Off.** Nobody has switched it on yet. Until then, `/menu` says the menu isn't in the app.

**Not yet tried for real:**
- the organiser's **Food & drinks menu** card on the live site (sheet link, "last changed", the problems box);
- a refused copy (a deliberate typo in the sheet, then put it back);
- `/menu` in Preview on a phone.

## Next steps

1. **Owner:** in the organiser, **Food & drinks menu → Preview**, then look at `/menu` on a phone.
2. **Owner and the café, before Live** ([audit §6](RTD_FOOD_MENU_AUDIT.md#6-before-launch-for-the-café)), all in the sheet:
   - check every price, especially the Coke float (£1.75), Cheesy fries and Guinness / 0%;
   - add the **alcohol measures** the law needs on the price list: spirits 25 or 35ml, wine 125/175/250ml, draught pint or half;
   - confirm the **"gluten-free cakes"** wording (a regulated claim), or change it to "cakes (ask about gluten)";
   - confirm the allergen note ("speak to the team before ordering") and the over-18s wording (Challenge 25?).

   Then **Live**.
3. **Check PR #10's deploy** (above). The join request change only shows on the next real request.
4. **Stage 6:** follow its handoff. It needs the Cloudflare connector on the right account first (below), and the owner's go-ahead for `0022`, then for the test copy, then the trial.
5. **Tidy up:** delete the merged branches listed above (owner's call).
6. **Next food menu stage:** offers (Stage 3 in [RTD_FOOD_MENU_AUDIT.md](RTD_FOOD_MENU_AUDIT.md#5-delivery)). It waits for the owner.

## Blockers and gotchas

- **The Cloudflare connector reaches the wrong account:** it lists no Workers and no D1 databases, and `rtd-app` comes back "not found". The app's account is the one behind `dan-289.workers.dev`. The owner has to reconnect the connector to that account before any D1 query, migration or `workers_get_worker_code` check.
- **This session's container can't reach the live app.** `curl` to `rtd-app.dan-289.workers.dev` gets a proxy 403. Check it through n8n executions instead, or the Cloudflare connector once it's on the right account.
- **The "Workers Builds: rtd-app" check on PR commits shows an instant failure** (#8 and #9 alike). It's the branch build, not the production deploy, which worked both times. Don't read it as a broken deploy; check the live Worker or an n8n call instead.
- **The plugin Cloudflare MCP server** (`plugin:cloudflare`) fails to connect (proxy 403). The **Cloudflare Developer Platform** connector is the one that connects.

## Standing rules (from the owner; they still apply)

- **No production migrations, mass notifications or destructive edits without the owner's explicit go-ahead.** Ask before each one.
- **Don't make new events or delete old ones** while the app is being tested.
- **Never claim deployed or working without runtime evidence** (the live Worker's code, an n8n execution, the next sync).
- **No sheet IDs or secrets in this repository.**
- Commits end with the attribution lines; no model names in commits or PRs; no PR unless the owner asks.

## Checks at the end of today

- `main` at `5c7a67b`: `npm test` 29 files, 410 passed (on the merged tree before #10 went in); `npm run typecheck` clean.
- Menu code: `src/menu/sheet.ts` (reading the sheet), `src/menu/menu.ts` (storing and serving), `POST /internal/menu` in `src/routes/internal.ts`, `web/src/pages/OrganiseMenu.tsx`, `test/menu.test.ts` (with `test/fixtures/menuSheet.ts`, the sheet's starting rows).
