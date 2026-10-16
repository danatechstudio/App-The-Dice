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
| **Off** | "The menu isn't in the app just now." The link stays, so nobody hits a missing page. |
| **Preview** (where it starts) | The menu, with the "still checking" note |
| **Live** | The menu, as the café's own |

- **Changes:** each one asks for confirmation. Who changed it and when shows on the card, and every change is in the audit log (`menu.status_changed`).
- **Check every line against the board:** opens a table with each line as the app shows it, its price, and the original line as transcribed from the photographed menu. Use it before switching to Live, along with the checklist in [RTD_FOOD_MENU_AUDIT.md §6](RTD_FOOD_MENU_AUDIT.md#6-before-launch-for-the-café).
- **Who can:** only admins, checked on the server for every request (`/api/staff/menu`, `/api/staff/menu/status`). Approvers and hosts get 403.

## Changing the menu

The organiser can't edit lines yet: that comes with its own permission (`menu.manage`, see the audit §4). Until then, a change is a **new numbered migration**, reviewed like any other. Never edit `0022_food_menu.sql` once it has been applied.

```sql
-- A new price (pence)
UPDATE menu_items SET price_pence = 375, updated_at = '<now>' WHERE item_id = 'RTD-MENU-00003';
-- Sold out for now / back again
UPDATE menu_items SET available = 0, updated_at = '<now>' WHERE item_id = 'RTD-MENU-00025';
-- Off the menu (kept, so its ID is never reused)
UPDATE menu_items SET visible = 0, updated_at = '<now>' WHERE item_id = 'RTD-MENU-00032';
-- A new line, after the last in its section
INSERT INTO menu_items (item_id, category_id, name, price_pence, sort_order, source_text, created_at, updated_at)
VALUES ('RTD-MENU-00060', 'hot-drinks', 'Chai latte', 300, 110, 'Added by the café, <date>', '<now>', '<now>');
-- A photo: the app's own (/images/…) or an https address, with a description
UPDATE menu_items SET image_url = 'https://…', image_alt = 'A bacon bun in a floured bap' WHERE item_id = 'RTD-MENU-00001';
```

- **Prices are pence**, between 0 and £1,000.
- **Several prices for one line** (Single/Double, Small/Large) go in `menu_item_variants`, which then replace `price_pence`.
- **A photo address that isn't `/images/…` or `https://`** is ignored, and the placeholder shows.

## How it works

- **Tables:** `menu_categories`, `menu_items`, `menu_item_variants` ([RTD_DATABASE_SCHEMA.md](RTD_DATABASE_SCHEMA.md#food--drinks-menu)). The switch is the setting `food_menu_status`.
- **API:** `GET /api/menu`, public, cached for 60 seconds. It returns visible sections in `sort_order`, each with its visible lines in `sort_order`, and `status` and `as_of`. A section with nothing visible is left out. Off returns no sections.
- **Service worker:** `/api/menu` is network first, like the diary and the games: online always gets the current menu, offline the last copy.
- **Stats:** `menu_view` counts page views, shown under **Stats → Around the app**.
- **Untouched:** events, bookings, hosts, notifications, the Logic Engine sync and n8n.

## Rollout

1. **Apply `0022_food_menu.sql` to production first**, with the owner's go-ahead, then merge. Applying it changes nothing visible: the menu only shows once the code that reads it is deployed.
   - **Check before:** counts of `events`, `occurrences`, `bookings` and `audit_log`; the latest sync `ok`.
   - **Check after:** the same counts, plus 8 sections, 59 lines, 16 serve prices, and `food_menu_status = preview`.
2. **Merge the PR.** Workers Builds deploys it; check `/menu` and `/api/menu` on the live app.
3. **When the café has checked the menu** (audit §6), an admin switches it to **Live**.

**If the code is deployed before the migration:** `/menu` shows "That didn't roll properly" with **Try again**, and nothing else is affected. Apply the migration and it works.

## Rollback

| If… | Do |
| --- | --- |
| A price or line is wrong | Switch the menu to **Off** or keep it in **Preview** (it says the café's price applies), then fix it with a migration |
| The page itself misbehaves | Switch to **Off**, or `npx wrangler rollback` to the version before it |
| The tables have to go | Switch to Off and roll back the code first, then `DROP TABLE menu_item_variants; DROP TABLE menu_items; DROP TABLE menu_categories; DELETE FROM settings WHERE key = 'food_menu_status';`. Nothing else refers to them |

## Next

- **Stage 3, offers:** a clearly marked offers area on this page; offers created and scheduled by the two people given `offers.manage`; activation and expiry by server time.
- **Stage 4, notifications:** offer notifications, sent only to devices that opted in to promotions, after an explicit preview and confirmation.

See [RTD_FOOD_MENU_AUDIT.md §5](RTD_FOOD_MENU_AUDIT.md#5-delivery).
