// What the organiser shows about delivery (docs/RTD_EVENT_CONTROL_AUDIT.md §5.3; Stage 4b):
// how the last 7 days' emails and booking pushes have gone, and each one that's failing
// or was given up on in the last 30 days. "Sent" only ever means the provider accepted
// it (Gmail, or the push service); nothing here can say it was read.

const WEEK_MS = 7 * 86_400_000;
const MONTH_MS = 30 * 86_400_000;

type Counts = { sent: number; waiting: number; failing: number; failed: number };
const NOT_GONE = 'COALESCE(last_status, 0) NOT IN (404, 410, -1)';

/** Where an email went, in words. null and '@…' are the café's own inboxes, filled in by n8n. */
const recipient = (to: string | null) => (to === null ? "the café's address" : to === '@bookings' ? 'the bookings inbox' : to === '@approvals' ? "the approvers' inbox" : to);

export async function deliveryOverview(db: D1Database, now: Date) {
  const week = new Date(now.getTime() - WEEK_MS).toISOString();
  const month = new Date(now.getTime() - MONTH_MS).toISOString();
  const state = `CASE WHEN sent_at IS NOT NULL THEN 'sent' WHEN dead_at IS NOT NULL THEN 'failed' WHEN attempts > 0 THEN 'failing' ELSE 'waiting' END`;
  const [emailCounts, pushCounts, emails, pushes] = await db.batch([
    db.prepare(`SELECT ${state} AS state, COUNT(*) AS n FROM outbox WHERE created_at >= ?1 GROUP BY 1`).bind(week),
    // A browser that has gone (404 / 410) or was turned off first (-1) isn't a failure: the email still went.
    db.prepare(`SELECT ${state} AS state, COUNT(*) AS n FROM push_outbox WHERE created_at >= ?1 AND ${NOT_GONE} GROUP BY 1`).bind(week),
    db
      .prepare(
        `SELECT o.message_id, o.kind, o.to_email, o.subject, o.attempts, o.last_error, o.last_attempt_at, o.next_attempt_at, o.dead_at, o.created_at,
           o.booking_id, b.lead_name, b.mobile
         FROM outbox o LEFT JOIN bookings b ON b.booking_id = o.booking_id
         WHERE o.sent_at IS NULL AND o.attempts > 0 AND o.created_at >= ?1
         ORDER BY o.dead_at IS NULL, o.message_id DESC LIMIT 50`,
      )
      .bind(month),
    db
      .prepare(
        `SELECT push_id, kind, booking_id, title, attempts, last_status, last_error, last_attempt_at, next_attempt_at, dead_at, created_at
         FROM push_outbox WHERE sent_at IS NULL AND attempts > 0 AND ${NOT_GONE} AND created_at >= ?1
         ORDER BY dead_at IS NULL, push_id DESC LIMIT 50`,
      )
      .bind(month),
  ]);
  const count = (r: D1Result | undefined): Counts => {
    const out: Counts = { sent: 0, waiting: 0, failing: 0, failed: 0 };
    for (const row of (r?.results ?? []) as { state: keyof Counts; n: number }[]) out[row.state] = row.n;
    return out;
  };
  type EmailRow = {
    message_id: number;
    kind: string;
    to_email: string | null;
    subject: string;
    attempts: number;
    last_error: string | null;
    last_attempt_at: string | null;
    next_attempt_at: string | null;
    dead_at: string | null;
    created_at: string;
    booking_id: string | null;
    lead_name: string | null;
    mobile: string | null;
  };
  return {
    email: count(emailCounts),
    push: count(pushCounts),
    emails: ((emails?.results ?? []) as EmailRow[]).map(e => ({
      message_id: e.message_id,
      kind: e.kind,
      to: recipient(e.to_email),
      subject: e.subject,
      attempts: e.attempts,
      last_error: e.last_error,
      last_attempt_at: e.last_attempt_at,
      next_attempt_at: e.dead_at ? null : e.next_attempt_at,
      given_up: !!e.dead_at,
      created_at: e.created_at,
      booking_id: e.booking_id,
      contact: e.lead_name && e.lead_name !== 'Erased' ? { name: e.lead_name, mobile: e.mobile } : null,
    })),
    pushes: ((pushes?.results ?? []) as { push_id: number; kind: string; booking_id: string; title: string; attempts: number; last_status: number | null; last_error: string | null; last_attempt_at: string | null; next_attempt_at: string | null; dead_at: string | null; created_at: string }[]).map(p => ({
      push_id: p.push_id,
      kind: p.kind,
      booking_id: p.booking_id,
      title: p.title,
      attempts: p.attempts,
      last_error: p.last_error,
      next_attempt_at: p.dead_at ? null : p.next_attempt_at,
      given_up: !!p.dead_at,
      created_at: p.created_at,
    })),
  };
}

export type DeliveryOverview = Awaited<ReturnType<typeof deliveryOverview>>;
