// The admin event editor (docs/superpowers/specs/2026-10-18-admin-event-editor-design.md). Admins
// see every event in one list (café events from both tabs, host sessions and markets; public,
// private or hidden; running or stopped) and open any of them in one form. Saving never writes
// event details here: each field goes through the route that already owns it, so every check
// stays in place (the Logic Engine's conflict check, the host's approval path, places never
// below what's booked).

import { setBookingMode, setSessionPlaces } from '../bookings/places';
import { adminChange, type ChangeRequest } from '../host/changes';
import type { AuthUser } from '../lib/auth';
import { BOOKING_MODE, CAPACITY, type BookingMode } from '../lib/queries';
import { londonDate } from '../lib/time';
import { IN_LAST_SYNC, OPEN, type SheetEdit } from '../sync/edits';

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
  /** A change still on its way: a Logic Engine edit, or a host's request waiting for a decision. */
  pending: { kind: 'sheet_edit' | 'host_change'; id: string } | null;
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
  unavailable: Partial<Record<DetailField | 'active', string>>;
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

const NO_DIARY_COLUMN = "The Standard Diary tab has no column for this: it's set in the sheet's Notes.";
const UNAVAILABLE: Record<EventKind, AdminEventForm['unavailable']> = {
  event_index: {},
  host_session: { category: "Set in the Logic Engine's App Category column." },
  standard_diary: {
    start_time: NO_DIARY_COLUMN,
    end_time: NO_DIARY_COLUMN,
    price: NO_DIARY_COLUMN,
    active: 'The Standard Diary has no Status column: Stop running hides the group instead.',
  },
  market: Object.fromEntries([...FIELDS, 'active'].map(f => [f, 'Change markets under Markets.'])),
};

const BOOKED = `(SELECT COALESCE(SUM(b.party_size), 0) FROM bookings b WHERE b.occurrence_id = o.occurrence_id AND b.status = 'confirmed')`;
const KIND = `CASE WHEN e.market_id IS NOT NULL THEN 'market' WHEN e.host_session_id IS NOT NULL THEN 'host_session' ELSE e.source END`;
const ROW_FIELDS = `e.event_id, e.display_name AS name, ${KIND} AS kind, e.visibility, e.active,
  (SELECT MIN(o.event_date) FROM occurrences o WHERE o.event_id = e.event_id AND o.status = 'scheduled' AND o.event_date >= ?1) AS next_date,
  (SELECT COUNT(*) FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
     WHERE o.event_id = e.event_id AND b.status = 'confirmed' AND o.status = 'scheduled' AND o.event_date >= ?1) AS bookings,
  (SELECT s.edit_id FROM sheet_edits s WHERE s.event_id = e.event_id AND ${OPEN} ORDER BY s.created_at DESC LIMIT 1) AS open_edit,
  (SELECT r.request_id FROM event_change_requests r WHERE r.event_id = e.event_id AND r.status = 'pending' LIMIT 1) AS open_change`;

const shapeRow = (r: Record<string, unknown>): AdminEventRow => ({
  event_id: String(r.event_id),
  name: String(r.name),
  kind: r.kind as EventKind,
  next_date: (r.next_date as string | null) ?? null,
  visibility: r.visibility as Visibility,
  active: r.active === 1,
  bookings: Number(r.bookings),
  pending: r.open_edit ? { kind: 'sheet_edit', id: String(r.open_edit) } : r.open_change ? { kind: 'host_change', id: String(r.open_change) } : null,
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
         (SELECT o.end_time FROM occurrences o WHERE o.event_id = e.event_id AND o.status = 'scheduled' AND o.event_date >= ?1 ORDER BY o.event_date LIMIT 1) AS next_end
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
  visibility?: Visibility;
  active?: false;
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
  if (b.visibility !== undefined && !VISIBILITIES.includes(b.visibility as Visibility)) errors.visibility = 'Choose Public, App Bookable, Private or Hidden.';
  if (b.active !== undefined && b.active !== false) errors.active = 'Use Stop running this event to stop it.';
  if (Object.keys(errors).length) return { ok: false, status: 400, error: 'Please check the form', errors };
  return { ...(b as SaveBody), details: details as Partial<Details> };
};
const failed = (v: SaveBody | Fail): v is Fail => 'ok' in v && v.ok === false;

/**
 * Body: SaveBody, with only what changed. Each part goes through the route that owns it, details
 * first; places and booking only once the details are on their way. 409 { warning } asks to send
 * again with confirm: true.
 */
export async function saveEvent(db: D1Database, admin: AuthUser, eventId: string, body: unknown, ctx: { now: Date; origin: string }): Promise<SaveResult> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  const form = await eventForm(db, eventId, ctx.now);
  if (!form) return { ok: false, status: 404, error: 'No event with that ID.' };
  const b = parseBody(body);
  if (failed(b)) return b;
  if (form.kind === 'market') return { ok: false, status: 409, error: 'Change markets under Markets.' };
  const blocked = Object.keys(b.details ?? {}).filter(f => f in form.unavailable && b.details![f as DetailField] !== form.details[f as DetailField]);
  if (blocked.length)
    return { ok: false, status: 400, error: 'Please check the form', errors: Object.fromEntries(blocked.map(f => [f, form.unavailable[f as DetailField]!])) };

  const iso = ctx.now.toISOString();
  const out: Extract<SaveResult, { ok: true }> = { ok: true };
  const hasDetails = Object.keys(b.details ?? {}).length > 0 || b.visibility !== undefined || b.active === false;
  if (form.kind === 'host_session') {
    if (hasDetails) {
      const res = await adminChange(
        db,
        admin,
        form.session_id!,
        { details: b.details, visibility: b.visibility, active: b.active, note: b.note },
        { now: iso, origin: ctx.origin },
      );
      if (!res.ok) return res;
      out.change = res.request;
    }
    if (b.places !== undefined) {
      if (b.places === null)
        return { ok: false, status: 400, error: 'Please check the form', errors: { places: "A host's session always has a number of places." } };
      const res = await setSessionPlaces(db, admin, form.session_id!, b.places, { now: iso, today: londonDate(ctx.now) });
      if (!res.ok) return res;
      out.places = res.places;
    }
  }
  if (b.booking_mode !== undefined) {
    const res = await setBookingMode(db, admin, eventId, { mode: b.booking_mode, confirm: b.confirm }, { now: iso, today: londonDate(ctx.now) });
    if (!res.ok) return res;
    out.booking_mode = res.booking_mode;
  }
  return out;
}
