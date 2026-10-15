# Game Library: Completion Report

_15 October 2026. **Code deployed to production** (`main` at `c1a6584`) with the library switched **off**: the public app still shows the preview shelf. Catalogue parsed the same evening: 163 titles ready for review, none confirmed yet._

## Done (deployed, tested)

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
| Catalogue parser: the café's Markdown into the manifest, the same output every run; the source kept with it | `scripts/parse-game-catalogue.py`, `data/source/` |
| Confirming many titles at once: tick the ones on the shelf, one note for all of them; titles whose details are incomplete stay open | `src/games/admin.ts` `confirmReviews`, organiser **Review** |
| Deployment, cutover, rollback, manifest format | [GAME_LIBRARY_DEPLOYMENT.md](GAME_LIBRARY_DEPLOYMENT.md) |
| Image policy and coverage report | [GAME_LIBRARY_IMAGE_AUDIT.md](GAME_LIBRARY_IMAGE_AUDIT.md) |

**Tests:**
- **Suite:** 312 pass (was 279): 33 new in `test/games.test.ts`, and every existing test passes unchanged.
- **Covered:** parsing and validation, an import refused on any bad entry, dry run versus apply, re-runs not duplicating, admin edits kept, retiring only on request, admin-only access (hosts and approvers refused), the review register never being public, the switch, every filter rule (unknown age or time never counting as suitable), repeat avoidance, server-side roll and count agreeing, similar and alternative games only from the shelf, Game of the Week (week boundaries in BST, concurrent requests picking once, the 12-week window, the fallback, reselecting after a retirement, history, the Cron check, no push), cover rights gating, the bundled catalogue importing cleanly (163 for review, none confirmed, no errors), category names with apostrophes, and confirming several titles at once (one note, incomplete titles left open, refused if any were already decided).

**Checked in a browser (local, with test data):**
- **Preview mode:** a filtered roll, a game page, and the shelf with Game of the Week, at 390 and 1280 px.
- **Live mode:** the admin library, attaching a cover, confirming and rejecting review titles, and the dry run.
- **No horizontal scrolling.**

## Production (15 Oct 2026)

- **Database:** restore point `2026-10-15T21:25:56Z` noted, then migration `0016_game_library.sql` applied and recorded (`d1_migrations` id 16). Four tables, six indexes and two settings (`game_library_live` = `off`, `gotw_avoid_weeks` = `12`).
- **Code:** `game-library` merged into `main` (fast-forward to `c1a6584`). Tests (308) and typecheck passed before the push; Workers Builds deployed build `c1a65843e9dc`.
- **Checked live:**
  - `/version.json` gives build `c1a65843e9dc`.
  - `GET /api/games` gives `live: false` and the 10 preview games.
  - `GET /api/games/gotw` gives the preview pick (Carcassonne) and writes nothing.
  - Baseline counts unchanged: events 32, occurrences 56, bookings 0, users 2, applications 1, audit log 146, push sends 2, event images 57. Settings 9 (the 2 new ones). Game tables empty.
- **Not yet checked live:** the organiser's **Game library** (needs an admin signed in through Cloudflare Access).

## Counts

| | Count |
| --- | --- |
| Source profiles parsed | **127**, in 6 categories |
| Unconfirmed or obscured entries | **36** (plus 1 note: "Other partially obscured boxes", which needs a stocktake, not a title) |
| Confirmed holdings | **0**: the catalogue marks every profile provisional |
| For review, in the manifest | **163**: 127 with details (124 complete enough to confirm as they are; 3 have an open-ended player count) and 36 uncertain with no details. In the live review register once an admin runs the import. |
| Rejected | 0 |
| Covers verified | 0 |
| Legacy (preview) games in production | 10, served until the switch is turned on |
| Legacy game IDs stored anywhere | 0 (nothing referenced them) |

## Not done, and why

| Item | Status | Needed |
| --- | --- | --- |
| Parsing the catalogue; `data/game-library-master.json` and `data/game-library-review.json` | **Done** 15 Oct | One file was supplied, `board_game_library_image_references.md`. It holds the enriched catalogue and the image references together, so the second file isn't needed. |
| Checking holdings against the shelf photos | **Not needed** | Admins confirm what's on the shelf under **Review**, which records who and when. The photos would only have pre-filled evidence. |
| Researching covers | **Waiting** | Confirmed games first, then rights decisions. The catalogue has a search link per title and no verified image ([image audit](GAME_LIBRARY_IMAGE_AUDIT.md)). |
| Production: migration 0016 and merge | **Done** 15 Oct 2026 | See **Production** above |
| Production: import and review | **Waiting** | An admin: **Import → Dry run → Apply**, then **Review** ([deployment §2](GAME_LIBRARY_DEPLOYMENT.md#2-load-the-catalogue)) |
| Production: cutover | **Waiting** | Approval to switch on, once enough games are confirmed ([deployment §3](GAME_LIBRARY_DEPLOYMENT.md#3-cutover-put-the-library-live)) |
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
- **Reading the catalogue:**
  - **Titles kept whole:** "Monopoly: Star Wars Saga Edition" stays one title, with no edition split off, so nothing is misread. An admin can set an edition when confirming.
  - **Categories:** the catalogue's own six (Classic & Family; Modern Strategy & Hobby; Party, Trivia & Social; Children's & Educational; Word, Dexterity & Quick Play; Fantasy, Licensed & Specialist).
  - **Audiences:** the catalogue's Children, Family, Adult, Party and Strategy map to the app's five. Its other labels (Teen, Fans, Trivia, Cooperative and so on) describe the game rather than who it suits, so they stay on the entry as `source_audience`, for reference. One title, Solitaire, has none of the five.
  - **Players "1+" or "2+":** no maximum is invented. Those three titles need one before they're confirmed.
  - **Uncertain entries** have no details, as the catalogue says. They're confirmed one at a time once the box is identified.
- **Confirming many at once:** ticking titles uses the catalogue's details as they are, with one note for all of them ("Stocktake, 16 Oct"). Each still gets its own record and audit entry.

## Operator actions

1. ~~Supply the source files.~~ Done 15 Oct. The shelf photos are no longer needed.
2. ~~Approve applying migration 0016 and merging the branch (deployment §1).~~ Done 15 Oct 2026.
3. In the organiser: **Game library → Import → Dry run**, then **Apply**. Then work through **Review**: tick what's on the shelf and **Confirm ticked**, and reject what isn't. Add covers where rights allow.
4. Approve turning the library live (deployment §3).
