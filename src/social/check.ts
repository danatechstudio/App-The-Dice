// What n8n is given before each social post, and the check every post goes through (spec §3, §4B).
// RTD Master V1 asks for each event's layer (its approved prompt, its facts and the date block of its
// next date) before Gemini writes a caption, then sends the finished caption (and any poster wording)
// here before it posts. The switch decides what happens:
// - off: nothing is looked at or recorded, and every post is allowed, as before;
// - shadow: every post is checked and the result recorded, but none is held;
// - enforce: a post that fails is held (allow: false), and the reasons say why.
//
// A post passes only when every target event can be posted about now (running, public, its date
// still to come and not cancelled, no change on its way to the Logic Engine, and the sheet's date
// already in the app), its approved prompt is the one in use for the current facts, and the words
// pass the deterministic check (src/social/validate.ts). Anything that can't be confirmed fails.

import { BOOKING_MODE, OCCURRENCE_FIELDS, upcoming, VISIBLE, type BookingMode } from '../lib/queries';
import { addDays, londonDate, parseSheetDate } from '../lib/time';
import { parseFacts, parsePeople, sourceFields } from './facts';
import { activeEventNamesExcept, currentPrompt, EVENT_FIELDS, OPEN_SHEET_EDIT, PENDING_CHANGE_REQUEST, socialMode, type Fail, type Mode } from './prompts';
import { checkPostText, type CheckTarget } from './validate';

/** One event's layer, put before the persona prompt in each caption node (spec §3). */
export interface EventLayer {
  event_id: string;
  /** The approved master prompt in use; '' when there is none for the current facts. */
  prompt: string;
  /** Its version, to send back with the check; 0 when there is none. */
  prompt_version: number;
  base_details: string;
  approved_facts: string;
  people_roles: string;
  banned_phrases: string;
  /** The event's next scheduled date in the app, in London. */
  occurrence: {
    occurrence_id: string;
    date: string;
    /** "Friday 23 October, 6:30pm", or "Friday 23 October" with no time. */
    label: string;
    start_time: string | null;
    end_time: string | null;
    is_today: boolean;
    is_tomorrow: boolean;
  } | null;
  /** The sheet's date (sheet_dates) isn't the app's yet: the sync is behind, so the check will fail. */
  sync_pending: boolean;
}

export interface CheckResult {
  allow: boolean;
  result: 'pass' | 'fail' | null;
  reasons: string[];
  mode: Mode;
}

const KINDS = ['event_post', 'roundup', 'poster'] as const;
type Kind = (typeof KINDS)[number];

/** Events in one request: a round-up covers a week at most. */
const MAX_EVENTS = 50;
/** Longest caption or poster wording accepted. */
const MAX_TEXT = 20_000;
const ID_MAX = 100;

const bad = (error: string): Fail => ({ ok: false, status: 400, error });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= ID_MAX;
const shortText = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, ID_MAX) : null);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "18:30" as "6:30pm", "18:00" as "6pm". Null when it can't be read. */
function twelveHour(hhmm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const h = Number(m[1]);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m[2] === '00' ? '' : `:${m[2]}`}${h < 12 ? 'am' : 'pm'}`;
}

/** A London date and start time as a post would say it: "Friday 23 October, 6:30pm" ("Friday 23 October" with no time). */
export function occurrenceLabel(date: string, start: string | null): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  const day = `${WEEKDAYS[at.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
  const time = start ? twelveHour(start) : null;
  return time ? `${day}, ${time}` : day;
}

/** Banned Phrases as the café writes them: one per line, or separated by commas or semicolons. */
export function bannedPhrases(text: string): string[] {
  return text
    .split(/[\n\r;,]+/)
    .map(p => p.trim())
    .filter(Boolean);
}

/** The Banned Phrases cell from an event's synced owner columns ('' when none, or when it won't read). */
function bannedCell(row: Record<string, unknown>): string {
  try {
    const parsed: unknown = typeof row.social_values === 'string' ? JSON.parse(row.social_values) : null;
    return isObject(parsed) && typeof parsed.banned_phrases === 'string' ? parsed.banned_phrases : '';
  } catch {
    return '';
  }
}

/** sheet_dates: { event_id: the Logic Engine's date as n8n read it }. Absent is the same as none. */
function readSheetDates(v: unknown): { ok: true; dates: Record<string, unknown> } | Fail {
  if (v === undefined || v === null) return { ok: true, dates: {} };
  if (!isObject(v) || !Object.values(v).every(d => typeof d === 'string' || typeof d === 'number'))
    return bad('sheet_dates must be an object of { event_id: the date in the sheet }');
  return { ok: true, dates: v };
}

/** Whether the sheet's date for an event (if n8n sent one) isn't the app's. A date that can't be read can't be confirmed, so it is pending too. */
function syncPending(sheetDates: Record<string, unknown>, eventId: string, appDate: string | null): boolean {
  if (!Object.hasOwn(sheetDates, eventId)) return false;
  const sheet = parseSheetDate(sheetDates[eventId]);
  return sheet === null || sheet !== appDate;
}

// ---- The event layer ----

/**
 * Each event's layer for the caption nodes. Body: { event_ids, sheet_dates? }. An event ID the app
 * doesn't know is left out. At off, no layers: the posts go out exactly as before.
 */
export async function socialContext(db: D1Database, body: unknown, now: Date): Promise<{ mode: Mode; events: EventLayer[] } | Fail> {
  const mode = await socialMode(db);
  if (mode === 'off') return { mode, events: [] };
  if (!isObject(body)) return bad('Body must be a JSON object');
  const ids = body.event_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_EVENTS || !ids.every(isId)) return bad(`event_ids must be a list of 1 to ${MAX_EVENTS} event IDs`);
  const read = readSheetDates(body.sheet_dates);
  if (!read.ok) return read;
  const sheetDates = read.dates;

  const today = londonDate(now);
  const tomorrow = addDays(today, 1);
  const events: EventLayer[] = [];
  for (const id of new Set(ids as string[])) {
    const row = await db.prepare(`SELECT ${EVENT_FIELDS} FROM events e WHERE e.event_id = ?1`).bind(id).first<Record<string, unknown>>();
    if (!row) continue;
    const fields = sourceFields(row);
    const prompt = await currentPrompt(db, id);
    const usable = prompt?.current ? prompt : null;
    // The date the post is about: its next one the public can see that is still to come or still running, as
    // the public pages pick it (src/lib/queries.ts). A date the app only projected from the event's cadence isn't
    // one: the Logic Engine hasn't confirmed it.
    const occ = await db
      .prepare(
        `SELECT o.occurrence_id, o.event_date, o.start_time, o.end_time FROM occurrences o JOIN events e ON e.event_id = o.event_id
         WHERE o.event_id = ?1 AND o.projected = 0 AND ${VISIBLE} AND ${upcoming('?2', '?3')}
         ORDER BY o.event_date, COALESCE(o.start_time, '00:00') LIMIT 1`,
      )
      .bind(id, now.toISOString(), today)
      .first<{ occurrence_id: string; event_date: string; start_time: string | null; end_time: string | null }>();
    events.push({
      event_id: id,
      prompt: usable?.master_prompt ?? '',
      prompt_version: usable?.version ?? 0,
      base_details: fields.base_details,
      approved_facts: fields.approved_facts,
      people_roles: fields.people_roles,
      banned_phrases: bannedCell(row),
      occurrence: occ
        ? {
            occurrence_id: occ.occurrence_id,
            date: occ.event_date,
            label: occurrenceLabel(occ.event_date, occ.start_time || null),
            start_time: occ.start_time || null,
            end_time: occ.end_time || null,
            is_today: occ.event_date === today,
            is_tomorrow: occ.event_date === tomorrow,
          }
        : null,
      sync_pending: syncPending(sheetDates, id, occ?.event_date ?? null),
    });
  }
  return { mode, events };
}

// ---- The check before a post ----

interface Target {
  event_id: string;
  occurrence_id: string;
  prompt_version: number;
}

interface CheckRequest {
  kind: Kind;
  platform: string | null;
  targets: Target[];
  text: string;
  image_text: string | null;
  workflow: string | null;
  execution_id: string | null;
  sheet_dates: Record<string, unknown>;
}

/** The check's body: { kind, platform, targets: [{ event_id, occurrence_id, prompt_version }], text, image_text?, workflow, execution_id, sheet_dates? }. */
function readCheck(body: unknown): CheckRequest | Fail {
  if (!isObject(body)) return bad('Body must be a JSON object');
  if (!(KINDS as readonly unknown[]).includes(body.kind)) return bad(`kind must be one of: ${KINDS.join(', ')}`);
  const targets = body.targets;
  const shape = `targets must be a list of 1 to ${MAX_EVENTS} { event_id, occurrence_id, prompt_version } (prompt_version as the context gave it, 0 for none)`;
  if (!Array.isArray(targets) || !targets.length || targets.length > MAX_EVENTS) return bad(shape);
  for (const t of targets) {
    if (!isObject(t) || !isId(t.event_id) || !isId(t.occurrence_id)) return bad(shape);
    if (typeof t.prompt_version !== 'number' || !Number.isInteger(t.prompt_version) || t.prompt_version < 0) return bad(shape);
  }
  if (typeof body.text !== 'string') return bad('text (the caption as it will be posted) is required');
  if (body.text.length > MAX_TEXT) return bad(`text is over ${MAX_TEXT} characters`);
  if (body.image_text !== undefined && body.image_text !== null && typeof body.image_text !== 'string')
    return bad('image_text must be the poster wording, as text');
  if (typeof body.image_text === 'string' && body.image_text.length > MAX_TEXT) return bad(`image_text is over ${MAX_TEXT} characters`);
  const sheetDates = readSheetDates(body.sheet_dates);
  if (!sheetDates.ok) return sheetDates;
  return {
    kind: body.kind as Kind,
    platform: shortText(body.platform),
    targets: (targets as Target[]).map(t => ({ event_id: t.event_id, occurrence_id: t.occurrence_id, prompt_version: t.prompt_version })),
    text: body.text,
    image_text: typeof body.image_text === 'string' ? body.image_text : null,
    workflow: shortText(body.workflow),
    execution_id: shortText(body.execution_id),
    sheet_dates: sheetDates.dates,
  };
}

const PUBLIC = ['public', 'app_bookable'];

/**
 * One target: whether its event and date can be posted about now and its prompt is the one in use
 * (each problem a plain reason), and what the words are checked against. No CheckTarget when the
 * event or the date doesn't exist: there is nothing to check the words against.
 */
async function resolveTarget(
  db: D1Database,
  t: Target,
  sheetDates: Record<string, unknown>,
  now: Date,
): Promise<{ reasons: string[]; target: CheckTarget | null; names: unknown[]; current: boolean }> {
  const event = await db
    .prepare(
      `SELECT ${EVENT_FIELDS}, e.active, ${BOOKING_MODE} AS booking_mode,
         CASE WHEN ${OPEN_SHEET_EDIT} THEN 1 ELSE 0 END AS open_edit, CASE WHEN ${PENDING_CHANGE_REQUEST} THEN 1 ELSE 0 END AS change_request
       FROM events e WHERE e.event_id = ?1`,
    )
    .bind(t.event_id)
    .first<Record<string, unknown>>();
  if (!event) return { reasons: [`${t.event_id}: no event with that ID`], target: null, names: [], current: false };

  const fields = sourceFields(event);
  const name = fields.name || t.event_id;
  const reasons: string[] = [];
  const say = (why: string) => reasons.push(`${name}: ${why}`);

  // The event.
  if (event.active !== 1) say('not running (inactive in the Logic Engine)');
  const eventPublic = PUBLIC.includes(fields.visibility);
  if (!eventPublic) say(`not public (${fields.visibility || 'no visibility'})`);
  if (event.open_edit === 1) say('a change is on its way to the Logic Engine; wait for it to sync');
  if (event.change_request === 1) say("a host's change is waiting to reach the Logic Engine; wait for it to sync");

  // Its date.
  const occ = await db
    // Read as the public pages read it (src/lib/queries.ts), so the price is the date's own when it has one, else App Price.
    .prepare(
      `SELECT ${OCCURRENCE_FIELDS}, o.visibility AS own_visibility FROM occurrences o JOIN events e ON e.event_id = o.event_id WHERE o.occurrence_id = ?1`,
    )
    .bind(t.occurrence_id)
    .first<{
      event_id: string;
      date: string;
      start_time: string | null;
      end_time: string | null;
      ends_at: string | null;
      status: string;
      own_visibility: string | null;
      projected: number;
      price_display: string | null;
    }>();
  let target: CheckTarget | null = null;
  if (!occ || occ.event_id !== t.event_id) say(`${t.occurrence_id} is not a date of this event`);
  else {
    const date = occ.date;
    if (occ.status === 'cancelled') say(`its date ${date} was cancelled`);
    else if (occ.status === 'rescheduled') say(`its date ${date} was moved to another date`);
    // Over: an earlier day (London), marked completed, or ended earlier today.
    if (occ.status === 'completed' || date < londonDate(now) || (occ.ends_at && occ.ends_at <= now.toISOString())) say(`its date ${date} has already happened`);
    if (eventPublic && occ.own_visibility && !PUBLIC.includes(occ.own_visibility)) say(`its date ${date} is not public (${occ.own_visibility})`);
    // A date the app only projected from the event's cadence: the Logic Engine hasn't reached it.
    if (occ.projected === 1) say(`date not in the app yet (${date} is only projected from the event's cadence); wait for the sync`);
    else if (syncPending(sheetDates, t.event_id, date))
      say(`date not in the app yet (the sheet has ${String(sheetDates[t.event_id])}, the app ${date}); wait for the sync`);
    const social = { facts: parseFacts(fields.approved_facts).facts, people: parsePeople(fields.people_roles).people };
    target = {
      event_id: t.event_id,
      name,
      date,
      start_time: occ.start_time || null,
      end_time: occ.end_time || null,
      price: occ.price_display ?? '',
      ...social,
      base_details: fields.base_details,
      banned: bannedPhrases(bannedCell(event)),
      booking_mode: event.booking_mode as BookingMode,
    };
  }

  // Its prompt: the approved one in use for the current facts, and the version the caption was written with.
  const prompt = await currentPrompt(db, t.event_id);
  if (!prompt) say('prompt missing (no approved prompt yet)');
  else if (!prompt.current) say(`prompt out of date (the facts changed since version ${prompt.version} was approved)`);
  else if (t.prompt_version !== prompt.version) say(`prompt version ${t.prompt_version} isn't the current one (${prompt.version})`);

  const current = !!prompt?.current && t.prompt_version === prompt.version;
  return { reasons, target, names: [event.event_name, event.display_name], current };
}

/**
 * Checks a post before n8n sends it to Buffer. At off it answers allow at once and records nothing.
 * In shadow and enforce each call is recorded in social_checks; allow is false only in enforce,
 * when the post failed. A body that can't be checked is refused (400), never allowed.
 */
export async function runCheck(db: D1Database, body: unknown, now: Date): Promise<CheckResult | Fail> {
  const mode = await socialMode(db);
  if (mode === 'off') return { allow: true, result: null, reasons: [], mode };
  const req = readCheck(body);
  if ('ok' in req) return req;

  const reasons: string[] = [];
  const targets: CheckTarget[] = [];
  const names: unknown[] = [];
  const current: Target[] = [];
  for (const t of req.targets) {
    const r = await resolveTarget(db, t, req.sheet_dates, now);
    reasons.push(...r.reasons);
    names.push(...r.names);
    if (r.current) current.push(t);
    if (r.target) targets.push(r.target);
  }
  // The words are checked against the targets that exist; one that doesn't has already failed the post.
  if (targets.length) {
    const ctx = { now, otherEventNames: await activeEventNamesExcept(db, [...new Set(req.targets.map(t => t.event_id))], names) };
    reasons.push(...checkPostText(req.text, targets, ctx).reasons);
    if (req.image_text !== null) reasons.push(...checkPostText(req.image_text, targets, ctx).reasons.map(r => `Poster: ${r}`));
  }
  const result = reasons.length ? 'fail' : 'pass';
  const allow = mode !== 'enforce' || result === 'pass';

  const iso = now.toISOString();
  const steps: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO social_checks (check_id, mode, kind, platform, targets, text, image_text, result, reasons, workflow, execution_id, created_at)
         SELECT (SELECT printf('RTD-SC-%05d', COALESCE(MAX(CAST(substr(check_id, 8) AS INTEGER)), 0) + 1) FROM social_checks),
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11`,
      )
      .bind(
        mode,
        req.kind,
        req.platform,
        JSON.stringify(req.targets),
        req.text,
        req.image_text,
        result,
        JSON.stringify(reasons),
        req.workflow,
        req.execution_id,
        iso,
      ),
  ];
  // The prompt versions the post was written with, when it is going out: only a version in use for the
  // event's current facts. An old or stale one (allowed in shadow) isn't marked.
  if (allow) {
    for (const t of current)
      steps.push(db.prepare('UPDATE social_prompts SET last_used_at = ?3 WHERE event_id = ?1 AND version = ?2').bind(t.event_id, t.prompt_version, iso));
  }
  await db.batch(steps);
  return { allow, result, reasons, mode };
}
