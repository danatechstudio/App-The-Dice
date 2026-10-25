// Changing an event's Logic Engine columns from the organiser (docs/RTD_EVENT_CONTROL_AUDIT.md
// §4, Stage 6; owner decisions D-10 and D-13). Admins only.
//
// The sheet stays the master. An edit is never applied in the app: it is queued here, and
// n8n "RTD Sheet Writer" (every 5 minutes) claims it, reads the row with that Event ID and
// posts it to /check. If every changed column still holds what the admin saw, the app hands
// back just those cells; n8n writes them (matched on Event ID, RAW), reads the row back and
// posts it to /written. The next Event Sync then brings the change into the diary exactly as
// if it had been typed into the sheet, so there is nothing to echo back and no loop.
// - Conflict: the sheet changed one of those columns since. Nothing is written; the admin
//   keeps the sheet's value or writes theirs over it. Nothing is ever overwritten silently.
// - A column that already holds the new value is left alone (both sides made the same change).
// - Errors (no row, duplicate Event ID, renamed column, Google down) are tried again after
//   5 m, 15 m, 1 h, 4 h and 12 h, then given up on where admins can see them.
// - The setting `sheet_writes` decides where new edits go: off (closed), staging (the test
//   copy of the sheet), shadow (a trial on the live sheet that writes nothing) or live.
// The admin who made an edit is emailed if it conflicts or is given up on.

import type { AuthUser } from '../lib/auth';
import { attendeeTimeChanged } from '../host/changes';
import { esc, longDate, timeLabel } from '../lib/format';
import { addDays, londonDate, parseSheetDate } from '../lib/time';
import { queue } from '../notify/outbox';
import type { Email } from '../notify/emails';
import { FACT_KEYS, parseFacts, parsePeople } from '../social/facts';
import { ROLE_WORD_LIST, hasRoleWord } from '../social/validate';
import { CATEGORIES, type Source } from './normalise';
import { EDITABLE, FREQUENCIES, TAB, canon, cellsFor, checkRows, isColumn, verifyRows, type Column, type Fields } from './sheetValues';

export const MODES = ['off', 'staging', 'shadow', 'live'] as const;
export type Mode = (typeof MODES)[number];
type Target = Exclude<Mode, 'off'>;

const EDIT_ID = /^RTD-SE-\d{5,}$/;
const EVENT_ID = /^RTD-EVT-\d{5,}$/;
/** A claim lapses after this, so an n8n run that died never holds an edit for good. */
const CLAIM_MS = 10 * 60_000;
const RETRY_AFTER_MS = [5, 15, 60, 240, 720].map(m => m * 60_000);
const CLAIM_BATCH = 5;
const NAME_MAX = 100;
const DETAILS_MAX = 3000;
const PRICE_MAX = 40;
/** Approved Facts, People & Roles, Banned Phrases. */
export const LONG_MAX = 5000;
/** Michelle's prompts and the TikTok blueprint: hand-written and long, so more room than other long text. */
export const PROMPT_MAX = 20000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOLDER_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** A Google Drive folder ID, or a pasted folder link reduced to its ID. */
export function folderIdOf(v: string): string {
  const m = /drive\.google\.com\/.*?(?:\/folders\/|[?&]id=)([A-Za-z0-9_-]+)/.exec(v);
  return m ? m[1]! : v;
}

type Fail = { ok: false; status: 400 | 403 | 404 | 409; error: string; errors?: Record<string, string> };
const fail = (status: Fail['status'], error: string, errors?: Record<string, string>): Fail => ({ ok: false, status, error, errors });
const adminOnly = (u: AuthUser): Fail | null => (u.role === 'admin' ? null : fail(403, 'Only admins can change events in the Logic Engine from the app.'));
const json = <T>(s: string | null): T => (s ? JSON.parse(s) : null) as T;

export async function sheetMode(db: D1Database): Promise<Mode> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'sheet_writes'").first<{ value: string }>();
  return (MODES as readonly string[]).includes(row?.value ?? '') ? (row!.value as Mode) : 'off';
}

/** Admins: where new edits go. Edits already made keep theirs. */
export async function setSheetMode(db: D1Database, admin: AuthUser, mode: unknown, now: Date): Promise<{ ok: true; mode: Mode } | Fail> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  if (!(MODES as readonly unknown[]).includes(mode)) return fail(400, `Choose one of: ${MODES.join(', ')}.`);
  const before = await sheetMode(db);
  const iso = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('sheet_writes', ?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(mode, iso, admin.email),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         VALUES ('setting', 'sheet_writes', 'staff', ?1, 'sheet_writes.changed', ?2, ?3, 'organiser', ?4)`,
      )
      .bind(admin.email, before, mode, iso),
  ]);
  return { ok: true, mode: mode as Mode };
}

// ---- What can be changed ----

export interface SheetEvent {
  event_id: string;
  source: Source;
  tab: string;
  name: string;
  active: boolean;
  frequency: string;
  /** The editable columns as the last sync read them (canonical). */
  values: Record<string, string>;
  /** Confirmed bookings on dates still to come. */
  bookings: number;
  /** The edit still on its way, if any (queued, in conflict, or written and waiting for the sync). */
  open_edit: string | null;
}

/**
 * The Event Index columns an admin may change on a host's session. The host owns the rest (name,
 * description, dates, times, price, visibility, Status, Frequency, places...) through change
 * requests, and n8n "RTD Host Sessions To Diary" never writes any of these, so the two paths
 * can't overwrite each other.
 */
export const HOST_SESSION_COLUMNS = [
  'Approved Facts',
  'People & Roles',
  'Banned Phrases',
  "Michelle's Standard Prompt",
  'Michelles KPI Hook Prompt',
  'TikTok Video Blueprint',
  'Photo Folder ID',
  'Post Frequency (Days)',
  'Target Post Time',
  'App Category',
] as const satisfies readonly Column[];
const HOST_MESSAGE = "This is a host's session: the host asks for changes and an approver decides (Change requests).";

export const IN_LAST_SYNC =`e.last_synced_at >= (SELECT MAX(received_at) FROM sync_runs WHERE status = 'ok')`;
export const OPEN = `(s.status IN ('queued', 'conflict') OR (s.status = 'written' AND s.target = 'live'))`;
const CAFE = 'e.host_session_id IS NULL AND e.market_id IS NULL';

/** The café's own events in the last sync (host sessions and markets change elsewhere), Active first. */
export async function sheetEvents(db: D1Database, admin: AuthUser, now: Date): Promise<{ ok: true; events: SheetEvent[] } | Fail> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  const { results } = await db
    .prepare(
      `SELECT e.event_id, e.source, e.event_name AS name, e.active, e.frequency, e.sheet_values,
         (SELECT COUNT(*) FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
            WHERE o.event_id = e.event_id AND b.status = 'confirmed' AND o.status = 'scheduled' AND o.event_date >= ?1) AS bookings,
         (SELECT s.edit_id FROM sheet_edits s WHERE s.event_id = e.event_id AND ${OPEN} ORDER BY s.created_at DESC LIMIT 1) AS open_edit
       FROM events e WHERE ${CAFE} AND e.sheet_values IS NOT NULL AND ${IN_LAST_SYNC}
       ORDER BY e.active DESC, e.source, lower(e.event_name) LIMIT 500`,
    )
    .bind(londonDate(now))
    .all<Record<string, unknown>>();
  return {
    ok: true,
    events: results.map(r => ({
      event_id: String(r.event_id),
      source: r.source as Source,
      tab: TAB[r.source as Source],
      name: String(r.name),
      active: r.active === 1,
      frequency: String(r.frequency),
      values: json<Record<string, string>>(r.sheet_values as string),
      bookings: Number(r.bookings),
      open_edit: (r.open_edit as string | null) ?? null,
    })),
  };
}

// ---- Asking for a change ----

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const VISIBILITIES = ['public', 'app_bookable', 'private', 'hidden'];

/** Checks one value as typed in the editor; returns it canonical, or an error message. */
function validate(source: Source, c: Column, raw: unknown, today: string): { value: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'This must be text.' };
  const v = canon(c, c === 'Photo Folder ID' ? folderIdOf(raw.trim()) : raw);
  switch (c) {
    case 'Event Name':
    case 'Group':
      if (!v) return { error: 'A name is needed.' };
      if (v.length > NAME_MAX) return { error: `Keep it to ${NAME_MAX} characters.` };
      if (v.includes('\n')) return { error: 'Keep the name on one line.' };
      return { value: v };
    case 'Base Details':
    case 'Notes':
      return v.length > DETAILS_MAX ? { error: `Keep it to ${DETAILS_MAX} characters.` } : { value: v };
    case 'Event Date':
    case 'Date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) || parseSheetDate(raw) !== raw.trim()) {
        return { error: v ? 'Choose a date.' : 'A date is needed. To take the event out, set Status to Inactive.' };
      }
      if (v < today) return { error: 'Choose today or a later date.' };
      if (v > addDays(today, 731)) return { error: 'Choose a date in the next two years.' };
      return { value: v };
    case 'Event Time':
    case 'End Time':
      return v === '' || TIME.test(v) ? { value: v } : { error: 'Use a time like 18:30, or leave it empty.' };
    case 'Status':
      return v === 'Active' || v === 'Inactive' ? { value: v } : { error: 'Choose Active or Inactive.' };
    case 'App Visibility':
      return VISIBILITIES.includes(v) ? { value: v } : { error: 'Choose who can see it.' };
    case 'App Category':
      return v === '' || (CATEGORIES as readonly string[]).includes(v) ? { value: v } : { error: 'Choose a category.' };
    case 'App Price':
      if (v.length > PRICE_MAX) return { error: `Keep it to ${PRICE_MAX} characters, like £5 or Free.` };
      return v.includes('\n') ? { error: 'Keep the price on one line.' } : { value: v };
    case 'Frequency':
      return FREQUENCIES[source].includes(v) ? { value: v } : { error: `Choose ${FREQUENCIES[source].join(', ')}.` };
    case 'Post Frequency (Days)':
      return /^\d+$/.test(v) && Number(v) <= 60 ? { value: v } : { error: 'Use a whole number of days from 0 to 60.' };
    case 'App Capacity':
      return v === '' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1000) ? { value: v } : { error: 'Use a whole number from 1 to 1000, or leave it empty.' };
    case 'Target Post Time':
      return v === '' || TIME.test(v) ? { value: v } : { error: 'Use a time like 18:00, or leave it empty.' };
    case 'Photo Folder ID':
      return v === '' || FOLDER_ID.test(v) ? { value: v } : { error: 'Paste the Google Drive folder’s link or its ID, or leave it empty.' };
    case 'Organiser Email':
      return v === '' || (EMAIL.test(v) && v.length <= 254) ? { value: v } : { error: 'Use an email address like name@example.com, or leave it empty.' };
    case "Michelle's Standard Prompt":
    case 'Michelles KPI Hook Prompt':
    case 'TikTok Video Blueprint':
      return v.length > PROMPT_MAX ? { error: `Keep it to ${PROMPT_MAX.toLocaleString('en-GB')} characters.` } : { value: v };
    case 'Banned Phrases':
      return v.length > LONG_MAX ? { error: `Keep it to ${LONG_MAX.toLocaleString('en-GB')} characters.` } : { value: v };
    case 'Approved Facts': {
      if (v.length > LONG_MAX) return { error: `Keep it to ${LONG_MAX.toLocaleString('en-GB')} characters.` };
      const { errors } = parseFacts(v);
      return errors.length ? { error: `${errors[0]}. One fact per line, like "Booking: essential" (keys: ${FACT_KEYS.join(', ')}).` } : { value: v };
    }
    case 'People & Roles': {
      if (v.length > LONG_MAX) return { error: `Keep it to ${LONG_MAX.toLocaleString('en-GB')} characters.` };
      const { people, errors } = parsePeople(v);
      if (errors.length) return { error: `${errors[0]}. One person per line, like "Trixie - host".` };
      const unread = people.find(p => !hasRoleWord(p.role));
      if (unread) return { error: `"${unread.role}" (${unread.name}) has no role word the post checks know: use ${ROLE_WORD_LIST.join(', ')}.` };
      return { value: v };
    }
  }
}

export interface SheetEdit {
  edit_id: string;
  event_id: string;
  name: string | null;
  source: Source;
  tab: string;
  target: Target;
  fields: Fields;
  note: string | null;
  requested_by: string;
  status: string;
  /** For a conflict: what the sheet held. */
  found: Record<string, string> | null;
  cells: Record<string, string> | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  written_at: string | null;
  settled_at: string | null;
  resolution: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

const EDIT_FIELDS = `s.edit_id, s.event_id, e.event_name AS name, s.source, s.target, s.fields, s.note, s.requested_by, s.status,
  s.found, s.cells, s.attempts, s.last_error, s.next_attempt_at, s.written_at, s.settled_at, s.resolution, s.resolved_by,
  s.created_at, s.updated_at, s.claim, s.claimed_at`;

const shapeEdit = (r: Record<string, unknown>): SheetEdit & { claim: string | null; claimed_at: string | null } => ({
  ...(r as unknown as SheetEdit & { claim: string | null; claimed_at: string | null }),
  tab: TAB[r.source as Source],
  fields: json<Fields>(r.fields as string),
  found: json<Record<string, string> | null>(r.found as string | null),
  cells: json<Record<string, string> | null>(r.cells as string | null),
});

async function getEdit(db: D1Database, id: string) {
  if (!EDIT_ID.test(id)) return null;
  const r = await db.prepare(`SELECT ${EDIT_FIELDS} FROM sheet_edits s LEFT JOIN events e ON e.event_id = s.event_id WHERE s.edit_id = ?1`).bind(id).first<Record<string, unknown>>();
  return r ? shapeEdit(r) : null;
}

const publicEdit = (e: SheetEdit & { claim?: unknown; claimed_at?: unknown }): SheetEdit => {
  const { claim: _c, claimed_at: _ca, ...rest } = e;
  return rest;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Body: { values: {column: value}, note?, confirm? }, values as the editor shows them
 * (dates YYYY-MM-DD, times HH:MM, App Visibility public | app_bookable | private | hidden).
 * Only columns that differ from the last sync become the edit. Setting Status Inactive with
 * bookings to come, or moving a date people have booked, needs confirm: true.
 */
export async function requestEdit(
  db: D1Database,
  admin: AuthUser,
  eventId: string,
  body: unknown,
  now: Date,
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: true; edit: SheetEdit | null } | Fail | { ok: false; status: 409; warning: string }> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const values = (b.values && typeof b.values === 'object' ? b.values : {}) as Record<string, unknown>;
  const refused = await sheetEditRefusal(db, eventId, values);
  if (refused) return refused;
  const mode = (await sheetMode(db)) as Target;
  const ev = await db
    .prepare(
      `SELECT e.event_id, e.source, e.event_name, e.host_session_id, e.market_id, e.sheet_values, ${IN_LAST_SYNC} AS in_sheet,
         (SELECT s.edit_id FROM sheet_edits s WHERE s.event_id = e.event_id AND ${OPEN} LIMIT 1) AS open_edit
       FROM events e WHERE e.event_id = ?1`,
    )
    .bind(eventId)
    .first<{ event_id: string; source: Source; event_name: string; host_session_id: string | null; market_id: string | null; sheet_values: string | null; in_sheet: number; open_edit: string | null }>();
  if (!ev || !ev.sheet_values) return fail(404, 'No event with that ID.');

  const current = json<Record<string, string>>(ev.sheet_values);
  const today = londonDate(now);
  const errors: Record<string, string> = {};
  const fields: Fields = {};
  for (const [c, raw] of Object.entries(values)) {
    if (!isColumn(ev.source, c)) {
      errors[c] = `${c} can't be changed from the app.`;
      continue;
    }
    // A column the last sync didn't carry has no known value: never take it for blank.
    if (!(c in current)) {
      errors[c] = `${c} is not synced yet: RTD Event Sync doesn't send it. Change it in the Logic Engine for now.`;
      continue;
    }
    const from = current[c]!;
    if (typeof raw === 'string' && canon(c, raw) === from) continue; // unchanged, even if the sheet's value wouldn't pass the checks
    const r = validate(ev.source, c, raw, today);
    if ('error' in r) errors[c] = r.error;
    else if (r.value !== from) fields[c] = { from, to: r.value };
  }
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) || null : null;
  // Times belong together: an end needs a start.
  if (ev.source === 'event_index') {
    const start = fields['Event Time']?.to ?? current['Event Time'] ?? '';
    const end = fields['End Time']?.to ?? current['End Time'] ?? '';
    if (end && !start && (fields['Event Time'] || fields['End Time'])) errors['End Time'] = 'Add a start time, or clear the end time.';
    if (end && end === start && fields['End Time']) errors['End Time'] = 'The end time is the same as the start.';
  }
  const nameCol = ev.source === 'event_index' ? 'Event Name' : 'Group';
  const newName = fields[nameCol]?.to;
  if (newName) {
    // The poster and guard automations tell rows apart by name: never reuse one.
    const clash = await db
      .prepare('SELECT event_name FROM events WHERE lower(event_name) = lower(?1) AND event_id != ?2 LIMIT 1')
      .bind(newName, eventId)
      .first();
    if (clash) errors[nameCol] = 'Another row in the Logic Engine already has this name.';
  }
  if (Object.keys(errors).length) return fail(400, 'Please check the form', errors);
  if (!Object.keys(fields).length) return fail(400, 'Nothing has changed.');

  if (b.confirm !== true) {
    const warning = await bookedWarning(db, ev.event_id, ev.source, fields, current, today);
    if (warning) return { ok: false, status: 409, warning };
  }

  // Every check passed: a dry run (the admin event editor, before it changes anything else) stops here.
  if (opts.dryRun) return { ok: true, edit: null };
  const iso = now.toISOString();
  const target: Target = mode;
  const inserted = await db
    .prepare(
      `INSERT INTO sheet_edits (edit_id, event_id, source, target, fields, note, requested_by, status, created_at, updated_at)
       SELECT printf('RTD-SE-%05d', COALESCE(MAX(CAST(substr(edit_id, 8) AS INTEGER)), 0) + 1), ?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?7
       FROM sheet_edits
       RETURNING edit_id`,
    )
    .bind(eventId, ev.source, target, JSON.stringify(fields), note, admin.email, iso)
    .first<{ edit_id: string }>();
  const editId = inserted!.edit_id;
  await audit(db, editId, eventId, 'staff', admin.email, 'sheet_edit.requested', null, { target, fields, note }, iso);
  return { ok: true, edit: publicEdit((await getEdit(db, editId))!) };
}

/**
 * Why this event's Logic Engine columns can't be changed from the app right now, or null. Also
 * asked before Stop running cancels anything, so it never cancels dates and then can't stop.
 * `values`: the columns about to be sent. A host's session takes only HOST_SESSION_COLUMNS, and
 * only when every column that changes is one of them; without values it is refused.
 */
export async function sheetEditRefusal(db: D1Database, eventId: string, values?: Record<string, unknown>): Promise<Fail | null> {
  if ((await sheetMode(db)) === 'off') return fail(409, 'Changing events from the app is switched off (Sheet sync, at the top of this page).');
  if (!EVENT_ID.test(eventId)) return fail(404, 'No event with that ID.');
  const ev = await db
    .prepare(
      `SELECT e.host_session_id, e.market_id, e.sheet_values, ${IN_LAST_SYNC} AS in_sheet,
         (SELECT s.edit_id FROM sheet_edits s WHERE s.event_id = e.event_id AND ${OPEN} LIMIT 1) AS open_edit
       FROM events e WHERE e.event_id = ?1`,
    )
    .bind(eventId)
    .first<{ host_session_id: string | null; market_id: string | null; sheet_values: string | null; in_sheet: number; open_edit: string | null }>();
  if (!ev) return fail(404, 'No event with that ID.');
  if (ev.market_id) return fail(409, 'This is a market: change it under Markets.');
  if (ev.host_session_id && !hostMayTake(ev.sheet_values, values)) return fail(409, HOST_MESSAGE);
  if (!ev.sheet_values || !ev.in_sheet) return fail(409, "This event wasn't in the last sync from the Logic Engine, so it can't be changed from here.");
  if (ev.open_edit) return fail(409, `A change to this event (${ev.open_edit}) is still on its way to the Logic Engine. Wait for it, or withdraw it under Sheet sync.`);
  return null;
}

/**
 * Whether every column these values change on a host's session is one admins may set. A value
 * sent as it already is doesn't count as a change; an unknown column always does.
 */
function hostMayTake(sheetValues: string | null, values: Record<string, unknown> | undefined): boolean {
  if (!values) return false;
  const current = json<Record<string, string> | null>(sheetValues) ?? {};
  const changes = Object.entries(values).filter(
    ([c, raw]) => !isColumn('event_index', c) || !(c in current) || typeof raw !== 'string' || canon(c, raw) !== current[c],
  );
  return changes.every(([c]) => (HOST_SESSION_COLUMNS as readonly string[]).includes(c));
}

/** Bookings an edit would touch, said plainly, or null. */
async function bookedWarning(db: D1Database, eventId: string, source: Source, fields: Fields, current: Record<string, string>, today: string): Promise<string | null> {
  if (fields.Status?.to === 'Inactive') {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(b.party_size), 0) AS people FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
         WHERE o.event_id = ?1 AND b.status = 'confirmed' AND o.status = 'scheduled' AND o.event_date >= ?2`,
      )
      .bind(eventId, today)
      .first<{ n: number; people: number }>();
    if (r?.n) {
      return `${plural(r.n, 'booking')} (${plural(r.people, 'place')}) on dates to come. Inactive takes the event out of the diary; those bookings will show under Needs attention for you to cancel or keep.`;
    }
  }
  const dateCol = source === 'event_index' ? 'Event Date' : 'Date';
  const moves = fields[dateCol] || fields['Event Time'] || fields['End Time'];
  const date = current[dateCol] ?? '';
  if (moves && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today) {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(b.party_size), 0) AS people FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
         WHERE o.event_id = ?1 AND o.event_date = ?2 AND b.status = 'confirmed' AND o.status = 'scheduled'`,
      )
      .bind(eventId, date)
      .first<{ n: number; people: number }>();
    if (r?.n) {
      const said = `${plural(r.n, 'booking')} (${plural(r.people, 'place')}) on ${longDate(date)}.`;
      // A new time only: everyone booked is emailed it once it's written (tellNewTime).
      if (!fields[dateCol]) return `${said} Everyone booked is emailed the new time once it's in the Logic Engine; their bookings stand.`;
      return `${said} Once the change reaches the app, it asks you under Needs attention whether to tell them or cancel their bookings.`;
    }
  }
  return null;
}

async function audit(db: D1Database, editId: string, eventId: string, actorType: 'staff' | 'n8n', actor: string, action: string, before: unknown, after: unknown, iso: string) {
  await db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
       VALUES ('event', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(eventId, actorType, actor, action, before === null ? null : JSON.stringify(before), JSON.stringify({ edit_id: editId, ...(after as object) }), actorType === 'n8n' ? 'n8n' : 'organiser', iso)
    .run();
}

// ---- Withdrawing, and choosing after a conflict ----

/**
 * Body: { action }. withdraw: a queued edit not being written right now. keep_sheet: after a
 * conflict, the sheet's value stands. write_mine: after a conflict, write the edit over what
 * the sheet holds now (checked again first). retry: one given up on, tried again.
 */
export async function resolveEdit(db: D1Database, admin: AuthUser, editId: string, body: unknown, now: Date): Promise<{ ok: true; edit: SheetEdit } | Fail> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  const e = await getEdit(db, editId);
  if (!e) return fail(404, 'No change with that number.');
  const action = (body && typeof body === 'object' ? (body as Record<string, unknown>).action : undefined) as string | undefined;
  const iso = now.toISOString();
  const stale = new Date(now.getTime() - CLAIM_MS).toISOString();
  let res: D1Result;
  if (action === 'withdraw') {
    res = await db
      .prepare(
        `UPDATE sheet_edits SET status = 'cancelled', resolution = 'withdrawn', resolved_by = ?2, settled_at = ?3, claim = NULL, updated_at = ?3
         WHERE edit_id = ?1 AND status = 'queued' AND (claimed_at IS NULL OR claimed_at < ?4)`,
      )
      .bind(editId, admin.email, iso, stale)
      .run();
    if (!res.meta.changes) return fail(409, e.status === 'queued' ? "It's being written right now: wait a minute and look again." : "This change isn't waiting, so it can't be withdrawn.");
  } else if (action === 'keep_sheet') {
    res = await db
      .prepare(`UPDATE sheet_edits SET status = 'cancelled', resolution = 'kept_sheet', resolved_by = ?2, settled_at = ?3, updated_at = ?3 WHERE edit_id = ?1 AND status = 'conflict'`)
      .bind(editId, admin.email, iso)
      .run();
    if (!res.meta.changes) return fail(409, "This change isn't in conflict.");
  } else if (action === 'write_mine') {
    if (e.status !== 'conflict' || !e.found) return fail(409, "This change isn't in conflict.");
    // What the sheet holds now becomes what it changes from, so the next check passes unless it moves again.
    const fields: Fields = Object.fromEntries(Object.entries(e.fields).map(([c, f]) => [c, { from: e.found![c] ?? f!.from, to: f!.to }]));
    res = await db
      .prepare(
        `UPDATE sheet_edits SET status = 'queued', fields = ?2, resolution = 'kept_mine', resolved_by = ?3, attempts = 0, next_attempt_at = NULL,
           claim = NULL, claimed_at = NULL, settled_at = NULL, updated_at = ?4
         WHERE edit_id = ?1 AND status = 'conflict'`,
      )
      .bind(editId, JSON.stringify(fields), admin.email, iso)
      .run();
    if (!res.meta.changes) return fail(409, "This change isn't in conflict.");
  } else if (action === 'retry') {
    res = await db
      .prepare(
        `UPDATE sheet_edits SET status = 'queued', resolution = 'retried', resolved_by = ?2, attempts = 0, next_attempt_at = NULL,
           claim = NULL, claimed_at = NULL, settled_at = NULL, updated_at = ?3
         WHERE edit_id = ?1 AND status = 'dead'`,
      )
      .bind(editId, admin.email, iso)
      .run();
    if (!res.meta.changes) return fail(409, "Only a change that was given up on can be tried again.");
  } else {
    return fail(400, 'Choose withdraw, keep_sheet, write_mine or retry.');
  }
  await audit(db, editId, e.event_id, 'staff', admin.email, `sheet_edit.${action}`, null, {}, iso);
  return { ok: true, edit: publicEdit((await getEdit(db, editId))!) };
}

// ---- Overview ----

export async function sheetSyncOverview(db: D1Database, admin: AuthUser) {
  const denied = adminOnly(admin);
  if (denied) return denied;
  const [mode, edits, counts, lastSync] = await Promise.all([
    sheetMode(db),
    db
      .prepare(
        `SELECT ${EDIT_FIELDS} FROM sheet_edits s LEFT JOIN events e ON e.event_id = s.event_id
         ORDER BY CASE WHEN s.status IN ('conflict', 'dead') THEN 0 WHEN ${OPEN} THEN 1 ELSE 2 END, s.created_at DESC LIMIT 50`,
      )
      .all<Record<string, unknown>>(),
    db.prepare("SELECT status, COUNT(*) AS n FROM sheet_edits WHERE status IN ('queued', 'conflict', 'dead') GROUP BY status").all<{ status: string; n: number }>(),
    db.prepare("SELECT run_id, status, received_at, events_seen, warnings FROM sync_runs ORDER BY received_at DESC LIMIT 1").first<Record<string, unknown>>(),
  ]);
  const count = (s: string) => counts.results.find(r => r.status === s)?.n ?? 0;
  return {
    ok: true as const,
    mode,
    counts: { queued: count('queued'), conflict: count('conflict'), dead: count('dead') },
    edits: edits.results.map(r => publicEdit(shapeEdit(r))),
    last_sync: lastSync ? { ...lastSync, warnings: lastSync.warnings ? JSON.parse(String(lastSync.warnings)) : [] } : null,
  };
}

// ---- n8n RTD Sheet Writer ----

const TARGETS_FOR: Record<Mode, Target[]> = { off: [], staging: ['staging'], shadow: ['staging', 'shadow'], live: ['staging', 'shadow', 'live'] };

/**
 * Edits due, oldest first, each claimed for 10 minutes. Off: none. Staging and shadow edits never
 * touch the live sheet, so they go in any mode but off; live ones only while the mode is live.
 */
export async function claimEdits(db: D1Database, now: Date) {
  const mode = await sheetMode(db);
  const targets = TARGETS_FOR[mode];
  if (!targets.length) return { mode, edits: [] };
  const iso = now.toISOString();
  const claim = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
  const [, list] = await db.batch([
    db
      .prepare(
        `UPDATE sheet_edits SET claim = ?1, claimed_at = ?2, updated_at = ?2 WHERE edit_id IN (
           SELECT edit_id FROM sheet_edits WHERE status = 'queued' AND target IN (SELECT value FROM json_each(?3))
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?2) AND (claimed_at IS NULL OR claimed_at < ?4)
           ORDER BY created_at LIMIT ${CLAIM_BATCH})`,
      )
      .bind(claim, iso, JSON.stringify(targets), new Date(now.getTime() - CLAIM_MS).toISOString()),
    db.prepare('SELECT edit_id, event_id, source, target FROM sheet_edits WHERE claim = ?1 ORDER BY created_at').bind(claim),
  ]);
  const rows = (list?.results ?? []) as { edit_id: string; event_id: string; source: Source; target: Target }[];
  return { mode, edits: rows.map(r => ({ edit_id: r.edit_id, claim, event_id: r.event_id, target: r.target, tab: TAB[r.source] })) };
}

type Rows = Record<string, unknown>[];

/** n8n's body: { claim, rows } (rows: what it read, as objects keyed by header). */
export function parseWriterBody(body: unknown): { claim: string; rows: Rows } | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof b.claim !== 'string' || !b.claim) return 'claim is required';
  if (!Array.isArray(b.rows) || b.rows.length > 2000 || b.rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) return 'rows must be an array of row objects';
  return { claim: b.claim, rows: b.rows as Rows };
}

type Claimed = Awaited<ReturnType<typeof getEdit>> & object;

/** The edit, if this claim still holds it. */
async function held(db: D1Database, id: string, claim: string): Promise<Claimed | null> {
  const e = await getEdit(db, id);
  return e && e.status === 'queued' && e.claim === claim ? e : null;
}

export type CheckAnswer = { action: 'write'; tab: string; cells: Record<string, string> } | { action: 'skip'; status: string; error?: string };

/**
 * The row n8n read, against the edit. Answers with the cells to write, or skip (and why).
 * A trial (shadow) records what it would write and never answers write.
 */
export async function checkEdit(db: D1Database, id: string, claim: string, rows: Rows, now: Date, origin: string): Promise<CheckAnswer | null> {
  const e = await getEdit(db, id);
  if (!e) return null;
  if (e.status !== 'queued' || e.claim !== claim) return { action: 'skip', status: e.status, error: 'No longer held by this run' };
  const iso = now.toISOString();
  const r = checkRows(e.source, e.event_id, e.fields, rows);
  if (r.action === 'error') {
    const status = await recordFailure(db, e, r.error, now, origin);
    return { action: 'skip', status, error: r.error };
  }
  if (r.action === 'conflict') {
    await db
      .prepare(`UPDATE sheet_edits SET status = 'conflict', found = ?2, claim = NULL, last_attempt_at = ?3, settled_at = ?3, updated_at = ?3 WHERE edit_id = ?1`)
      .bind(id, JSON.stringify(r.found), iso)
      .run();
    await audit(db, id, e.event_id, 'n8n', 'n8n', 'sheet_edit.conflict', null, { columns: r.columns, found: r.found }, iso);
    await queue(db, problemEmail({ ...e, status: 'conflict', found: r.found }, origin, iso), iso).run();
    return { action: 'skip', status: 'conflict' };
  }
  const cells = r.action === 'write' ? cellsFor(e.event_id, r.changes) : {};
  if (e.target === 'shadow' || r.action === 'none') {
    // A trial writes nothing; and when the sheet already shows every change, there is nothing to write.
    const status = e.target === 'shadow' ? 'dry_run' : 'written';
    await db
      .prepare(
        `UPDATE sheet_edits SET status = ?2, found = ?3, cells = ?4, claim = NULL, last_attempt_at = ?5,
           written_at = CASE WHEN ?2 = 'written' THEN ?5 END, settled_at = CASE WHEN ?2 = 'dry_run' THEN ?5 END, updated_at = ?5
         WHERE edit_id = ?1`,
      )
      .bind(id, status, JSON.stringify(r.found), JSON.stringify(cells), iso)
      .run();
    await audit(db, id, e.event_id, 'n8n', 'n8n', status === 'dry_run' ? 'sheet_edit.dry_run' : 'sheet_edit.already_in_sheet', null, { cells }, iso);
    return { action: 'skip', status };
  }
  await db.prepare('UPDATE sheet_edits SET found = ?2, cells = ?3, last_attempt_at = ?4, updated_at = ?4 WHERE edit_id = ?1').bind(id, JSON.stringify(r.found), JSON.stringify(cells), iso).run();
  return { action: 'write', tab: e.tab, cells };
}

/** n8n wrote the cells and read the row back. Verified: written. Not as intended: given up on, for a person to look at. */
export async function markEditWritten(db: D1Database, id: string, claim: string, rows: Rows, now: Date, origin: string): Promise<'ok' | 'mismatch' | 'already' | 'not_found'> {
  const e = await getEdit(db, id);
  if (!e) return 'not_found';
  const mine = await held(db, id, claim);
  if (!mine || !mine.cells) return 'already';
  const changes = Object.fromEntries(Object.keys(mine.cells).filter(c => c in mine.fields).map(c => [c, mine.fields[c as Column]!.to])) as Partial<Record<Column, string>>;
  const wrong = verifyRows(mine.source, mine.event_id, changes, rows);
  const iso = now.toISOString();
  if (wrong) {
    await db
      .prepare(`UPDATE sheet_edits SET status = 'dead', last_error = ?2, claim = NULL, settled_at = ?3, updated_at = ?3 WHERE edit_id = ?1`)
      .bind(id, wrong, iso)
      .run();
    await audit(db, id, e.event_id, 'n8n', 'n8n', 'sheet_edit.dead', null, { error: wrong }, iso);
    await queue(db, problemEmail({ ...mine, status: 'dead', last_error: wrong }, origin, iso), iso).run();
    return 'mismatch';
  }
  await db
    .prepare(`UPDATE sheet_edits SET status = 'written', written_at = ?2, claim = NULL, last_error = NULL, updated_at = ?2 WHERE edit_id = ?1`)
    .bind(id, iso)
    .run();
  await audit(db, id, e.event_id, 'n8n', 'n8n', 'sheet_edit.written', null, { target: e.target, cells: mine.cells }, iso);
  if (e.target === 'live' && ('Event Time' in changes || 'End Time' in changes)) await tellNewTime(db, mine, changes, now, origin);
  return 'ok';
}

/**
 * A new time is in the Logic Engine: everyone booked on dates to come is emailed it, as for an
 * approved host change. Once per booking (the outbox dedupes on the edit).
 */
async function tellNewTime(db: D1Database, e: Claimed, changes: Partial<Record<Column, string>>, now: Date, origin: string) {
  const ev = await db.prepare('SELECT display_name, sheet_values FROM events WHERE event_id = ?1').bind(e.event_id).first<{ display_name: string; sheet_values: string | null }>();
  const current = json<Record<string, string> | null>(ev?.sheet_values ?? null) ?? {};
  const start = changes['Event Time'] ?? current['Event Time'] ?? '';
  if (!start) return;
  const end = changes['End Time'] ?? current['End Time'] ?? '';
  const { results: booked } = await db
    .prepare(
      `SELECT b.booking_id, b.lead_name, b.email, b.party_size, o.event_date FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id
       WHERE o.event_id = ?1 AND o.status = 'scheduled' AND o.event_date >= ?2 AND b.status = 'confirmed' ORDER BY o.event_date, b.booking_id`,
    )
    .bind(e.event_id, londonDate(now))
    .all<{ booking_id: string; lead_name: string; email: string; party_size: number; event_date: string }>();
  if (!booked.length) return;
  const name = ev?.display_name ?? e.name ?? e.event_id;
  const time = timeLabel(start, end || null);
  const iso = now.toISOString();
  await db.batch(booked.map(b => queue(db, attendeeTimeChanged(e.edit_id, name, name, b, time, origin), iso)));
}

/** Google refused (or n8n failed). Body: { claim, error }. Tried again later; after the last try, given up on. */
export async function markEditFailed(db: D1Database, id: string, claim: string, error: unknown, now: Date, origin: string): Promise<'retry' | 'dead' | 'already' | 'not_found'> {
  const e = await getEdit(db, id);
  if (!e) return 'not_found';
  if (e.status !== 'queued' || e.claim !== claim) return 'already';
  const message = typeof error === 'string' && error.trim() ? error.trim().slice(0, 500) : 'n8n could not write to the sheet';
  return (await recordFailure(db, e, message, now, origin)) === 'dead' ? 'dead' : 'retry';
}

async function recordFailure(db: D1Database, e: Claimed, message: string, now: Date, origin: string): Promise<'queued' | 'dead'> {
  const iso = now.toISOString();
  const attempts = e.attempts + 1;
  const dead = attempts > RETRY_AFTER_MS.length;
  const next = dead ? null : new Date(now.getTime() + RETRY_AFTER_MS[attempts - 1]!).toISOString();
  const res = await db
    .prepare(
      `UPDATE sheet_edits SET attempts = ?2, last_error = ?3, last_attempt_at = ?4, next_attempt_at = ?5, claim = NULL, claimed_at = NULL,
         status = CASE WHEN ?6 = 1 THEN 'dead' ELSE status END, settled_at = CASE WHEN ?6 = 1 THEN ?4 END, updated_at = ?4
       WHERE edit_id = ?1 AND claim = ?7 AND status = 'queued'`,
    )
    .bind(e.edit_id, attempts, message, iso, next, dead ? 1 : 0, e.claim)
    .run();
  if (res.meta.changes && dead) {
    await audit(db, e.edit_id, e.event_id, 'n8n', 'n8n', 'sheet_edit.dead', null, { error: message, attempts }, iso);
    await queue(db, problemEmail({ ...e, status: 'dead', last_error: message }, origin, iso), iso).run();
  }
  return dead ? 'dead' : 'queued';
}

// ---- The email to the admin ----

const WHERE: Record<Target, string> = { staging: 'the test copy of the Logic Engine', shadow: 'the Logic Engine (trial run: nothing is written)', live: 'the Logic Engine' };

/** A value for the email: a long prompt is cut short, the organiser shows it whole. */
const brief = (v: string | undefined) => esc(!v ? 'nothing' : v.length > 200 ? `${v.slice(0, 200)}…` : v);

function problemEmail(e: SheetEdit, origin: string, iso: string): Email {
  const name = e.name ?? e.event_id;
  const list = Object.entries(e.fields)
    .map(([c, f]) => {
      const sheet = e.status === 'conflict' && e.found && e.found[c] !== f!.from && e.found[c] !== f!.to ? `; the sheet now has <strong>${brief(e.found[c])}</strong>` : '';
      return `<li><strong>${esc(c)}:</strong> ${brief(f!.from)} → ${brief(f!.to)}${sheet}</li>`;
    })
    .join('');
  const why =
    e.status === 'conflict'
      ? `<p>Nothing was written: the sheet changed since you made this change. Choose which to keep under Sheet sync in the organiser.</p>`
      : `<p>It couldn't be written, and won't be tried again unless you ask: ${esc(e.last_error ?? 'unknown error')}.</p>`;
  return {
    dedupe_key: `sheet-edit:${e.edit_id}:${e.status}:${iso}`,
    kind: e.status === 'conflict' ? 'sheet_edit_conflict' : 'sheet_edit_dead',
    to: e.requested_by,
    reply_to: null,
    subject: `${e.status === 'conflict' ? 'Not written, the sheet changed' : 'Not written'}: ${name}`,
    html: `<p>Your change to <strong>${esc(name)}</strong> (${esc(e.edit_id)}) for ${WHERE[e.target]}:</p><ul>${list}</ul>${why}<p><a href="${esc(origin)}/organise">Open the organiser</a></p>`,
  };
}

/** Columns the organiser can change, by tab, for the editor. */
export const editableColumns = EDITABLE;
