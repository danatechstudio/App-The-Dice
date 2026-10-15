# Game Library: Deployment, Cutover and Rollback

The work is on the branch `game-library` of `danatechstudio/App-The-Dice`. Nothing reaches production until the steps below are taken. The production steps that need explicit approval are marked **(approval)**.

## 1. Ship the code (the public app doesn't change)

1. **Bookmark the database** (lets it be restored to this moment):
   ```sh
   npx wrangler d1 time-travel info rtd-app
   ```
   Note the bookmark it prints.
2. **(approval) Apply migration `0016_game_library.sql` to the live database.** It only adds tables, and two settings with the switch **off**. Then record it:
   ```sql
   INSERT INTO d1_migrations (id, name, applied_at) VALUES (16, '0016_game_library.sql', '<UTC time>');
   ```
3. **Merge `game-library` into `main`.** Workers Builds runs the tests, then deploys.
4. **Check:**
   - `GET /api/games` answers `{"live": false, …}` with the 10 preview games. The public app looks as it does now, with the preview shelf served by the API.
   - `/roll`, `/games`, a game page (for example `/games/carcassonne`) and the home page's Game of the Week all work.
   - In the organiser, admins see **Game library**.
   - The [§4 baseline counts](GAME_LIBRARY_AUDIT.md#4-baseline-for-the-integrity-check-live-15-oct-2026) of the other tables are unchanged.

## 2. Load the catalogue

1. **Supply the source files** (the two Markdown files and the shelf photos). Claude parses them into:
   - `data/game-library-master.json`: confirmed holdings, each with its ownership evidence.
   - `data/game-library-review.json`: everything else, with the reasons it's held.
   The manifest format is below. Once committed and deployed, the organiser's **Import** tab shows its counts.
2. **Dry run:** **Game library → Import → Dry run** shows what would be added, updated, kept or flagged, and any errors. An import with errors can't be applied.
3. **(approval) Apply import:** confirm the prompt. It's one transaction, and safe to repeat (`game_import_batches` logs each run).
4. **Review:** under **Review**, confirm each title that's on the shelf, saying how you know ("On the shelf, checked 16 Oct"), or reject it. Each decision goes in the audit log.
5. **Covers:** **Library → Cover** for each game, following [GAME_LIBRARY_IMAGE_AUDIT.md](GAME_LIBRARY_IMAGE_AUDIT.md). Optional: placeholders work.

## 3. Cutover: put the library live

1. **(approval) Game library → Import → Put the library live.** It refuses until at least one confirmed game is in Roll Me a Game.
2. **What changes at once:** Roll Me a Game, the Games page, game pages and Game of the Week switch to the confirmed library. The first Game of the Week is picked on the first visit, or by the hourly Cron check. No notification is sent.
3. **Check:**
   - `GET /api/games` gives `live: true`, only confirmed titles, and none with `preview`.
   - A roll with filters, a game page, the Games page and Game of the Week all work.
   - `SELECT * FROM gotw_weeks` shows one row.
   - The other tables' counts are unchanged (audit §4).
4. **Phones:** a phone that's online gets the new shelf straight away (game endpoints are network-first). An offline phone shows its last copy until it reconnects.

## Rollback

| What | How |
| --- | --- |
| Public pages, at any time | **Back to the preview shelf** in the Import tab, or `UPDATE settings SET value = 'off' WHERE key = 'game_library_live'`. Instant; nothing is deleted. |
| A bad import | Retire the games it added (Library → Retire), or restore D1 to the bookmark from step 1 with `npx wrangler d1 time-travel restore rtd-app --bookmark=<bookmark>`. That also undoes everything else since, so prefer retiring. |
| The code | `npx wrangler rollback` to the previous version. Then turn the switch off first, or leave it: the older code ignores the game tables. |
| The migration | Not needed: the new tables are unused by older code. To remove them: `DROP TABLE gotw_weeks; DROP TABLE game_import_batches; DROP TABLE game_review; DROP TABLE games; DELETE FROM settings WHERE key IN ('game_library_live', 'gotw_avoid_weeks'); DELETE FROM d1_migrations WHERE id = 16;` |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "Put the library live" refuses | No confirmed game has **In Roll Me a Game** set to Yes. |
| A game is on the shelf but never rolled | Its **In Roll Me a Game** is No, or it lacks the age or play time a filter needs (games with unknown details only appear when those filters are off). |
| No Game of the Week | No confirmed game can be featured: **Can be Game of the Week** is No for all, or their synopses are under 20 characters. |
| A cover doesn't show | Its rights aren't **Approved**, or **Matches the café's edition** isn't Yes. |
| An import "can't be applied" | Read the errors in the dry run: each names the game and the problem. |

## Manifest format (`rtd-game-library/1`)

`data/game-library-master.json`, confirmed holdings:

```json
{
  "format": "rtd-game-library/1",
  "status": "ready",
  "sources": [{ "name": "board_game_library_image_references.md", "sha256": "…" }],
  "games": [
    {
      "title": "Ticket to Ride", "edition": "Europe", "category": "Strategy",
      "audiences": ["Family", "Strategy"], "min_age": 8,
      "min_players": 2, "max_players": 5, "play_time_min": 30, "play_time_max": 60,
      "synopsis": "Two or three short sentences.",
      "source_title": "Ticket to Ride: Europe", "source_evidence": "Profile 42; shelf photo 3",
      "ownership_evidence": "Shelf photo 3, second row",
      "image_lookup": "https://… (search link: discovery only)"
    }
  ]
}
```

`data/game-library-review.json`, held back:

```json
{
  "format": "rtd-game-library/1",
  "status": "ready",
  "sources": […],
  "entries": [
    { "title": "…", "kind": "provisional", "reasons": ["Listed in the catalogue, not seen in a photo"], "category": "…", "synopsis": "…" },
    { "title": "Unknown red box (photo 5)", "kind": "uncertain", "reasons": ["Spine unreadable"] }
  ]
}
```

**Rules the importer enforces:**
- **Audiences:** from `Children, Family, Adults, Party, Strategy`.
- **Categories:** written in Title Case.
- **Ranges:** players 1–100, age 0–21, minutes 1–720, and minimum ≤ maximum.
- **Publishing a game needs:** the title, the category, a synopsis of at least 20 characters, the players, the minimum age, the longest play time, and the ownership evidence.
- **Matching:** each game is matched by its normalised title and edition, so running the import again never duplicates.
