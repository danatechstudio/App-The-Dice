# Game Library: Completion Report

_15 October 2026. Branch `game-library`. **Not deployed to production.**_

## Done (on the branch, tested)

| Part | Where |
| --- | --- |
| Pre-change audit, with the live baseline counts | [GAME_LIBRARY_AUDIT.md](GAME_LIBRARY_AUDIT.md) |
| Additive migration (`games`, `game_review`, `game_import_batches`, `gotw_weeks`, two settings) | `migrations/0016_game_library.sql` |
| Validated, idempotent importer: dry run, then explicit apply in one transaction; never overwrites admin edits; only retires imported games, and only when asked | `src/games/admin.ts` |
| Review register: titles go live only when an admin confirms the café owns them, with their evidence recorded | `src/games/admin.ts`, organiser **Review** |
| Public API: shelf, eligible count with "loosen" hints, server-side roll that avoids repeats, game pages with similar games and alternatives | `src/routes/games.ts`, `src/games/chooser.ts` |
| Roll Me a Game: Quick (no filters) and Chaos rolls; filters for party size, youngest age, time, audience (any of) and category (any of); filters remembered | `web/src/pages/Roll.tsx` |
| Game pages with similar games (labelled) and alternatives that keep to the filters | `web/src/pages/GamePage.tsx` |
| Games page: Game of the Week, searchable shelf with category filter, lazy thumbnails | `web/src/pages/Games.tsx` |
| Game of the Week: weekly (Monday, London), avoids 12 weeks, least-recent fallback, one row per week, snapshots, hourly Cron check, no notification | `src/games/gotw.ts` |
| Admin Game library: search and filter, add, edit, retire and restore; covers with source, credit and rights; review; import; the live switch | `web/src/pages/OrganiseGames.tsx` |
| Covers stored in KV; shown only when matched and rights-approved; RTD placeholder otherwise | `src/games/admin.ts`, `/images/games/:id` |
| Cutover by switch, with the preview shelf kept until then | `settings.game_library_live` |
| Deployment, cutover, rollback, manifest format | [GAME_LIBRARY_DEPLOYMENT.md](GAME_LIBRARY_DEPLOYMENT.md) |
| Image policy and coverage report | [GAME_LIBRARY_IMAGE_AUDIT.md](GAME_LIBRARY_IMAGE_AUDIT.md) |

**Tests:**
- **Suite:** 308 pass (was 279): 29 new in `test/games.test.ts`, and every existing test passes unchanged.
- **Covered:** parsing and validation, an import refused on any bad entry, dry run versus apply, re-runs not duplicating, admin edits kept, retiring only on request, admin-only access (hosts and approvers refused), the review register never being public, the switch, every filter rule (unknown age or time never counting as suitable), repeat avoidance, server-side roll and count agreeing, similar and alternative games only from the shelf, Game of the Week (week boundaries in BST, concurrent requests picking once, the 12-week window, the fallback, reselecting after a retirement, history, the Cron check, no push), and cover rights gating.

**Checked in a browser (local, with test data):**
- **Preview mode:** a filtered roll, a game page, and the shelf with Game of the Week, at 390 and 1280 px.
- **Live mode:** the admin library, attaching a cover, confirming and rejecting review titles, and the dry run.
- **No horizontal scrolling.**

## Counts

| | Count |
| --- | --- |
| Source profiles parsed | **0** (source not supplied) |
| Confirmed holdings | 0 |
| In the review register | 0 |
| Rejected | 0 |
| Covers verified | 0 |
| Legacy (preview) games in production | 10, served until the switch is turned on |
| Legacy game IDs stored anywhere | 0 (nothing referenced them) |

## Not done, and why

| Item | Status | Needed |
| --- | --- | --- |
| Parsing the catalogue; `data/game-library-master.json` and `data/game-library-review.json` | **Blocked** | The two Markdown files. The data files exist, marked `awaiting-source`. |
| Checking holdings against the shelf photos | **Blocked** | The photos. Without them, titles wait for an admin to confirm. |
| Researching covers | **Blocked** | Confirmed games first, then rights decisions ([image audit](GAME_LIBRARY_IMAGE_AUDIT.md)). |
| Production: migration 0016, merge, import, cutover | **Not started**: waiting for approval | [GAME_LIBRARY_DEPLOYMENT.md](GAME_LIBRARY_DEPLOYMENT.md) |
| Deleting the preview shelf code (`src/games/preview.ts`) | After cutover is stable | One small follow-up |

## Decisions taken (change any of them)

- **Ownership evidence:**
  - **Why:** the source marks every profile provisional.
  - **What's decided:** a title is published only when an admin confirms it with a note, or when the manifest records photo evidence for it.
- **Filters:**
  - **How they combine:** the audience and category filters match any selected value, and different filters combine.
  - **Play time:** judged by the game's longest estimate.
  - **Unknown details:** a game with an unknown age or play time doesn't match a filter on that detail.
- **No Game of the Week notification,** to keep automatic pushes within the one-per-48-hours rule set for event alerts.
- **Chaos Roll stays as the Quick Roll** (it ignores filters). The main button rolls with whatever filters are set, so with none set it's a Quick Roll too.
- **Covers are stored in KV,** because R2 isn't enabled on the account.

## Operator actions

1. Supply the two source files and the shelf photos.
2. Approve applying migration 0016 and merging the branch (deployment §1).
3. After the import, work through **Review**, and add covers where rights allow.
4. Approve turning the library live (deployment §3).
