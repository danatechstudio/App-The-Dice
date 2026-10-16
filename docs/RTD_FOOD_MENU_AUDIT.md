# Food & Drinks Menu and Offers: Pre-change Audit

_Audit date: 16 October 2026. Brief: "Roll The Dice — Food & Drinks Menu and Offers" (`RTD_FOOD_MENU_OFFERS-1.md`)._

The audit itself changed nothing in production. It read the repository: the Worker, the D1 migrations `0001`–`0021`, auth, push, the service worker and the web app. It ran no live queries. The only change that follows it is Stage 2 (§5), which is code and one additive migration.

> **This repository is public.** This file names tables and roles, not people's email addresses. Who holds a permission is recorded in the database, not here.

## 1. Findings that shape the plan

| # | Finding | Effect |
| --- | --- | --- |
| F1 | **Nothing about food or drink exists.** No table, route, page or stats count refers to a menu, an item or an offer. | Everything is additive. No data to migrate or orphan. |
| F2 | **One production D1 database, no staging** (`rtd-app`). Migrations are applied by hand, through the Cloudflare connector or `wrangler d1 migrations apply --remote`, before the code that needs them is merged; Workers Builds deploys `main` on every push. | Each stage is one new migration file, applied (with the owner's go-ahead) before its PR is merged. The public menu also has an **Off / Preview / Live** switch in `settings`, so it can be hidden without a deploy. |
| F3 | **Roles are `users.role`: `host`, `staff` (shown as Approver) and `admin`.** Cloudflare Access proves the email; the `users` row decides. `requireRole('staff')` also admits admins; admin-only checks compare `role === 'admin'` on the server. Today Michelle is the approver and Dan the admin. | Offers must not follow the role ladder: the brief says neither all admins nor all approvers get them. A per-person permission is needed (§4). |
| F4 | **There is no per-person permission today**, only roles. | Stage 3 adds `user_permissions` (one row per person and permission, granted by the owner in the database, audited). Nothing in the organiser can grant it, so no admin can give it to themselves. |
| F5 | **Three separate push audiences already exist:** `push_subscriptions` (approvers' devices, signed in), `alert_subscriptions` (anyone's device, no account: event reminders), and booking devices (one booking's cancel/move notice). They share one VAPID key and one every-minute Cron Trigger with a 20-message budget (`BATCH`). | Customers opted in to **event reminders**, not marketing. Promotional offers need a **separate, explicit opt-in** per device (Stage 4), on the same `alert_subscriptions` devices, and offer pushes must take their turn inside the existing per-minute budget so event and booking alerts aren't delayed. |
| F6 | **`audit_log` is append-only** (database triggers refuse UPDATE and DELETE). | Menu status changes (Stage 2) and every offer step (Stage 3/4) are written there. A separate `offer_audit_events` table isn't needed. |
| F7 | **All times are UTC instants in D1; London dates and wall-clock times are converted with `src/lib/time.ts`** (`londonToUtc`, BST-aware, tested across the clock changes). | Offers store `starts_at` / `ends_at` as UTC; the organiser enters London times, converted on the server. "Active" is decided by comparing with the server's clock on every read, so an offer leaves the public app the moment it ends, whether or not any scheduled job has run. |
| F8 | **The service worker caches public API reads network-first** (`/api/events`, `/api/occurrences`, `/api/games`) and falls back to the last copy offline. | `/api/menu` joins that list. Offers (Stage 3) will be re-checked against their `ends_at` in the page itself, so an offline copy can never show an offer that has ended. |
| F9 | **The mobile bottom bar has five slots, with Roll raised in the middle.** A sixth would push Roll off-centre and squeeze every label at 320px. The top bar shows only the logo on phones. | **Food & Drinks** goes in the desktop top navigation, in the phone top bar (a labelled button beside the logo), on the Home page and in the footer. The bottom bar is unchanged. |
| F10 | **Images:** event photos and game covers live in Workers KV (`IMAGES`). The Content Security Policy allows images from the app and any `https:` address. | Menu items and categories get `image_url` / `image_alt` columns now (reserved, empty). Uploads can later use the same KV namespace. Until then every item shows a neutral placeholder. |
| F11 | **Stats count page views as daily totals** with an allow-list of metric names. | A `menu_view` count is added, shown in the organiser's Stats. |
| F12 | **Google Sheets / n8n:** the Logic Engine sync, RTD Outbox, Team Notices and every other workflow only touch events, bookings, hosts and markets. | The menu and offers need no n8n or sheet change. Event, booking and host behaviour is untouched. |
| F13 | **The brief's menu was transcribed from photographs.** Some lines are ambiguous, and the menu doesn't state the legal measures for alcohol. | The data is loaded exactly as transcribed (with the original line kept in `source_text`). The menu starts in **Preview**, marked as being checked, until an admin switches it to Live (§6). |

## 2. What the existing app gives us

- **Hosting:** one Worker (Hono API + the Preact PWA in `web/dist`), D1 `rtd-app`, KV `IMAGES`, one Cron Trigger every minute.
- **Public pages:** routed client-side (`web/src/app.tsx`); unknown paths fall back to the app shell, so `/menu` needs no Worker route.
- **Theme:** tokens in `web/src/theme/`, components in `web/src/styles/`; WCAG contrast tested (`test/theme.test.ts`).
- **Settings:** a key/value `settings` table, already used for switches (`game_library_live`, `attention_enabled`).
- **Patterns reused:** the game library's live switch (admin-only, confirmed, audited); `useApi` with a one-minute in-memory cache; `EmptyState` / `ErrorState`; `useCount` stats.

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | **Prices are stored in pence** (`INTEGER`, 0–£1,000). An item with no single price has `price_pence = NULL` and a `price_note` ("Individually priced"); the API never invents one. Serve sizes with their own prices (spirits: Single, Double) are rows in `menu_item_variants`. | No floating-point money. "Never infer missing prices." |
| D2 | **Category and item IDs are stable:** categories by slug (`hot-food`, also the page anchor), items `RTD-MENU-00001` upwards, never reused. | Offers (Stage 3) can link to items, and links to `/menu#hot-food` keep working. |
| D3 | **Two switches per item:** `visible` (on the menu at all) and `available` (listed, but marked "Not available right now"). Categories have `visible` too. Order is `sort_order` within each. | "Menu availability visibility, category sort order, product sort order." |
| D4 | **Alcohol is marked per item** (`alcohol = 1`) and per category. Alcoholic items show an **18+** marker; alcoholic categories say "Over-18s only". 0% drinks aren't marked. | "Alcoholic beverages should be clearly marked." No age-related claim beyond the law. |
| D5 | **No dietary or allergen labels.** Item text is the café's own; the page tells people to ask at the counter about allergens before ordering. | "Do not label any item allergen-free without validated information." |
| D6 | **Browse only.** No basket, quantity, order, checkout or payment controls anywhere. | Brief scope. |
| D7 | **The menu has a status:** Off (the page says the menu isn't in the app), Preview (shown, with a note that prices are being checked and the counter price applies), Live. It starts at **Preview**; only admins change it, and every change is audited. | Prices must be confirmed with the café before the menu is relied on (§6), without holding back the page. |
| D8 | **Menu editing** (prices, wording, hiding items) isn't in Stage 2. Until there's an editor, corrections are made by a reviewed migration. The editor, when built, uses its own permission (`menu.manage`), granted like `offers.manage`. | "Menu content editing may be separately permissioned after audit." |

## 4. Roles and permissions (for review)

| Capability | Host | Approver (`staff`) | Admin | Needs permission |
| --- | --- | --- | --- | --- |
| See the public menu and offers | ✓ | ✓ | ✓ | — (everyone, signed in or not) |
| Switch the menu Off / Preview / Live (Stage 2) | | | ✓ | — |
| Edit menu items, prices, order, availability (later stage) | | | | `menu.manage` |
| Create, edit, publish, schedule, pause, expire, cancel or delete offers (Stage 3) | | | | `offers.manage` |
| Preview and send an offer notification (Stage 4) | | | | `offers.manage` |
| Grant or remove a permission | | | | Owner only, in the database (`wrangler d1 execute` or the Cloudflare dashboard), never from the app |

- **`offers.manage` goes to exactly two people, Michelle and Dan,** granted by their `users.user_id` once each has signed in (so the identity is the one Cloudflare Access verified). It is **not** tied to a role: making someone an approver or admin doesn't grant it, and removing their access (`users.active = 0`) stops it working.
- **Every protected endpoint checks the permission on the server**, after `requireRole`, on every request. Hiding a button is never the control.
- **Each grant and removal** is written to `audit_log` (`user.permission_granted` / `user.permission_removed`).

## 5. Delivery

| Stage | What | State |
| --- | --- | --- |
| 1 | This audit | Done |
| 2 | Menu schema and data (`0023_food_menu.sql`), `GET /api/menu`, the public **Food & Drinks** page with placeholders, navigation, offline copy, the admin status switch, `menu_view` stats | **Built** (this change) |
| 3 | `user_permissions`; `offers` + `offer_menu_items`; the protected offer editor (draft → scheduled → active → paused / expired / cancelled); server-time activation and expiry; the public offers area on the menu page and `/menu/offers/:id` deep links | Next |
| 4 | Promotional opt-in (separate from event alerts) with unsubscribe; **Notify customers** with a preview and explicit confirmation; campaigns and per-device deliveries with idempotency keys, rate limits and logs; dispatch at start for scheduled offers | After 3 |
| 5 | Progressive deploy, admin instructions, rollback | With each stage |

### Stage 3 and 4 outline (to be confirmed before building)

- **`offers`:** `offer_id`, `title`, `description`, `terms`, `promo_price_pence` *or* `discount_percent` (both optional, never both), `image_url`, `image_alt`, `starts_at`, `ends_at` (UTC; entered in Europe/London), `status` (`draft`, `scheduled`, `paused`, `cancelled`; **active and expired are worked out from the clock**, never stored, so they can't go stale), `published_at`, `created_by`, `updated_by`, `created_at`, `updated_at`, plus notification fields (`notify_requested_at`, `notification_sent_at`, `notification_status`). `CHECK (ends_at > starts_at)`.
- **Public rule (one SQL fragment, mirrored in the page):** `status = 'scheduled' AND starts_at <= now AND ends_at > now`. Draft, paused, cancelled, not yet started and ended offers are never returned. Responses are cached no longer than the first `ends_at` among them (as `publicCache` already does for events).
- **Deleting:** drafts can be deleted; anything that was ever published is cancelled instead, so the audit trail and any notification log still read.
- **Notifications:** `offer_notification_campaigns` (one per approved send, unique per offer and approval, so retries and repeated scheduler runs can't make a second campaign) and `offer_notification_deliveries` (one per device, claimed in batches like `push_deliveries`). Promotional opt-in lives on the existing device row (`alert_subscriptions.promotions_at`, `NULL` = not opted in), with its own on/off control and a note in the privacy notice. An edit after approval cancels a waiting send until it's approved again. At most one offer campaign per 24 hours (configurable).
- **Alcohol offers:** devices are anonymous, so nobody's age is known. **Proposed:** an offer linked to an alcoholic item can be shown in the app but can't be sent as a notification.

## 6. Before launch (for the café)

The menu goes live in **Preview** until these are done; then an admin switches it to **Live** in the organiser.

1. **Check every price against the board**, especially:
   - **Coke float £1.75**, which is less than a soft drink (£2.00);
   - **Cheesy fries £2.75**, only 25p more than fries;
   - **Guinness / 0% £3.50**: does one price cover both?
2. **Measures for alcohol.** The law requires them on the price list:
   - **Spirits:** 25ml or 35ml (Single and Double);
   - **Wine:** glass sizes, 125ml, 175ml or 250ml;
   - **Draught beer and cider:** pint or half.

   The transcription has none of these, and they haven't been guessed. Send them and they'll be added.
3. **"Gluten-free cakes":** the menu's own wording, kept as written. Confirm it is validated: gluten-free is a regulated claim. Otherwise it changes to "cakes (ask about gluten)".
4. **Allergen and dietary information:** the page says to ask at the counter before ordering. Confirm that's how the café wants to handle it.
5. **The over-18s wording on alcohol:** the page says "Over-18s only". If the café uses Challenge 25, the wording can say so.
6. **Items "individually priced"** (cakes, crisps, chocolate) show that phrase, with no price.
