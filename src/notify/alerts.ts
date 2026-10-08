// Event alerts (docs/RTD_ALERTS.md). Anyone can turn them on in the app, with
// no account. Two kinds of reminder reach every device with alerts on:
// - an admin's, about any public event, whenever they like. It also queues a
//   Facebook post (n8n RTD Event Reminders To Facebook). A second one about the
//   same event within 24 hours has to be confirmed;
// - the automatic one: at 8pm London time, about a random public event from
//   tomorrow to three days ahead, at most once every 48 hours. Admins' reminders
//   don't count towards that.
// Each reminder is queued per device and sent in batches by the Worker's
// every-minute Cron Trigger, because a Worker can only make so many requests at once.

import { clean, sha256 } from '../bookings/bookings';
import { withImages } from '../images/store';
import type { AuthUser } from '../lib/auth';
import { shortDate, timeLabel } from '../lib/format';
import { OCCURRENCE_FIELDS, OCCURRENCE_ID, VISIBLE, findOccurrence, shape, type PublicOccurrence, type Row } from '../lib/queries';
import { addDays, londonDate, londonHour } from '../lib/time';
import { deviceLabel, parseSubscription, sendPush, vapidHeader, vapidKeys, type PushContext, type PushMessage } from './push';

/**
 * Devices one run sends to. Workers on the free plan allow 50 outgoing requests
 * and 10ms of CPU per run, and encrypting each message takes a fraction of a
 * millisecond: 20 a minute is 1,200 an hour.
 */
export const BATCH = 20;
/** The automatic reminder's hour, London time. */
export const AUTO_HOUR = 20;
/** "At most every 48 hours", with half an hour's slack so it keeps to the same evening slot. */
const AUTO_GAP_MS = 47.5 * 3_600_000;
/** An admin is warned about a second reminder for the same event within this time. */
export const WARN_WITHIN_MS = 24 * 3_600_000;
/** A batch claimed but not finished (the Worker stopped) is picked up again after this. */
const CLAIM_MS = 5 * 60_000;
/** Push services hold a reminder this long for a phone that's off. */
const TTL_SECONDS = 12 * 3600;
const MAX_FAILURES = 5;
const TURN_ONS_PER_HOUR = 20;

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, '0')).join('');
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString();

// ---- Turning alerts on and off (anyone) ----

type Fail = { ok: false; status: 400 | 403 | 404 | 409 | 429; error: string; errors?: Record<string, string> };

export async function turnOn(db: D1Database, body: unknown, ctx: { ua?: string; ip: string | null; now: Date }): Promise<{ ok: true } | Fail> {
  const sub = parseSubscription(body);
  if (!sub) return { ok: false, status: 400, error: "That browser can't receive alerts." };
  const ipHash = ctx.ip ? (await sha256(`${ctx.ip}|${londonDate(ctx.now)}`)).slice(0, 32) : null;
  const known = await db.prepare('SELECT 1 FROM alert_subscriptions WHERE endpoint = ?1').bind(sub.endpoint).first();
  if (!known && ipHash) {
    const recent = await db
      .prepare('SELECT COUNT(*) AS n FROM alert_subscriptions WHERE ip_hash = ?1 AND created_at > ?2')
      .bind(ipHash, ago(ctx.now, 3_600_000))
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= TURN_ONS_PER_HOUR) return { ok: false, status: 429, error: 'Too many devices from here just now. Please try again later.' };
  }
  await db
    .prepare(
      `INSERT INTO alert_subscriptions (endpoint, p256dh, auth, device_label, ip_hash, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device_label = excluded.device_label, failures = 0`,
    )
    .bind(sub.endpoint, sub.p256dh, sub.auth, deviceLabel(ctx.ua), ipHash, ctx.now.toISOString())
    .run();
  return { ok: true };
}

const endpointOf = (body: unknown) => {
  const e = (body as { endpoint?: unknown } | null)?.endpoint;
  return typeof e === 'string' && e.length <= 2000 ? e : null;
};

/** Turns alerts off for a device. Only someone holding its (secret) push address can. */
export async function turnOff(db: D1Database, body: unknown): Promise<void> {
  const endpoint = endpointOf(body);
  if (endpoint) await db.prepare('DELETE FROM alert_subscriptions WHERE endpoint = ?1').bind(endpoint).run();
}

export async function isOn(db: D1Database, body: unknown): Promise<boolean> {
  const endpoint = endpointOf(body);
  if (!endpoint) return false;
  return !!(await db.prepare('SELECT 1 FROM alert_subscriptions WHERE endpoint = ?1').bind(endpoint).first());
}

/** The browser renewed its subscription (service worker): move alerts to the new one. */
export async function renew(db: D1Database, body: unknown, ctx: { ua?: string; now: Date }): Promise<boolean> {
  const b = (body ?? {}) as { old_endpoint?: unknown; subscription?: unknown };
  const old = typeof b.old_endpoint === 'string' ? b.old_endpoint : null;
  const sub = parseSubscription(b.subscription);
  if (!old || !sub) return false;
  const had = await db.prepare('SELECT 1 FROM alert_subscriptions WHERE endpoint = ?1').bind(old).first();
  if (!had) return false;
  await db.batch([
    db.prepare('DELETE FROM alert_subscriptions WHERE endpoint = ?1').bind(old),
    db
      .prepare(
        `INSERT INTO alert_subscriptions (endpoint, p256dh, auth, device_label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
      )
      .bind(sub.endpoint, sub.p256dh, sub.auth, deviceLabel(ctx.ua), ctx.now.toISOString()),
  ]);
  return true;
}

// ---- What a reminder says ----

/** The suggested reminder for a date: its name, then when, and what to do. */
export function defaultReminder(o: Pick<PublicOccurrence, 'name' | 'date' | 'start_time' | 'end_time' | 'bookable'>) {
  const when = `${shortDate(o.date)}${o.start_time ? `, ${timeLabel(o.start_time, o.end_time)}` : ''}`;
  return { title: o.name, body: `${when}. ${o.bookable ? 'Book your place in the app.' : 'Tap to see the details.'}` };
}

export interface ReminderInput {
  occurrence_id: string;
  title: string;
  body: string;
  social: boolean;
  confirm: boolean;
}

export function parseReminder(body: unknown): { ok: true; value: ReminderInput } | { ok: false; errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const occurrence = typeof b.occurrence_id === 'string' ? b.occurrence_id : '';
  if (!OCCURRENCE_ID.test(occurrence)) errors.occurrence_id = 'Choose an event.';
  const title = clean(b.title, 60);
  if (title.length < 3 || title.length > 60) errors.title = 'The title must be 3 to 60 characters.';
  const text = clean(b.body, 180);
  if (text.length < 5 || text.length > 180) errors.body = 'The message must be 5 to 180 characters.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { occurrence_id: occurrence, title, body: text, social: b.social !== false, confirm: b.confirm === true } };
}

// ---- Queuing a reminder for every device ----

interface Social {
  text: string;
  image: string | null;
}

/** Saves the reminder and queues it for every device with alerts on, in one transaction. */
async function queueSend(
  db: D1Database,
  r: { kind: 'manual' | 'auto'; event_id: string; occurrence_id: string; title: string; body: string; sent_by: string; social: Social | null },
  now: Date,
): Promise<{ send_id: number; devices: number }> {
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO push_sends (kind, event_id, occurrence_id, title, body, url, sent_by, social, social_text, social_image, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(r.kind, r.event_id, r.occurrence_id, r.title, r.body, `/event/${r.occurrence_id}`, r.sent_by, r.social ? 'pending' : null,
        r.social?.text ?? null, r.social?.image ?? null, now.toISOString()),
    // Writes in a batch are one transaction, so the newest send is the one just saved.
    db.prepare('INSERT INTO push_deliveries (send_id, endpoint) SELECT (SELECT MAX(send_id) FROM push_sends), endpoint FROM alert_subscriptions'),
    db.prepare(
      `UPDATE push_sends SET devices = (SELECT COUNT(*) FROM push_deliveries d WHERE d.send_id = push_sends.send_id)
       WHERE send_id = (SELECT MAX(send_id) FROM push_sends)`,
    ),
    db.prepare('SELECT send_id, devices FROM push_sends WHERE send_id = (SELECT MAX(send_id) FROM push_sends)'),
  ]);
  return results[3]!.results[0] as { send_id: number; devices: number };
}

export interface LastSend {
  send_id: number;
  kind: 'manual' | 'auto';
  title: string;
  sent_by: string;
  created_at: string;
}

/** The latest reminder about this event within the last 24 hours, if any. */
export async function recentFor(db: D1Database, eventId: string, now: Date): Promise<LastSend | null> {
  return db
    .prepare('SELECT send_id, kind, title, sent_by, created_at FROM push_sends WHERE event_id = ?1 AND created_at > ?2 ORDER BY created_at DESC LIMIT 1')
    .bind(eventId, ago(now, WARN_WITHIN_MS))
    .first<LastSend>();
}

/** The event's photo as a full address Buffer can fetch: the app's own, or a web address set on the sheet. */
export function absoluteImage(image: string | null, origin: string): string | null {
  if (!image) return null;
  if (image.startsWith('/')) return `${origin}${image}`;
  return /^https:\/\//.test(image) ? image : null;
}

export type Sent = { ok: true; send: { send_id: number; devices: number; social: boolean } } | Fail | { ok: false; status: 409; warning: LastSend };

/**
 * An admin's reminder about one date, to every device with alerts on, plus a
 * Facebook post unless they untick it. A second one about the same event within
 * 24 hours comes back as a warning until it's sent again with confirm: true.
 */
export async function sendReminder(db: D1Database, admin: AuthUser, input: ReminderInput, ctx: { now: Date; origin: string }): Promise<Sent> {
  if (admin.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can send reminders.' };
  const found = await findOccurrence(db, input.occurrence_id);
  if (!found) return { ok: false, status: 404, error: 'No public event on that date.' };
  if (found.status !== 'scheduled' || found.date < londonDate(ctx.now)) return { ok: false, status: 409, error: "That date isn't coming up any more." };
  const recent = await recentFor(db, found.event_id, ctx.now);
  if (recent && !input.confirm) return { ok: false, status: 409, warning: recent };

  const [o] = await withImages(db, [found]);
  const link = `${ctx.origin}/event/${o!.occurrence_id}`;
  const social = input.social ? { text: `${input.title}\n\n${input.body}\n\n${link}`, image: absoluteImage(o!.image, ctx.origin) } : null;
  const queued = await queueSend(
    db,
    { kind: 'manual', event_id: o!.event_id, occurrence_id: o!.occurrence_id, title: input.title, body: input.body, sent_by: admin.email, social },
    ctx.now,
  );
  await db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, occurrence_id, actor_type, actor_id, action, new_value, source, created_at)
       VALUES ('push_send', ?1, ?2, 'staff', ?3, 'push.reminder_sent', ?4, 'organiser', ?5)`,
    )
    .bind(String(queued.send_id), o!.occurrence_id, admin.email, JSON.stringify({ devices: queued.devices, social: !!social, after_warning: !!recent }), ctx.now.toISOString())
    .run();
  return { ok: true, send: { ...queued, social: !!social } };
}

/**
 * The automatic reminder: only at 8pm London time, only if none went out in the
 * last 48 hours, about a random public event from tomorrow to three days ahead
 * that hasn't had a reminder in those 48 hours either.
 */
export async function autoReminder(db: D1Database, now: Date): Promise<{ send_id: number; devices: number; occurrence_id: string } | null> {
  if (londonHour(now) !== AUTO_HOUR) return null;
  const [last, devices] = await db.batch([
    db.prepare("SELECT created_at FROM push_sends WHERE kind = 'auto' AND created_at > ?1 LIMIT 1").bind(ago(now, AUTO_GAP_MS)),
    db.prepare('SELECT COUNT(*) AS n FROM alert_subscriptions'),
  ]);
  if (last!.results.length || !(devices!.results[0] as { n: number }).n) return null;
  const today = londonDate(now);
  const { results } = await db
    .prepare(
      `SELECT ${OCCURRENCE_FIELDS} FROM occurrences o JOIN events e ON e.event_id = o.event_id
       WHERE ${VISIBLE} AND o.status = 'scheduled' AND o.event_date BETWEEN ?1 AND ?2
         AND e.event_id NOT IN (SELECT event_id FROM push_sends WHERE created_at > ?3)
       ORDER BY o.event_date, o.start_time`,
    )
    .bind(addDays(today, 1), addDays(today, 3), ago(now, 48 * 3_600_000))
    .all<Row>();
  // One date per event, so a weekly club isn't three times as likely as a one-off.
  const seen = new Set<string>();
  const firsts = results.map(shape).filter(o => !seen.has(o.event_id) && seen.add(o.event_id));
  if (!firsts.length) return null;
  const pick = firsts[crypto.getRandomValues(new Uint32Array(1))[0]! % firsts.length]!;
  const text = defaultReminder(pick);
  const queued = await queueSend(db, { kind: 'auto', event_id: pick.event_id, occurrence_id: pick.occurrence_id, ...text, sent_by: 'auto', social: null }, now);
  return { ...queued, occurrence_id: pick.occurrence_id };
}

// ---- Sending (the every-minute Cron Trigger, and straight after an admin sends) ----

interface Claimed {
  send_id: number;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
  title: string;
  body: string;
  url: string;
  event_id: string;
}

/** Sends up to `max` queued reminders. Each batch is claimed first, so two runs never send the same one. */
export async function drain(db: D1Database, ctx: PushContext, max = BATCH): Promise<{ sent: number; failed: number }> {
  const claim = hex(12);
  const now = ctx.now.toISOString();
  await db
    .prepare(
      `UPDATE push_deliveries SET claim = ?1, claimed_at = ?2
       WHERE rowid IN (SELECT rowid FROM push_deliveries WHERE claim IS NULL OR claimed_at < ?3 ORDER BY send_id LIMIT ?4)`,
    )
    .bind(claim, now, ago(ctx.now, CLAIM_MS), max)
    .run();
  const { results } = await db
    .prepare(
      `SELECT d.send_id, d.endpoint, a.p256dh, a.auth, s.title, s.body, s.url, s.event_id
       FROM push_deliveries d JOIN push_sends s ON s.send_id = d.send_id
       LEFT JOIN alert_subscriptions a ON a.endpoint = d.endpoint
       WHERE d.claim = ?1`,
    )
    .bind(claim)
    .all<Claimed>();
  if (!results.length) return { sent: 0, failed: 0 };

  const keys = await vapidKeys(db);
  // One signed token per push service (Google, Apple, Mozilla) rather than per device.
  const tokens = new Map<string, Promise<string>>();
  const tokenFor = (endpoint: string) => {
    const origin = new URL(endpoint).origin;
    if (!tokens.has(origin)) tokens.set(origin, vapidHeader(endpoint, keys, ctx.subject, ctx.now));
    return tokens.get(origin)!;
  };
  const statuses = await Promise.all(
    results.map(async r => {
      // Alerts were turned off after it was queued: nothing to send.
      if (!r.p256dh || !r.auth) return -1;
      const message: PushMessage = { title: r.title, body: r.body, url: r.url, tag: `event-${r.event_id}` };
      return sendPush({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, message, keys, ctx, {
        ttlSeconds: TTL_SECONDS,
        urgency: 'normal',
        authorization: await tokenFor(r.endpoint),
      });
    }),
  );
  const ok = results.filter((_, i) => statuses[i]! >= 200 && statuses[i]! < 300);
  const gone = results.filter((_, i) => statuses[i] === 404 || statuses[i] === 410);
  const failing = results.filter((_, i) => statuses[i]! >= 0 && !(statuses[i]! >= 200 && statuses[i]! < 300) && statuses[i] !== 404 && statuses[i] !== 410);
  const endpoints = (list: Claimed[]) => JSON.stringify(list.map(r => r.endpoint));
  const perSend = new Map<number, { delivered: number; failed: number }>();
  results.forEach((r, i) => {
    const c = perSend.get(r.send_id) ?? { delivered: 0, failed: 0 };
    if (statuses[i]! >= 200 && statuses[i]! < 300) c.delivered++;
    else if (statuses[i]! >= 0) c.failed++;
    perSend.set(r.send_id, c);
  });
  await db.batch([
    db.prepare('DELETE FROM push_deliveries WHERE claim = ?1').bind(claim),
    db.prepare('UPDATE alert_subscriptions SET last_sent_at = ?2, failures = 0 WHERE endpoint IN (SELECT value FROM json_each(?1))').bind(endpoints(ok), now),
    // 404 / 410: the browser unsubscribed, or the app was removed.
    db.prepare('DELETE FROM alert_subscriptions WHERE endpoint IN (SELECT value FROM json_each(?1))').bind(endpoints(gone)),
    db.prepare('UPDATE alert_subscriptions SET failures = failures + 1 WHERE endpoint IN (SELECT value FROM json_each(?1))').bind(endpoints(failing)),
    db.prepare(`DELETE FROM alert_subscriptions WHERE failures >= ${MAX_FAILURES}`),
    ...[...perSend].map(([id, c]) =>
      db.prepare('UPDATE push_sends SET delivered = delivered + ?2, failed = failed + ?3 WHERE send_id = ?1').bind(id, c.delivered, c.failed),
    ),
  ]);
  return { sent: ok.length, failed: gone.length + failing.length };
}

// ---- For admins ----

export interface ReminderEvent {
  occurrence_id: string;
  event_id: string;
  name: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  bookable: boolean;
  suggested: { title: string; body: string };
  last_sent_at: string | null;
}

/** Devices with alerts on, the latest reminders, and the next date of every public event in the next fortnight. */
export async function overview(db: D1Database, now: Date) {
  const today = londonDate(now);
  const [devices, recent, lastAuto, upcoming] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM alert_subscriptions'),
    db.prepare(
      `SELECT send_id, kind, event_id, occurrence_id, title, body, sent_by, devices, delivered, failed, social, social_error, social_at, created_at
       FROM push_sends ORDER BY send_id DESC LIMIT 10`,
    ),
    db.prepare("SELECT created_at FROM push_sends WHERE kind = 'auto' ORDER BY send_id DESC LIMIT 1"),
    db
      .prepare(
        `SELECT ${OCCURRENCE_FIELDS}, (SELECT MAX(p.created_at) FROM push_sends p WHERE p.event_id = e.event_id) AS last_sent_at
         FROM occurrences o JOIN events e ON e.event_id = o.event_id
         WHERE ${VISIBLE} AND o.status = 'scheduled' AND o.event_date BETWEEN ?1 AND ?2
         ORDER BY o.event_date, o.start_time LIMIT 200`,
      )
      .bind(today, addDays(today, 14)),
  ]);
  const seen = new Set<string>();
  const events: ReminderEvent[] = (upcoming!.results as Row[])
    .map(r => ({ o: shape(r), last: (r.last_sent_at as string | null) ?? null }))
    .filter(({ o }) => !seen.has(o.event_id) && seen.add(o.event_id))
    .slice(0, 40)
    .map(({ o, last }) => ({
      occurrence_id: o.occurrence_id,
      event_id: o.event_id,
      name: o.name,
      date: o.date,
      start_time: o.start_time,
      end_time: o.end_time,
      bookable: o.bookable,
      suggested: defaultReminder(o),
      last_sent_at: last,
    }));
  return {
    devices: (devices!.results[0] as { n: number }).n,
    last_auto_at: ((lastAuto!.results[0] as { created_at: string } | undefined)?.created_at) ?? null,
    recent: recent!.results,
    events,
  };
}

// ---- The Facebook posts (n8n RTD Event Reminders To Facebook) ----

export async function socialQueue(db: D1Database) {
  const { results } = await db
    .prepare("SELECT send_id, social_text AS text, social_image AS image_url FROM push_sends WHERE social = 'pending' ORDER BY send_id LIMIT 5")
    .all<{ send_id: number; text: string; image_url: string | null }>();
  return results;
}

/** n8n posted it (with Buffer's post ID), or couldn't (with the reason). */
export async function markSocial(db: D1Database, id: number, outcome: { ok: true; post_id: string | null } | { ok: false; error: string }, now: Date): Promise<boolean> {
  const res = await db
    .prepare("UPDATE push_sends SET social = ?2, social_post_id = ?3, social_error = ?4, social_at = ?5 WHERE send_id = ?1 AND social = 'pending'")
    .bind(id, outcome.ok ? 'posted' : 'failed', outcome.ok ? outcome.post_id : null, outcome.ok ? null : outcome.error.slice(0, 500), now.toISOString())
    .run();
  return res.meta.changes > 0;
}
