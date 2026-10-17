# Organiser hub: sections with outstanding work (design)

_2026-10-17. Agreed with the owner in chat: grouping, approach A, part 1 (structure and navigation). This document adds the counts, links, errors and testing._

## Why

The staff side of `/organise` is 20 panels on one page. The owner (admin) and Michelle (approver) need to see at a glance what's waiting, and where, without scrolling, mostly on phones at the café.

**Success:** opening `/organise` shows within seconds which sections have work waiting and how much; one tap opens that section.

**Not changing:** what any panel does, the host view, the server's permission checks, the public app.

## Structure

### The hub: `/organise` (approvers and admins)

- **Top:** the welcome and the notifications-on-this-device card, as now.
- **A card per section**, in this order: To approve, Needs attention, Events & dates, Bookings, People, Café content (admins), Stats (admins).
- **Each card:** the section name, a large count of what's waiting, and a line saying what it is ("2 join requests · 1 session"). Nothing waiting: "All clear", in a quiet style.
- **Ordering:** cards with something waiting get the accent and move to the top, in the order above; clear cards follow in the same order.
- **Layout:** full width and stacked on phones; two or three across on wider screens.
- **Hosts** keep exactly what they see today. The hub is only for approvers and admins.

### Section pages: `/organise/<section>`

| Section | Path | Panels (unchanged, in this order) | Who |
| --- | --- | --- | --- |
| To approve | `/organise/approve` | Join requests; Sessions awaiting approval; Changes to approve; Market applications | Approvers, admins |
| Needs attention | `/organise/attention` | Needs attention; Delivery | Approvers, admins |
| Events & dates | `/organise/events` | Dates in the app; Booking for café events; Logic Engine changes (admins) | Approvers, admins |
| Bookings | `/organise/bookings` | Bookings coming up | Approvers, admins |
| People | `/organise/people` | Hosts; Approvers (admins) | Approvers, admins |
| Café content | `/organise/content` | Food & drinks menu; Game library; Markets; Event reminders | Admins |
| Stats | `/organise/stats` | Stats | Admins |

- **Header on each:** a "← Organiser" link back to the hub, the section title, and its count.
- **After a change** in a section (approving, resolving, retrying), its count and the hub's update without a reload: the section re-asks for the summary when a panel reports a change.
- **A section that isn't theirs** (Michelle opening `/organise/stats`): "This section is for admins" with a link back to the hub. The server already refuses the data.
- **Unknown section** (`/organise/nonsense`): the app's not-found page.

## Counts: one summary call

**`GET /api/staff/summary`** (approvers and admins; the same sign-in and role check as the rest of `/api/staff`). It works every count out in one go, with only the sections the caller's role allows, and reads only: it never sends emails or changes anything.

```json
{
  "sections": {
    "approve":   { "count": 3, "parts": { "join_requests": 2, "sessions": 1, "changes": 0, "market_applications": 0 } },
    "attention": { "count": 2, "parts": { "open_items": 1, "failed_deliveries": 1 } },
    "events":    { "count": 0, "parts": { "sheet_edit_problems": 0 } },
    "bookings":  { "count": 0, "info": { "booked_dates_7_days": 4 } },
    "people":    { "count": 0 },
    "content":   { "count": 1, "parts": { "menu_sheet_problem": 1, "games_to_review": 0 } },
    "stats":     { "count": 0 }
  }
}
```

`content` and `stats` are left out for approvers, and so is `events.parts.sheet_edit_problems`, which counts towards `events.count` for admins only.

| Count | What it counts (the same rule its panel uses) |
| --- | --- |
| `join_requests` | Join requests with status `pending` |
| `sessions` | Host sessions with status `submitted` |
| `changes` | Host change requests with status `pending` |
| `market_applications` | Market applications with status `pending` |
| `open_items` | Needs attention items with status `open` |
| `failed_deliveries` | Emails and booking pushes from the last 7 days that were given up on (`dead_at` set) and not sent since: the Delivery panel's "failed" |
| `sheet_edit_problems` | Logic Engine changes with status `conflict` or `dead` (admins) |
| `menu_sheet_problem` | 1 when the latest copy of the RTD Food Menu sheet was refused (`food_menu_sync.ok` false), else 0 |
| `games_to_review` | Game library review items with status `open` |
| `booked_dates_7_days` | Information only, never counted as waiting: dates in the next 7 days with at least one booking |

Each section's `count` is the sum of its `parts`. The hub's line is built from the non-zero parts ("2 join requests · 1 session").

**Needs attention freshness:** the panel brings its list up to date when it opens; the summary reads what's stored, which the app keeps up to date on its regular runs. If the two ever differ, opening the section settles it, and the hub updates when you come back.

## Links into sections

**New links** in emails and pushes go to section pages: `/organise/approve`, `/organise/attention`, and so on.

**Old links** already sent (`/organise#awaiting`, `#join-requests`, `#changes`, `#market-applications`, `#attention`) must keep working. The hub sees the hash and moves to the right section, keeping the hash, so the page still scrolls to the panel:

| Old link | Goes to |
| --- | --- |
| `/organise#join-requests`, `#awaiting`, `#changes`, `#market-applications` | `/organise/approve` + the same hash |
| `/organise#attention` | `/organise/attention#attention` |

A host following one of these links stays on their own view, as now.

## Errors

- **The summary call fails:** the hub still shows every card, without counts, and a small "Couldn't load what's waiting. Try again" with a retry button. Sections still open and work.
- **A panel fails inside a section:** exactly as today; the panel shows its own error.
- **Slow connection:** the cards appear at once with a loading shimmer where the count goes.

## Code shape

- **Server:** `src/staff/summary.ts`, with a `staffSummary(db, user, now)` function that runs the counts as one batch of small `COUNT` queries; `GET /summary` in `src/routes/staff.ts`.
- **Web:**
  - `web/src/pages/OrganiseHub.tsx` (the cards);
  - `web/src/pages/OrganiseSection.tsx` (the header, the role check, and the panels per section, from one table);
  - `web/src/lib/staffSummary.ts` (the fetch, and refresh after changes).
  - `StaffDesk` in `Organise.tsx` is replaced by these.
  - The app routes `/organise/:section` to the organiser.
  - Panels move, not change. The panels that share data today (sessions, hosts and markets loaded by `StaffDesk`) load it in the section that needs it.
- **Emails and pushes:** their `/organise#…` links become section paths.

## Testing

- **Server:** the summary's counts for each part, from seeded data; approvers don't get `content`, `stats` or the sheet-edit count; hosts and signed-out callers are refused; it changes nothing in the database.
- **Links:** the old hash links reach the right section.
- **Screens:** Playwright at 390px and 1280px, for an admin and an approver:
  - the hub with work waiting, and all clear;
  - each section;
  - the "for admins" page;
  - the summary failing.

  No horizontal scroll, no console errors, and tap targets of at least 40px.
- **Regression:** the existing test suite stays green.

## Rollout

No database change. Merge, then check on the live app as an admin and as an approver. Rollback is reverting the merge.
