// Bookings for open host sessions (docs/RTD_BOOKINGS.md).
//
// - Customers book without an account: name, email, optional mobile, party size.
//   Capacity is counted in people, never bookings, and checked inside the insert
//   itself, so two people booking the last places at once can't both get in.
// - A secret link (only its hash is stored) lets the customer see or cancel it.
// - The host is emailed for every booking and cancellation, and two days before
//   each date with the numbers. They (or an approver) can cancel a date: everyone
//   booked is emailed, and n8n takes the date out of the Logic Engine so it isn't
//   advertised.
// Emails go through the outbox (src/notify/outbox.ts) in the same transaction.

import type { AuthUser } from '../lib/auth';
import { places, ukDate } from '../lib/format';
import { OCCURRENCE_ID, VISIBLE } from '../lib/queries';
import { addDays, londonDate, londonHour } from '../lib/time';
import {
  attendeeDateCancelled,
  bookingConfirmed,
  dateCancelledNotice,
  hostBookingCancelled,
  hostNewBooking,
  hostNumbers,
  type Links,
  type Slot,
} from '../notify/emails';
import { queue, queueForBooking } from '../notify/outbox';

export const MAX_PARTY = 10;
/** Bookings one email address can make in a day, and one network address in an hour. */
const PER_EMAIL_PER_DAY = 5;
const PER_IP_PER_HOUR = 10;

interface SlotRow extends Slot {
  event_id: string;
  starts_at: string | null;
  status: string;
  host_session_id: string;
  host_user_id: string;
  host_email: string;
  host_active: number;
  access: string;
  visible: number;
  booked: number;
}

/** One date of a host session, with its host and how many places are taken. */
const SLOT_SQL = `
  SELECT o.occurrence_id, o.event_id, o.event_date, o.start_time, o.end_time, o.starts_at, o.status,
    e.display_name AS name, COALESCE(o.price_display, e.price_display) AS price_display,
    COALESCE(o.capacity, e.default_capacity) AS capacity, e.host_session_id,
    h.host_user_id, h.access, u.email AS host_email, u.display_name AS host_name, u.active AS host_active,
    CASE WHEN ${VISIBLE} THEN 1 ELSE 0 END AS visible,
    (SELECT COALESCE(SUM(b.party_size), 0) FROM bookings b WHERE b.occurrence_id = o.occurrence_id AND b.status = 'confirmed') AS booked
  FROM occurrences o
  JOIN events e ON e.event_id = o.event_id
  JOIN host_sessions h ON h.session_id = e.host_session_id
  JOIN users u ON u.user_id = h.host_user_id`;

async function findSlot(db: D1Database, occurrenceId: string): Promise<SlotRow | null> {
  if (!OCCURRENCE_ID.test(occurrenceId)) return null;
  return db.prepare(`${SLOT_SQL} WHERE o.occurrence_id = ?1`).bind(occurrenceId).first<SlotRow>();
}

/** Where host emails go: the host, or the café if their access was removed. */
const hostInbox = (s: SlotRow) => (s.host_active ? s.host_email : null);
const started = (s: { starts_at: string | null; event_date: string }, now: string) =>
  s.starts_at ? s.starts_at <= now : s.event_date < londonDate(new Date(now));

const audit = (db: D1Database, type: string, id: string, occurrenceId: string | null, actorType: string, actor: string, action: string, next: unknown, now: string) =>
  db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, occurrence_id, actor_type, actor_id, action, new_value, source, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'app', ?8)`,
    )
    .bind(type, id, occurrenceId, actorType, actor, action, next === null ? null : JSON.stringify(next), now);

// ---- Availability ----

export type Availability =
  | { bookable: false }
  | { bookable: true; open: boolean; reason: 'full' | 'closed' | 'cancelled' | null; capacity: number; places_left: number; max_party: number };

function availabilityOf(s: SlotRow | null, now: string): Availability {
  // Only open host sessions with a size can be booked; private ones are the host's own group.
  if (!s || !s.visible || s.access !== 'open' || !s.capacity) return { bookable: false };
  const left = Math.max(0, s.capacity - s.booked);
  const base = { bookable: true as const, capacity: s.capacity, places_left: left, max_party: Math.min(left, MAX_PARTY) };
  if (s.status === 'cancelled') return { ...base, open: false, reason: 'cancelled' };
  if (s.status !== 'scheduled' || started(s, now)) return { ...base, open: false, reason: 'closed' };
  if (!left) return { ...base, open: false, reason: 'full' };
  return { ...base, open: true, reason: null };
}

export async function availability(db: D1Database, occurrenceId: string, now: string): Promise<Availability> {
  return availabilityOf(await findSlot(db, occurrenceId), now);
}

// ---- Booking ----

// Plain addresses only: no commas, semicolons or angle brackets that a mail header could read as extra recipients.
const EMAIL = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const MOBILE = /^\+?[0-9][0-9 ()-]{6,19}$/;
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max + 1) : '');

export interface BookingInput {
  occurrence_id: string;
  lead_name: string;
  email: string;
  mobile: string | null;
  party_size: number;
  notes: string | null;
}

export function parseBooking(body: unknown): { ok: true; value: BookingInput } | { ok: false; errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  // A field people can't see: only form-filling robots put anything in it.
  if (typeof b.website === 'string' && b.website.trim()) errors.form = 'Please try again.';
  const occurrence = typeof b.occurrence_id === 'string' ? b.occurrence_id : '';
  if (!OCCURRENCE_ID.test(occurrence)) errors.occurrence_id = 'Choose a session to book.';
  const name = clean(b.lead_name, 60);
  if (name.length < 2 || name.length > 60) errors.lead_name = 'Enter your name.';
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 200) errors.email = 'Enter an email address we can send your booking to.';
  const mobile = typeof b.mobile === 'string' ? b.mobile.trim() : '';
  if (mobile && !MOBILE.test(mobile)) errors.mobile = 'Enter a phone number, or leave it blank.';
  const size = b.party_size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_PARTY) errors.party_size = `Choose how many places (1 to ${MAX_PARTY}).`;
  const notes = typeof b.notes === 'string' ? b.notes.trim() : '';
  if (notes.length > 300) errors.notes = 'Keep the note to 300 characters.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { occurrence_id: occurrence, lead_name: name, email, mobile: mobile || null, party_size: size as number, notes: notes || null } };
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type Created =
  | { ok: true; booking: Record<string, unknown>; manage_path: string; availability: Availability }
  | { ok: false; status: 400 | 404 | 409 | 429; error: string; errors?: Record<string, string>; availability?: Availability };

export async function createBooking(db: D1Database, body: unknown, ctx: { now: string; ip: string | null; origin: string }): Promise<Created> {
  const parsed = parseBooking(body);
  if (!parsed.ok) return { ok: false, status: 400, error: 'Please check the form', errors: parsed.errors };
  const b = parsed.value;
  const { now } = ctx;
  const s = await findSlot(db, b.occurrence_id);
  const before = availabilityOf(s, now);
  if (!s || !before.bookable) return { ok: false, status: 404, error: "Online booking isn't open for this event." };
  if (!before.open) {
    const why = { full: 'Sorry, this session is full.', cancelled: 'This session has been cancelled.', closed: 'Booking has closed for this session.' };
    return { ok: false, status: 409, error: why[before.reason ?? 'closed'], availability: before };
  }
  if (b.party_size > before.places_left) {
    return { ok: false, status: 409, error: `Only ${places(before.places_left)} left.`, errors: { party_size: `Only ${places(before.places_left)} left.` }, availability: before };
  }

  const ipHash = ctx.ip ? (await sha256(`${ctx.ip}|${londonDate(new Date(now))}`)).slice(0, 32) : null;
  const [dup, byEmail, byIp] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE occurrence_id = ?1 AND email = ?2 AND status = 'confirmed'").bind(b.occurrence_id, b.email),
    db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE email = ?1 AND created_at > ?2').bind(b.email, new Date(Date.parse(now) - 86_400_000).toISOString()),
    db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE ip_hash = ?1 AND created_at > ?2').bind(ipHash, new Date(Date.parse(now) - 3_600_000).toISOString()),
  ]);
  const count = (r: D1Result | undefined) => Number((r?.results[0] as { n: number } | undefined)?.n ?? 0);
  if (count(dup)) {
    return { ok: false, status: 409, error: "You've already booked this one. To change it, cancel it from your confirmation email and book again." };
  }
  if (count(byEmail) >= PER_EMAIL_PER_DAY || (ipHash && count(byIp) >= PER_IP_PER_HOUR)) {
    return { ok: false, status: 429, error: 'Too many bookings in a short time. Please try again later, or ask the café.' };
  }

  const token = newToken();
  const tokenHash = await sha256(token);
  const l: Links = { origin: ctx.origin };
  const confirm = bookingConfirmed(s, b, `${ctx.origin}/booking/{{booking_id}}#t=${token}`, l);
  const toHost = hostNewBooking(s, b, s.booked + b.party_size, hostInbox(s), l);
  await db.batch([
    // Saved only if the date is still on, the places are still free and this
    // email hasn't just booked it: all checked in the same statement.
    db
      .prepare(
        `INSERT INTO bookings (booking_id, occurrence_id, lead_name, email, mobile, party_size, notes, status, source,
           cancellation_token_hash, ip_hash, created_at, updated_at)
         SELECT printf('RTD-BK-%05d', n), ?1, ?2, ?3, ?4, ?5, ?6, 'confirmed', 'app', ?7, ?8, ?9, ?9
         FROM (SELECT COALESCE(MAX(CAST(substr(booking_id, 8) AS INTEGER)), 0) + 1 AS n FROM bookings)
         WHERE EXISTS (SELECT 1 FROM occurrences WHERE occurrence_id = ?1 AND status = 'scheduled')
           AND (SELECT COALESCE(SUM(party_size), 0) FROM bookings WHERE occurrence_id = ?1 AND status = 'confirmed') + ?5 <= ?10
           AND NOT EXISTS (SELECT 1 FROM bookings WHERE occurrence_id = ?1 AND email = ?3 AND status = 'confirmed')`,
      )
      .bind(b.occurrence_id, b.lead_name, b.email, b.mobile, b.party_size, b.notes, tokenHash, ipHash, now, s.capacity),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, occurrence_id, actor_type, actor_id, action, new_value, source, created_at)
         SELECT 'booking', booking_id, occurrence_id, 'customer', email, 'booking.created', json_object('party_size', party_size), 'app', ?2
         FROM bookings WHERE cancellation_token_hash = ?1`,
      )
      .bind(tokenHash, now),
    queueForBooking(db, confirm, tokenHash, now),
    queueForBooking(db, toHost, tokenHash, now),
  ]);
  const saved = await db.prepare('SELECT booking_id, lead_name, party_size FROM bookings WHERE cancellation_token_hash = ?1').bind(tokenHash).first<{ booking_id: string; lead_name: string; party_size: number }>();
  const after = await availability(db, b.occurrence_id, now);
  if (!saved) return { ok: false, status: 409, error: 'Sorry, those places have just gone.', availability: after };
  return {
    ok: true,
    booking: { ...saved, occurrence_id: s.occurrence_id, name: s.name, event_date: s.event_date, start_time: s.start_time, end_time: s.end_time, email: b.email },
    manage_path: `/booking/${saved.booking_id}#t=${token}`,
    availability: after,
  };
}

// ---- The customer's Manage / Cancel link ----

interface BookingRow {
  booking_id: string;
  occurrence_id: string;
  lead_name: string;
  email: string;
  party_size: number;
  status: 'confirmed' | 'cancelled';
  cancelled_by: string | null;
  cancel_message: string | null;
}

async function bookingByToken(db: D1Database, id: string, token: unknown): Promise<BookingRow | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100 || !/^RTD-BK-\d{5,}$/.test(id)) return null;
  return db
    .prepare(
      `SELECT booking_id, occurrence_id, lead_name, email, party_size, status, cancelled_by, cancel_message
       FROM bookings WHERE booking_id = ?1 AND cancellation_token_hash = ?2`,
    )
    .bind(id, await sha256(token))
    .first<BookingRow>();
}

export async function viewBooking(db: D1Database, id: string, token: unknown, now: string) {
  const b = await bookingByToken(db, id, token);
  if (!b) return null;
  const s = await findSlot(db, b.occurrence_id);
  return {
    booking_id: b.booking_id,
    lead_name: b.lead_name,
    party_size: b.party_size,
    status: b.status,
    cancelled_by: b.cancelled_by,
    cancel_message: b.cancel_message,
    occurrence_id: b.occurrence_id,
    name: s?.name ?? 'Your session',
    event_date: s?.event_date ?? null,
    start_time: s?.start_time ?? null,
    end_time: s?.end_time ?? null,
    price_display: s?.price_display ?? null,
    can_cancel: b.status === 'confirmed' && !!s && s.status === 'scheduled' && !started(s, now),
  };
}

export async function cancelByCustomer(
  db: D1Database,
  id: string,
  token: unknown,
  ctx: { now: string; origin: string },
): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const b = await bookingByToken(db, id, token);
  if (!b) return { ok: false, status: 404, error: 'Booking not found. Check the link in your confirmation email.' };
  if (b.status !== 'confirmed') return { ok: false, status: 409, error: 'This booking is already cancelled.' };
  const s = await findSlot(db, b.occurrence_id);
  if (!s || started(s, ctx.now)) return { ok: false, status: 409, error: 'This session has already started, so it can no longer be cancelled here. Please tell the café.' };
  const res = await db
    .prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = 'customer', cancelled_at = ?2, updated_at = ?2 WHERE booking_id = ?1 AND status = 'confirmed'")
    .bind(b.booking_id, ctx.now)
    .run();
  if (!res.meta.changes) return { ok: false, status: 409, error: 'This booking is already cancelled.' };
  await db.batch([
    audit(db, 'booking', b.booking_id, b.occurrence_id, 'customer', b.email, 'booking.cancelled', { by: 'customer' }, ctx.now),
    // Only tell the host while the date is still on: a cancelled date has already told them.
    ...(s.status === 'scheduled' ? [queue(db, hostBookingCancelled(s, b, Math.max(0, s.booked - b.party_size), hostInbox(s), { origin: ctx.origin }), ctx.now)] : []),
  ]);
  return { ok: true };
}

// ---- What hosts and approvers see ----

export interface DateBooking {
  booking_id: string;
  lead_name: string;
  party_size: number;
  notes: string | null;
  /** Approvers only: so the café can get in touch. */
  email?: string;
  mobile?: string | null;
}

export interface SessionDate {
  occurrence_id: string;
  host_session_id: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  status: 'scheduled' | 'cancelled';
  cancelled_by: string | null;
  capacity: number | null;
  booked: number;
  bookings: DateBooking[];
}

/** Upcoming dates (and cancelled ones) of the given sessions, each with who's booked. */
export async function datesForSessions(db: D1Database, sessionIds: string[], today: string, opts: { days?: number; contact?: boolean } = {}): Promise<SessionDate[]> {
  if (!sessionIds.length) return [];
  const { results: dates } = await db
    .prepare(
      `SELECT o.occurrence_id, e.host_session_id, o.event_date, o.start_time, o.end_time, o.status, o.cancelled_by,
         COALESCE(o.capacity, e.default_capacity) AS capacity
       FROM occurrences o JOIN events e ON e.event_id = o.event_id
       WHERE e.host_session_id IN (SELECT value FROM json_each(?1)) AND o.event_date BETWEEN ?2 AND ?3
         AND o.status IN ('scheduled', 'cancelled')
       ORDER BY o.event_date, o.occurrence_id`,
    )
    .bind(JSON.stringify(sessionIds), today, addDays(today, opts.days ?? 56))
    .all<Omit<SessionDate, 'booked' | 'bookings'>>();
  if (!dates.length) return [];
  const { results: bookings } = await db
    .prepare(
      `SELECT booking_id, occurrence_id, lead_name, party_size, notes, email, mobile FROM bookings
       WHERE occurrence_id IN (SELECT value FROM json_each(?1)) AND status = 'confirmed'
       ORDER BY created_at, booking_id`,
    )
    .bind(JSON.stringify(dates.map(d => d.occurrence_id)))
    .all<DateBooking & { occurrence_id: string; email: string; mobile: string | null }>();
  return dates.map(d => {
    const mine = bookings.filter(b => b.occurrence_id === d.occurrence_id);
    return {
      ...d,
      booked: mine.reduce((n, b) => n + b.party_size, 0),
      bookings: mine.map(b => ({
        booking_id: b.booking_id,
        lead_name: b.lead_name,
        party_size: b.party_size,
        notes: b.notes,
        ...(opts.contact ? { email: b.email, mobile: b.mobile } : {}),
      })),
    };
  });
}

/** For approvers: every hosted date in the next three weeks, with the session and host. */
export async function upcomingHostedDates(db: D1Database, today: string) {
  const { results: sessions } = await db
    .prepare(
      `SELECT h.session_id, h.name, h.access, h.max_players, u.display_name AS host_name, u.email AS host_email
       FROM host_sessions h JOIN users u ON u.user_id = h.host_user_id WHERE h.status = 'published'`,
    )
    .all<{ session_id: string; name: string; access: string; max_players: number; host_name: string | null; host_email: string }>();
  const byId = new Map(sessions.map(s => [s.session_id, s]));
  const dates = await datesForSessions(db, [...byId.keys()], today, { days: 21, contact: true });
  return dates.map(d => ({ ...d, session: byId.get(d.host_session_id)! }));
}

/** The host (or an approver) cancels one date. Everyone booked is emailed, and so is the café or the host. */
export async function cancelDate(
  db: D1Database,
  actor: AuthUser,
  occurrenceId: string,
  message: unknown,
  ctx: { now: string; origin: string },
): Promise<{ ok: true; cancelled_bookings: number } | { ok: false; status: 403 | 404 | 409; error: string }> {
  const s = await findSlot(db, occurrenceId);
  if (!s) return { ok: false, status: 404, error: 'No hosted session on that date.' };
  const owner = s.host_user_id === actor.user_id;
  if (!owner && actor.role === 'host') return { ok: false, status: 403, error: 'You can only cancel your own sessions.' };
  if (s.status === 'cancelled') return { ok: false, status: 409, error: 'That date is already cancelled.' };
  if (s.status !== 'scheduled') return { ok: false, status: 409, error: "That date isn't on any more." };
  if (started(s, ctx.now)) return { ok: false, status: 409, error: 'That session has already started.' };
  const by = owner ? 'host' : 'staff';
  const note = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : null;
  const l: Links = { origin: ctx.origin };

  const confirmed = async () =>
    (
      await db
        .prepare("SELECT booking_id, lead_name, email, party_size FROM bookings WHERE occurrence_id = ?1 AND status = 'confirmed' ORDER BY booking_id")
        .bind(occurrenceId)
        .all<{ booking_id: string; lead_name: string; email: string; party_size: number }>()
    ).results;
  const cancelBookings = (list: { booking_id: string }[]) =>
    db
      .prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_by = ?2, cancel_message = ?3, cancelled_at = ?4, updated_at = ?4
         WHERE booking_id IN (SELECT value FROM json_each(?1)) AND status = 'confirmed'`,
      )
      .bind(JSON.stringify(list.map(b => b.booking_id)), by, note, ctx.now);

  const booked = await confirmed();
  const people = booked.reduce((n, b) => n + b.party_size, 0);
  const who = actor.display_name ?? actor.email;
  await db.batch([
    db
      .prepare("UPDATE occurrences SET status = 'cancelled', cancelled_at = ?2, cancelled_by = ?3, updated_at = ?2 WHERE occurrence_id = ?1 AND status = 'scheduled'")
      .bind(occurrenceId, ctx.now, by),
    cancelBookings(booked),
    ...booked.map(b => queue(db, attendeeDateCancelled(s, b, by, note, l), ctx.now)),
    queue(db, dateCancelledNotice(s, by, who, s.host_email, { bookings: booked.length, people }, note, l), ctx.now),
    audit(db, 'occurrence', s.event_id, occurrenceId, by, actor.email, 'occurrence.cancelled', { by, message: note, bookings: booked.length, people }, ctx.now),
  ]);
  // Someone who booked in the moment before the cancel landed is told too.
  const late = await confirmed();
  if (late.length) await db.batch([cancelBookings(late), ...late.map(b => queue(db, attendeeDateCancelled(s, b, by, note, l), ctx.now))]);
  return { ok: true, cancelled_bookings: booked.length + late.length };
}

// ---- For n8n ----

/**
 * Two days before each open hosted date (or the day before, if that was
 * missed), the host gets the numbers. Queued from 09:00 London time.
 */
export async function queueHostNumbers(db: D1Database, ctx: { now: string; origin: string }): Promise<number> {
  const at = new Date(ctx.now);
  if (londonHour(at) < 9) return 0;
  const today = londonDate(at);
  const tomorrow = addDays(today, 1);
  const { results } = await db
    .prepare(
      `${SLOT_SQL}
       WHERE o.status = 'scheduled' AND o.event_date BETWEEN ?1 AND ?2 AND h.access = 'open' AND ${VISIBLE}
         AND NOT EXISTS (SELECT 1 FROM outbox WHERE dedupe_key = 'host-numbers:' || o.occurrence_id)
       ORDER BY o.event_date LIMIT 50`,
    )
    .bind(tomorrow, addDays(today, 2))
    .all<SlotRow>();
  if (!results.length) return 0;
  const dates = await datesForSessions(db, [...new Set(results.map(r => r.host_session_id))], today, { days: 2 });
  const l: Links = { origin: ctx.origin };
  await db.batch(
    results.map(s => {
      const list = dates.find(d => d.occurrence_id === s.occurrence_id)?.bookings ?? [];
      return queue(db, hostNumbers(s, list, hostInbox(s), tomorrow, l), ctx.now);
    }),
  );
  return results.length;
}

/**
 * Logic Engine changes for cancelled dates, so they're never advertised:
 * - a cancelled one-off: its Event Index row goes Inactive;
 * - a weekly session whose next date (the one in the sheet) is cancelled: the
 *   row's Event Date moves on to the next date that isn't.
 * Each is offered until n8n reports it done.
 */
export async function sheetFixes(db: D1Database, today: string) {
  const { results: sessions } = await db
    .prepare(
      `SELECT h.session_id, h.frequency, h.sheet_fix_sent, e.event_id
       FROM host_sessions h JOIN events e ON e.host_session_id = h.session_id
       WHERE e.active = 1 AND e.source = 'event_index'`,
    )
    .all<{ session_id: string; frequency: string; sheet_fix_sent: string | null; event_id: string }>();
  if (!sessions.length) return [];
  const { results: occs } = await db
    .prepare(
      `SELECT event_id, event_date, projected, status FROM occurrences
       WHERE event_id IN (SELECT value FROM json_each(?1)) AND event_date >= ?2 AND status IN ('scheduled', 'cancelled')
       ORDER BY event_date`,
    )
    .bind(JSON.stringify(sessions.map(s => s.event_id)), today)
    .all<{ event_id: string; event_date: string; projected: number; status: string }>();
  const fixes: { session_id: string; key: string; row: Record<string, string> }[] = [];
  for (const s of sessions) {
    const mine = occs.filter(o => o.event_id === s.event_id);
    const cancelled = new Set(mine.filter(o => o.status === 'cancelled').map(o => o.event_date));
    let fix: { key: string; status: string; date: string } | null = null;
    if (s.frequency === 'one-off') {
      const c = mine.find(o => o.status === 'cancelled');
      if (c && !mine.some(o => o.status === 'scheduled')) fix = { key: 'inactive', status: 'Inactive', date: c.event_date };
    } else {
      const inSheet = mine.filter(o => !o.projected).at(-1);
      if (inSheet?.status === 'cancelled') {
        let d = addDays(inSheet.event_date, 7);
        while (cancelled.has(d)) d = addDays(d, 7);
        fix = { key: `date:${d}`, status: 'Active', date: d };
      }
    }
    if (fix && fix.key !== s.sheet_fix_sent) {
      fixes.push({ session_id: s.session_id, key: fix.key, row: { 'App Host Session': s.session_id, Status: fix.status, 'Event Date': ukDate(fix.date) } });
    }
  }
  return fixes;
}

export async function markSheetFixed(db: D1Database, id: string, key: string, now: string): Promise<boolean> {
  const res = await db.prepare('UPDATE host_sessions SET sheet_fix_sent = ?2, sheet_fix_sent_at = ?3 WHERE session_id = ?1').bind(id, key.slice(0, 40), now).run();
  return !!res.meta.changes;
}
