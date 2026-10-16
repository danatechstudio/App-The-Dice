// Booking push (docs/RTD_BOOKINGS.md#telling-this-device; audit §5.2, G-3). Someone
// booking can ask for this device to be told if the date is cancelled or moved. It's
// opt-in, for that one booking, and never needed to book: the email always goes too.
//
// The push is written to push_outbox in the same batch as the change it tells of, one
// per (booking, device), and sent by the every-minute Cron Trigger ahead of event
// alerts, out of the same budget. A browser that has gone (404 or 410) is marked
// invalid and never used again; any other failure is tried again later, and given up
// on after the last wait. Nothing here can hold up or change an email.

import { clock, shortDate } from '../lib/format';
import { hasEnded } from '../lib/queries';
import { londonDate } from '../lib/time';
import { deviceLabel, parseSubscription, sendPush, vapidHeader, vapidKeys, type PushContext, type PushMessage } from '../notify/push';
import { sha256 } from './bookings';

/** Devices one booking can have. */
const MAX_DEVICES = 3;
/** Same waits as the email outbox (src/notify/outbox.ts), then given up on. */
const RETRY_AFTER_MS = [5, 15, 60, 240, 720].map(m => m * 60_000);
const CLAIM_MS = 5 * 60_000;
/** Push services hold a message this long for a phone that's off. */
const TTL_SECONDS = 24 * 3600;
/** Pushes are kept this long as a record of what was sent (they hold no contact details). */
const KEEP_DAYS = 90;

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, '0')).join('');

type Fail = { ok: false; status: 400 | 404 | 409; error: string };

/** The booking a Manage / Cancel link points to, if the token is right. */
async function bookingFor(db: D1Database, id: string, token: unknown) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100 || !/^RTD-BK-\d{5,}$/.test(id)) return null;
  return db
    .prepare(
      `SELECT b.booking_id, b.status, o.status AS date_status, o.event_date, o.ends_at FROM bookings b
       JOIN occurrences o ON o.occurrence_id = b.occurrence_id WHERE b.booking_id = ?1 AND b.cancellation_token_hash = ?2`,
    )
    .bind(id, await sha256(token))
    .first<{ booking_id: string; status: string; date_status: string; event_date: string; ends_at: string | null }>();
}

/**
 * Tell this device if the date is cancelled or moved. Body: { token, subscription }
 * (the browser's PushSubscription). The token is the one in the Manage / Cancel link.
 */
export async function addDevice(db: D1Database, id: string, body: unknown, ctx: { now: string; ua?: string }): Promise<{ ok: true } | Fail> {
  const b = (body && typeof body === 'object' ? body : {}) as { token?: unknown; subscription?: unknown };
  const booking = await bookingFor(db, id, b.token);
  if (!booking) return { ok: false, status: 404, error: 'Booking not found. Check the link in your confirmation email.' };
  const sub = parseSubscription(b.subscription);
  if (!sub) return { ok: false, status: 400, error: "This browser can't take notifications." };
  if (booking.status !== 'confirmed' || booking.date_status !== 'scheduled' || hasEnded({ date: booking.event_date, ends_at: booking.ends_at }, new Date(ctx.now))) {
    return { ok: false, status: 409, error: 'This booking is no longer coming up.' };
  }
  const res = await db
    .prepare(
      `INSERT INTO booking_devices (booking_id, endpoint, p256dh, auth, device_label, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE (SELECT COUNT(*) FROM booking_devices WHERE booking_id = ?1 AND endpoint <> ?2) < ${MAX_DEVICES}
       ON CONFLICT (booking_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, invalid_at = NULL`,
    )
    .bind(booking.booking_id, sub.endpoint, sub.p256dh, sub.auth, deviceLabel(ctx.ua), ctx.now)
    .run();
  if (!res.meta.changes) return { ok: false, status: 409, error: `This booking is already set to tell ${MAX_DEVICES} devices.` };
  return { ok: true };
}

/** Stop telling this device. Body: { token, endpoint }. */
export async function removeDevice(db: D1Database, id: string, body: unknown): Promise<{ ok: true } | Fail> {
  const b = (body && typeof body === 'object' ? body : {}) as { token?: unknown; endpoint?: unknown };
  const booking = await bookingFor(db, id, b.token);
  if (!booking) return { ok: false, status: 404, error: 'Booking not found. Check the link in your confirmation email.' };
  if (typeof b.endpoint !== 'string') return { ok: false, status: 400, error: 'Which device?' };
  await db.prepare('DELETE FROM booking_devices WHERE booking_id = ?1 AND endpoint = ?2').bind(booking.booking_id, b.endpoint).run();
  return { ok: true };
}

/** Whether this browser is set to be told about this booking (the Manage page). */
export async function deviceOn(db: D1Database, bookingId: string, endpoint: unknown): Promise<boolean> {
  if (typeof endpoint !== 'string' || !endpoint) return false;
  const row = await db
    .prepare('SELECT 1 FROM booking_devices WHERE booking_id = ?1 AND endpoint = ?2 AND invalid_at IS NULL')
    .bind(bookingId, endpoint)
    .first();
  return !!row;
}

/** A browser renewed its subscription (the service worker's pushsubscriptionchange). Knowing the old address is the proof. */
export async function renewDevice(db: D1Database, body: unknown): Promise<boolean> {
  const b = (body && typeof body === 'object' ? body : {}) as { old_endpoint?: unknown; subscription?: unknown };
  const sub = parseSubscription(b.subscription);
  if (!sub || typeof b.old_endpoint !== 'string' || !b.old_endpoint) return false;
  const res = await db
    .prepare(
      `UPDATE OR IGNORE booking_devices SET endpoint = ?2, p256dh = ?3, auth = ?4, invalid_at = NULL
       WHERE endpoint = ?1`,
    )
    .bind(b.old_endpoint, sub.endpoint, sub.p256dh, sub.auth)
    .run();
  return !!res.meta.changes;
}

// ---- What the pushes say: the event, the date and what happened. Nothing else. ----

interface Slot {
  occurrence_id: string;
  name: string;
  event_date: string;
  start_time: string | null;
}

const at = (s: Slot) => `${shortDate(s.event_date)}${s.start_time ? `, ${clock(s.start_time)}` : ''}`;

export const cancelledPush = (s: Slot): Omit<PushMessage, 'tag'> => ({
  title: `Cancelled: ${s.name}`,
  body: `${at(s)}. Your booking is cancelled; the email has the details.`,
  url: `/event/${s.occurrence_id}`,
});

export const movedPush = (s: Slot, to: Slot): Omit<PushMessage, 'tag'> => ({
  title: `Moved: ${s.name}`,
  body: `${at(s)} has moved to ${at(to)}. The email has the details.`,
  url: `/event/${to.occurrence_id}`,
});

/**
 * Queues one push per opted-in device of each booking, in the same batch as the change.
 * kind: 'date-cancelled' or 'date-moved'. Each (date, device) is pushed once, however
 * often this is called.
 */
export function queuePushes(
  db: D1Database,
  kind: 'date-cancelled' | 'date-moved',
  occurrenceId: string,
  bookingIds: string[],
  message: Omit<PushMessage, 'tag'>,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO push_outbox (dedupe_key, kind, device_id, booking_id, occurrence_id, title, body, url, tag, created_at)
       SELECT 'push:' || ?1 || ':' || ?2 || ':' || d.device_id, ?1, d.device_id, d.booking_id, ?2, ?4, ?5, ?6, 'booking-' || d.booking_id, ?7
       FROM booking_devices d WHERE d.booking_id IN (SELECT value FROM json_each(?3)) AND d.invalid_at IS NULL`,
    )
    .bind(kind, occurrenceId, JSON.stringify(bookingIds), message.title, message.body, message.url, now);
}

// ---- Sending (the every-minute Cron Trigger) ----

interface Claimed {
  push_id: number;
  attempts: number;
  device_id: number;
  title: string;
  body: string;
  url: string;
  tag: string;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  invalid_at: string | null;
}

/** Sends up to `max` due booking pushes. Returns how many it tried, so event alerts can use the rest of the budget. */
export async function drainBookingPushes(db: D1Database, ctx: PushContext, max: number): Promise<{ tried: number; sent: number; failed: number; gone: number }> {
  const none = { tried: 0, sent: 0, failed: 0, gone: 0 };
  if (max <= 0) return none;
  const claim = hex(12);
  const now = ctx.now.toISOString();
  await db
    .prepare(
      `UPDATE push_outbox SET claim = ?1, claimed_at = ?2
       WHERE push_id IN (SELECT push_id FROM push_outbox WHERE sent_at IS NULL AND dead_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?2) AND (claimed_at IS NULL OR claimed_at < ?3) ORDER BY push_id LIMIT ?4)`,
    )
    .bind(claim, now, new Date(ctx.now.getTime() - CLAIM_MS).toISOString(), max)
    .run();
  const { results } = await db
    .prepare(
      `SELECT p.push_id, p.attempts, p.device_id, p.title, p.body, p.url, p.tag, d.endpoint, d.p256dh, d.auth, d.invalid_at
       FROM push_outbox p LEFT JOIN booking_devices d ON d.device_id = p.device_id WHERE p.claim = ?1`,
    )
    .bind(claim)
    .all<Claimed>();
  if (!results.length) return none;

  const keys = await vapidKeys(db);
  const tokens = new Map<string, Promise<string>>();
  const tokenFor = (endpoint: string) => {
    const origin = new URL(endpoint).origin;
    if (!tokens.has(origin)) tokens.set(origin, vapidHeader(endpoint, keys, ctx.subject, ctx.now));
    return tokens.get(origin)!;
  };
  // -1: the device was turned off or has gone since this was queued; nothing to send.
  const statuses = await Promise.all(
    results.map(async r =>
      !r.endpoint || !r.p256dh || !r.auth || r.invalid_at
        ? -1
        : sendPush({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, { title: r.title, body: r.body, url: r.url, tag: r.tag }, keys, ctx, {
            ttlSeconds: TTL_SECONDS,
            urgency: 'high',
            authorization: await tokenFor(r.endpoint),
          }),
    ),
  );
  const writes: D1PreparedStatement[] = [];
  const out = { ...none, tried: results.length };
  results.forEach((r, i) => {
    const status = statuses[i]!;
    if (status >= 200 && status < 300) {
      out.sent++;
      writes.push(db.prepare('UPDATE push_outbox SET sent_at = ?2, last_status = ?3, last_attempt_at = ?2, attempts = attempts + 1, claim = NULL, claimed_at = NULL WHERE push_id = ?1').bind(r.push_id, now, status));
    } else if (status === -1 || status === 404 || status === 410) {
      out.gone++;
      const why = status === -1 ? 'The device was turned off before it was sent.' : 'This browser no longer takes notifications.';
      writes.push(
        db
          .prepare('UPDATE push_outbox SET dead_at = ?2, last_status = ?3, last_error = ?4, last_attempt_at = ?2, attempts = attempts + 1, claim = NULL, claimed_at = NULL WHERE push_id = ?1')
          .bind(r.push_id, now, status, why),
      );
      if (status !== -1) writes.push(db.prepare('UPDATE booking_devices SET invalid_at = ?2 WHERE device_id = ?1 AND invalid_at IS NULL').bind(r.device_id, now));
    } else {
      out.failed++;
      const wait = RETRY_AFTER_MS[r.attempts];
      writes.push(
        db
          .prepare(
            `UPDATE push_outbox SET attempts = attempts + 1, last_status = ?3, last_error = ?4, last_attempt_at = ?2, next_attempt_at = ?5,
               dead_at = ?6, claim = NULL, claimed_at = NULL WHERE push_id = ?1`,
          )
          .bind(
            r.push_id, now, status,
            status === 0 ? "Couldn't reach the push service." : `The push service answered ${status}.`,
            wait === undefined ? null : new Date(ctx.now.getTime() + wait).toISOString(),
            wait === undefined ? now : null,
          ),
      );
    }
  });
  await db.batch(writes);
  return out;
}

/**
 * Booking devices are only needed until the date: deleted the day after it (privacy
 * retention, src/lib/privacy.ts). The record of each push stays 90 days, then goes too.
 */
export function forgetDevices(db: D1Database, now: Date): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM booking_devices WHERE booking_id IN (SELECT b.booking_id FROM bookings b
           JOIN occurrences o ON o.occurrence_id = b.occurrence_id WHERE o.event_date < ?1)`,
      )
      .bind(londonDate(now)),
    db.prepare('DELETE FROM push_outbox WHERE created_at < ?1').bind(new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString()),
  ];
}
