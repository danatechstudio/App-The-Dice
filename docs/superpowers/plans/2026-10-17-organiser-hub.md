# Organiser Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the organiser's single long staff page with a hub of section cards showing outstanding counts, each opening its own page.

**Architecture:** A read-only `GET /api/staff/summary` works out every count in one D1 batch, filtered by role. The web app routes `/organise/:section` to the organiser. `OrganiseHub` shows cards from the summary; `OrganiseSection` renders the existing panels for one section from a single table. A successful POST through `hostApi` refreshes the summary, so the counts follow every change without touching the panels.

**Tech Stack:** Cloudflare Worker (Hono, D1), Preact PWA, Vitest with `@cloudflare/vitest-pool-workers`, Playwright for screenshots.

**Spec:** `docs/superpowers/specs/2026-10-17-organiser-hub-design.md`

## Global Constraints

- **Paths:** sections are exactly `approve`, `attention`, `events`, `bookings`, `people`, `content`, `stats`.
- **Admins only:** `content` and `stats`, and the `sheet_edit_problems` part of `events`.
- **The summary changes nothing:** no inserts, updates, emails or attention refresh.
- **Old links still work:** `/organise#join-requests`, `#awaiting`, `#changes` and `#market-applications` go to `/organise/approve` with the same hash; `/organise#attention` goes to `/organise/attention#attention`.
- **Hosts:** see exactly what they see today.
- **Copy:**
  - nothing waiting: "All clear";
  - the summary fails: "Couldn't load what's waiting." with a "Try again" button;
  - the wrong role: "This section is for admins.";
  - the back link: "← Organiser".
- **No database change.** Tap targets at least 40px. No horizontal scroll at 320px.

## Review Focus

1. **A host opens `/organise/approve`** (an old push link, or a guess): they get their own host view, not an error. Test in Task 3.
2. **Counts disagree with the panel:** each count uses the panel's own rule. For example, `failed_deliveries` excludes devices that are gone, like `NOT_GONE` in `src/notify/delivery.ts`. Tests in Task 1.
3. **Attention switched off** (`enabled()` false): `open_items` is 0, not the stale rows. Test in Task 1.
4. **A hash link on a slow phone:** the panel loads after the first render, so the scroll must wait for its element. Covered in Task 3 (retry until the element exists, for up to 5 seconds).
5. **An approver sees an admin-only part in a shared section:** Events shows no Logic Engine panel and no sheet-edit count for approvers. Tests in Task 1 (server) and Task 4 (screens).

---

### Task 1: The summary endpoint

**Files:**
- Create: `src/staff/summary.ts`
- Modify: `src/routes/staff.ts` (add `GET /summary` beside `/me`)
- Test: `test/summary.test.ts`

**Interfaces:**
- Produces:
  - `staffSummary(db: D1Database, user: AuthUser, now: Date): Promise<StaffSummary>`
  - `type SectionKey = 'approve' | 'attention' | 'events' | 'bookings' | 'people' | 'content' | 'stats'`
  - `interface SectionSummary { count: number; parts?: Record<string, number>; info?: Record<string, number> }`
  - `interface StaffSummary { sections: Partial<Record<SectionKey, SectionSummary>> }`
  - `GET /api/staff/summary` returns `StaffSummary` with `Cache-Control: no-store`.

- [ ] **Step 1: Write the failing tests** in `test/summary.test.ts`. Seed users the way `test/onboarding.test.ts` does: Dan admin, Michelle staff, Sam host, with `DEV_AUTH_EMAIL`. Tests:
  - `refuses signed-out callers and hosts`: 401 without auth, 403 for Sam.
  - `an approver gets five sections, an admin seven`: Michelle's keys are `['approve','attention','events','bookings','people']`; Dan's add `content` and `stats`. Michelle's `events.parts` has no `sheet_edit_problems`.
  - `all clear on an empty database`: every `count` is 0.
  - `counts what waits for a decision`:
    - seed 2 `applications` pending and 1 declined;
    - 1 `host_sessions` submitted and 1 approved;
    - 1 `event_change_requests` pending;
    - 1 `market_applications` pending.

    Expect `approve` to be `{ count: 5, parts: { join_requests: 2, sessions: 1, changes: 1, market_applications: 1 } }`.
  - `counts open attention items only while attention is on`:
    - seed 1 open item and 1 resolved;
    - with attention on, `open_items` is 1;
    - with the attention setting off, it's 0.
  - `counts given-up emails and pushes from the last 7 days`:
    - outbox: one with `dead_at` 2 days ago, one with `dead_at` 9 days ago, one sent;
    - push_outbox: one dead 1 day ago with `last_status` 500, one dead with `last_status` 410.

    Expect `failed_deliveries` to be 2.
  - `admin-only problems`:
    - `sheet_edits`: one `conflict`, one `dead`, one `queued`, so `sheet_edit_problems` is 2;
    - `food_menu_sync` = `{"ok":false,...}`, so `menu_sheet_problem` is 1;
    - 1 open `game_review`, so `games_to_review` is 1;
    - expect `content.count` to be 2.
  - `booked dates are information, not waiting`: a confirmed booking on a scheduled date 3 days ahead and one 10 days ahead give `bookings` = `{ count: 0, info: { booked_dates_7_days: 1 } }`.
  - `changes nothing`: `SELECT COUNT(*)` of `audit_log`, `outbox` and `attention_items`, and the max `updated_at` in `settings`, are equal before and after a call.
- [ ] **Step 2: Run** `npx vitest run test/summary.test.ts`. Expected: FAIL, 404 on `/api/staff/summary`.
- [ ] **Step 3: Implement `staffSummary`.** Use one `db.batch` of `SELECT COUNT(*)` queries, using the existing `enabled()` from `src/attention/attention.ts` and `londonDate`/`addDays` for the 7-day window. Leave out the admin-only sections and parts when `user.role !== 'admin'`. Each `count` is the sum of `parts`; `bookings.count` is always 0. Add the route: `staffRoutes.get('/summary', async c => c.json(await staffSummary(c.env.DB, c.get('user'), new Date()), 200, { 'Cache-Control': 'no-store' }))`.
- [ ] **Step 4: Run** `npx vitest run test/summary.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Organiser summary: outstanding counts per section".

### Task 2: Links go to section pages

**Files:**
- Modify: `src/notify/push.ts:287-308`, `src/attention/reminders.ts:73`, `src/notify/emails.ts:229`, `src/markets/markets.ts:451,646`, `src/host/changes.ts:476`
- Test: update `test/push.test.ts:126,156`, `test/reminders.test.ts:86`, `test/markets.test.ts:315`

**Interfaces:**
- Produces: new links `/organise/approve#awaiting`, `/organise/approve#changes`, `/organise/approve#join-requests`, `/organise/approve#market-applications`, `/organise/attention#attention`.

- [ ] **Step 1: Change the four tests' expected URLs** to the new paths, for example `'/organise/approve#awaiting'` and `'https://rtd.test/organise/attention#attention'`.
- [ ] **Step 2: Run** `npx vitest run test/push.test.ts test/reminders.test.ts test/markets.test.ts`. Expected: FAIL on the old URLs.
- [ ] **Step 3: Replace** each `/organise#x` in the six source lines with its section path and the same hash.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `grep -rn "organise#" src` returns nothing.
- [ ] **Step 5: Commit** with the message "Emails and pushes link to organiser sections".

### Task 3: Hub, sections and routing (web)

**Files:**
- Create: `web/src/lib/staffSummary.ts`, `web/src/pages/OrganiseHub.tsx`, `web/src/pages/OrganiseSection.tsx`
- Modify:
  - `web/src/lib/hostApi.ts` (refresh the summary after a successful POST);
  - `web/src/pages/Organise.tsx` (replace `StaffDesk`; export `ReviewCard` and `HostsPanel` for the sections; accept a `section` prop);
  - `web/src/app.tsx` (route `/organise/:section`);
  - `web/src/styles/pages.css` (the hub grid and cards).

**Interfaces:**
- Consumes: `GET /api/staff/summary` → `StaffSummary` (Task 1).
- Produces:
  - `useStaffSummary(): { data: StaffSummary | null; error: boolean; reload: () => void }` and `refreshStaffSummary(): void` in `web/src/lib/staffSummary.ts`. It's a module-level store, so the hub and the section share one copy.
  - `SECTIONS: { key: SectionKey; title: string; adminOnly: boolean; partLabels: Record<string, [singular: string, plural: string]> }[]` in `OrganiseSection.tsx`. The titles are: To approve, Needs attention, Events & dates, Bookings, People, Café content, Stats.
  - `Organise({ section }: { section?: string })`.

- [ ] **Step 1: Routing and the hash redirect.**
  - `app.tsx`: `match('/organise/:section', path)` renders `<Organise section={p.section} />`; `/organise` stays `<Organise />`.
  - In `Organise`, once `gate.canReview` is known and there's no `section`, map a `location.hash` via `HASH_TO_SECTION = { 'join-requests': 'approve', awaiting: 'approve', changes: 'approve', 'market-applications': 'approve', attention: 'attention' }`, then `navigate('/organise/<section>#<hash>', { replace: true })`.
  - A host with a `section`, or with any hash, renders the host view unchanged.
  - An unknown `section` renders `<NotFound />`.
- [ ] **Step 2: `staffSummary.ts`.** Fetch with `hostApi<StaffSummary>('/api/staff/summary')`. In `hostApi`, after a successful POST whose path starts with `/api/staff/` or `/api/host/`, call `refreshStaffSummary()`. Import it lazily or through a registered callback, to avoid an import cycle.
- [ ] **Step 3: `OrganiseHub`.**
  - **Cards:** one per section the role allows. Order: those with `count > 0` first, then the rest, each group in `SECTIONS` order.
  - **Each card** is an `<a href="/organise/<key>">` showing the title, the count (or a shimmer while loading), and the line built from the non-zero parts joined with " · ", for example "2 join requests · 1 session". A count of 0 shows "All clear".
  - **Bookings** shows `info.booked_dates_7_days` as "N booked dates this week", never as a count.
  - **Error:** "Couldn't load what's waiting." plus a "Try again" button calling `reload`; the cards still link.
  - **Above the cards:** `PushCard`.
- [ ] **Step 4: `OrganiseSection`.**
  - **Header:** `<a href="/organise">← Organiser</a>`, the title, and the count from the summary.
  - **Wrong role:** an admin-only section for an approver shows "This section is for admins." with a link to `/organise`.
  - **Panels** per section, as in the spec's table. Move `StaffDesk`'s loading of sessions, hosts and markets into the section that needs it (To approve: sessions, markets; Events: nothing extra; People: hosts; Content: markets).
  - **Hash scroll:** after mount, when `location.hash` names an element, call `scrollIntoView` once it exists, checking every 250ms for up to 5 seconds.
- [ ] **Step 5: Run** `npm run typecheck` and `npm test`. Expected: clean, and all tests pass (the existing 428 plus Task 1's).
- [ ] **Step 6: Commit** with the message "Organiser hub: section cards with what's waiting, and a page per section".

### Task 4: Check the screens, then docs

**Files:**
- Modify: `docs/RTD_HOST_PORTAL.md` (the organiser's layout), `docs/RTD_ONBOARDING.md` (where Join requests now live: To approve), `RTD_CHANGELOG.md`, `docs/RTD_HANDOFF.md`

- [ ] **Step 1: Run the app locally.**
  1. Write a `.dev.vars` with `ENVIRONMENT=development`, `DEV_AUTH_EMAIL=dan@example.com` and `INTERNAL_SYNC_TOKEN=local-token`.
  2. Run `npx wrangler d1 migrations apply rtd-app --local` and `npm run build:web`, then start `npx wrangler dev --port 8787` in the background.
  3. Seed the local D1: an admin, an approver and a host; 2 pending applications; 1 submitted session; 1 open attention item.
- [ ] **Step 2: Take Playwright screenshots** at 390px and 1280px, as the admin and then as the approver (switch `DEV_AUTH_EMAIL`):
  - `/organise` with work waiting, then all clear;
  - every section;
  - `/organise/stats` as the approver;
  - the hub with `/api/staff/summary` blocked through route interception;
  - `/organise#awaiting`, which must land on `/organise/approve#awaiting`.

  Expected: no horizontal scroll, no console errors, and every link or button at least 40px tall. Look at each screenshot.
- [ ] **Step 3: Delete `.dev.vars` and stop the server.**
- [ ] **Step 4: Update the docs.** Add a changelog entry (what changed, no database change, the test count). Update the host portal and onboarding docs to the new layout, and add the hub to the handoff.
- [ ] **Step 5: Commit** with the message "Docs: organiser hub". Then push to `ccr-b9b076a7-f9fv6q` and open the PR.
