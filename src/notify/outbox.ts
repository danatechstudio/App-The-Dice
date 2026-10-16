// The app's email outbox (docs/RTD_BOOKINGS.md). Emails are written here in
// the same transaction as the change they describe; n8n (RTD Outbox) collects
// them every few minutes, sends each through Gmail and marks it sent, or failed.
// dedupe_key makes every email once-only, however often a step is retried.
//
// Delivery (docs/RTD_EVENT_CONTROL_AUDIT.md §5.3): collecting claims an email for
// 10 minutes, so a run that dies part-way doesn't send it twice straight away. A
// failure is tried again after 5 minutes, 15 minutes, 1 hour, 4 hours and 12 hours,
// then given up on (dead) where admins can see it and try again. "Sent" only ever
// means Gmail accepted it.

import type { Email } from './emails';

/** Sent emails are kept this long (they hold names and email addresses), then deleted. */
const KEEP_SENT_DAYS = 90;
const BATCH = 50;
/** An email collected but neither sent nor failed after this long is offered again. */
export const CLAIM_MS = 10 * 60_000;
/** After each failed attempt, the wait before the next; after the last one it's given up on. */
export const RETRY_AFTER_MS = [5, 15, 60, 240, 720].map(m => m * 60_000);
const ERROR_MAX = 500;

export function queue(db: D1Database, e: Email, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox (dedupe_key, kind, to_email, reply_to, subject, html, created_at, booking_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(e.dedupe_key, e.kind, e.to, e.reply_to, e.subject, e.html, now, e.booking_id ?? null);
}

/**
 * Queues an email about a booking saved earlier in the same batch, found by its
 * token hash. `{{booking_id}}` in the key, subject and body becomes its ID, and
 * nothing is queued if the booking wasn't saved (for example, the session filled up).
 */
export function queueForBooking(db: D1Database, e: Email, tokenHash: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox (dedupe_key, kind, to_email, reply_to, subject, html, created_at, booking_id)
       SELECT replace(?1, '{{booking_id}}', booking_id), ?2, ?3, ?4, replace(?5, '{{booking_id}}', booking_id),
         replace(?6, '{{booking_id}}', booking_id), ?7, booking_id
       FROM bookings WHERE cancellation_token_hash = ?8`,
    )
    .bind(e.dedupe_key, e.kind, e.to, e.reply_to, e.subject, e.html, now, tokenHash);
}

export interface OutboxMessage {
  message_id: number;
  /** null = the café address */
  to: string | null;
  /** null = the café address */
  reply_to: string | null;
  subject: string;
  html: string;
}

/** Waiting to go: not sent or given up on, due, and not collected in the last 10 minutes. */
const DUE = `sent_at IS NULL AND dead_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?1) AND (claimed_at IS NULL OR claimed_at < ?2)`;

/**
 * Emails due to go, oldest first, each claimed for 10 minutes. Also deletes sent
 * ones past their keep-by date.
 */
export async function unsent(db: D1Database, now: string): Promise<OutboxMessage[]> {
  const cutoff = new Date(Date.parse(now) - KEEP_SENT_DAYS * 86_400_000).toISOString();
  const stale = new Date(Date.parse(now) - CLAIM_MS).toISOString();
  const claim = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
  const [, , list] = await db.batch([
    db.prepare('DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?1').bind(cutoff),
    db
      .prepare(`UPDATE outbox SET claim = ?3, claimed_at = ?1 WHERE message_id IN (SELECT message_id FROM outbox WHERE ${DUE} ORDER BY message_id LIMIT ${BATCH})`)
      .bind(now, stale, claim),
    db.prepare(`SELECT message_id, to_email AS "to", reply_to, subject, html FROM outbox WHERE claim = ?1 ORDER BY message_id`).bind(claim),
  ]);
  return (list?.results ?? []) as unknown as OutboxMessage[];
}

/** Gmail accepted it. Idempotent. Settles a "couldn't email this customer" item, if one was opened. */
export async function markSent(db: D1Database, id: number, now: string): Promise<'ok' | 'already' | 'not_found'> {
  const [res] = await db.batch([
    db.prepare('UPDATE outbox SET sent_at = ?2, claim = NULL, claimed_at = NULL, dead_at = NULL WHERE message_id = ?1 AND sent_at IS NULL').bind(id, now),
    db
      .prepare(
        `UPDATE attention_items SET status = 'resolved', resolution = 'sent', resolved_by = 'system',
           resolution_note = 'It went on a later try.', resolved_at = ?2
         WHERE item_key = 'undelivered:' || CAST(?1 AS INTEGER) AND status = 'open'`,
      )
      .bind(id, now),
  ]);
  if (res?.meta.changes) return 'ok';
  const row = await db.prepare('SELECT 1 FROM outbox WHERE message_id = ?1').bind(id).first();
  return row ? 'already' : 'not_found';
}

/** Emails to a customer about their booking: worth an item under Needs attention when they don't go. */
const TO_CUSTOMER = `o.booking_id IS NOT NULL AND o.to_email IS NOT NULL AND o.to_email NOT LIKE '@%'`;

/**
 * Gmail refused it (n8n RTD Outbox). Counts one attempt per collection: a repeated
 * call for the same attempt changes nothing. Tried again later, or given up on after
 * the last wait. The first failure of an email to a customer about their booking opens
 * an item under Needs attention, so the café can reach them another way.
 */
export async function markFailed(db: D1Database, id: number, error: unknown, now: string): Promise<'ok' | 'dead' | 'already' | 'not_found'> {
  const text = (typeof error === 'string' ? error : error === undefined ? '' : JSON.stringify(error)).slice(0, ERROR_MAX) || 'No reason given';
  const waits = RETRY_AFTER_MS.map((ms, i) => `WHEN ${i} THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+${ms / 1000} seconds')`).join(' ');
  const [res] = await db.batch([
    db
      .prepare(
        `UPDATE outbox SET attempts = attempts + 1, last_error = ?3, last_attempt_at = ?2, claim = NULL, claimed_at = NULL,
           next_attempt_at = CASE attempts ${waits} ELSE NULL END,
           dead_at = CASE WHEN attempts + 1 > ${RETRY_AFTER_MS.length} THEN ?2 END
         WHERE message_id = ?1 AND sent_at IS NULL AND dead_at IS NULL AND claim IS NOT NULL`,
      )
      .bind(id, now, text),
    db
      .prepare(
        `INSERT OR IGNORE INTO attention_items (item_key, kind, event_id, occurrence_id, detail, status, opened_at)
         SELECT 'undelivered:' || o.message_id, 'undelivered', c.event_id, b.occurrence_id, o.subject, 'open', ?2
         FROM outbox o JOIN bookings b ON b.booking_id = o.booking_id JOIN occurrences c ON c.occurrence_id = b.occurrence_id
         WHERE o.message_id = ?1 AND o.last_attempt_at = ?2 AND ${TO_CUSTOMER}`,
      )
      .bind(id, now),
  ]);
  const row = await db.prepare('SELECT dead_at, last_attempt_at FROM outbox WHERE message_id = ?1').bind(id).first<{ dead_at: string | null; last_attempt_at: string | null }>();
  if (!row) return 'not_found';
  if (!res?.meta.changes) return 'already';
  return row.dead_at ? 'dead' : 'ok';
}

/** An admin tries a failing or given-up email again now. */
export async function retryNow(db: D1Database, id: number, now: string): Promise<boolean> {
  const res = await db
    .prepare('UPDATE outbox SET dead_at = NULL, next_attempt_at = ?2, claim = NULL, claimed_at = NULL WHERE message_id = ?1 AND sent_at IS NULL AND attempts > 0')
    .bind(id, now)
    .run();
  return !!res.meta.changes;
}
