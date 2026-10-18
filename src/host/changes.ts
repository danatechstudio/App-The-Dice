// Host change requests (docs/RTD_HOST_PORTAL.md#changing-a-live-session; audit G-7, D-7;
// Stage 5a). A host asks to change their live session's name, description, date, times,
// price or who can come. Nothing public changes until an approver or admin approves it:
// then n8n writes just the changed cells to the session's Event Index row (matched on
// Event ID; /internal/host-changes) and the next sync brings them into the diary.
//
// - "Now" is what's public: the session's event and its next date, not the host's
//   original form, so sheet edits are respected. The request keeps a copy of it.
// - Asking again before a decision replaces the pending request (it's "superseded").
// - Approving refuses if a field being changed has moved on since it was asked for.
// - Declining needs a reason, which the host is emailed.
// - A new time is emailed to everyone booked on dates to come once it's approved. A new
//   date moves the booked date in the sheet, which Needs attention then holds (G-4).
// - Places and cancelling a date stay immediate (D-7): src/bookings/places.ts, bookings.ts.
// - An admin's change (adminChange, the admin event editor) is a request approved on the spot,
//   which then takes the same path; it can also hide the session or stop it running. The host
//   is emailed what changed.

import type { AuthUser } from '../lib/auth';
import { esc, firstName, longDate, places, shortDate, timeLabel, ukDate, weekdayOf } from '../lib/format';
import { addDays, londonDate } from '../lib/time';
import { APPROVALS_INBOX, BOOKINGS_INBOX, fact, join, link, p, type Email } from '../notify/emails';
import { queue } from '../notify/outbox';
import type { Visibility } from '../events/admin';
import { parseSessionInput, priceLabel } from './sessions';

export type Field = 'name' | 'description' | 'event_date' | 'start_time' | 'end_time' | 'price' | 'access';
export const FIELDS: Field[] = ['name', 'description', 'event_date', 'start_time', 'end_time', 'price', 'access'];
export const LABELS: Record<Field, string> = {
  name: 'Name',
  description: 'Description',
  event_date: 'Date',
  start_time: 'Start time',
  end_time: 'End time',
  price: 'Cost per player',
  access: 'Who can come',
};

/** Only an admin changes these (adminChange): who can see the session, and whether it runs. */
export type AdminField = 'visibility' | 'active';
const ADMIN_FIELDS: AdminField[] = ['visibility', 'active'];
const ADMIN_LABELS: Record<AdminField, string> = { visibility: 'Who can see it', active: 'Running' };
const VISIBILITY_CELL: Record<Visibility, string> = { public: 'Public', app_bookable: 'App Bookable', private: 'Private', hidden: 'Hidden' };
const VISIBILITY_LABEL: Record<Visibility, string> = { public: 'Public', app_bookable: 'App Bookable', private: 'Private (invite only)', hidden: 'Hidden' };

/** A session's public details, in the units the request compares: price as the label people see. */
export interface Details {
  name: string;
  description: string | null;
  event_date: string | null;
  start_time: string | null;
  end_time: string | null;
  price: string;
  access: 'open' | 'private';
}

type Fail = { ok: false; status: 400 | 404 | 409; error: string; errors?: Record<string, string> };

const NOTE_MAX = 500;
/** Decided requests stay on the host's card this long. */
const RECENT_DAYS = 14;

interface Live extends Details {
  session_id: string;
  event_id: string;
  host_user_id: string;
  host_email: string;
  host_name: string | null;
  frequency: 'one-off' | 'weekly';
  max_players: number;
  price_pence: number;
  status: string;
}

/**
 * A live session's details as the diary has them: its event (name, description, price,
 * visibility) and its next date still to come (date and times). null if it isn't live.
 */
export async function liveDetails(db: D1Database, sessionId: string, today: string, opts: { stopped?: boolean } = {}): Promise<Live | null> {
  const row = await db
    .prepare(
      `SELECT s.session_id, s.event_id, s.host_user_id, s.frequency, s.max_players, s.price_pence, s.status, s.deleted_at,
         u.email AS host_email, u.display_name AS host_name,
         e.display_name AS name, e.description, e.price_display, e.visibility,
         o.event_date, o.start_time, o.end_time
       FROM host_sessions s JOIN users u ON u.user_id = s.host_user_id
       JOIN events e ON e.event_id = s.event_id AND (e.active = 1 OR ?3 = 1)
       LEFT JOIN occurrences o ON o.occurrence_id = (
         SELECT x.occurrence_id FROM occurrences x WHERE x.event_id = e.event_id AND x.status = 'scheduled' AND x.event_date >= ?2
         ORDER BY x.event_date LIMIT 1)
       WHERE s.session_id = ?1 AND s.status = 'published' AND s.deleted_at IS NULL`,
    )
    .bind(sessionId, today, opts.stopped ? 1 : 0)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    session_id: row.session_id as string,
    event_id: row.event_id as string,
    host_user_id: row.host_user_id as string,
    host_email: row.host_email as string,
    host_name: (row.host_name as string | null) ?? null,
    frequency: row.frequency as 'one-off' | 'weekly',
    max_players: row.max_players as number,
    price_pence: row.price_pence as number,
    status: row.status as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    event_date: (row.event_date as string | null) ?? null,
    start_time: (row.start_time as string | null) ?? null,
    end_time: (row.end_time as string | null) ?? null,
    price: (row.price_display as string | null) ?? priceLabel(row.price_pence as number),
    access: row.visibility === 'private' ? 'private' : 'open',
  };
}

const pick = (d: Details): Details => ({
  name: d.name,
  description: d.description,
  event_date: d.event_date,
  start_time: d.start_time,
  end_time: d.end_time,
  price: d.price,
  access: d.access,
});

/** Proposed values, with the price also in pence (the session's own record), and an admin's own fields. */
type Proposed = Partial<Details> & { price_pence?: number; visibility?: Visibility; active?: boolean };
type Published = Details & { visibility?: Visibility; active?: boolean };

const json = <T>(s: string | null): T => (s ? (JSON.parse(s) as T) : ({} as T));

// ---- A host asks ----

const NOTHING = 'Nothing has changed: change something, or close the form.';

/**
 * The form (name, description, event_date, start_time, end_time, price_pence, access; anything
 * left out stays as it is), checked like a new session, as just the fields that differ from what's
 * public. Empty when nothing does.
 */
async function proposeChange(db: D1Database, live: Live, b: Record<string, unknown>, today: string): Promise<{ ok: true; proposed: Proposed } | Fail> {
  // Validated like a new session; a date left as it is (even today's) isn't checked again.
  const dateGiven = typeof b.event_date === 'string' ? b.event_date : live.event_date;
  const dateChanged = dateGiven !== live.event_date;
  const merged = {
    name: b.name ?? live.name,
    description: b.description ?? live.description ?? '',
    event_date: dateChanged ? dateGiven : addDays(today, 1),
    start_time: b.start_time ?? live.start_time ?? '',
    end_time: b.end_time ?? live.end_time ?? '',
    price_pence: b.price_pence ?? live.price_pence,
    max_players: live.max_players,
    frequency: live.frequency,
    access: b.access ?? live.access,
  };
  const parsed = parseSessionInput(merged, today);
  if (!parsed.ok) return { ok: false, status: 400, error: 'Please check the form', errors: parsed.errors };
  const v = parsed.value;
  const next: Details = {
    name: v.name,
    description: v.description,
    event_date: dateChanged ? v.event_date : live.event_date,
    start_time: v.start_time,
    end_time: v.end_time,
    price: priceLabel(v.price_pence),
    access: v.access,
  };
  const proposed: Proposed = {};
  for (const f of FIELDS) if ((next[f] ?? null) !== (live[f] ?? null)) (proposed as Record<string, unknown>)[f] = next[f];
  if (proposed.price !== undefined) proposed.price_pence = v.price_pence;
  if (proposed.name !== undefined) {
    const clash = await db
      .prepare('SELECT 1 FROM events WHERE lower(display_name) = lower(?1) AND event_id <> ?2 AND active = 1')
      .bind(proposed.name, live.event_id)
      .first();
    if (clash) return { ok: false, status: 400, error: 'Please check the form', errors: { name: 'Another event is already called that. Choose a different name.' } };
  }
  return { ok: true, proposed };
}

/**
 * Body: the change form, filled in from what's public now (name, description, event_date,
 * start_time, end_time, price_pence, access), plus an optional note. Only what differs is
 * kept. Asking again before a decision replaces the pending request.
 */
export async function requestChange(
  db: D1Database,
  host: AuthUser,
  sessionId: string,
  body: unknown,
  ctx: { now: string; origin: string },
): Promise<{ ok: true; request: ChangeRequest } | Fail> {
  const today = londonDate(new Date(ctx.now));
  const live = await liveDetails(db, sessionId, today);
  if (!live || live.host_user_id !== host.user_id) return { ok: false, status: 404, error: 'Session not found, or not in the diary yet.' };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > NOTE_MAX) return { ok: false, status: 400, error: 'Please check the form', errors: { note: `Keep the note to ${NOTE_MAX} characters.` } };

  const made = await proposeChange(db, live, b, today);
  if (!made.ok) return made;
  const proposed = made.proposed;
  if (!Object.keys(proposed).length) return { ok: false, status: 400, error: 'Nothing has changed.', errors: { form: NOTHING } };

  const published = JSON.stringify(pick(live));
  const [, inserted] = await db.batch([
    db
      .prepare("UPDATE event_change_requests SET status = 'superseded', updated_at = ?2 WHERE session_id = ?1 AND status = 'pending'")
      .bind(sessionId, ctx.now),
    db
      .prepare(
        `INSERT INTO event_change_requests (request_id, session_id, event_id, origin, requested_by, published, proposed, note, status, created_at, updated_at)
         SELECT printf('RTD-CR-%05d', COALESCE(MAX(CAST(substr(request_id, 8) AS INTEGER)), 0) + 1), ?1, ?2, 'host', ?3, ?4, ?5, ?6, 'pending', ?7, ?7
         FROM event_change_requests
         RETURNING request_id`,
      )
      .bind(sessionId, live.event_id, host.email, published, JSON.stringify(proposed), note || null, ctx.now),
  ]);
  const id = (inserted?.results[0] as { request_id: string }).request_id;
  const request = (await getChange(db, id, today))!;
  await db.batch([
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         VALUES ('host_session', ?1, 'host', ?2, 'host_session.change_requested', ?3, ?4, 'organiser', ?5)`,
      )
      .bind(sessionId, host.email, published, JSON.stringify({ request_id: id, ...proposed }), ctx.now),
    queue(db, changeToApprove(request, ctx.origin), ctx.now),
  ]);
  return { ok: true, request };
}

/** The host takes back a request still waiting for a decision. */
export async function withdrawChange(db: D1Database, host: AuthUser, requestId: string, now: string): Promise<{ ok: true } | Fail> {
  const res = await db
    .prepare(
      `UPDATE event_change_requests SET status = 'withdrawn', updated_at = ?3
       WHERE request_id = ?1 AND status = 'pending' AND session_id IN (SELECT session_id FROM host_sessions WHERE host_user_id = ?2)`,
    )
    .bind(requestId, host.user_id, now)
    .run();
  if (!res.meta.changes) return { ok: false, status: 409, error: "That request isn't waiting any more." };
  await db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, new_value, source, created_at)
       SELECT 'host_session', session_id, 'host', ?2, 'host_session.change_withdrawn', ?1, 'organiser', ?3 FROM event_change_requests WHERE request_id = ?1`,
    )
    .bind(requestId, host.email, now)
    .run();
  return { ok: true };
}

// ---- What approvers and hosts see ----

interface Row {
  request_id: string;
  session_id: string;
  event_id: string;
  requested_by: string;
  published: string;
  proposed: string;
  note: string | null;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn' | 'superseded';
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied_at: string | null;
  created_at: string;
  host_name: string | null;
  frequency: string;
  bookings: number;
  people: number;
}

const ROW_SQL = `
  SELECT r.request_id, r.session_id, r.event_id, r.requested_by, r.published, r.proposed, r.note, r.status, r.decided_by,
    r.decided_at, r.decision_note, r.applied_at, r.created_at, u.display_name AS host_name, s.frequency,
    (SELECT COUNT(*) FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
      WHERE o.event_id = r.event_id AND o.status = 'scheduled' AND o.event_date >= ?1 AND b.status = 'confirmed') AS bookings,
    (SELECT COALESCE(SUM(b.party_size), 0) FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
      WHERE o.event_id = r.event_id AND o.status = 'scheduled' AND o.event_date >= ?1 AND b.status = 'confirmed') AS people
  FROM event_change_requests r JOIN host_sessions s ON s.session_id = r.session_id JOIN users u ON u.user_id = s.host_user_id`;

function shape(r: Row) {
  const now = json<Published>(r.published);
  const proposed = json<Proposed>(r.proposed);
  return {
    request_id: r.request_id,
    session_id: r.session_id,
    event_id: r.event_id,
    host: r.host_name ?? r.requested_by,
    requested_by: r.requested_by,
    frequency: r.frequency,
    name: now.name,
    note: r.note,
    status: r.status,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    decision_note: r.decision_note,
    /** Approved, and n8n has written it to Event Index (it's in the diary after the next sync). */
    applied: !!r.applied_at,
    applied_at: r.applied_at,
    created_at: r.created_at,
    /** Side by side: every field that changes, with what's public now. */
    changes: [
      ...FIELDS.filter(f => f in proposed).map(f => ({ field: f as Field | AdminField, label: LABELS[f], now: now[f] ?? null, proposed: proposed[f] ?? null })),
      ...ADMIN_FIELDS.filter(f => f in proposed).map(f => ({ field: f as Field | AdminField, label: ADMIN_LABELS[f], now: adminValue(f, now[f]), proposed: adminValue(f, proposed[f]) })),
    ],
    /** People booked on dates to come, who a new time or date affects. */
    bookings: r.bookings,
    people: r.people,
  };
}

export type ChangeRequest = ReturnType<typeof shape>;

/** An admin field as people read it. */
const adminValue = (f: AdminField, v: Visibility | boolean | undefined): string | null =>
  v === undefined ? null : f === 'visibility' ? VISIBILITY_LABEL[v as Visibility] : v ? 'Running' : 'Stopped (Inactive)';

async function getChange(db: D1Database, id: string, today: string): Promise<ChangeRequest | null> {
  const row = await db.prepare(`${ROW_SQL} WHERE r.request_id = ?2`).bind(today, id).first<Row>();
  return row ? shape(row) : null;
}

/** Approvers: waiting for a decision (oldest first), or recently decided. */
export async function listChanges(db: D1Database, status: 'pending' | 'decided', today: string): Promise<ChangeRequest[]> {
  const where =
    status === 'pending'
      ? "r.status = 'pending' ORDER BY r.created_at, r.request_id"
      : `r.status IN ('approved', 'declined') AND r.decided_at >= ?2 ORDER BY r.decided_at DESC LIMIT 50`;
  const stmt = db.prepare(`${ROW_SQL} WHERE ${where}`);
  const { results } = await (status === 'pending' ? stmt.bind(today) : stmt.bind(today, `${addDays(today, -RECENT_DAYS)}T00:00:00Z`)).all<Row>();
  return results.map(shape);
}

/** A host's own sessions: each one's latest request, while it's waiting or was decided in the last fortnight. */
export async function latestChanges(db: D1Database, sessionIds: string[], today: string): Promise<Record<string, ChangeRequest>> {
  if (!sessionIds.length) return {};
  const { results } = await db
    .prepare(
      `${ROW_SQL} WHERE r.session_id IN (SELECT value FROM json_each(?2))
         AND (r.status = 'pending' OR (r.status IN ('approved', 'declined') AND r.decided_at >= ?3))
       ORDER BY r.created_at DESC, r.request_id DESC`,
    )
    .bind(today, JSON.stringify(sessionIds), `${addDays(today, -RECENT_DAYS)}T00:00:00Z`)
    .all<Row>();
  const out: Record<string, ChangeRequest> = {};
  for (const r of results) if (!out[r.session_id]) out[r.session_id] = shape(r);
  return out;
}

// ---- An approver decides ----

/** Body: { decision: 'approve' | 'decline', note? }. Declining needs a reason (the note), which the host is emailed. */
export async function decideChange(
  db: D1Database,
  staff: AuthUser,
  requestId: string,
  body: unknown,
  ctx: { now: string; origin: string },
): Promise<{ ok: true; request: ChangeRequest } | Fail> {
  const b = (body && typeof body === 'object' ? body : {}) as { decision?: unknown; note?: unknown };
  if (b.decision !== 'approve' && b.decision !== 'decline') return { ok: false, status: 400, error: "decision must be 'approve' or 'decline'" };
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > NOTE_MAX) return { ok: false, status: 400, error: 'Please check the form', errors: { note: `Keep the note to ${NOTE_MAX} characters.` } };
  if (b.decision === 'decline' && note.length < 3) {
    return { ok: false, status: 400, error: 'Please check the form', errors: { note: 'Say why, so the host knows what to change.' } };
  }
  const today = londonDate(new Date(ctx.now));
  const r = await db.prepare(`${ROW_SQL} WHERE r.request_id = ?2`).bind(today, requestId).first<Row>();
  if (!r) return { ok: false, status: 404, error: 'No change request with that number.' };
  if (r.status !== 'pending') return { ok: false, status: 409, error: `This request is already ${r.status}.` };
  const proposed = json<Proposed>(r.proposed);

  const writes: D1PreparedStatement[] = [];
  if (b.decision === 'approve') {
    const live = await liveDetails(db, r.session_id, today);
    if (!live) return { ok: false, status: 409, error: "This session isn't in the diary any more, so it can't be changed." };
    const before = json<Details>(r.published);
    const moved = FIELDS.filter(f => f in proposed && (live[f] ?? null) !== (before[f] ?? null));
    if (moved.length) {
      const what = moved.map(f => `${LABELS[f].toLowerCase()} (now ${live[f] ?? 'blank'})`).join(', ');
      return { ok: false, status: 409, error: `Since this was asked for, the ${what} changed in the Logic Engine. Decline it, and ask the host to ask again.` };
    }
    writes.push(...(await approvalWrites(db, r, proposed, before, { now: ctx.now, origin: ctx.origin, today })));
  }
  const status = b.decision === 'approve' ? 'approved' : 'declined';
  const [res] = await db.batch([
    db
      .prepare(
        `UPDATE event_change_requests SET status = ?2, decided_by = ?3, decided_at = ?4, decision_note = ?5, updated_at = ?4
         WHERE request_id = ?1 AND status = 'pending'`,
      )
      .bind(requestId, status, staff.email, ctx.now, note || null),
    ...writes,
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         SELECT 'host_session', session_id, 'staff', ?2, ?3, published, json_object('request_id', request_id, 'proposed', json(proposed), 'note', decision_note),
           'organiser', ?4
         FROM event_change_requests WHERE request_id = ?1 AND decided_at = ?4 AND decided_by = ?2`,
      )
      .bind(requestId, staff.email, `host_session.change_${status}`, ctx.now),
  ]);
  if (!res?.meta.changes) return { ok: false, status: 409, error: 'Someone else has just decided this request.' };
  const request = (await getChange(db, requestId, today))!;
  const hostEmail = await db
    .prepare('SELECT u.email FROM host_sessions s JOIN users u ON u.user_id = s.host_user_id WHERE s.session_id = ?1 AND u.active = 1')
    .bind(r.session_id)
    .first<{ email: string }>();
  await queue(db, changeDecided(request, hostEmail?.email ?? null, ctx.origin), ctx.now).run();
  return { ok: true, request };
}

/**
 * What approving a change does at once: the session's own record follows (so the organiser shows
 * the new details), and a new time is emailed to everyone booked on dates to come. The sheet
 * follows through n8n branch D (changesToApply).
 */
async function approvalWrites(
  db: D1Database,
  r: { request_id: string; session_id: string; event_id: string },
  proposed: Proposed,
  before: Details,
  ctx: { now: string; origin: string; today: string },
): Promise<D1PreparedStatement[]> {
  const writes: D1PreparedStatement[] = [];
  // The session's own record follows, so the organiser shows the new details.
  const sets: string[] = [];
  const vals: unknown[] = [];
  const col: Partial<Record<Field | 'price_pence', string>> = {
    name: 'name', description: 'description', event_date: 'event_date', start_time: 'start_time', end_time: 'end_time', access: 'access', price_pence: 'price_pence',
  };
  for (const [k, c] of Object.entries(col)) {
    if (k in proposed && k !== 'price') {
      sets.push(`${c} = ?${vals.length + 3}`);
      vals.push((proposed as Record<string, unknown>)[k] ?? null);
    }
  }
  if (sets.length) writes.push(db.prepare(`UPDATE host_sessions SET ${sets.join(', ')}, updated_at = ?2 WHERE session_id = ?1`).bind(r.session_id, ctx.now, ...vals));
  // A new time: everyone booked on dates to come is emailed it.
  if ('start_time' in proposed || 'end_time' in proposed) {
    const { results: booked } = await db
      .prepare(
        `SELECT b.booking_id, b.lead_name, b.email, b.party_size, o.event_date FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
         WHERE o.event_id = ?1 AND o.status = 'scheduled' AND o.event_date >= ?2 AND b.status = 'confirmed' ORDER BY o.event_date, b.booking_id`,
      )
      .bind(r.event_id, ctx.today)
      .all<{ booking_id: string; lead_name: string; email: string; party_size: number; event_date: string }>();
    const time = timeLabel(proposed.start_time ?? before.start_time, 'end_time' in proposed ? (proposed.end_time ?? null) : before.end_time);
    for (const bk of booked) writes.push(queue(db, attendeeTimeChanged(r.request_id, before.name, proposed.name ?? before.name, bk, time, ctx.origin), ctx.now));
  }
  // An admin making it public or private: the session's own setting follows.
  if (proposed.visibility === 'public' || proposed.visibility === 'private') {
    writes.push(
      db.prepare('UPDATE host_sessions SET access = ?2, updated_at = ?3 WHERE session_id = ?1').bind(r.session_id, proposed.visibility === 'private' ? 'private' : 'open', ctx.now),
    );
  }
  return writes;
}

// ---- An admin changes it ----

/** Admin form values for a host session: details in the editor's units (price as a label). */
export interface AdminChangeInput {
  details?: Partial<Record<'name' | 'description' | 'event_date' | 'start_time' | 'end_time' | 'price' | 'category', string>>;
  visibility?: Visibility;
  /** false stops the session (from Stop running); true starts a stopped one again. */
  active?: boolean;
  note?: string;
}

/** "Free", "£3" or "£3.50" in pence, or null if it isn't one. */
function pence(label: string): number | null {
  const t = label.trim();
  if (/^free$/i.test(t) || t === '£0') return 0;
  const m = /^£?(\d{1,3})(?:\.(\d{2}))?$/.exec(t);
  return m ? Number(m[1]) * 100 + Number(m[2] ?? 0) : null;
}

/** Refuses moving a date people have booked: cancel it first (everyone booked is emailed), then set the new date. */
export async function refuseBookedMove(db: D1Database, eventId: string, date: string | null): Promise<Fail | null> {
  if (!date) return null;
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
       WHERE o.event_id = ?1 AND o.event_date = ?2 AND o.status = 'scheduled' AND b.status = 'confirmed'`,
    )
    .bind(eventId, date)
    .first<{ n: number }>();
  if (!r?.n) return null;
  const error = `${r.n === 1 ? '1 booking' : `${r.n} bookings`} on ${longDate(date)}. Cancel this date first (everyone booked is emailed), then set the new date.`;
  return { ok: false, status: 409, error, errors: { event_date: error } };
}

/**
 * Why an admin can't change this session right now, or null: a host's request waiting for a
 * decision, or an approved change not yet in the sheet (a second one would be proposed from the
 * same, stale values, and its emails sent twice).
 */
export async function adminChangeRefusal(db: D1Database, eventId: string, today: string, sessionId: string): Promise<Fail | null> {
  const waiting = await db.prepare(`${ROW_SQL} WHERE r.session_id = ?2 AND r.status = 'pending'`).bind(today, sessionId).first<Row>();
  if (waiting) {
    const host = waiting.host_name ?? waiting.requested_by;
    return { ok: false, status: 409, error: `${host} has asked for a change to this session (${waiting.request_id}). Approve or decline it first, under Approve.` };
  }
  const onWay = await db
    .prepare("SELECT request_id FROM event_change_requests WHERE event_id = ?1 AND status = 'approved' AND applied_at IS NULL ORDER BY decided_at DESC LIMIT 1")
    .bind(eventId)
    .first<{ request_id: string }>();
  if (onWay) {
    return { ok: false, status: 409, error: `An earlier change (${onWay.request_id}) is still on its way to the Logic Engine. Change it again once that's in the diary, within about half an hour.` };
  }
  return null;
}

/**
 * An admin changes a live host session directly (the admin event editor): a change request
 * approved on the spot by that admin, which then takes the approved path (the session's record,
 * emails to people booked on a new time, n8n branch D writes the cells). The host is emailed what
 * changed. A request from the host still waiting is decided first, so neither replaces the other.
 */
export async function adminChange(
  db: D1Database,
  admin: AuthUser,
  sessionId: string,
  input: AdminChangeInput,
  ctx: { now: string; origin: string; dryRun?: boolean },
): Promise<{ ok: true; request: ChangeRequest | null } | Fail | { ok: false; status: 403; error: string }> {
  if (admin.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can edit every event.' };
  const today = londonDate(new Date(ctx.now));
  const live = await liveDetails(db, sessionId, today, { stopped: true });
  if (!live) return { ok: false, status: 404, error: "This session isn't in the diary, so it can't be changed here." };
  const refused = await adminChangeRefusal(db, live.event_id, today, sessionId);
  if (refused) return refused;
  const ev = await db.prepare('SELECT visibility, active FROM events WHERE event_id = ?1').bind(live.event_id).first<{ visibility: Visibility; active: number }>();
  const running = ev?.active === 1;
  // A stopped session is started again on its own, before anything else changes.
  if (!running && (Object.keys(input.details ?? {}).length || input.visibility !== undefined)) {
    return { ok: false, status: 409, error: 'This session is stopped. Start it running first, then change it once it is back in the diary.' };
  }
  const d = input.details ?? {};
  const form: Record<string, unknown> = {};
  for (const f of ['name', 'description', 'event_date', 'start_time', 'end_time'] as const) if (d[f] !== undefined) form[f] = d[f];
  if (d.price !== undefined) {
    const p = pence(d.price);
    if (p === null) return { ok: false, status: 400, error: 'Please check the form', errors: { price: 'Use a price like £3, £3.50 or Free.' } };
    form.price_pence = p;
  }
  // Starting a stopped session changes nothing else (it has no date to come to check the form against).
  const made = running ? await proposeChange(db, live, form, today) : { ok: true as const, proposed: {} };
  if (!made.ok) return made;
  const proposed: Proposed = made.proposed;
  if (input.visibility !== undefined && input.visibility !== ev?.visibility) proposed.visibility = input.visibility;
  if (input.active === false && running) proposed.active = false;
  if (input.active === true && !running) proposed.active = true;
  if (!Object.keys(proposed).length) return { ok: false, status: 400, error: 'Nothing has changed.', errors: { form: NOTHING } };
  if (proposed.event_date !== undefined) {
    const refused = await refuseBookedMove(db, live.event_id, live.event_date);
    if (refused) return refused;
  }

  if (ctx.dryRun) return { ok: true, request: null };
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, NOTE_MAX) || null : null;
  const before = pick(live);
  const published: Published = { ...before, visibility: ev?.visibility, active: running };
  const inserted = await db
    .prepare(
      `INSERT INTO event_change_requests (request_id, session_id, event_id, origin, requested_by, published, proposed, note, status, decided_by, decided_at, created_at, updated_at)
       SELECT printf('RTD-CR-%05d', COALESCE(MAX(CAST(substr(request_id, 8) AS INTEGER)), 0) + 1), ?1, ?2, 'admin', ?3, ?4, ?5, ?6, 'approved', ?3, ?7, ?7, ?7
       FROM event_change_requests
       RETURNING request_id`,
    )
    .bind(sessionId, live.event_id, admin.email, JSON.stringify(published), JSON.stringify(proposed), note, ctx.now)
    .first<{ request_id: string }>();
  const id = inserted!.request_id;
  const r = { request_id: id, session_id: sessionId, event_id: live.event_id };
  await db.batch([
    ...(await approvalWrites(db, r, proposed, before, { now: ctx.now, origin: ctx.origin, today })),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         VALUES ('host_session', ?1, 'staff', ?2, 'host_session.changed_by_admin', ?3, ?4, 'organiser', ?5)`,
      )
      .bind(sessionId, admin.email, JSON.stringify(published), JSON.stringify({ request_id: id, proposed, note }), ctx.now),
  ]);
  const request = (await getChange(db, id, today))!;
  await queue(db, changedByAdmin(request, live.host_email, ctx.origin), ctx.now).run();
  return { ok: true, request };
}

// ---- Into the Logic Engine (n8n RTD Host Sessions To Diary, branch D) ----

/**
 * Approved changes not yet in Event Index, each as the cells to write on its row (matched
 * on Event ID): only the fields that change, as the sheet writes them. Oldest first, so a
 * later change to the same row is written after an earlier one.
 */
export async function changesToApply(db: D1Database) {
  const { results } = await db
    .prepare("SELECT request_id, event_id, proposed FROM event_change_requests WHERE status = 'approved' AND applied_at IS NULL ORDER BY decided_at, request_id LIMIT 50")
    .all<{ request_id: string; event_id: string; proposed: string }>();
  return results.map(r => {
    const v = json<Proposed>(r.proposed);
    const row: Record<string, string> = { 'Event ID': r.event_id };
    if (v.name !== undefined) row['Event Name'] = v.name;
    if (v.description !== undefined) row['Base Details'] = v.description ?? '';
    if (v.event_date) {
      row['Event Date'] = ukDate(v.event_date);
      row.Day = weekdayOf(v.event_date);
    }
    if (v.start_time !== undefined) row['Event Time'] = v.start_time ?? '';
    if (v.end_time !== undefined) row['End Time'] = v.end_time ?? '';
    if (v.price !== undefined) row['App Price'] = v.price;
    if (v.access !== undefined) row['App Visibility'] = v.access === 'private' ? 'Private' : 'Public';
    if (v.visibility !== undefined) row['App Visibility'] = VISIBILITY_CELL[v.visibility];
    if (v.active !== undefined) row.Status = v.active ? 'Active' : 'Inactive';
    return { request_id: r.request_id, event_id: r.event_id, row };
  });
}

/** n8n wrote it. Idempotent. */
export async function markChangeApplied(db: D1Database, id: string, now: string): Promise<'ok' | 'already' | 'not_found'> {
  const res = await db
    .prepare("UPDATE event_change_requests SET applied_at = ?2, updated_at = ?2 WHERE request_id = ?1 AND status = 'approved' AND applied_at IS NULL")
    .bind(id, now)
    .run();
  if (res.meta.changes) {
    await db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, new_value, source, created_at)
         SELECT 'host_session', session_id, 'n8n', 'n8n', 'host_session.change_applied', request_id, 'n8n', ?2 FROM event_change_requests WHERE request_id = ?1`,
      )
      .bind(id, now)
      .run();
    return 'ok';
  }
  const row = await db.prepare('SELECT 1 FROM event_change_requests WHERE request_id = ?1').bind(id).first();
  return row ? 'already' : 'not_found';
}

// ---- Emails ----

const show = (f: Field | AdminField, v: string | null) =>
  v === null || v === '' ? '<em>none</em>' : f === 'event_date' ? esc(longDate(v)) : f === 'access' ? (v === 'private' ? 'Private' : 'Open to anyone') : esc(v);

const changeTable = (c: ChangeRequest) =>
  `<ul>${c.changes.map(x => `<li><strong>${x.label}:</strong> ${show(x.field, x.now)} → ${show(x.field, x.proposed)}</li>`).join('')}</ul>`;

/** To the approvers' inbox, when a host asks. */
function changeToApprove(c: ChangeRequest, origin: string): Email {
  return {
    dedupe_key: `change-request:${c.request_id}`,
    kind: 'cafe_change_request',
    to: APPROVALS_INBOX,
    reply_to: c.requested_by,
    subject: `Change to approve: ${c.name}`,
    html: join([
      p(`${esc(c.host)} has asked to change <strong>${esc(c.name)}</strong>. Nothing changes in the diary until it's approved.`),
      changeTable(c),
      c.note && fact('Their note', esc(c.note)),
      c.bookings > 0 && p(`${c.bookings === 1 ? '1 booking' : `${c.bookings} bookings`} (${places(c.people)}) on dates to come.`),
      p(link(`${origin}/organise/approve#changes`, 'Approve or decline it in the organiser')),
      p(`Reply to this email to contact ${esc(firstName(c.host))}. Reference ${c.request_id}.`),
    ]),
  };
}

/** To the host, when it's decided. */
function changeDecided(c: ChangeRequest, hostEmail: string | null, origin: string): Email {
  const approved = c.status === 'approved';
  return {
    dedupe_key: `change-decided:${c.request_id}`,
    kind: 'host_change_decided',
    to: hostEmail,
    reply_to: BOOKINGS_INBOX,
    subject: `${approved ? 'Change approved' : 'Change not approved'}: ${c.name}`,
    html: join([
      p(`Hi ${esc(firstName(c.host))},`),
      approved
        ? p(`The café has approved your change to <strong>${esc(c.name)}</strong>. It reaches the diary within about half an hour.`)
        : p(`The café hasn't approved your change to <strong>${esc(c.name)}</strong>, so the session stays as it was.`),
      changeTable(c),
      !approved && c.decision_note && fact('The café says', esc(c.decision_note)),
      p(link(`${origin}/organise`, 'Open the host organiser')),
      p('The Roll The Dice team'),
    ]),
  };
}

/** To the host, when an admin changes their session. */
function changedByAdmin(c: ChangeRequest, hostEmail: string, origin: string): Email {
  return {
    dedupe_key: `change-by-admin:${c.request_id}`,
    kind: 'host_change_by_admin',
    to: hostEmail,
    reply_to: BOOKINGS_INBOX,
    subject: `Your session was changed: ${c.name}`,
    html: join([
      p(`Hi ${esc(firstName(c.host))},`),
      p(`The café has changed <strong>${esc(c.name)}</strong>. It reaches the diary within about half an hour.`),
      changeTable(c),
      c.note && fact('The café says', esc(c.note)),
      p(`Questions? Reply to this email. Reference ${c.request_id}.`),
      p(link(`${origin}/organise`, 'Open the host organiser')),
      p('The Roll The Dice team'),
    ]),
  };
}

/** To each person booked, when an approved change (or an admin's Logic Engine change) gives an event a new time. */
export function attendeeTimeChanged(
  requestId: string,
  oldName: string,
  name: string,
  b: { booking_id: string; lead_name: string; email: string; party_size: number; event_date: string },
  time: string,
  origin: string,
): Email {
  return {
    dedupe_key: `time-changed:${requestId}:${b.booking_id}`,
    kind: 'attendee_time_changed',
    booking_id: b.booking_id,
    to: b.email,
    reply_to: BOOKINGS_INBOX,
    subject: `New time: ${name}, ${shortDate(b.event_date)}`,
    html: join([
      p(`Hi ${esc(firstName(b.lead_name))},`),
      p(`<strong>${esc(oldName)}</strong> on ${esc(longDate(b.event_date))} now runs <strong>${esc(time)}</strong>. Your booking for ${places(b.party_size)} stays as it is.`),
      p(`If the new time doesn't suit, you can cancel from your confirmation email. ${link(`${origin}/diary`, 'See what else is on')}.`),
      p('The Roll The Dice team'),
    ]),
  };
}
