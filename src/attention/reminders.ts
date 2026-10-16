// Needs attention emails (docs/RTD_EVENT_CONTROL_AUDIT.md §5.1; Stage 3c).
//
// - A notice when a date passes with nothing after it (an `expired` item), once per
//   item per address: dedupe key 'expiry-new:<item_id>:<address>'. At most 5 items a
//   run, so even a burst can't flood anyone; the rest follow in the next runs. The same
//   goes for a booked date the Logic Engine moved (`moved`) and an email to a customer
//   that didn't go (`undelivered`), from Stage 4b, and a cancelled monthly or Standard
//   Diary date that needs the sheet changing (`cancelled`), from Stage 4c.
// - A reminder every morning from 09:00 London, at most once a day per address
//   ('expiry-digest:<date>:<address>'), listing every such item still waiting
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
/** The kinds of item that are emailed. */
const EMAILED = "('expired', 'moved', 'undelivered', 'cancelled')";

const SIGN_OFF = p('The Roll The Dice app');

export async function emailSettings(db: D1Database): Promise<{ on: boolean; to: string[] }> {
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key IN ('attention_emails', 'attention_email_to')").all<{ key: string; value: string }>();
  const get = (k: string) => results.find(r => r.key === k)?.value ?? '';
  return { on: get('attention_emails') === 'on', to: get('attention_email_to').split(',').filter(Boolean) };
}

interface Waiting {
  item_id: number;
  kind: 'expired' | 'moved' | 'undelivered' | 'cancelled';
  name: string;
  /** cancelled: a Standard Diary group (changed by hand) or an Event Index monthly. */
  source: string;
  date: string | null;
  start_time: string | null;
  opened_at: string;
  reminder_count: number;
  /** undelivered: the email's subject. */
  detail: string | null;
  /** moved: where to, and how many are booked on the old date. */
  new_date: string | null;
  booked: number;
}

const WAITING_SQL = `
  SELECT a.item_id, a.kind, e.display_name AS name, e.source, o.event_date AS date, o.start_time, a.opened_at, a.reminder_count, a.detail,
    nt.event_date AS new_date,
    (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = a.occurrence_id AND b.status = 'confirmed') AS booked
  FROM attention_items a JOIN events e ON e.event_id = a.event_id
  LEFT JOIN occurrences o ON o.occurrence_id = a.occurrence_id
  LEFT JOIN occurrences nt ON nt.occurrence_id = o.rescheduled_to
  WHERE a.kind IN ${EMAILED} AND a.status = 'open'`;

const bookingsText = (n: number) => (n === 1 ? '1 booking' : `${n} bookings`);

const organiserLink = (origin: string) => p(link(`${origin}/organise#attention`, 'Open Needs attention in the organiser'));
const when = (w: Waiting) => (w.date ? `${longDate(w.date)}${w.start_time ? ` at ${clock(w.start_time)}` : ''}` : 'its last date');

/** One item, to one address. */
export function noticeEmail(w: Waiting, to: string, origin: string): Email {
  const base = { dedupe_key: `expiry-new:${w.item_id}:${to}`, to, reply_to: null };
  if (w.kind === 'moved') {
    return {
      ...base,
      kind: 'attention_moved',
      subject: `Needs attention: ${w.name}${w.date ? ` (${shortDate(w.date)})` : ''} has moved, with ${bookingsText(w.booked)}`,
      html: join([
        p(
          `<strong>${esc(w.name)}</strong> on ${when(w)} has moved in the Logic Engine${w.new_date ? ` to ${longDate(w.new_date)}` : ''}, ` +
            `and ${bookingsText(w.booked)} ${w.booked === 1 ? 'was' : 'were'} for the old date. Nobody booked has been told yet.`,
        ),
        p('In the organiser, choose one:'),
        `<ul>${w.new_date ? '<li><strong>Tell them it has moved</strong>: their bookings for the old date are cancelled, and they\'re sent a link to book the new one</li>' : ''}<li><strong>Cancel their bookings</strong>: they're told it's cancelled</li><li><strong>Leave it</strong>, if you've told them yourself or the move was a mistake</li></ul>`,
        organiserLink(origin),
        p(`A reminder comes every morning until it's sorted. Opening this email doesn't sort it. Reference ${ref(w.item_id)}.`),
        SIGN_OFF,
      ]),
    };
  }
  if (w.kind === 'cancelled') {
    const diary = w.source === 'standard_diary';
    return {
      ...base,
      kind: 'attention_cancelled',
      subject: `Needs attention: ${w.name}${w.date ? ` (${shortDate(w.date)})` : ''} was cancelled${diary ? ': change the Standard Diary' : ': set its next date'}`,
      html: join([
        diary
          ? p(
              `<strong>${esc(w.name)}</strong> on ${when(w)} was cancelled in the app, but the Standard Diary tab still has that date, so it may still be advertised. ` +
                "The app can't change that tab: please change its Date there (move it on to the next meeting, or clear it).",
            )
          : p(
              `<strong>${esc(w.name)}</strong> on ${when(w)} was cancelled. It's switched off in the Logic Engine, so it isn't advertised. ` +
                'Set its next date in the organiser, or archive it if it isn\'t coming back.',
            ),
        organiserLink(origin),
        p(`${diary ? 'This clears itself when the sheet changes. ' : ''}A reminder comes every morning until it's sorted. Reference ${ref(w.item_id)}.`),
        SIGN_OFF,
      ]),
    };
  }
  if (w.kind === 'undelivered') {
    return {
      ...base,
      kind: 'attention_undelivered',
      subject: `Needs attention: an email to a customer didn't go (${w.name})`,
      html: join([
        p(`The email "${esc(w.detail ?? '')}" to someone booked on <strong>${esc(w.name)}</strong> couldn't be sent, so they may not know.`),
        p("It's tried again by itself. The organiser has their details, if you'd rather reach them another way."),
        organiserLink(origin),
        p(`Reference ${ref(w.item_id)}.`),
        SIGN_OFF,
      ]),
    };
  }
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
  const waited = (w: Waiting) => `waiting ${days(w) === 1 ? '1 day' : `${days(w)} days`} (${ref(w.item_id)})`;
  const line = (w: Waiting) =>
    w.kind === 'moved'
      ? `<li><strong>${esc(w.name)}</strong>: moved from ${w.date ? shortDate(w.date) : 'its date'}${w.new_date ? ` to ${shortDate(w.new_date)}` : ''}, ${bookingsText(w.booked)} not told, ${waited(w)}</li>`
      : w.kind === 'undelivered'
        ? `<li><strong>${esc(w.name)}</strong>: an email to a customer didn't go ("${esc(w.detail ?? '')}"), ${waited(w)}</li>`
        : w.kind === 'cancelled'
          ? `<li><strong>${esc(w.name)}</strong>: ${w.date ? shortDate(w.date) : 'its date'} was cancelled, ${w.source === 'standard_diary' ? 'the Standard Diary tab still has that date' : 'needs its next date'}, ${waited(w)}</li>`
        : `<li><strong>${esc(w.name)}</strong>: finished ${w.date ? shortDate(w.date) : ''}, ${waited(w)}</li>`;
  const n = list.length;
  const onlyExpired = list.every(w => w.kind === 'expired');
  return {
    dedupe_key: `expiry-digest:${day}:${to}`,
    kind: 'attention_digest',
    to,
    reply_to: null,
    subject: `Needs attention: ${n} ${onlyExpired ? (n === 1 ? 'event' : 'events') : n === 1 ? 'thing' : 'things'} still waiting`,
    html: join([
      onlyExpired
        ? p(`${n === 1 ? 'This event has' : 'These events have'} finished with no next date, and ${n === 1 ? "hasn't" : "haven't"} been sorted yet:`)
        : p(`${n === 1 ? 'This still needs' : 'These still need'} someone to decide:`),
      `<ul>${list.map(line).join('')}</ul>`,
      noDate > 0 && p(`Also ${noDate} ${noDate === 1 ? 'event has' : 'events have'} no usable date in the Logic Engine; they're listed in the organiser too.`),
      organiserLink(origin),
      p(
        onlyExpired
          ? 'For each one: set a new date, archive it, or mark it finished. This reminder comes every morning while anything is waiting.'
          : 'Each one is sorted in the organiser. This reminder comes every morning while anything is waiting.',
      ),
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
      ? [db.prepare(`UPDATE attention_items SET first_notified_at = ?1 WHERE kind IN ${EMAILED} AND status = 'open' AND first_notified_at IS NULL`).bind(iso)]
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

type Delivery = 'queued' | 'sent' | 'stuck' | 'failing' | 'failed';
type DeliveryRow = { created_at: string; sent_at: string | null; attempts: number; dead_at: string | null };

/**
 * How each email has gone: Gmail accepted it (sent), it's waiting (queued), it's been
 * waiting too long (stuck), Gmail refused it and it's being tried again (failing), or it
 * was given up on (failed).
 */
function delivery(rows: DeliveryRow[], now: Date): Delivery | null {
  if (!rows.length) return null;
  if (rows.every(r => r.sent_at)) return 'sent';
  if (rows.some(r => r.dead_at && !r.sent_at)) return 'failed';
  if (rows.some(r => r.attempts > 0 && !r.sent_at)) return 'failing';
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
      "SELECT dedupe_key, created_at, sent_at, attempts, dead_at FROM outbox WHERE dedupe_key LIKE 'expiry-new:%' OR dedupe_key LIKE 'expiry-digest:%' OR dedupe_key LIKE 'expiry-test:%' ORDER BY message_id DESC LIMIT 500",
    ),
  ]);
  const rows = (outboxRes?.results ?? []) as (DeliveryRow & { dedupe_key: string })[];
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
