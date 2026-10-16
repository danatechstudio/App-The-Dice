// Editing one date in the app (docs/RTD_EVENT_CONTROL_AUDIT.md §5, Stage 5b), for approvers
// and admins: the fields only the app owns, which the Logic Engine sync never touches
// (occurrences.visibility, description_override, price_display).
// - Hide this date in the app, or show it again. Hiding never makes anything public that the
//   sheet hides: a date can only be hidden, or put back to its event's visibility. People
//   already booked keep their bookings; hiding a booked date asks first.
// - A description and a price label for this date only (empty: the event's own).
// Every change is in the audit log with the values before and after. Dates and times, names
// and whether an event runs are the Logic Engine's: they're changed there (Stage 6 brings
// them into the app).

import type { AuthUser } from '../lib/auth';
import { OCCURRENCE_ID, upcoming } from '../lib/queries';
import { addDays, londonDate } from '../lib/time';

const DESCRIPTION_MAX = 1000;
const PRICE_MAX = 30;
/** How far ahead the list goes. */
const DAYS = 28;

const DATE_FIELDS = `
  o.occurrence_id, o.event_id, e.display_name AS name, e.source, e.frequency, e.host_session_id, e.market_id,
  o.event_date AS date, o.start_time, o.end_time, e.visibility AS event_visibility, o.visibility = 'hidden' AS hidden,
  e.description AS event_description, o.description_override AS description, e.price_display AS event_price, o.price_display AS price,
  (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = o.occurrence_id AND b.status = 'confirmed') AS bookings,
  (SELECT COALESCE(SUM(b.party_size), 0) FROM bookings b WHERE b.occurrence_id = o.occurrence_id AND b.status = 'confirmed') AS people`;

export interface DateRow {
  occurrence_id: string;
  event_id: string;
  name: string;
  source: string;
  frequency: string;
  host_session_id: string | null;
  market_id: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  event_visibility: string;
  /** Hidden in the app, for this date only. */
  hidden: boolean;
  event_description: string | null;
  /** This date's own description, or null for the event's. */
  description: string | null;
  event_price: string | null;
  /** This date's own price label, or null for the event's. */
  price: string | null;
  bookings: number;
  people: number;
}

const shape = (r: Record<string, unknown>): DateRow => ({ ...(r as unknown as DateRow), hidden: r.hidden === 1 });

/**
 * Dates still to come in the next four weeks, for every event the diary lists (and dates
 * hidden here, so they can be shown again). Oldest first.
 */
export async function listDates(db: D1Database, now: Date): Promise<DateRow[]> {
  const today = londonDate(now);
  const { results } = await db
    .prepare(
      `SELECT ${DATE_FIELDS} FROM occurrences o JOIN events e ON e.event_id = o.event_id
       WHERE e.active = 1 AND e.visibility IN ('public', 'app_bookable', 'private') AND ${upcoming('?1', '?2')} AND o.event_date <= ?3
       ORDER BY o.event_date, COALESCE(o.start_time, '00:00'), e.display_name LIMIT 200`,
    )
    .bind(now.toISOString(), today, addDays(today, DAYS))
    .all<Record<string, unknown>>();
  return results.map(shape);
}

type Fail = { ok: false; status: 400 | 404 | 409; error: string; errors?: Record<string, string> };

/**
 * Body: { hidden?: boolean, description?: string | null, price?: string | null, confirm?: boolean }.
 * Only what's given changes. An empty description or price goes back to the event's own.
 * Hiding a date people have booked needs confirm: true; the answer says how many.
 */
export async function editDate(
  db: D1Database,
  actor: AuthUser,
  occurrenceId: string,
  body: unknown,
  now: Date,
): Promise<{ ok: true; date: DateRow } | Fail | { ok: false; status: 409; warning: { bookings: number; people: number } }> {
  if (!OCCURRENCE_ID.test(occurrenceId)) return { ok: false, status: 404, error: 'No date with that ID.' };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const row = await db
    .prepare(`SELECT ${DATE_FIELDS} FROM occurrences o JOIN events e ON e.event_id = o.event_id WHERE o.occurrence_id = ?1 AND ${upcoming('?2', '?3')}`)
    .bind(occurrenceId, now.toISOString(), londonDate(now))
    .first<Record<string, unknown>>();
  if (!row) return { ok: false, status: 404, error: "That date isn't coming up, so it can't be changed here." };
  const d = shape(row);

  const errors: Record<string, string> = {};
  const next: { hidden?: boolean; description?: string | null; price?: string | null } = {};
  if ('hidden' in b) {
    if (typeof b.hidden !== 'boolean') errors.hidden = 'Choose shown or hidden.';
    else next.hidden = b.hidden;
  }
  if ('description' in b) {
    const v = typeof b.description === 'string' ? b.description.trim() : b.description === null ? '' : undefined;
    if (v === undefined) errors.description = 'The description must be text.';
    else if (v.length > DESCRIPTION_MAX) errors.description = `Keep it to ${DESCRIPTION_MAX} characters.`;
    // The same as the event's own is no override at all.
    else next.description = v && v !== (d.event_description ?? '').trim() ? v : null;
  }
  if ('price' in b) {
    const v = typeof b.price === 'string' ? b.price.replace(/\s+/g, ' ').trim() : b.price === null ? '' : undefined;
    if (v === undefined) errors.price = 'The price must be text, like £5 or Free.';
    else if (v.length > PRICE_MAX) errors.price = `Keep it to ${PRICE_MAX} characters, like £5 or Free.`;
    else next.price = v && v !== (d.event_price ?? '') ? v : null;
  }
  if (Object.keys(errors).length) return { ok: false, status: 400, error: 'Please check the form', errors };

  const changed = (Object.keys(next) as (keyof typeof next)[]).filter(k => next[k] !== d[k]);
  if (!changed.length) return { ok: true, date: d };
  if (next.hidden === true && !d.hidden && d.bookings > 0 && b.confirm !== true) {
    return { ok: false, status: 409, warning: { bookings: d.bookings, people: d.people } };
  }
  const before = Object.fromEntries(changed.map(k => [k, d[k]]));
  const after = Object.fromEntries(changed.map(k => [k, next[k]]));
  const iso = now.toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE occurrences SET
           visibility = CASE WHEN ?2 = 1 THEN (CASE WHEN ?3 = 1 THEN 'hidden' ELSE NULL END) ELSE visibility END,
           description_override = CASE WHEN ?4 = 1 THEN ?5 ELSE description_override END,
           price_display = CASE WHEN ?6 = 1 THEN ?7 ELSE price_display END,
           updated_at = ?8
         WHERE occurrence_id = ?1`,
      )
      .bind(
        occurrenceId,
        changed.includes('hidden') ? 1 : 0, next.hidden ? 1 : 0,
        changed.includes('description') ? 1 : 0, next.description ?? null,
        changed.includes('price') ? 1 : 0, next.price ?? null,
        iso,
      ),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, occurrence_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         VALUES ('occurrence', ?1, ?2, 'staff', ?3, 'occurrence.edited', ?4, ?5, 'organiser', ?6)`,
      )
      .bind(d.event_id, occurrenceId, actor.email, JSON.stringify(before), JSON.stringify(after), iso),
  ]);
  const fresh = await db.prepare(`SELECT ${DATE_FIELDS} FROM occurrences o JOIN events e ON e.event_id = o.event_id WHERE o.occurrence_id = ?1`).bind(occurrenceId).first<Record<string, unknown>>();
  return { ok: true, date: shape(fresh!) };
}
