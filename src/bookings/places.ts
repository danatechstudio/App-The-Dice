// Places on an event (docs/RTD_BOOKINGS.md#places). A host changes their own
// live session's places, for every date or one date; an approver sets a café
// event's places (instead of App Capacity in the sheet), or any one date's.
// Never below the number already booked on a date it applies to.

import type { AuthUser } from '../lib/auth';
import { shortDate } from '../lib/format';
import { londonDate } from '../lib/time';

/** Most places on a date: a host's session (as Max players), or a café event. */
export const MAX_PLACES = { hosted: 100, cafe: 500 } as const;

type Fail = { ok: false; status: 400 | 403 | 404 | 409; error: string; errors?: Record<string, string> };

const BOOKED = `(SELECT COALESCE(SUM(b.party_size), 0) FROM bookings b WHERE b.occurrence_id = o.occurrence_id AND b.status = 'confirmed')`;

/** A whole number of places from 1 to max; null (when allowed) clears it. */
function parsePlaces(v: unknown, max: number, allowNull: boolean): number | null | Fail {
  if (v === null && allowNull) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) {
    const error = `Choose between 1 and ${max} places.`;
    return { ok: false, status: 400, error, errors: { places: error } };
  }
  return v;
}
const failed = (v: number | null | Fail): v is Fail => v !== null && typeof v === 'object';

interface UpcomingDate {
  occurrence_id: string;
  event_date: string;
  booked: number;
}

/** An event's dates still to come, with how many are booked on each. */
async function upcomingDates(db: D1Database, eventId: string, today: string): Promise<UpcomingDate[]> {
  const { results } = await db
    .prepare(
      `SELECT o.occurrence_id, o.event_date, ${BOOKED} AS booked FROM occurrences o
       WHERE o.event_id = ?1 AND o.status = 'scheduled' AND o.event_date >= ?2 ORDER BY o.event_date`,
    )
    .bind(eventId, today)
    .all<UpcomingDate>();
  return results;
}

/** Refuses a number below what's already booked on any of the dates. */
function belowBooked(dates: { event_date: string; booked: number }[], places: number | null): Fail | null {
  if (places === null) return null;
  const worst = dates.filter(d => d.booked > places).sort((a, b) => b.booked - a.booked || a.event_date.localeCompare(b.event_date))[0];
  if (!worst) return null;
  const error = `${worst.booked} places are already booked on ${shortDate(worst.event_date)}, so it can't go below ${worst.booked}.`;
  return { ok: false, status: 409, error, errors: { places: error } };
}

const audit = (db: D1Database, type: string, id: string, occurrenceId: string | null, actorType: 'host' | 'staff', actor: AuthUser, prev: number | null, next: number | null, now: string) =>
  db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, occurrence_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'organiser', ?9)`,
    )
    .bind(type, id, occurrenceId, actorType, actor.email, `${type}.places_changed`, prev === null ? null : String(prev), next === null ? null : String(next), now);

/** The dates from today on stop having their own number, so a new number for every date reaches them all. */
const clearDatePlaces = (db: D1Database, eventId: string, today: string, now: string) =>
  db
    .prepare("UPDATE occurrences SET capacity = NULL, updated_at = ?3 WHERE event_id = ?1 AND event_date >= ?2 AND status = 'scheduled' AND capacity IS NOT NULL")
    .bind(eventId, today, now);

/**
 * A host changes the places on every date of their own live session. It
 * becomes its Max players too; no new approval is needed.
 */
export async function setSessionPlaces(
  db: D1Database,
  actor: AuthUser,
  sessionId: string,
  value: unknown,
  ctx: { now: string; today: string },
): Promise<{ ok: true; places: number } | Fail> {
  const s = await db
    .prepare('SELECT session_id, host_user_id, status, event_id, max_players, deleted_at FROM host_sessions WHERE session_id = ?1')
    .bind(sessionId)
    .first<{ session_id: string; host_user_id: string; status: string; event_id: string | null; max_players: number; deleted_at: string | null }>();
  if (!s || s.deleted_at) return { ok: false, status: 404, error: 'No session with that ID.' };
  if (s.host_user_id !== actor.user_id) return { ok: false, status: 403, error: 'You can only change your own sessions.' };
  if (s.status !== 'published' || !s.event_id) {
    return { ok: false, status: 409, error: "You can change places once the session is live. Until then, withdraw it and send it again with the new number." };
  }
  const places = parsePlaces(value, MAX_PLACES.hosted, false);
  if (failed(places)) return places;
  const tooFew = belowBooked(await upcomingDates(db, s.event_id, ctx.today), places);
  if (tooFew) return tooFew;
  await db.batch([
    db.prepare('UPDATE host_sessions SET max_players = ?2, updated_at = ?3 WHERE session_id = ?1').bind(sessionId, places, ctx.now),
    db.prepare('UPDATE events SET capacity_override = ?2, updated_at = ?3 WHERE event_id = ?1').bind(s.event_id, places, ctx.now),
    clearDatePlaces(db, s.event_id, ctx.today, ctx.now),
    audit(db, 'host_session', sessionId, null, 'host', actor, s.max_players, places, ctx.now),
  ]);
  return { ok: true, places: places! };
}

/**
 * Places on one date: the host of the session, or an approver for any date.
 * null puts the date back to the same number as the others.
 */
export async function setDatePlaces(
  db: D1Database,
  actor: AuthUser,
  occurrenceId: string,
  value: unknown,
  ctx: { now: string },
): Promise<{ ok: true; capacity: number | null } | Fail> {
  const d = await db
    .prepare(
      `SELECT o.occurrence_id, o.event_id, o.event_date, o.status, o.starts_at, o.capacity AS own,
         COALESCE(e.capacity_override, e.default_capacity) AS event_places, h.host_user_id, ${BOOKED} AS booked
       FROM occurrences o JOIN events e ON e.event_id = o.event_id
       LEFT JOIN host_sessions h ON h.session_id = e.host_session_id
       WHERE o.occurrence_id = ?1`,
    )
    .bind(occurrenceId)
    .first<{ occurrence_id: string; event_id: string; event_date: string; status: string; starts_at: string | null; own: number | null; event_places: number | null; host_user_id: string | null; booked: number }>();
  if (!d) return { ok: false, status: 404, error: 'Nothing is on that date.' };
  const hosted = !!d.host_user_id;
  const owner = hosted && d.host_user_id === actor.user_id;
  if (!owner && actor.role === 'host') return { ok: false, status: 403, error: 'You can only change your own sessions.' };
  if (d.status !== 'scheduled') return { ok: false, status: 409, error: "That date isn't on any more." };
  const started = d.starts_at ? d.starts_at <= ctx.now : d.event_date < londonDate(new Date(ctx.now));
  if (started) return { ok: false, status: 409, error: 'That has already started.' };
  const places = parsePlaces(value, hosted ? MAX_PLACES.hosted : MAX_PLACES.cafe, true);
  if (failed(places)) return places;
  const capacity = places ?? d.event_places;
  const tooFew = belowBooked([d], capacity);
  if (tooFew) return tooFew;
  await db.batch([
    db.prepare('UPDATE occurrences SET capacity = ?2, updated_at = ?3 WHERE occurrence_id = ?1').bind(occurrenceId, places, ctx.now),
    audit(db, 'occurrence', d.event_id, occurrenceId, owner ? 'host' : 'staff', actor, d.own, places, ctx.now),
  ]);
  return { ok: true, capacity };
}

/**
 * An approver sets the places on every date of a café event, instead of App
 * Capacity in the sheet. null goes back to the sheet's number (or no limit).
 * Hosts' sessions are theirs to change, apart from single dates.
 */
export async function setEventPlaces(
  db: D1Database,
  actor: AuthUser,
  eventId: string,
  value: unknown,
  ctx: { now: string; today: string },
): Promise<{ ok: true; capacity: number | null } | Fail> {
  const e = await db
    .prepare('SELECT event_id, host_session_id, market_id, default_capacity, capacity_override FROM events WHERE event_id = ?1 AND active = 1')
    .bind(eventId)
    .first<{ event_id: string; host_session_id: string | null; market_id: string | null; default_capacity: number | null; capacity_override: number | null }>();
  if (!e) return { ok: false, status: 404, error: 'No event with that ID.' };
  if (e.market_id) return { ok: false, status: 409, error: 'Customers don\'t book markets set up in the app. Change its pitches under Markets.' };
  if (e.host_session_id) {
    return { ok: false, status: 409, error: "This is a host's session, so the host sets its places. You can change a single date under Bookings coming up." };
  }
  const places = parsePlaces(value, MAX_PLACES.cafe, true);
  if (failed(places)) return places;
  const capacity = places ?? e.default_capacity;
  const tooFew = belowBooked(await upcomingDates(db, eventId, ctx.today), capacity);
  if (tooFew) return tooFew;
  await db.batch([
    db.prepare('UPDATE events SET capacity_override = ?2, updated_at = ?3 WHERE event_id = ?1').bind(eventId, places, ctx.now),
    clearDatePlaces(db, eventId, ctx.today, ctx.now),
    audit(db, 'event', eventId, null, 'staff', actor, e.capacity_override, places, ctx.now),
  ]);
  return { ok: true, capacity };
}

export interface EventPlaces {
  event_id: string;
  name: string;
  source: 'event_index' | 'standard_diary';
  frequency: string | null;
  next_date: string;
  /** App Capacity in the sheet (Event Index only). */
  sheet_places: number | null;
  /** Set in the organiser; wins over the sheet until App Capacity changes there. */
  app_places: number | null;
  /** What applies: app, else sheet. null: no limit. */
  places: number | null;
  /** The most booked on any date to come: the lowest it can go. */
  most_booked: number;
  /** Dates to come with their own number. */
  dates_with_own_places: number;
}

/** For approvers: every café event people can book, with its places. */
export async function cafeEventPlaces(db: D1Database, today: string): Promise<EventPlaces[]> {
  const { results } = await db
    .prepare(
      `SELECT e.event_id, e.display_name AS name, e.source, e.frequency, e.default_capacity AS sheet_places,
         e.capacity_override AS app_places, COALESCE(e.capacity_override, e.default_capacity) AS places,
         MIN(o.event_date) AS next_date, MAX(${BOOKED}) AS most_booked,
         SUM(CASE WHEN o.capacity IS NOT NULL THEN 1 ELSE 0 END) AS dates_with_own_places
       FROM events e JOIN occurrences o ON o.event_id = e.event_id AND o.status = 'scheduled' AND o.event_date >= ?1
       WHERE e.active = 1 AND e.host_session_id IS NULL AND e.market_id IS NULL AND e.visibility IN ('public', 'app_bookable')
       GROUP BY e.event_id
       ORDER BY next_date, name LIMIT 100`,
    )
    .bind(today)
    .all<EventPlaces>();
  return results;
}
