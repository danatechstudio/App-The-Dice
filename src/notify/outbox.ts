// The app's email outbox (docs/RTD_BOOKINGS.md). Emails are written here in
// the same transaction as the change they describe; n8n (RTD Outbox) collects
// them every few minutes, sends each through Gmail and marks it sent.
// dedupe_key makes every email once-only, however often a step is retried.

import type { Email } from './emails';

/** Sent emails are kept this long (they hold names and email addresses), then deleted. */
const KEEP_SENT_DAYS = 90;
const BATCH = 50;

export function queue(db: D1Database, e: Email, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox (dedupe_key, kind, to_email, reply_to, subject, html, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(e.dedupe_key, e.kind, e.to, e.reply_to, e.subject, e.html, now);
}

/**
 * Queues an email about a booking saved earlier in the same batch, found by its
 * token hash. `{{booking_id}}` in the key, subject and body becomes its ID, and
 * nothing is queued if the booking wasn't saved (for example, the session filled up).
 */
export function queueForBooking(db: D1Database, e: Email, tokenHash: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox (dedupe_key, kind, to_email, reply_to, subject, html, created_at)
       SELECT replace(?1, '{{booking_id}}', booking_id), ?2, ?3, ?4, replace(?5, '{{booking_id}}', booking_id),
         replace(?6, '{{booking_id}}', booking_id), ?7
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

/** Unsent emails, oldest first. Also deletes sent ones past their keep-by date. */
export async function unsent(db: D1Database, now: string): Promise<OutboxMessage[]> {
  const cutoff = new Date(Date.parse(now) - KEEP_SENT_DAYS * 86_400_000).toISOString();
  const [, list] = await db.batch([
    db.prepare('DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?1').bind(cutoff),
    db.prepare(`SELECT message_id, to_email AS "to", reply_to, subject, html FROM outbox WHERE sent_at IS NULL ORDER BY message_id LIMIT ${BATCH}`),
  ]);
  return (list?.results ?? []) as unknown as OutboxMessage[];
}

export async function markSent(db: D1Database, id: number, now: string): Promise<'ok' | 'already' | 'not_found'> {
  const res = await db.prepare('UPDATE outbox SET sent_at = ?2 WHERE message_id = ?1 AND sent_at IS NULL').bind(id, now).run();
  if (res.meta.changes) return 'ok';
  const row = await db.prepare('SELECT 1 FROM outbox WHERE message_id = ?1').bind(id).first();
  return row ? 'already' : 'not_found';
}
