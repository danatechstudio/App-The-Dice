# Admin Event Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One admin-only editor in the organiser that lists every event and changes or cancels any of them, routing each field through the mechanism that already owns it.

**Architecture:** A new server module `src/events/admin.ts` reads every event into one shape and saves an editor form by delegating:
- café sheet fields go to `requestEdit` (Sheet Writer queue)
- host-session details go to a new `adminChange` (an approved change request with `origin = 'admin'`, written by n8n branch D)
- places and need to book go to the existing places functions
- cancelling goes to the existing `cancelDate`

The web adds an All events panel and an edit page under Organise › Events.

**Tech Stack:** Cloudflare Workers + Hono, D1, Preact. Tests: Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-10-18-admin-event-editor-design.md`

## Global Constraints

- **Access:**
  - Admins only (`user.role === 'admin'`) on every new endpoint; approvers (`staff`) and hosts get 403 `{ error: 'Only admins can edit every event.' }`.
  - Host and approver behaviour is unchanged. No existing test may change its expectations.
- **The sheet stays the master.**
  - Never write event details (name, date, times, description, price, category, visibility, status) directly to `events` or `occurrences`.
  - Never move bookings.
  - A new date while the event's current date has confirmed bookings is refused (409) with: `"{n} booking(s) on {long date}. Cancel this date first (everyone booked is emailed), then set the new date."`
- **Every change goes in `audit_log`** with the admin's email and the values before and after.
- **Repo style:**
  - prettier `--single-quote --print-width 160 --arrow-parens avoid`
  - comments in the surrounding plain-English style
  - British spelling in copy
- **Checks:** `npm test` and `npm run typecheck` must pass before each commit.
- **Commits:**
  - end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01BEBLQduYvn5PLNj3aKrd6V`
  - no model names
- **No production migrations or sheet writes in this work.** RTD Sheet Writer stays unpublished until the owner says so (spec §4).

## Review Focus

1. **Two edits racing.** An admin saves while a host change request is pending, or while a Sheet Writer edit for the event is still open. Expect a 409 that names the pending item, and nothing queued. Tests: Task 3 (pending host request), Task 4 (open sheet edit).
2. **Standard Diary row.** It has no Status, time or price columns. "Stop running" hides it (App Visibility Hidden) and says why; the form never sends those columns. Tests: Task 1 (the form marks them unavailable), Task 5 (stop on a Standard Diary row queues App Visibility Hidden).
3. **Places below booked, on host sessions edited by an admin.** Expect the existing "already booked on …" 409. Test: Task 2.
4. **Event that isn't in the last sync, or an inactive host session.** Expect a 409 that says why, and nothing queued. Test: Task 4.
5. **Stop running with bookings on several dates.** Each person is emailed once per booking, and Inactive is queued only after every cancel succeeds. Test: Task 5.

---

### Task 1: Read every event (list and form)

**Files:**
- Create: `src/events/admin.ts`
- Modify: `src/routes/staff.ts` (two GET routes near `/event-places`)
- Test: `test/admin-events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EventKind = 'event_index' | 'standard_diary' | 'host_session' | 'market';
  export type Visibility = 'public' | 'app_bookable' | 'private' | 'hidden';
  export interface AdminEventRow { event_id: string; name: string; kind: EventKind; next_date: string | null; visibility: Visibility;
    active: boolean; bookings: number; pending: { kind: 'sheet_edit' | 'host_change'; id: string } | null; }
  export interface AdminEventForm extends AdminEventRow {
    session_id: string | null; market_id: string | null;
    details: { name: string; description: string; event_date: string; start_time: string; end_time: string; price: string; category: string };
    /** Fields this kind can't change here, with why (e.g. Standard Diary: start_time, end_time, price). */
    unavailable: Partial<Record<keyof AdminEventForm['details'] | 'active', string>>;
    places: number | null; most_booked: number; booking_mode: BookingMode; booking_mode_set: BookingMode | null;
    dates: { occurrence_id: string; date: string; start_time: string | null; status: 'scheduled' | 'cancelled'; hidden: boolean;
      places: number | null; booked: number; bookings: number }[]; // up to 12, from today
  }
  export const adminOnly: (u: AuthUser) => { ok: false; status: 403; error: string } | null;
  export async function listAllEvents(db: D1Database, now: Date): Promise<AdminEventRow[]>;
  export async function eventForm(db: D1Database, eventId: string, now: Date): Promise<AdminEventForm | null>;
  ```
- Routes: `GET /api/staff/events` → `{ events }`. `GET /api/staff/events/:id` → `{ event }` or 404. Both no-store, both admin only.

**How the rows are built:**
- `kind`: `market_id` → market, `host_session_id` → host_session, else `source`.
- Café `details` come from `sheet_values`: Event Name/Group, Base Details/Notes, Event Date/Date, Event Time, End Time, App Price, App Category.
- Host-session `details` come from `liveDetails` (export its use; it's already exported) plus `events.category`.
- `visibility` is `events.visibility`.
- The list includes inactive events from the last sync (`IN_LAST_SYNC` from `src/sync/edits.ts`; export it). Ordering: active first, then next date, then name.

- [ ] **Step 1: Write the failing tests** in `test/admin-events.test.ts`. Seed them like `test/changes.test.ts` (clock 2026-10-06T10:00Z):
  - users `dan@example.com` (role `admin`), `michelle@example.com` (`staff`), `sam@example.com` and `alex@example.com` (`host`)
  - Sam's approved weekly Catan Club (`RTD-HS-00001` / `RTD-EVT-00002`)
  - a sync with `catanRow`, a public Event Index quiz (`indexRow(4)`), a `Private` Event Index row (`indexRow(5, {'App Visibility':'Private'})`), a `Hidden` one (`indexRow(6, {'App Visibility':'Hidden'})`), an `Inactive` one (`indexRow(7, {Status:'Inactive'})`) and a Standard Diary row (`diaryRow(8)`)

  Tests:
  - `it('lists every event to an admin, whatever its kind, visibility or status')`: `GET /api/staff/events` as Dan is 200. The six event IDs are present. Kinds are `host_session`, `event_index` ×4 and `standard_diary`. The visibilities include `private` and `hidden`. `RTD-EVT-00007` has `active: false`.
  - `it('refuses approvers and hosts')`: Michelle and Sam both get 403 on `/api/staff/events` and `/api/staff/events/RTD-EVT-00004`. Sam is already refused by `requireRole('staff')`; assert the status only.
  - `it('gives a café event its form')`: `RTD-EVT-00004` has `details.name` 'Event 4', `details.event_date` '2026-10-23', `start_time` '18:30', `unavailable` `{}`, and up to 12 `dates`.
  - `it('marks what a Standard Diary row has no column for')`: `RTD-EVT-00008` has `unavailable` keys `start_time`, `end_time`, `price` and `active`.
  - `it('gives a host session its form with the session')`: `RTD-EVT-00002` has `kind` 'host_session', `session_id` 'RTD-HS-00001', `booking_mode` 'required', `places` 20.
  - `it('is 404 for an unknown event')`.

- [ ] **Step 2: Run** `npx vitest run test/admin-events.test.ts`. Expected: FAIL (404 or 403 from missing routes).
- [ ] **Step 3: Implement** `listAllEvents`, `eventForm` and `adminOnly` in `src/events/admin.ts`, and the two routes. Reuse `BOOKING_MODE`/`DEFAULT_BOOKING_MODE` and `CAPACITY` from `src/lib/queries.ts`.
- [ ] **Step 4: Run** `npx vitest run test/admin-events.test.ts`. Expected: PASS. Then `npm test && npm run typecheck`, all green.
- [ ] **Step 5: Commit** "Admin events: list and form for every event".

### Task 2: Admins set places and need to book on host sessions; prove host ownership holds

**Files:**
- Modify: `src/bookings/places.ts` (`setSessionPlaces`, `setBookingMode`)
- Test: `test/admin-events.test.ts`, plus a new `describe` in `test/places.test.ts` for host ownership

**Interfaces:**
- `setSessionPlaces(db, actor, sessionId, value, ctx)`: unchanged signature. An actor with `role === 'admin'` may change any live session. The audit `actor_type` is `'staff'` for an admin and `'host'` for the owner. Other non-owners still get 403.
- `setBookingMode(db, actor, eventId, body, ctx)`: an admin may set it on a host session. An approver still gets the 409 "This is a host's session: people always book those."

- [ ] **Step 1: Write the failing tests:**
  - `it('lets an admin change a host session’s places and booking')`:
    - Dan `POST /api/host/sessions/RTD-HS-00001/places {places: 12}` → 200.
    - `POST /api/staff/events/RTD-EVT-00002/booking-mode {mode:'optional'}` → 200, and the form shows `booking_mode` 'optional'.
  - `it('still refuses an approver on a host session’s booking')`: Michelle gets 409 on the same booking-mode call.
  - `it('never lets places go below what is booked, for an admin too')`:
    - Book 3 on `RTD-OCC-00002-20261013`.
    - Dan sets places to 2 → 409, and the error contains 'already booked'.
  - `describe('a host can only touch their own sessions')`. Alex gets 403 on each of:
    - `POST /api/host/sessions/RTD-HS-00001/places`
    - `POST /api/host/occurrences/RTD-OCC-00002-20261013/places`
    - `POST /api/host/occurrences/RTD-OCC-00002-20261013/cancel`
    - `POST /api/host/sessions/RTD-HS-00001/changes` (404, as today: "Session not found")

    Alex also gets 403 on `POST /api/staff/events/RTD-EVT-00004/places`.
- [ ] **Step 2: Run** these tests. Expected: the admin cases FAIL (403 and 409); the ownership cases already PASS.
- [ ] **Step 3: Implement** the two admin allowances.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all green, with no existing test changed.
- [ ] **Step 5: Commit** "Admins set places and booking on host sessions; host ownership tests".

### Task 3: Admin changes to a host session (`adminChange`)

**Files:**
- Modify: `src/host/changes.ts`
- Test: `test/admin-events.test.ts`, and `test/changes.test.ts` for the `/internal/host-changes` mapping

**Interfaces:**
- Produces:
  ```ts
  /** Admin-only fields, on top of the host's Field set. */
  export type AdminProposed = Proposed & { visibility?: Visibility; active?: false };
  export async function adminChange(db: D1Database, admin: AuthUser, sessionId: string,
    body: { details?: Partial<AdminEventForm['details']>; visibility?: Visibility; active?: false; note?: string },
    ctx: { now: string; origin: string }): Promise<{ ok: true; request: ChangeRequest } | Fail>;
  ```
- Refactor, with no behaviour change for hosts:
  - Move the "body → validated `Details` diff" part of `requestChange` into `proposeChange(db, live, input, today)`, which returns `{ proposed } | Fail`. `requestChange` keeps its host-only checks and uses it.
  - Move `decideChange`'s approve writes (the session record update and time-change emails) into `approvalWrites(db, r, proposed, before, ctx): Promise<D1PreparedStatement[]>`. `decideChange` uses it.

**Rules:**
- 403 unless admin. 404 if the session isn't live.
- 409 `"Sam Host has asked for a change to this session (RTD-CR-00001). Approve or decline it first."` if a request is pending.
- A date change while the current date is booked → the Global Constraints 409.
- `visibility` maps to the access field: `public` → open, `private` → private. `app_bookable` and `hidden` leave `host_sessions.access` as it is.
- Insert the request with `origin = 'admin'`, `status = 'approved'`, `decided_by = admin.email`, `decided_at = now`, in one batch with `approvalWrites` and the audit row (action `host_session.changed_by_admin`).
- Queue an email to the host, kind `host_change_by_admin`, subject `"Your session was changed: {name}"`, showing the `changeTable` old → new.
- `changesToApply`:
  - `visibility` → `App Visibility` using `{public:'Public', app_bookable:'App Bookable', private:'Private', hidden:'Hidden'}`
  - `active: false` → `Status: 'Inactive'`
  - host `access` keeps writing Public or Private

- [ ] **Step 1: Write the failing tests:**
  - `it('applies an admin’s change straight away, emails the host and booked people')`:
    - Book Ava on 13 Oct.
    - Dan `POST /api/staff/events/RTD-EVT-00002 {details:{start_time:'19:00', name:'Catan Night'}}` → 200.
    - The request has status `approved` and origin `admin`.
    - The outbox has one `host_change_by_admin` email to sam@example.com and one time-change email to ava@example.com.
    - `/internal/host-changes` row has `{'Event Name':'Catan Night','Event Time':'19:00'}`.
  - `it('writes Hidden and Inactive for a host session')`: `{visibility:'hidden'}` gives `App Visibility: 'Hidden'`. A later `{active:false}` (after marking the first applied) gives `Status: 'Inactive'`.
  - `it('asks the admin to decide a pending host request first')`:
    - Sam asks for a change.
    - Dan's save → 409, and the message contains 'RTD-CR-00001'.
    - Only one request exists.
  - `it('refuses to move a booked date')`:
    - Book on 13 Oct.
    - Dan `{details:{event_date:'2026-10-20'}}` → 409, and the message contains 'Cancel this date first'.
  - Existing `test/changes.test.ts` passes unchanged.
- [ ] **Step 2: Run.** Expected: FAIL (route missing).
- [ ] **Step 3: Implement** the refactor, `adminChange`, the mapping and the email.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all green.
- [ ] **Step 5: Commit** "Admins change host sessions directly, through the approved-change path".

### Task 4: Save the editor (`saveEvent`), including café time-change emails

**Files:**
- Modify: `src/events/admin.ts`, `src/routes/staff.ts`, `src/sync/edits.ts` (`markEditWritten`), `src/host/changes.ts` (export `attendeeTimeChanged`)
- Test: `test/admin-events.test.ts`, `test/sheet-edits.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SaveBody { details?: Partial<AdminEventForm['details']>; visibility?: Visibility; places?: number | null;
    booking_mode?: BookingMode | 'default'; confirm?: boolean; note?: string }
  export async function saveEvent(db: D1Database, admin: AuthUser, eventId: string, body: unknown, ctx: { now: Date; origin: string })
    : Promise<{ ok: true; sheet_edit?: SheetEdit; change?: ChangeRequest; places?: number | null; booking_mode?: BookingMode } | Fail | { ok: false; status: 409; warning: unknown }>;
  ```
  Route: `POST /api/staff/events/:id`. Status codes: 200, 400 `{error, errors}`, 403, 404, 409 `{error}` or `{warning}`.

**Routing by kind:**
- **Café:**
  - Map `details` and `visibility` to sheet columns: Event Index uses Event Name, Base Details, Event Date, Event Time, End Time, App Price, App Category, App Visibility. Standard Diary uses Group, Notes, Date, App Category, App Visibility.
  - A field in `unavailable` → 400 naming it.
  - Run the booked-date refusal first, then `requestEdit(db, admin, id, {values, note, confirm: body.confirm}, now)`. Its other warnings, such as a time move with bookings, pass through as `warning`.
- **Host session:** `adminChange` for details and visibility; `setSessionPlaces` for places; `setBookingMode` for booking.
- **Market:** 409 "Change markets under Markets."
- **Places and booking mode on café events:** `setEventPlaces` and `setBookingMode`, which are immediate.
- **Order:** places and booking are applied after the details step succeeds. Any failure returns before later steps run.

**`markEditWritten`, on `'ok'` with `target === 'live'`:**
- If `Event Time` or `End Time` was in the written cells, queue `attendeeTimeChanged(edit_id, name, name, booking, timeLabel(start, end), origin)` for each confirmed booking on scheduled dates from today.
- Uses the same query as `decideChange`. Dedupe on the edit id.

- [ ] **Step 1: Write the failing tests:**
  - `it('queues café detail changes for the Logic Engine and applies places at once')`:
    - Set `sheet_writes` to `live`.
    - Dan `POST /api/staff/events/RTD-EVT-00004 {details:{name:'Big Quiz'}, visibility:'private', places:40, booking_mode:'required'}` → 200.
    - `sheet_edit.fields` is `{'Event Name':{from:'Event 4',to:'Big Quiz'}, 'App Visibility':{from:'public',to:'private'}}`.
    - `events.capacity_override` is 40 and `booking_mode` is 'required'.
  - `it('refuses a column the Standard Diary hasn’t got')`: `{details:{start_time:'19:00'}}` on `RTD-EVT-00008` → 400.
  - `it('refuses while a Logic Engine change is on its way')`: a second save → 409, and the message contains 'still on its way'.
  - `it('refuses an event not in the last sync')`: delete its `last_synced_at` → 409.
  - `it('refuses to move a booked café date')`: book on 23 Oct, then change `event_date` → 409 'Cancel this date first'.
  - `it('refuses approvers')`: Michelle → 403.
  - In `test/sheet-edits.test.ts`, `it('emails people booked when a new time is written')`:
    - Queue an `Event Time` edit on a booked event.
    - Claim, check, then post `/written` with the row read back.
    - The outbox has one time-change email to the booker.
    - Posting `/written` again adds none.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `saveEvent`, the route and the email in `markEditWritten`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all green.
- [ ] **Step 5: Commit** "Admin editor saves every field through its own route".

### Task 5: Stop running an event

**Files:**
- Modify: `src/events/admin.ts`, `src/routes/staff.ts`
- Test: `test/admin-events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function stopEvent(db: D1Database, admin: AuthUser, eventId: string, body: unknown, ctx: { now: Date; origin: string })
    : Promise<{ ok: true; cancelled_dates: number; cancelled_bookings: number; sheet_edit?: SheetEdit; change?: ChangeRequest }
      | Fail | { ok: false; status: 409; warning: { dates: number; bookings: number; people: number } }>;
  ```
  Route: `POST /api/staff/events/:id/stop`, with body `{ message?: string, confirm?: boolean }`.

**Rules:**
- **With bookings on dates to come and no `confirm`:** 409 `warning` with the counts.
- **With `confirm`:** `cancelDate(db, admin, occurrenceId, message, {now, origin})` for each booked scheduled date from today, oldest first. Stop on the first failure and return it; nothing has been set Inactive at that point.
- **Then set the event inactive:**
  - Event Index: `requestEdit` with `Status: 'Inactive'` and `confirm: true`
  - Standard Diary: `App Visibility: 'hidden'`, with the response `note` "The Standard Diary has no Status column, so it's hidden instead."
  - Host session: `adminChange` with `{active:false}`
  - Market: 409
- **Audit:** `event.stopped`, with the counts.

- [ ] **Step 1: Write the failing tests:**
  - `it('warns, then cancels every booked date and stops the event')`:
    - Book 2 people on one date of a weekly café event and 1 person on another.
    - The first call → 409 `warning {dates:2, bookings:2}`.
    - With `confirm` → 200 and `cancelled_bookings: 2`.
    - The outbox has one cancellation email per booking.
    - `sheet_edit.fields.Status.to` is 'Inactive'.
  - `it('hides a Standard Diary row instead')`: `fields['App Visibility'].to` is 'hidden'.
  - `it('stops a host session through the approved-change path')`: `/internal/host-changes` gives `Status: 'Inactive'`.
  - `it('stops without asking when nobody is booked')`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all green.
- [ ] **Step 5: Commit** "Stop running an event: cancel booked dates, then set Inactive".

### Task 6: Organiser pages (All events and Edit event)

**Files:**
- Create: `web/src/pages/OrganiseEvents.tsx` (the list), `web/src/pages/OrganiseEventEdit.tsx` (the form)
- Modify:
  - `web/src/app.tsx`: `match('/organise/events/:eventId', path)` before `/organise/:section`, rendering `<Organise section="events" eventId={p.eventId} />`
  - `web/src/pages/Organise.tsx` and `OrganiseSection.tsx`: pass `eventId`. In `case 'events'`, admins see `<AllEventsPanel />` first. When `eventId` is set, render `<EventEditor eventId />` instead of the panels.
  - `web/src/lib/hostApi.ts`: the `AdminEventRow`/`AdminEventForm` types, mirroring Task 1
  - `web/src/styles/components.css`

**Behaviour:**
- **List:**
  - Search box and filter chips: All, Café, Host sessions, Markets, Stopped, Hidden or private.
  - Each row links to `/organise/events/{id}`.
  - Chips for kind, visibility, Stopped, and "Change on its way" when `pending`.
- **Form:**
  - Sections: Details, Who can see it (four radio choices with one-line hints), Booking (reuse `PlacesEditor` and the booking-mode choices from `OrganisePlaces.tsx`), Dates to come, and Danger zone (Stop running this event).
  - Fields in `unavailable` show read-only with their reason.
  - Save sends only fields that changed. A 409 `warning` shows the message with "Save anyway"/"Cancel"; "Save anyway" resends with `confirm: true`.
- **Dates to come:** each row has Cancel this date (existing `/api/host/occurrences/:id/cancel` with a message box), Hide/Show (existing `/api/staff/dates/:id {hidden}`) and Places (existing `/api/host/occurrences/:id/places`).
- **Toasts:** after a café save, "Sent to the Logic Engine. It shows in the app within about 20 minutes." For a host session, "Changed. Sam Host has been emailed." Places and booking: "Saved."
- **Markets:** a summary and a link to `/organise/content#markets` (the existing editor's anchor; check `OrganiseSection` for the exact hash).

- [ ] **Step 1:** Run `npm run typecheck` after writing the types and pages. Expected: clean.
- [ ] **Step 2: Browser check.**
  - Create `.dev.vars` (`ENVIRONMENT=development`, `DEV_AUTH_EMAIL=dan@example.com`, `INTERNAL_SYNC_TOKEN=local-token`) and run `npm run dev`.
  - Seed an admin user and sync rows locally.
  - With Playwright (`executablePath: '/opt/pw-browsers/chromium'`), at 390×844 and 1280×800, screenshot the list, the café form, the Standard Diary form, and the host-session form with a warning showing.
  - Check there's no horizontal scroll and the bottom bar doesn't cover Save.
  - Delete `.dev.vars` afterwards and stop wrangler with TaskStop.
- [ ] **Step 3:** Run `npm test && npm run typecheck`. Expected: all green.
- [ ] **Step 4: Commit** "Organiser: All events and Edit event for admins".

### Task 7: Docs and handoff

**Files:**
- Modify: `docs/RTD_EVENT_CONTROL_MIGRATION.md` (a section "Admin event editor", with the Sheet Writer go-ahead steps from spec §4), `docs/RTD_HOST_PORTAL.md` (admins change sessions directly; the host is emailed), `RTD_CHANGELOG.md`, `docs/RTD_HANDOFF.md`

- [ ] **Step 1:** Write the doc changes. Say plainly that café detail changes queue but don't reach the sheet until RTD Sheet Writer is published.
- [ ] **Step 2:** Run `npm test && npm run typecheck`, then commit "Docs: admin event editor" and push the branch.
