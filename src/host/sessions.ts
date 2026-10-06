// Host sessions: proposed in the organiser by hosts, approved or declined by
// staff. Approval doesn't publish anything by itself: n8n adds approved
// sessions to the Logic Engine, the one master calendar (docs/RTD_HOST_PORTAL.md).

import type { AuthUser } from '../lib/auth';
import { longDate, ukDate, weekdayOf } from '../lib/format';
import { addDays, londonDate, parseSheetDate } from '../lib/time';

export type SessionStatus = 'submitted' | 'approved' | 'declined' | 'withdrawn' | 'published';
/** The Logic Engine's own Frequency words, so a session maps straight onto Event Index. */
export type SessionFrequency = 'one-off' | 'weekly';
/** Open: anyone can come, and the diary shows it in full. Private: the host's own
 * group; the diary shows only "Private session" and its time (App Visibility Private). */
export type SessionAccess = 'open' | 'private';

export interface SessionInput {
  name: string;
  frequency: SessionFrequency;
  access: SessionAccess;
  description: string | null;
  event_date: string;
  start_time: string;
  end_time: string | null;
  price_pence: number;
  max_players: number;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseSheetDate(s) === s;
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max + 1) : '');

/** Field-by-field validation, so the form can show each problem next to its field. */
export function parseSessionInput(
  body: unknown,
  today = londonDate(new Date()),
): { ok: true; value: SessionInput } | { ok: false; errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};

  const name = clean(b.name, 80);
  if (name.length < 3) errors.name = 'Give the session a name (at least 3 characters).';
  else if (name.length > 80) errors.name = 'Keep the name to 80 characters.';

  const frequency = b.frequency ?? 'one-off';
  if (frequency !== 'one-off' && frequency !== 'weekly') errors.frequency = 'Choose one-off or weekly.';

  const access = b.access ?? 'open';
  if (access !== 'open' && access !== 'private') errors.access = 'Choose an open or private session.';

  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (description.length > 500) errors.description = 'Keep the description to 500 characters.';

  const date = b.event_date;
  if (!isDate(date)) errors.event_date = 'Choose a date.';
  else if (date <= today) errors.event_date = 'Choose a date from tomorrow onwards.';
  else if (date > addDays(today, 365)) errors.event_date = 'Choose a date within the next year.';

  const start = typeof b.start_time === 'string' ? b.start_time : '';
  if (!TIME.test(start)) errors.start_time = 'Choose a start time.';
  const end = typeof b.end_time === 'string' && b.end_time !== '' ? b.end_time : null;
  if (end !== null && !TIME.test(end)) errors.end_time = 'End time must be a time, like 21:30.';
  else if (end !== null && TIME.test(start) && end <= start) errors.end_time = 'End time must be after the start time.';

  const price = Number(b.price_pence ?? 0);
  if (!Number.isInteger(price) || price < 0 || price > 10_000) errors.price_pence = 'Cost must be between free and £100.';

  const players = Number(b.max_players);
  if (!Number.isInteger(players) || players < 1 || players > 100) errors.max_players = 'Max players must be between 1 and 100.';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      frequency: frequency as SessionFrequency,
      access: access as SessionAccess,
      description: description || null,
      event_date: date as string,
      start_time: start,
      end_time: end,
      price_pence: price,
      max_players: players,
    },
  };
}

/** "Free", "£5", "£7.50" */
export function priceLabel(pence: number): string {
  if (!pence) return 'Free';
  return pence % 100 ? `£${(pence / 100).toFixed(2)}` : `£${pence / 100}`;
}

const FIELDS = `s.session_id, s.host_user_id, u.display_name AS host_name, u.email AS host_email, s.name, s.description,
  s.event_date, s.start_time, s.end_time, s.price_pence, s.max_players, s.frequency, s.access, s.status, s.decision_note, s.decided_at,
  s.event_id, s.followup_sent_at, s.created_at, s.updated_at`;

export type SessionRow = Record<string, unknown> & { session_id: string; status: SessionStatus; host_user_id: string };

const withPrice = (r: SessionRow): SessionRow => ({ ...r, price_label: priceLabel(Number(r.price_pence)) });

export async function listSessions(db: D1Database, where: { hostUserId?: string; status?: SessionStatus }): Promise<SessionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${FIELDS} FROM host_sessions s JOIN users u ON u.user_id = s.host_user_id
       WHERE (?1 IS NULL OR s.host_user_id = ?1) AND (?2 IS NULL OR s.status = ?2)
       ORDER BY s.event_date DESC, s.start_time DESC LIMIT 200`,
    )
    .bind(where.hostUserId ?? null, where.status ?? null)
    .all<SessionRow>();
  return results.map(withPrice);
}

export async function getSession(db: D1Database, id: string): Promise<SessionRow | null> {
  const row = await db
    .prepare(`SELECT ${FIELDS} FROM host_sessions s JOIN users u ON u.user_id = s.host_user_id WHERE s.session_id = ?1`)
    .bind(id)
    .first<SessionRow>();
  return row ? withPrice(row) : null;
}

const audit = (
  db: D1Database,
  id: string,
  actor: AuthUser,
  actorType: 'host' | 'staff',
  action: string,
  prev: string | null,
  next: string | null,
  now: string,
) =>
  db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
       VALUES ('host_session', ?1, ?2, ?3, ?4, ?5, ?6, 'organiser', ?7)`,
    )
    .bind(id, actorType, actor.email, action, prev, next, now);

/** New session, numbered RTD-HS-00001 upwards in one statement (no race). */
export async function createSession(db: D1Database, host: AuthUser, input: SessionInput, now: string): Promise<SessionRow> {
  const inserted = await db
    .prepare(
      `INSERT INTO host_sessions (session_id, host_user_id, name, description, event_date, start_time, end_time,
         price_pence, max_players, frequency, access, status, created_at, updated_at)
       SELECT printf('RTD-HS-%05d', COALESCE(MAX(CAST(substr(session_id, 8) AS INTEGER)), 0) + 1),
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10, ?11, 'submitted', ?9, ?9
       FROM host_sessions
       RETURNING session_id`,
    )
    .bind(host.user_id, input.name, input.description, input.event_date, input.start_time, input.end_time,
      input.price_pence, input.max_players, now, input.frequency, input.access)
    .first<{ session_id: string }>();
  const id = inserted!.session_id;
  await audit(db, id, host, 'host', 'host_session.submitted', null, JSON.stringify(input), now).run();
  return (await getSession(db, id))!;
}

export type Transition = { ok: true; session: SessionRow } | { ok: false; status: 404 | 409; error: string };

/** A host withdraws their own session before it is in the diary. */
export async function withdrawSession(db: D1Database, host: AuthUser, id: string, now: string): Promise<Transition> {
  const s = await getSession(db, id);
  if (!s || s.host_user_id !== host.user_id) return { ok: false, status: 404, error: 'Session not found' };
  if (s.status !== 'submitted' && s.status !== 'approved') {
    const error = s.status === 'published' ? 'This session is already in the diary. Ask the café to cancel it.' : 'This session can no longer be withdrawn.';
    return { ok: false, status: 409, error };
  }
  await db.batch([
    db.prepare("UPDATE host_sessions SET status = 'withdrawn', updated_at = ?2 WHERE session_id = ?1").bind(id, now),
    audit(db, id, host, 'host', 'host_session.withdrawn', s.status, 'withdrawn', now),
  ]);
  return { ok: true, session: (await getSession(db, id))! };
}

/** Staff approve or decline a submitted session. */
export async function decideSession(
  db: D1Database,
  staff: AuthUser,
  id: string,
  decision: 'approve' | 'decline',
  note: string | null,
  now: string,
): Promise<Transition> {
  const s = await getSession(db, id);
  if (!s) return { ok: false, status: 404, error: 'Session not found' };
  if (s.status !== 'submitted') return { ok: false, status: 409, error: `This session is already ${s.status}.` };
  const status = decision === 'approve' ? 'approved' : 'declined';
  // Only move if still submitted, so two staff deciding at once can't both win.
  const res = await db
    .prepare(
      `UPDATE host_sessions SET status = ?2, decision_note = ?3, decided_by = ?4, decided_at = ?5, updated_at = ?5
       WHERE session_id = ?1 AND status = 'submitted'`,
    )
    .bind(id, status, note, staff.email, now)
    .run();
  if (!res.meta.changes) return { ok: false, status: 409, error: 'Someone else has just decided this session.' };
  await audit(db, id, staff, 'staff', `host_session.${status}`, 'submitted', note, now).run();
  return { ok: true, session: (await getSession(db, id))! };
}

// After a one-off session, n8n emails its host (docs/RTD_HOST_PORTAL.md). It
// only looks back a fortnight, so a long n8n outage can't email about old ones.
const FOLLOWUP_WINDOW_DAYS = 14;

/** One-off sessions that went ahead (approved or live), whose day has passed and whose host hasn't been emailed yet. */
export async function dueFollowups(db: D1Database, today: string) {
  const { results } = await db
    .prepare(
      `SELECT s.session_id, s.name, s.event_date, u.email AS host_email, u.display_name AS host_name
       FROM host_sessions s JOIN users u ON u.user_id = s.host_user_id
       WHERE s.frequency = 'one-off' AND s.status IN ('approved', 'published') AND s.followup_sent_at IS NULL
         AND s.event_date < ?1 AND s.event_date >= ?2 AND u.active = 1
       ORDER BY s.event_date, s.session_id LIMIT 50`,
    )
    .bind(today, addDays(today, -FOLLOWUP_WINDOW_DAYS))
    .all<{ session_id: string; name: string; event_date: string; host_email: string; host_name: string | null }>();
  return results.map(r => ({
    ...r,
    host_first_name: r.host_name?.trim().split(/\s+/)[0] || 'there',
    date_label: longDate(r.event_date),
  }));
}

/** n8n records that the email went out, so each host gets it once. */
export async function markFollowupSent(db: D1Database, id: string, now: string): Promise<'ok' | 'not_found' | 'already_sent'> {
  const res = await db
    .prepare("UPDATE host_sessions SET followup_sent_at = ?2 WHERE session_id = ?1 AND frequency = 'one-off' AND followup_sent_at IS NULL")
    .bind(id, now)
    .run();
  if (!res.meta.changes) {
    const row = await db.prepare("SELECT 1 FROM host_sessions WHERE session_id = ?1 AND frequency = 'one-off'").bind(id).first();
    return row ? 'already_sent' : 'not_found';
  }
  await db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, source, created_at)
       VALUES ('host_session', ?1, 'n8n', 'n8n', 'host_session.followup_sent', 'n8n', ?2)`,
    )
    .bind(id, now)
    .run();
  return 'ok';
}

// ---- Into the Logic Engine, and telling the café (n8n, docs/RTD_HOST_PORTAL.md) ----

const sessionWhen = (s: { frequency: string; event_date: string }) =>
  s.frequency === 'weekly' ? `Every ${weekdayOf(s.event_date)}, from ${longDate(s.event_date)}` : longDate(s.event_date);

/** A weekly session approved after its first date runs from its next week instead. */
function nextWeekly(iso: string, today: string): string {
  let d = iso;
  while (d < today) d = addDays(d, 7);
  return d;
}

interface PublishRow {
  session_id: string;
  name: string;
  description: string | null;
  event_date: string;
  start_time: string;
  end_time: string | null;
  price_pence: number;
  max_players: number;
  frequency: SessionFrequency;
  access: SessionAccess;
  host_email: string;
}

/**
 * Approved sessions not yet in Event Index, each with the exact row n8n appends
 * (keys are the sheet's column headers). One-offs whose day has gone are left out.
 */
export async function sessionsToPublish(db: D1Database, today: string) {
  const { results } = await db
    .prepare(
      `SELECT s.session_id, s.name, s.description, s.event_date, s.start_time, s.end_time, s.price_pence, s.max_players,
         s.frequency, s.access, u.email AS host_email
       FROM host_sessions s JOIN users u ON u.user_id = s.host_user_id
       WHERE s.status = 'approved' AND (s.frequency = 'weekly' OR s.event_date >= ?1)
       ORDER BY s.event_date, s.session_id LIMIT 50`,
    )
    .bind(today)
    .all<PublishRow>();
  return results.map(s => {
    const date = s.frequency === 'weekly' ? nextWeekly(s.event_date, today) : s.event_date;
    return {
      session_id: s.session_id,
      row: {
        'Event Name': s.name,
        Frequency: s.frequency === 'weekly' ? 'Weekly' : 'One-off',
        Day: weekdayOf(date),
        'Event Date': ukDate(date),
        'Event Time': s.start_time,
        'End Time': s.end_time ?? '',
        'Base Details': s.description ?? 'A games session hosted at Roll The Dice.',
        Status: 'Active',
        'Organiser Email': s.host_email,
        // Private: the diary shows only "Private session", and the social posts skip it.
        'App Visibility': s.access === 'private' ? 'Private' : 'Public',
        'App Category': 'Gaming',
        'App Price': priceLabel(s.price_pence),
        'App Capacity': String(s.max_players),
        'App Host Session': s.session_id,
      },
    };
  });
}

/** n8n added the session to Event Index: it's Live (the next sync links its Event ID). */
export async function markPublished(db: D1Database, id: string, now: string): Promise<'ok' | 'already' | 'not_found' | 'not_approved'> {
  const res = await db
    .prepare("UPDATE host_sessions SET status = 'published', published_at = ?2, updated_at = ?2 WHERE session_id = ?1 AND status = 'approved'")
    .bind(id, now)
    .run();
  if (!res.meta.changes) {
    const row = await db.prepare('SELECT status FROM host_sessions WHERE session_id = ?1').bind(id).first<{ status: string }>();
    return !row ? 'not_found' : row.status === 'published' ? 'already' : 'not_approved';
  }
  await db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
       VALUES ('host_session', ?1, 'n8n', 'n8n', 'host_session.published', 'approved', 'published', 'n8n', ?2)`,
    )
    .bind(id, now)
    .run();
  return 'ok';
}

/** Sessions waiting for approval that the café hasn't been emailed about yet. */
export async function newSubmissions(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT s.session_id, s.name, s.description, s.event_date, s.start_time, s.end_time, s.price_pence, s.max_players,
         s.frequency, s.access, u.display_name AS host_name, u.email AS host_email
       FROM host_sessions s JOIN users u ON u.user_id = s.host_user_id
       WHERE s.status = 'submitted' AND s.cafe_notified_at IS NULL
       ORDER BY s.created_at, s.session_id LIMIT 50`,
    )
    .all<PublishRow & { host_name: string | null }>();
  return results.map(s => ({
    session_id: s.session_id,
    name: s.name,
    description: s.description,
    host_name: s.host_name ?? s.host_email,
    host_email: s.host_email,
    when: sessionWhen(s),
    time: s.end_time ? `${s.start_time}–${s.end_time}` : s.start_time,
    price: priceLabel(s.price_pence),
    max_players: s.max_players,
    access: s.access === 'private' ? 'Private (their own group)' : 'Open to anyone',
  }));
}

/** n8n emailed the café about this submission; once is enough. */
export async function markCafeNotified(db: D1Database, id: string, now: string): Promise<'ok' | 'already' | 'not_found'> {
  const res = await db
    .prepare('UPDATE host_sessions SET cafe_notified_at = ?2 WHERE session_id = ?1 AND cafe_notified_at IS NULL')
    .bind(id, now)
    .run();
  if (res.meta.changes) return 'ok';
  const row = await db.prepare('SELECT 1 FROM host_sessions WHERE session_id = ?1').bind(id).first();
  return row ? 'already' : 'not_found';
}

/**
 * Sessions the café decided on in the last fortnight whose host hasn't been
 * emailed yet. An approved session may already be Live by the time n8n looks.
 */
export async function decidedSessionsForHosts(db: D1Database, today: string) {
  const { results } = await db
    .prepare(
      `SELECT s.session_id, s.name, s.event_date, s.start_time, s.end_time, s.frequency, s.access, s.status,
         s.decision_note, u.email AS host_email, u.display_name AS host_name
       FROM host_sessions s JOIN users u ON u.user_id = s.host_user_id
       WHERE s.decided_at IS NOT NULL AND s.host_notified_at IS NULL AND s.decided_at >= ?1
         AND s.status IN ('approved', 'published', 'declined') AND u.active = 1
       ORDER BY s.decided_at, s.session_id LIMIT 50`,
    )
    .bind(addDays(today, -14))
    .all<PublishRow & { status: SessionStatus; decision_note: string | null; host_name: string | null }>();
  return results.map(s => ({
    session_id: s.session_id,
    name: s.name,
    approved: s.status !== 'declined',
    private: s.access === 'private',
    when: sessionWhen(s),
    time: s.end_time ? `${s.start_time}–${s.end_time}` : s.start_time,
    decision_note: s.decision_note,
    host_email: s.host_email,
    host_first_name: s.host_name?.trim().split(/\s+/)[0] || 'there',
  }));
}

export async function markHostNotified(db: D1Database, id: string, now: string): Promise<'ok' | 'already' | 'not_found'> {
  const res = await db
    .prepare('UPDATE host_sessions SET host_notified_at = ?2 WHERE session_id = ?1 AND host_notified_at IS NULL')
    .bind(id, now)
    .run();
  if (res.meta.changes) return 'ok';
  const row = await db.prepare('SELECT 1 FROM host_sessions WHERE session_id = ?1').bind(id).first();
  return row ? 'already' : 'not_found';
}

/** Hosts, newest first, for the staff section of the organiser. */
export async function listHosts(db: D1Database) {
  const { results } = await db
    .prepare("SELECT user_id, email, display_name, role, active, created_at FROM users WHERE role = 'host' ORDER BY created_at DESC")
    .all<Record<string, unknown>>();
  return results;
}
