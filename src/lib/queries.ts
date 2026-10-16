// Shared public-read SQL. Visible = event active and effective visibility
// public/app_bookable. Hidden never leaves the database; Private only reaches
// the diary list, as a "Private session" with its time (see redactPrivate).
// The public only ever sees dates still to come or still running (`upcoming`).

import { addDays, londonDate, londonToUtc } from './time';

export const OCCURRENCE_ID = /^RTD-OCC-\d{5,}-\d{8}$/;
export const EVENT_ID = /^RTD-EVT-\d{5,}$/;

export const VISIBLE = `e.active = 1 AND COALESCE(o.visibility, e.visibility) IN ('public', 'app_bookable')`;

/** The diary list also shows private sessions, so the café looks as busy as it is. */
export const LISTED = `e.active = 1 AND COALESCE(o.visibility, e.visibility) IN ('public', 'app_bookable', 'private')`;

/**
 * Still to come or still running (docs/RTD_EVENT_CONTROL_AUDIT.md, G-1): scheduled, and
 * its end is in the future. A date with no times is all day and lasts until London
 * midnight; a missing end time was stored as start + 1 hour (src/lib/time.ts). The
 * arguments are the placeholders bound to now (UTC ISO) and today (London date).
 * Mirrors `hasEnded` below and web/src/lib/upcoming.ts.
 */
export const upcoming = (now: string, today: string) =>
  `o.status = 'scheduled' AND CASE WHEN o.ends_at IS NOT NULL THEN o.ends_at > ${now} ELSE o.event_date >= ${today} END`;

type Ends = { date: string; ends_at: string | null };

/** When a date stops being public: its end, or London midnight after an all-day date. */
export const publicUntil = (o: Ends) => o.ends_at ?? londonToUtc(addDays(o.date, 1), '00:00');

export const hasEnded = (o: Ends, now: Date) => Date.parse(publicUntil(o)) <= now.getTime();

/** Public caching that never outlasts what it shows: 60 seconds at most, and never past the first end among them. */
export function publicCache(list: Ends[], now: Date): { 'Cache-Control': string } {
  const seconds = Math.min(60, ...list.map(o => Math.floor((Date.parse(publicUntil(o)) - now.getTime()) / 1000)));
  return { 'Cache-Control': `public, max-age=${Math.max(0, seconds)}` };
}

export type GoneReason = 'finished' | 'cancelled' | 'moved';

/** Why a visible event's date is no longer public, or null while it's still to come. */
export function goneReason(o: PublicOccurrence, now: Date): GoneReason | null {
  if (o.status === 'cancelled') return 'cancelled';
  if (o.status === 'rescheduled') return 'moved';
  return o.status !== 'scheduled' || hasEnded(o, now) ? 'finished' : null;
}

/**
 * Places on a date (o = occurrences, e = events): that date's own number, else
 * the event's set in the organiser, else the sheet's App Capacity. NULL: no limit.
 */
export const CAPACITY = 'COALESCE(o.capacity, e.capacity_override, e.default_capacity)';

export type BookingMode = 'none' | 'optional' | 'required';
export const BOOKING_MODES: BookingMode[] = ['none', 'optional', 'required'];

/**
 * Whether people need to book (e = events; docs/RTD_EVENT_CONTROL_AUDIT.md G-5): set in
 * the organiser, else by kind. Markets: Not required (vendors apply instead). Hosts'
 * sessions: Required. Standard Diary groups (room bookings): Not required. The café's
 * own events: Optional.
 */
export const DEFAULT_BOOKING_MODE = `CASE WHEN e.market_id IS NOT NULL THEN 'none' WHEN e.host_session_id IS NOT NULL THEN 'required'
  WHEN e.source = 'standard_diary' THEN 'none' ELSE 'optional' END`;
export const BOOKING_MODE = `COALESCE(e.booking_mode, ${DEFAULT_BOOKING_MODE})`;

export const OCCURRENCE_FIELDS = `
  o.occurrence_id, o.event_id, e.display_name AS name, e.category,
  COALESCE(o.description_override, e.description) AS description,
  o.event_date AS date, o.start_time, o.end_time, o.starts_at, o.ends_at, o.all_day, o.projected,
  o.status, o.rescheduled_to, COALESCE(o.visibility, e.visibility) AS visibility,
  COALESCE(o.image_override, e.default_image) AS image,
  COALESCE(o.price_display, e.price_display) AS price_display, ${CAPACITY} AS capacity, e.market_id, ${BOOKING_MODE} AS booking_mode,
  CASE WHEN COALESCE(o.visibility, e.visibility) IN ('public', 'app_bookable') AND e.market_id IS NULL AND ${BOOKING_MODE} <> 'none'
    AND (e.host_session_id IS NULL OR ${CAPACITY} IS NOT NULL) THEN 1 ELSE 0 END AS bookable`;

export type Row = Record<string, unknown>;

export interface PublicOccurrence {
  occurrence_id: string;
  event_id: string;
  name: string;
  category: string;
  description: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  projected: boolean;
  status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled';
  rescheduled_to: string | null;
  visibility: string;
  image: string | null;
  price_display: string | null;
  /** Places on this date; null: no limit. */
  capacity: number | null;
  /** Whether people need to book: Not required, Optional or Required (BOOKING_MODE). */
  booking_mode: BookingMode;
  /** Takes bookings in the app: public, and booking Optional or Required (docs/RTD_BOOKINGS.md). */
  bookable: boolean;
  /** A market set up in the organiser: vendors apply for pitches (docs/RTD_MARKETS.md). */
  market_id: string | null;
}

export function shape(r: Row): PublicOccurrence {
  return { ...r, all_day: r.all_day === 1, projected: r.projected === 1, bookable: r.bookable === 1 } as unknown as PublicOccurrence;
}

/**
 * One occurrence of a visible event, whatever its status. Callers check
 * `goneReason` before showing anything: an old link only learns that the date
 * has finished, was cancelled or has moved.
 */
export async function findOccurrence(db: D1Database, id: string): Promise<PublicOccurrence | null> {
  if (!OCCURRENCE_ID.test(id)) return null;
  const row = await db
    .prepare(`SELECT ${OCCURRENCE_FIELDS} FROM occurrences o JOIN events e ON e.event_id = o.event_id WHERE o.occurrence_id = ?1 AND ${VISIBLE}`)
    .bind(id)
    .first<Row>();
  return row ? shape(row) : null;
}

/** The next date of a visible event that's still to come or still running. */
export async function nextOccurrence(db: D1Database, eventId: string, now: Date): Promise<PublicOccurrence | null> {
  if (!EVENT_ID.test(eventId)) return null;
  const row = await db
    .prepare(
      `SELECT ${OCCURRENCE_FIELDS} FROM occurrences o JOIN events e ON e.event_id = o.event_id
       WHERE o.event_id = ?1 AND ${VISIBLE} AND ${upcoming('?2', '?3')}
       ORDER BY o.event_date, COALESCE(o.start_time, '00:00') LIMIT 1`,
    )
    .bind(eventId, now.toISOString(), londonDate(now))
    .first<Row>();
  return row ? shape(row) : null;
}

/**
 * What the public may know about a private session: that one is on, and when.
 * The name, description, photo, price and size never leave the server.
 */
export function redactPrivate(o: PublicOccurrence): PublicOccurrence {
  if (o.visibility !== 'private') return o;
  return { ...o, name: 'Private session', description: null, image: null, price_display: null, capacity: null, bookable: false, booking_mode: 'none', market_id: null };
}
