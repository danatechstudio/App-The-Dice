# Game Library: Cover Image Audit

_Status, 15 October 2026: **no covers sourced yet.** There are no confirmed games to source covers for: the source catalogue hasn't been supplied ([GAME_LIBRARY_AUDIT.md §6](GAME_LIBRARY_AUDIT.md#6-blocked-inputs-needed-from-the-operator))._

## Coverage report

| Status | Games |
| --- | --- |
| Verified and usable (matched to the café's edition, rights approved) | 0 |
| Matched, rights pending | 0 |
| Missing (placeholder shown) | 0 |
| Rejected | 0 |

This table is filled in per game below once there are confirmed games.

## Per-game record

| Game (edition) | Source page | Attribution | Rights | Matches edition | Checked | Status |
| --- | --- | --- | --- | --- | --- | --- |
| _none yet_ | | | | | | |

The live record is the `games` table (`image_source_url`, `image_attribution`, `image_rights_status`, `image_status`, `image_checked_at`). The organiser's Game library shows the gaps: **Library → Show: No cover** and **Cover not approved**.

## How covers are handled

- **Placeholder by default:** every game without an approved cover shows the RTD placeholder (the knight from the logo). A missing cover never keeps a confirmed game out of the library.
- **Shown only when both are true:**
  - **Matches the edition:** an admin has checked the image is the café's edition (title, edition, language).
  - **Rights approved:** reuse is permitted (publisher permission, a press kit that allows it, or a licence).

  Until both are true the cover is stored but not shown; the public API never returns its address.
- **What's recorded for each cover:** the page it came from, the credit, the rights status, whether it matches, and the date checked. The credit shows under the cover on the game's page.
- **Stored in the app, not hotlinked:** the browser resizes the image (800 px cover, 320 px thumbnail, JPEG) and the Worker stores it in KV, content-addressed. No third-party host is involved when someone views a page, so an outside site going down can't break the app.
- **Never stored as an image address:**
  - **Search links:** the source catalogue's image lookups are search pages, used only to find the product.
  - **BoardGameGeek images:** BGG hosts images uploaded by its users. A BGG page can confirm which box is which, but it doesn't grant reuse, so a BGG image stays "rights pending" until permission is recorded.
- **Lazy loading:** thumbnails on the shelf and game pages load lazily. Each cover has alt text ("Box cover of <title>") and fixed dimensions, so the page doesn't jump.

## Suggested sourcing route, in order

1. **The publisher's own product page or press kit.** Many publishers allow retailers and cafés to use box art to promote their games. Record the permission (a page or an email) as "approved".
2. **The UK distributor's product page** (for example Asmodee UK), with the same check.
3. **Photograph the café's own box.** This is always permitted and always the right edition. Upload it with the source "Photo of the café's copy".
4. **Otherwise:** placeholder, with the rights left as "pending" or "unknown".
