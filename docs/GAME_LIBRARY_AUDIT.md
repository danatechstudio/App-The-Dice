# Game Library: Pre-change Audit

_Audit date: 15 October 2026. Read-only: nothing in production was changed while writing this._

Brief: replace the app's game catalogue with the café's enriched master list, build Quick Roll and Filtered Roll on it, add game detail pages with similar games, rotate Game of the Week automatically, and give admins a way to maintain the catalogue. Everything else in the app must stay as it is.

## 1. Findings that shape the plan

| # | Finding | Effect |
| --- | --- | --- |
| F1 | **There are no game tables in the live database.** Today's "catalogue" is 10 well-known titles hard-coded in `web/src/data/preview-games.ts`, shown as a labelled *Preview*. Game of the Week is a constant (`carcassonne`). | Nothing has to be deleted from the database. The cutover is a code change plus new tables. |
| F2 | **Nothing stores a game ID.** No table, foreign key, booking, audit row, push or stats count refers to a game. Stats count rolls and Games page views for the whole app only (`roll_use`, `roll_pick`, `gotw_view`). | No references to migrate or orphan. A legacy-ID map isn't needed. |
| F3 | **There is one D1 database, the production one** (`rtd-app`, `6c948ad3-…`). There is no staging database. | Staging means a local D1 (`wrangler dev`, and the test suite's own database), plus a separate branch. New tables in production are additive, and the public pages switch over with one setting, which switches back as easily. |
| F4 | **R2 isn't enabled on the account.** Event photos live in Workers KV (`IMAGES`), described in `event_images`. | Covers go in the same KV namespace, under their own keys. No new service. |
| F5 | **There is no Game of the Week history and no Game of the Week notification.** | History starts at cutover. No duplicate alerts are possible. No GOTW push is added: Dan asked for automatic pushes to stay at one every 48 hours (event alerts). |
| F6 | **The source files weren't supplied.** `board_game_library_image_references.md`, `board_game_library_enriched.md` and the shelf photographs aren't in the repository or the environment. | Parsing, the manifest, the review register and the image audit are blocked until they're provided (§6). |
| F7 | **The source marks every profile as provisional** (per the brief). Without the photographs, there is no evidence on file that the café owns any given title. | No game can be published as confirmed on the source alone. Proposed evidence route: an admin confirms each title is on the shelf, recorded with their name and the date (§5). |
| F8 | **The service worker caches `/api/events` and `/api/occurrences` (network first) and hashed `/assets/` (cache first).** Game data is currently inside the JavaScript bundle. | Game endpoints are network-first, so a removed game disappears as soon as the phone is online. The hashed bundle changes with every deploy. |

## 2. Current architecture (what exists)

- **Hosting:** one Cloudflare Worker `rtd-app` (Hono API + the PWA from `web/dist`), deployed by Workers Builds on every push to `main` of `danatechstudio/App-The-Dice`. Builds for other branches upload a preview version without deploying it.
- **Data:** D1 `rtd-app`. Migrations `0001`–`0015` live; each was applied through the Cloudflare connector and recorded in `d1_migrations`.
- **Scheduled work:** one Cron Trigger, every minute (`src/index.ts`): event-alert sending, the 8pm automatic reminder, and the 03:23 UTC erasing job.
- **Auth:** Cloudflare Access proves the email; `users.role` decides (`host`, `staff` = approver, `admin`). `requireRole('staff')` admits admins too; admin-only checks use `user.role === 'admin'` on the server (`src/routes/staff.ts`).
- **Audit:** `audit_log`, append-only (database triggers refuse UPDATE and DELETE).

## 3. Every code path that touches games

| File | What it does with games |
| --- | --- |
| `web/src/data/preview-games.ts` | The 10 sample games, the GOTW constant, filter buckets (players 2 / 3–4 / 5–6 / 7+; time; style) |
| `web/src/pages/Roll.tsx` | Roll Me a Game: filters, client-side random pick, Chaos Roll, reveal card, "This One!" |
| `web/src/pages/Games.tsx` | The Games page: GOTW feature and the shelf list |
| `web/src/pages/Home.tsx` | `GameOfTheWeekMini` on the home page |
| `web/src/components/GameCard.tsx` | `GameFacts`, and the knight placeholder `GameArt` |
| `web/src/components/Dice.tsx`, `web/src/styles/roll.css` | The dice tray animation (reduced motion supported through `lib/motion.ts`) |
| `src/stats/stats.ts`, `web/src/lib/stats.ts` | Counts `roll_use`, `roll_pick`, `gotw_view` (app-wide, no game IDs) |
| `web/public/sw.js` | No game-specific caching today |

Nothing on the server (`src/`) reads or writes game data today.

## 4. Baseline for the integrity check (live, 15 Oct 2026)

Counts of the tables the change must not touch, to compare after cutover:

| Table | Rows | Table | Rows |
| --- | --- | --- | --- |
| events | 32 | audit_log | 146 |
| occurrences | 56 | alert_subscriptions | 0 |
| bookings | 0 | push_sends | 2 |
| host_sessions | 2 | push_subscriptions | 1 |
| users | 2 | stats_daily | 16 |
| applications | 1 | sync_runs | 987 |
| markets / market_applications | 0 / 0 | settings | 7 |
| event_images | 57 | outbox | 0 |

Last migration: `0015_stats.sql`.

## 5. Proposed design (additive)

**Tables** (migration `0016_game_library.sql`; nothing existing is altered):
- `games`: confirmed holdings only, with every field in the brief (edition-aware slug, category, audiences, age, players, play time, synopsis, verification status, chooser and GOTW flags, copies, cover and thumbnail keys, image source, attribution, rights and status, source title and evidence, ownership evidence). Retired games keep their row (`retired_at`), so history survives.
- `game_review`: uncertain, provisional and unverifiable entries, with their parsed metadata and the reasons they're held. Never public.
- `game_import_batches`: one row per dry run or import, with the source file's SHA-256 and counts.
- `gotw_weeks`: one row per week (`week_key`, primary key, so a week can't be picked twice), with the game and a snapshot of its title and cover.
- Changes to games are written to the existing `audit_log`.

**Ownership evidence (F7):** an entry moves from the review register into `games` only when an admin confirms it, with their name, the date and a note (such as "on the shelf, checked 16 Oct", or a photo reference). The importer never promotes anything on its own.

**Cutover as a switch (F3):** a setting `game_library_live`. While it's off, the public pages keep today's preview shelf, and admins import, review and add covers behind the scenes. Turning it on swaps every public game surface to the confirmed library at once. Turning it off swaps back. No delete-then-reseed, and no outage.

**Public behaviour:**
- **Roll and filters:** Quick Roll (no filters, or Chaos Roll) and Filtered Roll (party size, youngest age, audience, category, maximum time). The server picks, using the same rules that count the eligible games on screen. When nothing matches, the app says which filter to relax.
- **Game detail page:** the cover (or a branded placeholder), the facts, similar games, and alternatives, all from confirmed holdings only.
- **Game of the Week:** picked automatically each week (Europe/London), avoiding the last 12 weeks, falling back to the least recently featured game.

**Covers (F4):**
- **Storage:** KV, with a branded placeholder whenever a game has none.
- **Adding one:** admins attach a cover with its source, attribution and rights status; the browser makes the thumbnail.
- **Only after research:** an image found while researching is recorded with its rights status, and is only stored once its rights are approved. Search links in the source are never stored as image addresses.

## 6. Blocked: inputs needed from the operator

1. **The two source files:** `board_game_library_image_references.md` and `board_game_library_enriched.md`.
2. **The eight shelf photographs,** if available. Without them, every title waits in the review register for an admin to confirm (F7).
3. **Cover rights:** whether there's any existing permission (for example from publishers) for box art. Otherwise covers stay as placeholders until approved images are attached.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| The live catalogue is empty at cutover because nothing is confirmed yet | Don't turn `game_library_live` on until the review is done. The switch keeps the preview shelf until then. |
| Treating the source list as proof of ownership | The importer only fills the review register; only an admin's confirmation publishes a game. |
| Copyrighted box art | Placeholders by default; covers only with recorded rights. |
| A Game of the Week picked twice under concurrent runs | `week_key` primary key with `INSERT … ON CONFLICT DO NOTHING`. |
| Stale games offline | Network-first game endpoints, and the bundle hash changes on deploy. |
| Breaking unrelated features | No existing table changes. The full regression suite (279 tests) must pass, and the §4 counts are compared after cutover. |

## 8. Backup and rollback

- **Database:** nothing existing is changed or deleted. Before applying `0016`, record a D1 Time Travel bookmark (`npx wrangler d1 time-travel info rtd-app`). That restores to just before the migration if ever needed. Rolling back the migration otherwise means dropping only the new tables.
- **Code:** the work happens on the branch `game-library`. `main` (currently `5cb05c5`) stays deployable. After merging, `npx wrangler rollback` returns to the previous version.
- **Cutover:** `UPDATE settings SET value = 'off' WHERE key = 'game_library_live'` returns the public pages to the preview shelf instantly.
- **Preview data:** `preview-games.ts` stays in git history.

## 9. Approval checkpoint

There is no production game data to delete, so no destructive step is needed. Two production steps still wait for explicit approval:
1. **Applying migration `0016`** to the live database (additive).
2. **Turning `game_library_live` on** (the public switch), after the review register has been worked through.
