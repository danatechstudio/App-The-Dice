// The admin event editor (docs/superpowers/specs/2026-10-18-admin-event-editor-design.md). Admins
// see every event in one list (café events from both tabs, host sessions and markets; public,
// private or hidden; running or stopped) and open any of them in one form. Saving never writes
// event details here: each field goes through the route that already owns it, so every check
// stays in place (the Logic Engine's conflict check, the host's approval path, places never
// below what's booked).

import { cancelDate } from '../bookings/bookings';
import { setBookingMode, setEventPlaces, setSessionPlaces } from '../bookings/places';
import { adminChange, adminChangeRefusal, liveDetails, refuseBookedMove, type ChangeRequest } from '../host/changes';
import type { AuthUser } from '../lib/auth';
import { BOOKING_MODE, CAPACITY, type BookingMode } from '../lib/queries';
import { londonDate } from '../lib/time';
import { HOST_SESSION_COLUMNS, IN_LAST_SYNC, OPEN, requestEdit, sheetEditRefusal, type SheetEdit } from '../sync/edits';
import { EXTRA, FREQUENCIES } from '../sync/sheetValues';

export type EventKind = 'event_index' | 'standard_diary' | 'host_session' | 'market';
export type Visibility = 'public' | 'app_bookable' | 'private' | 'hidden';
export const VISIBILITIES: Visibility[] = ['public', 'app_bookable', 'private', 'hidden'];

export interface AdminEventRow {
  event_id: string;
  name: string;
  kind: EventKind;
  next_date: string | null;
  visibility: Visibility;
  active: boolean;
  /** Confirmed bookings on dates to come. */
  bookings: number;
  /** A change still on its way: a Logic Engine edit, a host's request waiting for a decision, or an approved change not yet in the sheet. */
  pending: { kind: 'sheet_edit' | 'host_change' | 'change_on_way'; id: string } | null;
}

export interface Details {
  name: string;
  description: string;
  event_date: string;
  start_time: string;
  end_time: string;
  price: string;
  category: string;
}
export type DetailField = keyof Details;

export interface AdminEventForm extends AdminEventRow {
  session_id: string | null;
  market_id: string | null;
  details: Details;
  /** What this kind of event can't change here, and why. */
  unavailable: Partial<Record<DetailField | 'active' | 'sheet', string>>;
  /**
   * The tab's other hand-filled Logic Engine columns (src/sync/sheetValues.ts EXTRA), canonical, as
   * the last sync read them. null: not synced yet (RTD Event Sync doesn't send it), so it can't be
   * changed here. A host's session has only the posting, voice and social ones the host doesn't
   * own (HOST_SESSION_COLUMNS); a market has none.
   */
  sheet: Record<string, string | null>;
  /** Frequency as this tab spells it. */
  frequency_options: string[];
  /** The Logic Engine change still on its way, column by column: {from, to}. */
  pending_fields: Record<string, { from: string; to: string }>;
  places: number | null;
  /** The most booked on any date to come: the lowest places can go. */
  most_booked: number;
  booking_mode: BookingMode;
  booking_mode_set: BookingMode | null;
  dates: {
    occurrence_id: string;
    date: string;
    start_time: string | null;
    status: 'scheduled' | 'cancelled';
    hidden: boolean;
    /** This date's own places, or null for the event's. */
    places: number | null;
    capacity: number | null;
    booked: number;
    bookings: number;
  }[];
}

type Forbidden = { ok: false; status: 403; error: string };
export const adminOnly = (u: AuthUser): Forbidden | null =>
  u.role === 'admin' ? null : { ok: false, status: 403, error: 'Only admins can edit every event.' };

/** The sheet's columns for each detail, by tab. Standard Diary has no times, price or Status. */
export const COLUMNS: Record<'event_index' | 'standard_diary', Partial<Record<DetailField, string>>> = {
  event_index: {
    name: 'Event Name',
    description: 'Base Details',
    event_date: 'Event Date',
    start_time: 'Event Time',
    end_time: 'End Time',
    price: 'App Price',
    category: 'App Category',
  },
  standard_diary: { name: 'Group', description: 'Notes', event_date: 'Date', category: 'App Category' },
};
const FIELDS: DetailField[] = ['name', 'description', 'event_date', 'start_time', 'end_time', 'price', 'category'];

const NO_DIARY_COLUMN = 'The Standard Diary has no column for this: put it in the description.';
const UNAVAILABLE: Record<EventKind, AdminEventForm['unavailable']> = {
  event_index: {},
  // The host's own details go through the approved-change path; App Category and the posting,
  // voice and social columns (HOST_SESSION_COLUMNS) go to the Logic Engine like a café event's.
  host_session: {},
  standard_diary: {
    start_time: NO_DIARY_COLUMN,
    end_time: NO_DIARY_COLUMN,
    price: NO_DIARY_COLUMN,
    active: 'The Standard Diary has no Status column: Stop running hides the group instead.',
  },
  market: Object.fromEntries([...FIELDS, 'active', 'sheet'].map(f => [f, 'Change markets under Markets.'])),
};

/** The tab's other Logic Engine columns the editor offers for this kind of event. */
const sheetColumns = (kind: EventKind): readonly string[] =>
  kind === 'market'
    ? []
    : kind === 'host_session'
      ? EXTRA.event_index.filter(c => (HOST_SESSION_COLUMNS as readonly string[]).includes(c))
      : EXTRA[kind];

const BOOKED = `(SELECT COALESCE(SUM(b.party_size), 0) FROM bookings b WHERE b.occurrence_id = o.occurrence_id AND b.status = 'confirmed')`;
const KIND = `CASE WHEN e.market_id IS NOT NULL THEN 'market' WHEN e.host_session_id IS NOT NULL THEN 'host_session' ELSE e.source END`;
const ROW_FIELDS = `e.event_id, e.display_name AS name, ${KIND} AS kind, e.visibility, e.active,
  (SELECT MIN(o.event_date) FROM occurrences o WHERE o.event_id = e.event_id AND o.status = 'scheduled' AND o.event_date >= ?1) AS next_date,
  (SELECT COUNT(*) FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
     WHERE o.event_id = e.event_id AND b.status = 'confirmed' AND o.status = 'scheduled' AND o.event_date >= ?1) AS bookings,
  (SELECT s.edit_id FROM sheet_edits s WHERE s.event_id = e.event_id AND ${OPEN} ORDER BY s.created_at DESC LIMIT 1) AS open_edit,
  (SELECT r.request_id FROM event_change_requests r WHERE r.event_id = e.event_id AND r.status = 'pending' LIMIT 1) AS open_change,
  (SELECT r.request_id FROM event_change_requests r WHERE r.event_id = e.event_id AND r.status = 'approved' AND r.applied_at IS NULL
     ORDER BY r.decided_at DESC LIMIT 1) AS on_way`;

const shapeRow = (r: Record<string, unknown>): AdminEventRow => ({
  event_id: String(r.event_id),
  name: String(r.name),
  kind: r.kind as EventKind,
  next_date: (r.next_date as string | null) ?? null,
  visibility: r.visibility as Visibility,
  active: r.active === 1,
  bookings: Number(r.bookings),
  pending: r.open_edit
    ? { kind: 'sheet_edit', id: String(r.open_edit) }
    : r.open_change
      ? { kind: 'host_change', id: String(r.open_change) }
      : r.on_way
        ? { kind: 'change_on_way', id: String(r.on_way) }
        : null,
});

/** Every event the last sync read, and any still running: active first, then by next date and name. */
export async function listAllEvents(db: D1Database, now: Date): Promise<AdminEventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${ROW_FIELDS} FROM events e WHERE e.active = 1 OR ${IN_LAST_SYNC}
       ORDER BY e.active DESC, next_date IS NULL, next_date, lower(e.display_name) LIMIT 500`,
    )
    .bind(londonDate(now))
    .all<Record<string, unknown>>();
  return results.map(shapeRow);
}

/** One event as the editor shows it, or null. Details are the sheet's, as the last sync read them. */
export async function eventForm(db: D1Database, eventId: string, now: Date): Promise<AdminEventForm | null> {
  const today = londonDate(now);
  const r = await db
    .prepare(
      `SELECT ${ROW_FIELDS}, e.source, e.host_session_id, e.market_id, e.sheet_values, e.event_name, e.description, e.price_display, e.category,
         COALESCE(e.capacity_override, e.default_capacity) AS places, ${BOOKING_MODE} AS booking_mode, e.booking_mode AS booking_mode_set,
         (SELECT o.start_time FROM occurrences o WHERE o.event_id = e.event_id AND o.status = 'scheduled' AND o.event_date >= ?1 ORDER BY o.event_date LIMIT 1) AS next_start,
         (SELECT o.end_time FROM occurrences o WHERE o.event_id = e.event_id AND o.status = 'scheduled' AND o.event_date >= ?1 ORDER BY o.event_date LIMIT 1) AS next_end,
         (SELECT s.fields FROM sheet_edits s WHERE s.event_id = e.event_id AND ${OPEN} ORDER BY s.created_at DESC LIMIT 1) AS open_fields
       FROM events e WHERE e.event_id = ?2`,
    )
    .bind(today, eventId)
    .first<Record<string, unknown>>();
  if (!r) return null;
  const row = shapeRow(r);
  const source = r.source === 'standard_diary' ? 'standard_diary' : 'event_index';
  const sheet = r.sheet_values ? (JSON.parse(r.sheet_values as string) as Record<string, string>) : null;
  const cols = COLUMNS[source];
  const fromSheet = (f: DetailField) => (cols[f] && sheet ? (sheet[cols[f]!] ?? '') : null);
  const details: Details = {
    name: fromSheet('name') ?? String(r.event_name),
    description: fromSheet('description') ?? String(r.description ?? ''),
    event_date: fromSheet('event_date') ?? String(row.next_date ?? ''),
    start_time: fromSheet('start_time') ?? String(r.next_start ?? ''),
    end_time: fromSheet('end_time') ?? String(r.next_end ?? ''),
    price: fromSheet('price') ?? String(r.price_display ?? ''),
    category: fromSheet('category') ?? String(r.category ?? ''),
  };
  const { results: dates } = await db
    .prepare(
      `SELECT o.occurrence_id, o.event_date AS date, o.start_time, o.status, o.visibility = 'hidden' AS hidden, o.capacity AS places,
         ${CAPACITY} AS capacity, ${BOOKED} AS booked,
         (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = o.occurrence_id AND b.status = 'confirmed') AS bookings
       FROM occurrences o JOIN events e ON e.event_id = o.event_id
       WHERE o.event_id = ?1 AND o.status IN ('scheduled', 'cancelled') AND o.event_date >= ?2
       ORDER BY o.event_date LIMIT 12`,
    )
    .bind(eventId, today)
    .all<Record<string, unknown>>();
  const shaped = dates.map(d => ({ ...(d as unknown as AdminEventForm['dates'][number]), hidden: d.hidden === 1 }));
  return {
    ...row,
    session_id: (r.host_session_id as string | null) ?? null,
    market_id: (r.market_id as string | null) ?? null,
    details,
    unavailable: UNAVAILABLE[row.kind],
    sheet: Object.fromEntries(sheetColumns(row.kind).map(c => [c, sheet && c in sheet ? sheet[c]! : null])),
    frequency_options: [...FREQUENCIES[source]],
    pending_fields: r.open_fields ? (JSON.parse(r.open_fields as string) as AdminEventForm['pending_fields']) : {},
    places: (r.places as number | null) ?? null,
    most_booked: Math.max(0, ...shaped.filter(d => d.status === 'scheduled').map(d => Number(d.booked))),
    booking_mode: r.booking_mode as BookingMode,
    booking_mode_set: (r.booking_mode_set as BookingMode | null) ?? null,
    dates: shaped,
  };
}

// ---- Saving ----

export interface SaveBody {
  details?: Partial<Details>;
  /** The tab's other Logic Engine columns, by exact header (AdminEventForm.sheet). */
  sheet?: Record<string, string>;
  visibility?: Visibility;
  /** true starts a stopped event again. Stopping is Stop running's (stopEvent), never a plain save. */
  active?: boolean;
  places?: number | null;
  booking_mode?: BookingMode | 'default';
  confirm?: boolean;
  note?: string;
}

type Fail = { ok: false; status: 400 | 403 | 404 | 409; error: string; errors?: Record<string, string> };
type Warning = { ok: false; status: 409; warning: unknown };
export type SaveResult = { ok: true; sheet_edit?: SheetEdit; change?: ChangeRequest; places?: number | null; booking_mode?: BookingMode } | Fail | Warning;

const parseBody = (body: unknown): SaveBody | Fail => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const details = (b.details && typeof b.details === 'object' ? b.details : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(details)) {
    if (!(FIELDS as string[]).includes(k)) errors[k] = `${k} isn't a detail the editor changes.`;
    else if (typeof v !== 'string') errors[k] = 'This must be text.';
  }
  const sheet = (b.sheet && typeof b.sheet === 'object' ? b.sheet : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(sheet)) if (typeof v !== 'string') errors[k] = 'This must be text.';
  if (b.visibility !== undefined && !VISIBILITIES.includes(b.visibility as Visibility)) errors.visibility = 'Choose Public, App Bookable, Private or Hidden.';
  if (b.active !== undefined && b.active !== true) errors.active = 'Use Stop running this event to stop it: it cancels the dates people have booked first.';
  if (Object.keys(errors).length) return { ok: false, status: 400, error: 'Please check the form', errors };
  return { ...(b as SaveBody), details: details as Partial<Details>, sheet: sheet as Record<string, string> };
};
const failed = (v: SaveBody | Fail): v is Fail => 'ok' in v && v.ok === false;

/**
 * Body: SaveBody, with only what changed. Each part goes through the route that owns it: booking
 * and places first, details last. 409 { warning } asks to send again with confirm: true.
 */
export async function saveEvent(db: D1Database, admin: AuthUser, eventId: string, body: unknown, ctx: { now: Date; origin: string }): Promise<SaveResult> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  const form = await eventForm(db, eventId, ctx.now);
  if (!form) return { ok: false, status: 404, error: 'No event with that ID.' };
  const b = parseBody(body);
  if (failed(b)) return b;
  // Only what differs from the form counts as a change: the rest is as it was.
  b.details = Object.fromEntries(Object.entries(b.details ?? {}).filter(([f, v]) => v !== form.details[f as DetailField]));
  b.sheet = Object.fromEntries(Object.entries(b.sheet ?? {}).filter(([c, v]) => v !== form.sheet[c]));
  if (b.visibility === form.visibility) delete b.visibility;
  if (b.active === true && form.active) delete b.active;
  if (form.kind === 'market') return { ok: false, status: 409, error: 'Change markets under Markets.' };
  const blocked = [...Object.keys(b.details), ...(b.active !== undefined ? ['active'] : [])].filter(f => f in form.unavailable);
  if (Object.keys(b.sheet).length) {
    if (form.unavailable.sheet) return { ok: false, status: 400, error: 'Please check the form', errors: { sheet: form.unavailable.sheet } };
    const unknown = Object.keys(b.sheet).filter(c => !(c in form.sheet));
    if (unknown.length)
      return { ok: false, status: 400, error: 'Please check the form', errors: Object.fromEntries(unknown.map(c => [c, `${c} can't be changed from the app.`])) };
  }
  if (blocked.length)
    return {
      ok: false,
      status: 400,
      error: 'Please check the form',
      errors: Object.fromEntries(blocked.map(f => [f, form.unavailable[f as DetailField | 'active']!])),
    };

  const iso = ctx.now.toISOString();
  const out: Extract<SaveResult, { ok: true }> = { ok: true };
  const hasDetails = Object.keys(b.details).length > 0 || Object.keys(b.sheet).length > 0 || b.visibility !== undefined || b.active !== undefined;
  if (!hasDetails && b.places === undefined && b.booking_mode === undefined) {
    return { ok: false, status: 400, error: 'Nothing has changed.', errors: { form: 'Nothing has changed: change something, or close the form.' } };
  }
  // Details are checked first without being sent (a refusal or a warning changes nothing); then
  // booking and places, which change at once and can safely be sent again; then the details, last,
  // so a refused or warned save never sends them (or their emails) twice.
  const today = londonDate(ctx.now);
  // A host's session splits: what the host owns goes through the approved-change path (the host is
  // emailed), App Category and the posting, voice and social columns to the Logic Engine.
  const hosted = form.kind === 'host_session';
  const { category, ...hostDetails } = b.details;
  const toHost = hosted && (Object.keys(hostDetails).length > 0 || b.visibility !== undefined || b.active !== undefined);
  const sheetPart: SaveBody = hosted ? { details: category !== undefined ? { category } : {}, sheet: b.sheet, note: b.note, confirm: b.confirm } : b;
  const toSheet = hosted ? category !== undefined || Object.keys(b.sheet).length > 0 : hasDetails;
  const sendDetails = async (dryRun: boolean): Promise<{ ok: true; request: ChangeRequest | null; edit: SheetEdit | null } | Fail | Warning> => {
    let edit: SheetEdit | null = null;
    let request: ChangeRequest | null = null;
    if (toSheet) {
      const res = await queueSheetEdit(db, admin, form, sheetPart, ctx.now, dryRun);
      if (!res.ok) return res;
      edit = res.edit;
    }
    if (toHost) {
      const res = await adminChange(
        db,
        admin,
        form.session_id!,
        { details: hostDetails, visibility: b.visibility, active: b.active, note: b.note },
        { now: iso, origin: ctx.origin, dryRun },
      );
      if (!res.ok) return res;
      request = res.request;
    }
    return { ok: true, request, edit };
  };
  if (hasDetails) {
    const res = await sendDetails(true);
    if (!res.ok) return res;
  }
  if (b.booking_mode !== undefined) {
    const res = await setBookingMode(db, admin, eventId, { mode: b.booking_mode, confirm: b.confirm }, { now: iso, today });
    if (!res.ok) return res;
    out.booking_mode = res.booking_mode;
  }
  if (b.places !== undefined) {
    if (form.kind === 'host_session') {
      if (b.places === null)
        return { ok: false, status: 400, error: 'Please check the form', errors: { places: "A host's session always has a number of places." } };
      const res = await setSessionPlaces(db, admin, form.session_id!, b.places, { now: iso, today });
      if (!res.ok) return res;
      out.places = res.places;
    } else {
      const res = await setEventPlaces(db, admin, eventId, b.places, { now: iso, today });
      if (!res.ok) return res;
      out.places = res.capacity;
    }
  }
  if (hasDetails) {
    const res = await sendDetails(false);
    if (!res.ok) return res;
    if (res.request) out.change = res.request;
    if (res.edit) out.sheet_edit = res.edit;
  }
  return out;
}

/**
 * A café event's details, as the Logic Engine columns of its tab, to the Sheet Writer queue
 * (requestEdit keeps its checks: the last sync, one change on its way at a time, the sheet's own
 * conflict check when it's written, and only HOST_SESSION_COLUMNS on a host's session). A new
 * date while people are booked on the current one is refused first.
 */
async function queueSheetEdit(db: D1Database, admin: AuthUser, form: AdminEventForm, b: SaveBody, now: Date, dryRun = false) {
  const cols = COLUMNS[form.kind === 'standard_diary' ? 'standard_diary' : 'event_index'];
  const values: Record<string, string> = {};
  for (const [f, v] of Object.entries(b.details ?? {})) if (cols[f as DetailField]) values[cols[f as DetailField]!] = v as string;
  Object.assign(values, b.sheet ?? {});
  if (b.visibility !== undefined) values['App Visibility'] = b.visibility;
  if (b.active === false) {
    if (form.kind === 'event_index') values.Status = 'Inactive';
    else values['App Visibility'] = 'hidden';
  }
  if (b.active === true && form.kind === 'event_index') values.Status = 'Active';
  if (values[cols.event_date!] !== undefined && values[cols.event_date!] !== form.details.event_date) {
    const refused = await refuseBookedMove(db, form.event_id, form.details.event_date || null);
    if (refused) return refused;
  }
  return requestEdit(db, admin, form.event_id, { values, note: b.note, confirm: b.confirm }, now, { dryRun });
}

// ---- Stopping ----

export type StopResult =
  | { ok: true; cancelled_dates: number; cancelled_bookings: number; sheet_edit?: SheetEdit; change?: ChangeRequest; note?: string }
  | Fail
  | { ok: false; status: 409; warning: { dates: number; bookings: number; people: number } };

/**
 * Stop running an event. Body: { message?, confirm? }. With people booked on dates to come, asks
 * first (409 { warning }); then cancels each of those dates (everyone booked is emailed, with the
 * message) and only then takes the event out: Status Inactive in Event Index, hidden for a
 * Standard Diary group (that tab has no Status column), or an admin change for a host session.
 * Nothing is cancelled while another change to the event is still on its way.
 */
export async function stopEvent(db: D1Database, admin: AuthUser, eventId: string, body: unknown, ctx: { now: Date; origin: string }): Promise<StopResult> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  const form = await eventForm(db, eventId, ctx.now);
  if (!form) return { ok: false, status: 404, error: 'No event with that ID.' };
  if (form.kind === 'market') return { ok: false, status: 409, error: 'Change markets under Markets.' };
  const stopped = form.kind === 'standard_diary' ? form.visibility === 'hidden' : !form.active;
  if (stopped) return { ok: false, status: 409, error: "This event isn't running." };
  if (form.pending) {
    const what =
      form.pending.kind === 'sheet_edit' ? 'A change to this event is still on its way to the Logic Engine' : 'The host has asked for a change to this session';
    return { ok: false, status: 409, error: `${what} (${form.pending.id}). Deal with that first, then stop it.` };
  }
  // Everything the last step will check, checked before any date is cancelled.
  if (form.kind === 'host_session') {
    const today = londonDate(ctx.now);
    if (!(await liveDetails(db, form.session_id!, today)))
      return { ok: false, status: 409, error: "This session isn't in the diary, so it can't be stopped here." };
    const refused = await adminChangeRefusal(db, eventId, today, form.session_id!);
    if (refused) return refused;
  } else {
    const refused = await sheetEditRefusal(db, eventId);
    if (refused) return refused;
  }
  const b = (body && typeof body === 'object' ? body : {}) as { message?: unknown; confirm?: unknown };
  const iso = ctx.now.toISOString();
  const { results: booked } = await db
    .prepare(
      `SELECT o.occurrence_id, COUNT(b.booking_id) AS bookings, SUM(b.party_size) AS people
       FROM occurrences o JOIN bookings b ON b.occurrence_id = o.occurrence_id AND b.status = 'confirmed'
       WHERE o.event_id = ?1 AND o.status = 'scheduled' AND o.event_date >= ?2
         AND (o.starts_at IS NULL OR o.starts_at > ?3) -- a date already under way is left as it is
       GROUP BY o.occurrence_id ORDER BY o.event_date`,
    )
    .bind(eventId, londonDate(ctx.now), iso)
    .all<{ occurrence_id: string; bookings: number; people: number }>();
  const warning = { dates: booked.length, bookings: booked.reduce((n, d) => n + d.bookings, 0), people: booked.reduce((n, d) => n + d.people, 0) };
  if (booked.length && b.confirm !== true) return { ok: false, status: 409, warning };

  let cancelled = 0;
  for (const d of booked) {
    const res = await cancelDate(db, admin, d.occurrence_id, b.message, { now: iso, origin: ctx.origin });
    if (!res.ok) return res;
    cancelled += res.cancelled_bookings;
  }
  const out: Extract<StopResult, { ok: true }> = { ok: true, cancelled_dates: booked.length, cancelled_bookings: cancelled };
  if (form.kind === 'host_session') {
    const res = await adminChange(
      db,
      admin,
      form.session_id!,
      { active: false, note: typeof b.message === 'string' ? b.message : undefined },
      { now: iso, origin: ctx.origin },
    );
    if (!res.ok) return res;
    out.change = res.request ?? undefined;
  } else {
    const res = await queueSheetEdit(db, admin, form, { details: {}, active: false, confirm: true }, ctx.now);
    if (!res.ok) return 'warning' in res ? { ok: false, status: 409, error: String(res.warning) } : res;
    out.sheet_edit = res.edit ?? undefined;
    if (form.kind === 'standard_diary') out.note = "The Standard Diary has no Status column, so it's hidden instead.";
  }
  await db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, new_value, source, created_at)
       VALUES ('event', ?1, 'staff', ?2, 'event.stopped', ?3, 'organiser', ?4)`,
    )
    .bind(eventId, admin.email, JSON.stringify({ cancelled_dates: booked.length, cancelled_bookings: cancelled }), iso)
    .run();
  return out;
}
