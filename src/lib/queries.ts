// Shared public-read SQL. Visible = event active and effective visibility
// public/app_bookable. Hidden never leaves the database; Private only reaches
// the diary list, as a "Private session" with its time (see redactPrivate).

export const OCCURRENCE_ID = /^RTD-OCC-\d{5,}-\d{8}$/;
export const EVENT_ID = /^RTD-EVT-\d{5,}$/;

export const VISIBLE = `e.active = 1 AND COALESCE(o.visibility, e.visibility) IN ('public', 'app_bookable')`;

/** The diary list also shows private sessions, so the café looks as busy as it is. */
export const LISTED = `e.active = 1 AND COALESCE(o.visibility, e.visibility) IN ('public', 'app_bookable', 'private')`;

/**
 * Places on a date (o = occurrences, e = events): that date's own number, else
 * the event's set in the organiser, else the sheet's App Capacity. NULL: no limit.
 */
export const CAPACITY = 'COALESCE(o.capacity, e.capacity_override, e.default_capacity)';

export const OCCURRENCE_FIELDS = `
  o.occurrence_id, o.event_id, e.display_name AS name, e.category,
  COALESCE(o.description_override, e.description) AS description,
  o.event_date AS date, o.start_time, o.end_time, o.starts_at, o.ends_at, o.all_day, o.projected,
  o.status, o.rescheduled_to, COALESCE(o.visibility, e.visibility) AS visibility,
  COALESCE(o.image_override, e.default_image) AS image,
  COALESCE(o.price_display, e.price_display) AS price_display, ${CAPACITY} AS capacity,
  CASE WHEN COALESCE(o.visibility, e.visibility) IN ('public', 'app_bookable')
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
  /** Takes bookings in the app: every public event (docs/RTD_BOOKINGS.md). */
  bookable: boolean;
}

export function shape(r: Row): PublicOccurrence {
  return { ...r, all_day: r.all_day === 1, projected: r.projected === 1, bookable: r.bookable === 1 } as unknown as PublicOccurrence;
}

/** One visible occurrence (any status, so old links can explain what happened). */
export async function findOccurrence(db: D1Database, id: string): Promise<PublicOccurrence | null> {
  if (!OCCURRENCE_ID.test(id)) return null;
  const row = await db
    .prepare(`SELECT ${OCCURRENCE_FIELDS} FROM occurrences o JOIN events e ON e.event_id = o.event_id WHERE o.occurrence_id = ?1 AND ${VISIBLE}`)
    .bind(id)
    .first<Row>();
  return row ? shape(row) : null;
}

/** The next scheduled, visible occurrence of an event. */
export async function nextOccurrence(db: D1Database, eventId: string, today: string): Promise<PublicOccurrence | null> {
  if (!EVENT_ID.test(eventId)) return null;
  const row = await db
    .prepare(
      `SELECT ${OCCURRENCE_FIELDS} FROM occurrences o JOIN events e ON e.event_id = o.event_id
       WHERE o.event_id = ?1 AND ${VISIBLE} AND o.status = 'scheduled' AND o.event_date >= ?2
       ORDER BY o.event_date LIMIT 1`,
    )
    .bind(eventId, today)
    .first<Row>();
  return row ? shape(row) : null;
}

/**
 * What the public may know about a private session: that one is on, and when.
 * The name, description, photo, price and size never leave the server.
 */
export function redactPrivate(o: PublicOccurrence): PublicOccurrence {
  if (o.visibility !== 'private') return o;
  return { ...o, name: 'Private session', description: null, image: null, price_display: null, capacity: null, bookable: false };
}
