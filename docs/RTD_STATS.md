# RTD Stats

The app counts how it's used, and admins see the numbers in the organiser under **Stats**. Counts are daily totals with nothing about who: no network address, device ID or cookie.

## Status (2026-10-08)

| Part | State |
| --- | --- |
| Counting page views and taps (daily totals) | **Built** |
| **Stats** in the organiser, for admins | **Built** |
| Bookings, join requests, stall applications and reminders, from their own records | **Built** |
| Taps on event reminders, per reminder ("tapped" under **Latest reminders**) | **Built** |
| The privacy notice says so | **Built** |

## What admins see

In the organiser, admins see **Stats**, above **Event reminders**. Choose **7 days**, **30 days** or **90 days** (today included). Everything compares with the same number of days before.

| Part | Shows |
| --- | --- |
| **Headline numbers** | Event page views, bookings (and places), opens from the Home Screen, visits in a browser, installs, event alerts on now. Each with the change from the period before. |
| **Event page views per day** | A column for each day (each week for 90 days). Hover or tap a column for its number; **Show as a table** lists them all. |
| **Most viewed, most booked, most tapped** | The top 5 events for each. "Tapped" adds up the book, Add to calendar and Share buttons. |
| **Every event** | Views, book taps, bookings (places), bookings per view, Add to calendar, shares and reminder taps, for every event with any of them in the period. Two events with the same name get their day or date added: "Home Education Support Club (Mondays)". |
| **Around the app** | Diary, Book, Games and Markets page views, Roll Me a Game rolls and "This One!" picks, Become a host page views and Apply to host taps, join requests, stall applications, and event reminders sent, reached and tapped. |

**Who can see it:** admins only. Approvers and hosts don't see the section, and the server refuses them.

## What's counted

**Counted by the page** (`web/src/lib/stats.ts`), then sent in small batches:

| Count | When |
| --- | --- |
| `app_open` | The app opens in a browser |
| `home_screen_open` | The app opens from the Home Screen (installed) |
| `install` | The browser says the app was installed. Android, and Chrome or Edge on a computer; **iPhone doesn't say**, so use Home Screen opens instead. |
| `event_view` | An event page is shown (per event) |
| `book_tap` | The book button is pressed (per event), including ones the form turned back |
| `calendar_tap` | **Add to calendar**, either kind (per event) |
| `share_tap` | **Share** (per event) |
| `reminder_open` | An event reminder notification is tapped (per event, and per reminder). Counted by the service worker. |
| `diary_view`, `book_page_view`, `gotw_view`, `host_page_view`, `markets_view` | Those pages are shown (`gotw_view` is the Games page, which leads with Game of the Week) |
| `roll_use`, `roll_pick` | Roll Me a Game: a roll, and "This One!" |
| `host_apply_tap` | **Apply to host** |

**Counted by the server:** `alerts_on` (a device turns event alerts on for the first time) and `alerts_off`.

**From their own records, not counted:**
- **Bookings and places:** from `bookings`, by when they were made, so they include everything since bookings began.
- **Join requests:** from `applications`.
- **Stall applications:** from `market_applications`.
- **Reminders sent and reached:** from `push_sends`.

**Not counted:**
- **People signed in to the organiser** (the café team and hosts), so their own checking doesn't count. The server sees Cloudflare Access's sign-in cookie.
- **Robots:** search engines, link previews and automated browsers.
- **Anything over the limits:** a request carries at most 10 counts. One network address can add at most 60 a minute; that limit is kept in the Worker's memory only, never stored.

## How to read the numbers

- **Views, not people.** Without an ID, the app can't tell one person viewing twice from two people. Treat them as how much interest there is, not how many people.
- **Installs undercount:** iPhone never reports one. Opens from the Home Screen are the better sign that people use the installed app.
- **Bookings per view** is bookings divided by views. Views started being counted on the day stats went live (the screen says "Counting since…"), while bookings go back further. So early on, an event can have bookings with few or no views.
- **Someone could inflate a count** by sending made-up requests. The limits make that slow, and the numbers are for spotting trends, not for anything that matters more.

## How it works

- **Endpoint:** `POST /api/stats`, same-origin JSON, no account. Body: `{ hits: [{ m: metric, e?: Event ID, s?: reminder }] }`. Always answers `204`, so a page never waits on it.
- **Checked:**
  - **Unknown counts are ignored.** So are the server's own counts (`alerts_on`, `alerts_off`) if a page sends them.
  - **Per-event counts** need an Event ID that exists.
  - **A reminder tap** (`s`) also adds to that reminder's `opened`, if the event matches.
- **Stored:** `stats_daily`: one row per London day, count and event, holding the total. Nothing else.
- **Sending:** the page batches counts for up to 3 seconds, or until it has 10. It also sends them when the page is hidden or closed (`keepalive`).
- **For admins:** `GET /api/staff/stats?days=7|30|90` (`src/stats/stats.ts`, `statsOverview`).

## Data and privacy

Migration `0015_stats.sql`: the table `stats_daily`, and the column `push_sends.opened`. See [RTD_DATABASE_SCHEMA.md](RTD_DATABASE_SCHEMA.md#stats).

- **Nothing personal:** a row is a day, a count's name, an event and a number.
- **Kept for good:** the totals hold nothing about anyone.
- **The privacy notice** has a **Counting visits** section saying all this, and the app still sets no tracking cookies.

## Checks

```sql
-- Today's counts
SELECT metric, event_id, count FROM stats_daily WHERE day = date('now') ORDER BY count DESC;
-- Most viewed events, last 30 days
SELECT s.event_id, e.display_name, SUM(s.count) AS views FROM stats_daily s JOIN events e ON e.event_id = s.event_id
WHERE s.metric = 'event_view' AND s.day >= date('now', '-29 days') GROUP BY s.event_id ORDER BY views DESC LIMIT 10;
```
