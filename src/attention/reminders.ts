// Needs attention emails (docs/RTD_EVENT_CONTROL_AUDIT.md §5.1; Stage 3c).
//
// - A notice when a date passes with nothing after it (an `expired` item), once per
//   item per address: dedupe key 'expiry-new:<item_id>:<address>'. At most 5 items a
//   run, so even a burst can't flood anyone; the rest follow in the next runs.
// - A reminder every morning from 09:00 London, at most once a day per address
//   ('expiry-digest:<date>:<address>'), listing every expired item still waiting
//   that was announced before today. It stops when nothing is waiting.
// - Events with no usable date aren't emailed; the reminder only counts them.
//
// Emails go through the outbox (n8n RTD Outbox, Gmail) to the addresses an admin
// sets in the organiser. They live only in the live database. Opening an email never
// resolves anything. "Sent" means Gmail accepted it (the outbox's sent_at), never
// "delivered". Runs from the hourly Cron Trigger, after the detector.

import { EMAIL } from '../bookings/bookings';
import type { AuthUser } from '../lib/auth';
import { clock, esc, longDate, shortDate } from '../lib/format';
import { londonDate, londonHour, londonToUtc } from '../lib/time';
import { join, link, p, type Email } from '../notify/emails';
import { queue } from '../notify/outbox';
import { enabled, ref } from './attention';

/** Items announced per run, at most. */
export const NOTICES_PER_RUN = 5;
export const MAX_RECIPIENTS = 5;
/** The morning reminder goes from this hour, London time. */
export const DIGEST_HOUR = 9;
/** An email still unsent after this long is shown to admins as stuck. */
const STUCK_MS = 30 * 60_000;

const SIGN_OFF = p('The Roll The Dice app');

export async function emailSettings(db: D1Database): Promise<{ on: boolean; to: string[] }> {
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key IN ('attention_emails', 'attention_email_to')").all<{ key: string; value: string }>();
  const get = (k: string) => results.find(r => r.key === k)?.value ?? '';
  return { on: get('attention_emails') === 'on', to: get('attention_email_to').split(',').filter(Boolean) };
}

interface Waiting {
  item_id: number;
  name: string;
  date: string | null;
  start_time: string | null;
  opened_at: string;
  reminder_count: number;
}

const WAITING_SQL = `
  SELECT a.item_id, e.display_name AS name, o.event_date AS date, o.start_time, a.opened_at, a.reminder_count
  FROM attention_items a JOIN events e ON e.event_id = a.event_id
  LEFT JOIN occurrences o ON o.occurrence_id = a.occurrence_id
  WHERE a.kind = 'expired' AND a.status = 'open'`;

const organiserLink = (origin: string) => p(link(`${origin}/organise#attention`, 'Open Needs attention in the organiser'));
const when = (w: Waiting) => (w.date ? `${longDate(w.date)}${w.start_time ? ` at ${clock(w.start_time)}` : ''}` : 'its last date');

/** One expired item, to one address. */
export function noticeEmail(w: Waiting, to: string, origin: string): Email {
  return {
    dedupe_key: `expiry-new:${w.item_id}:${to}`,
    kind: 'attention_expired',
    to,
    reply_to: null,
    subject: `Needs attention: ${w.name}${w.date ? ` (${shortDate(w.date)})` : ''} has no next date`,
    html: join([
      p(`<strong>${esc(w.name)}</strong> finished on ${when(w)}, and there's no next date in the app, so customers no longer see it.`),
      p('In the organiser, choose one:'),
      `<ul><li><strong>Set a new date</strong> if it's running again</li><li><strong>Archive</strong> if it isn't coming back</li><li><strong>Finished, no new date</strong> if it was a one-off</li></ul>`,
      organiserLink(origin),
      p(`A reminder comes every morning until it's sorted. Opening this email doesn't sort it. Reference ${ref(w.item_id)}.`),
      SIGN_OFF,
    ]),
  };
}

/** Everything still waiting, to one address, once a day. */
export function digestEmail(list: Waiting[], noDate: number, day: string, to: string, origin: string, now: Date): Email {
  const days = (w: Waiting) => Math.max(0, Math.floor((now.getTime() - Date.parse(w.opened_at)) / 86_400_000));
  const n = list.length;
  return {
    dedupe_key: `expiry-digest:${day}:${to}`,
    kind: 'attention_digest',
    to,
    reply_to: null,
    subject: `Needs attention: ${n} ${n === 1 ? 'event' : 'events'} still waiting`,
    html: join([
      p(`${n === 1 ? 'This event has' : 'These events have'} finished with no next date, and ${n === 1 ? "hasn't" : "haven't"} been sorted yet:`),
      `<ul>${list
        .map(w => `<li><strong>${esc(w.name)}</strong>: finished ${w.date ? shortDate(w.date) : ''}, waiting ${days(w) === 1 ? '1 day' : `${days(w)} days`} (${ref(w.item_id)})</li>`)
        .join('')}</ul>`,
      noDate > 0 && p(`Also ${noDate} ${noDate === 1 ? 'event has' : 'events have'} no usable date in the Logic Engine; they're listed in the organiser too.`),
      organiserLink(origin),
      p('For each one: set a new date, archive it, or mark it finished. This reminder comes every morning while anything is waiting.'),
      SIGN_OFF,
    ]),
  };
}

export function testEmail(to: string, minute: string, origin: string): Email {
  return {
    dedupe_key: `expiry-test:${minute}:${to}`,
    kind: 'attention_test',
    to,
    reply_to: null,
    subject: 'Needs attention: test email',
    html: join([
      p("This is a test from the Roll The Dice app. Emails about events that need attention will come to this address: a notice when a date passes with nothing after it, and a reminder every morning until it's sorted."),
      organiserLink(origin),
      SIGN_OFF,
    ]),
  };
}

/**
 * Queues what's due: notices for newly expired items, and from 09:00 London the
 * day's reminder. Idempotent: rerunning queues nothing twice.
 */
export async function remind(db: D1Database, now: Date, origin: string): Promise<{ notices: number; digest: number }> {
  if (!(await enabled(db))) return { notices: 0, digest: 0 };
  const settings = await emailSettings(db);
  if (!settings.on || !settings.to.length) return { notices: 0, digest: 0 };
  const iso = now.toISOString();
  const today = londonDate(now);
  const startOfToday = londonToUtc(today, '00:00');

  // Notices: expired items nobody has been told about yet.
  const { results: fresh } = await db.prepare(`${WAITING_SQL} AND a.first_notified_at IS NULL ORDER BY a.item_id LIMIT ${NOTICES_PER_RUN}`).all<Waiting>();
  if (fresh.length) {
    await db.batch([
      ...fresh.flatMap(w => settings.to.map(to => queue(db, noticeEmail(w, to, origin), iso))),
      db
        .prepare('UPDATE attention_items SET first_notified_at = ?2 WHERE item_id IN (SELECT value FROM json_each(?1)) AND first_notified_at IS NULL')
        .bind(JSON.stringify(fresh.map(w => w.item_id)), iso),
    ]);
  }

  // The morning reminder: everything announced before today and still waiting.
  let digest = 0;
  if (londonHour(now) >= DIGEST_HOUR) {
    const [listRes, noDateRes] = await db.batch([
      db.prepare(`${WAITING_SQL} AND a.first_notified_at < ?1 ORDER BY a.opened_at, a.item_id LIMIT 50`).bind(startOfToday),
      db.prepare("SELECT COUNT(*) AS n FROM attention_items WHERE kind = 'no_date' AND status = 'open'"),
    ]);
    const list = (listRes?.results ?? []) as unknown as Waiting[];
    if (list.length) {
      const noDate = Number((noDateRes?.results[0] as { n: number } | undefined)?.n ?? 0);
      await db.batch([
        ...settings.to.map(to => queue(db, digestEmail(list, noDate, today, to, origin, now), iso)),
        // Counted once a day, however often this runs.
        db
          .prepare(
            `UPDATE attention_items SET reminder_count = reminder_count + 1, last_reminded_at = ?2
             WHERE item_id IN (SELECT value FROM json_each(?1)) AND (last_reminded_at IS NULL OR last_reminded_at < ?3)`,
          )
          .bind(JSON.stringify(list.map(w => w.item_id)), iso, startOfToday),
      ]);
      digest = list.length;
    }
  }
  return { notices: fresh.length, digest };
}

// ---- Settings, for admins ----

type Fail = { ok: false; status: 400 | 403; error: string; errors?: Record<string, string> };

/**
 * Body: { to?: string (addresses, separated by commas or spaces), on?: boolean }.
 * Switching on puts the expired items already waiting into the next morning's
 * reminder rather than sending each a notice now.
 */
export async function setEmailSettings(db: D1Database, admin: AuthUser, body: unknown, now: Date): Promise<{ ok: true; on: boolean; to: string[] } | Fail> {
  if (admin.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can change who gets these emails.' };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const current = await emailSettings(db);
  let to = current.to;
  if (b.to !== undefined) {
    if (typeof b.to !== 'string') return { ok: false, status: 400, error: 'Please check the form', errors: { to: 'Enter one or more email addresses.' } };
    const list = [...new Set(b.to.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean))];
    const bad = list.find(a => !EMAIL.test(a) || a.length > 200);
    if (bad) return { ok: false, status: 400, error: 'Please check the form', errors: { to: `"${bad}" isn't an email address.` } };
    if (list.length > MAX_RECIPIENTS) return { ok: false, status: 400, error: 'Please check the form', errors: { to: `Up to ${MAX_RECIPIENTS} addresses.` } };
    to = list;
  }
  const on = typeof b.on === 'boolean' ? b.on : current.on;
  if (on && !to.length) return { ok: false, status: 400, error: 'Please check the form', errors: { to: 'Add at least one address first.' } };
  const iso = now.toISOString();
  const set = (key: string, value: string) =>
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(key, value, iso, admin.email);
  await db.batch([
    set('attention_email_to', to.join(',')),
    set('attention_emails', on ? 'on' : 'off'),
    ...(on && !current.on
      ? [db.prepare("UPDATE attention_items SET first_notified_at = ?1 WHERE kind = 'expired' AND status = 'open' AND first_notified_at IS NULL").bind(iso)]
      : []),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, new_value, source, created_at)
         VALUES ('setting', 'attention_emails', 'staff', ?1, 'attention.emails_changed', ?2, 'organiser', ?3)`,
      )
      .bind(admin.email, JSON.stringify({ on, to }), iso),
  ]);
  return { ok: true, on, to };
}

/** A test to every address, at most once a minute. */
export async function sendTest(db: D1Database, admin: AuthUser, now: Date, origin: string): Promise<{ ok: true; to: string[] } | Fail> {
  if (admin.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can send a test.' };
  const { to } = await emailSettings(db);
  if (!to.length) return { ok: false, status: 400, error: 'Add at least one address first.' };
  const minute = now.toISOString().slice(0, 16);
  await db.batch(to.map(a => queue(db, testEmail(a, minute, origin), now.toISOString())));
  return { ok: true, to };
}

// ---- What the organiser shows ----

type Delivery = 'queued' | 'sent' | 'stuck';

/** How each email has gone: Gmail accepted it (sent), it's waiting (queued), or it's been waiting too long (stuck). */
function delivery(rows: { created_at: string; sent_at: string | null }[], now: Date): Delivery | null {
  if (!rows.length) return null;
  if (rows.every(r => r.sent_at)) return 'sent';
  return rows.some(r => !r.sent_at && now.getTime() - Date.parse(r.created_at) > STUCK_MS) ? 'stuck' : 'queued';
}

/** Email settings, the latest morning reminder and test, and each open item's emails. */
export async function emailOverview(db: D1Database, itemIds: number[], now: Date) {
  const settings = await emailSettings(db);
  const [itemsRes, outboxRes] = await db.batch([
    db
      .prepare('SELECT item_id, first_notified_at, last_reminded_at, reminder_count FROM attention_items WHERE item_id IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify(itemIds)),
    db.prepare(
      "SELECT dedupe_key, created_at, sent_at FROM outbox WHERE dedupe_key LIKE 'expiry-new:%' OR dedupe_key LIKE 'expiry-digest:%' OR dedupe_key LIKE 'expiry-test:%' ORDER BY message_id DESC LIMIT 500",
    ),
  ]);
  const rows = (outboxRes?.results ?? []) as { dedupe_key: string; created_at: string; sent_at: string | null }[];
  const latest = (prefix: string) => {
    const first = rows.find(r => r.dedupe_key.startsWith(prefix));
    if (!first) return null;
    const stamp = first.dedupe_key.split(':').slice(0, -1).join(':'); // without the address
    const batch = rows.filter(r => r.dedupe_key.startsWith(`${stamp}:`));
    return { queued_at: first.created_at, state: delivery(batch, now) };
  };
  const items = Object.fromEntries(
    ((itemsRes?.results ?? []) as { item_id: number; first_notified_at: string | null; last_reminded_at: string | null; reminder_count: number }[]).map(i => [
      i.item_id,
      {
        first_notified_at: i.first_notified_at,
        notice: delivery(rows.filter(r => r.dedupe_key.startsWith(`expiry-new:${i.item_id}:`)), now),
        reminder_count: i.reminder_count,
        last_reminded_at: i.last_reminded_at,
      },
    ]),
  );
  return { on: settings.on, to: settings.to, digest: latest('expiry-digest:'), test: latest('expiry-test:'), items };
}
