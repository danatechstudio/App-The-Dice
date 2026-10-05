// Host sessions: proposed in the organiser by hosts, approved or declined by
// staff. Approval doesn't publish anything by itself: n8n adds approved
// sessions to the Logic Engine, the one master calendar (docs/RTD_HOST_PORTAL.md).

import type { AuthUser } from '../lib/auth';
import { addDays, londonDate, parseSheetDate } from '../lib/time';

export type SessionStatus = 'submitted' | 'approved' | 'declined' | 'withdrawn' | 'published';

export interface SessionInput {
  name: string;
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
  s.event_date, s.start_time, s.end_time, s.price_pence, s.max_players, s.status, s.decision_note, s.decided_at,
  s.event_id, s.created_at, s.updated_at`;

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
         price_pence, max_players, status, created_at, updated_at)
       SELECT printf('RTD-HS-%05d', COALESCE(MAX(CAST(substr(session_id, 8) AS INTEGER)), 0) + 1),
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'submitted', ?9, ?9
       FROM host_sessions
       RETURNING session_id`,
    )
    .bind(host.user_id, input.name, input.description, input.event_date, input.start_time, input.end_time,
      input.price_pence, input.max_players, now)
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

/** Hosts, newest first, for the staff section of the organiser. */
export async function listHosts(db: D1Database) {
  const { results } = await db
    .prepare("SELECT user_id, email, display_name, role, active, created_at FROM users WHERE role = 'host' ORDER BY created_at DESC")
    .all<Record<string, unknown>>();
  return results;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Staff add a host (or reactivate one). Staff and admins can already host. */
export async function addHost(
  db: D1Database,
  staff: AuthUser,
  body: unknown,
  now: string,
): Promise<{ ok: true; host: Record<string, unknown> } | { ok: false; status: 400 | 409; errors: Record<string, string> }> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const name = clean(b.display_name, 60);
  const errors: Record<string, string> = {};
  if (!EMAIL.test(email) || email.length > 200) errors.email = 'Enter the email address they will sign in with.';
  if (name.length < 2 || name.length > 60) errors.display_name = 'Enter their name (2–60 characters).';
  if (Object.keys(errors).length) return { ok: false, status: 400, errors };

  const existing = await db.prepare('SELECT user_id, role, active FROM users WHERE email = ?1').bind(email).first<{ user_id: string; role: string; active: number }>();
  if (existing && existing.role !== 'host') return { ok: false, status: 409, errors: { email: `That address is already ${existing.role}, which can host anyway.` } };
  const userId = existing?.user_id ?? `host-${crypto.randomUUID()}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (user_id, email, display_name, role, active, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'host', 1, ?4, ?4)
         ON CONFLICT (email) DO UPDATE SET display_name = excluded.display_name, active = 1, updated_at = excluded.updated_at`,
      )
      .bind(userId, email, name, now),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, new_value, source, created_at)
         VALUES ('user', ?1, 'staff', ?2, ?3, ?4, 'organiser', ?5)`,
      )
      .bind(userId, staff.email, existing ? 'host.reactivated' : 'host.added', email, now),
  ]);
  const host = await db.prepare('SELECT user_id, email, display_name, role, active, created_at FROM users WHERE email = ?1').bind(email).first<Record<string, unknown>>();
  return { ok: true, host: host! };
}
