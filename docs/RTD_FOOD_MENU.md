# Food & Drinks menu

The café's food and drinks menu in the app, to browse. Nobody orders or pays through it. Built in Stage 2 of the food menu and offers brief. The findings, decisions and the plan for offers are in [RTD_FOOD_MENU_AUDIT.md](RTD_FOOD_MENU_AUDIT.md).

## What customers see

- **Food & Drinks** at `/menu`. It's linked from:
  - the top bar: a button beside the logo on phones, a link in the menu on computers;
  - a card on Home;
  - the footer;
  - the installed app's shortcuts.

  The bottom bar keeps its five places.
- **Eight sections, in order:** Hot food, Cold food, Hot drinks, Cold drinks, Spirits, Beer & cider, Mixers, Wine & prosecco. A row of section links stays under the top bar while scrolling.
  - **Links to a section** work: `/menu#hot-drinks` opens there.
- **Each line shows:**
  - its name;
  - the choices ("Cheese or pepperoni"), and anything served with it;
  - its price in pounds, or one per serve for spirits (Single £4.00, Double £6.00);
  - "Individually priced", or another note, where the menu gives no single price. **No price is ever guessed.**
- **Photo slots:** every line has a square slot, and each section has room for a wide photo. Until the café adds photos, lines show a soft neutral tile with the section's icon. It's decorative, so screen readers skip it. There are no stock or made-up food photos, and the page works with no images at all.
- **Alcohol:**
  - each alcoholic drink has an **18+** marker;
  - alcoholic sections say "Alcoholic drinks are for over-18s only.";
  - 0% drinks aren't marked.
- **Allergies:** a note at the end asks people with a food allergy or intolerance to speak to the team before ordering. **No line is labelled allergen-free or with any dietary claim** beyond the café's own wording.
- **Preview:** while the menu is in Preview, a note says it's still being checked against the board and the café's price applies.
- **Offline:** the last menu loaded shows without a connection. If it's more than 15 minutes old, a note gives its date and time and says prices may have changed.
- **Not available right now:** a line can be marked this way; it stays listed, greyed. A hidden line, or a hidden section, isn't shown at all.

## For admins: Off, Preview or Live

**Food & drinks menu** in the organiser (admins only):

| Status | The public sees |
| --- | --- |
| **Off** (where it starts) | "The menu isn't in the app just now." The link stays, so nobody hits a missing page. |
| **Preview** | The menu, with the "still checking" note |
| **Live** | The menu, as the café's own |

- **Changes:** each one asks for confirmation. Who changed it and when shows on the card, and every change is in the audit log (`menu.status_changed`).
- **From the sheet:** when the menu last changed, the **Edit the menu in Google Sheets** link, and, if the latest copy was refused, every row to fix.
- **Check every line against the board:** opens a table with each line as the app shows it, its price, and its **Menu wording** from the sheet (the line as on the board). Use it before switching to Live, along with the checklist in [RTD_FOOD_MENU_AUDIT.md §6](RTD_FOOD_MENU_AUDIT.md#6-before-launch-for-the-café).
- **Who can:** only admins, checked on the server for every request (`/api/staff/menu`, `/api/staff/menu/status`). Approvers and hosts get 403.

## Changing the menu: the RTD Food Menu sheet

The menu is the **RTD Food Menu** Google Sheet, in Atechstudio's Drive under *Roll The Dice › Business* (its ID is in n8n, not here: this repository is public). Anyone the sheet is shared with can change it; the app copies it every 15 minutes (n8n **RTD Menu Sync**, [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#rtd-menu-sync-oq7gmvsygon9hs3z)). Its **How to use** tab says the same as this section, for the café.

**Sections tab:** one row per section, in the order shown. **Show** = N hides the whole section. Its page anchor comes from the name (`Beer & cider` → `/menu#beer-cider`), so renaming a section changes its link.

**Menu tab:** one row per line, in the order shown.

| Column | |
| --- | --- |
| Section | Must match a name on the Sections tab (a dropdown) |
| Item | The name. Required |
| Options, Description | The choices ("Cheese or pepperoni"); anything else ("Served with side salad") |
| Price | In pounds: `3.50`, `3.5` and `£3.50` all work |
| Single, Double | Serve prices (spirits). Not with Price |
| Price note | Instead of a price: "Individually priced". **Every line needs a Price, a Single or Double price, or a Price note** |
| Alcohol | Y: marked 18+. 0% drinks are N |
| Show | N: off the menu, row kept |
| Available | N: listed, greyed as not available right now |
| Photo, Photo description | An `/images/…` or `https://` address and what it shows; anything else is ignored and the placeholder shows |
| Menu wording | The line as on the board, for checking. Not shown to customers |

**A copy with any bad row is refused whole:** the app keeps the menu it had, the organiser lists each problem by row ("Menu row 5 (Toast): Price "1,25" isn't a price. Write it like 3.50."), and the n8n execution fails, so `Studio: Error Handler` emails. Fix the row and the next copy goes in. An empty Menu tab is refused too, so a bad read never empties the menu.

**Every change is audited:** a copy that changes anything writes `menu.updated` to the audit log, with the names of the lines added, removed and changed. Copies with no change write nothing.

## How it works

- **No menu tables.** The latest good copy of the sheet is the setting `food_menu` (JSON: sections, lines, serve prices, when it last changed, the sheet's link); how the latest copy went is `food_menu_sync`; the switch is `food_menu_status`. No setting yet reads as Off and empty. See [RTD_DATABASE_SCHEMA.md](RTD_DATABASE_SCHEMA.md#food--drinks-menu).
- **Sync:** n8n RTD Menu Sync reads both tabs and posts them to `POST /internal/menu` (bearer token, like every n8n call). `src/menu/sheet.ts` checks every row and turns it into the menu; 422 with every problem listed when it refuses.
- **API:** `GET /api/menu`, public, cached for 60 seconds. It returns visible sections in sheet order, each with its visible lines in sheet order, and `status` and `as_of`. A section with nothing visible is left out. Off returns no sections.
- **Service worker:** `/api/menu` is network first, like the diary and the games: online always gets the current menu, offline the last copy.
- **Stats:** `menu_view` counts page views, shown under **Stats → Around the app**.
- **Untouched:** events, bookings, hosts, notifications and the Logic Engine sync.

## Rollout

No database change, so merging is safe at any time: the menu starts **Off**, and the page says the menu isn't in the app until it's switched on.

1. **Merge the PR.** Workers Builds deploys it. Check the deployed Worker has `/internal/menu`.
2. **Publish n8n RTD Menu Sync** and run it by hand once. It should end `{ ok: true, items: 59, changed: true }`.
3. **An admin switches the menu to Preview** in the organiser, and checks `/menu`.
4. **When the café has checked the menu** (audit §6), an admin switches it to **Live**.

## Rollback

| If… | Do |
| --- | --- |
| A price or line is wrong | Fix it in the sheet; it's in the app within 15 minutes. Meanwhile switch to **Off**, or keep it in **Preview** (it says the café's price applies) |
| The sheet copy keeps failing | The app keeps the last good menu. Fix the rows the organiser lists; or unpublish RTD Menu Sync |
| The page itself misbehaves | Switch to **Off**, or `npx wrangler rollback` to the version before it |
| Remove the menu's data | Switch to Off, then `DELETE FROM settings WHERE key IN ('food_menu', 'food_menu_sync', 'food_menu_status');` |

## Next

- **Stage 3, offers:** a clearly marked offers area on this page; offers created and scheduled by the two people given `offers.manage`; activation and expiry by server time.
- **Stage 4, notifications:** offer notifications, sent only to devices that opted in to promotions, after an explicit preview and confirmation.

See [RTD_FOOD_MENU_AUDIT.md §5](RTD_FOOD_MENU_AUDIT.md#5-delivery).
