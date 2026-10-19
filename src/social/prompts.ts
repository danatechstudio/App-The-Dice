// Each event's social master prompt, version by version (spec §1–§2), and the switch that decides
// whether posts are checked against it. n8n "RTD Social Prompt Builder" asks which events are due,
// sends each one's request to Gemini and posts the answer back here. The app checks it
// (src/social/validate.ts), stores it as a new version and hands back the two Logic Engine cells to
// write (Social Prompt, Social Prompt Status); n8n writes them and says so.
//
// - Versions are numbered per event (unique). Several can share a fingerprint, when an admin
//   pressed Regenerate or approved their own text for the same facts: the newest one for the
//   facts is the one that counts, and the older ones stay as they were, as history. A duplicate
//   post is harmless: a version is only added when no other has been added for those facts since.
// - A failed generation (malformed output, or n8n reporting a timeout or quota error) stores no
//   version; it is audited, and the event stays due. The third failure for the same facts stores a
//   blocked version ("generation failed"), and the event stops being due until an admin regenerates.
// - The last approved version stays in use only while its facts match the event's current ones.

import type { AuthUser } from '../lib/auth';
import { londonDate } from '../lib/time';
import { OPEN } from '../sync/edits';
import { fingerprint, sourceFields, type SourceFields } from './facts';
import { buildRequest, INSTRUCTION_VERSION, SCHEDULE_RULE } from './instruction';
import { MAX_PROMPT_CHARS, promptTextErrors, validatePrompt, type PromptStatus } from './validate';

export const MODES = ['off', 'shadow', 'enforce'] as const;
export type Mode = (typeof MODES)[number];

/** Every status a stored version can have. */
export type StoredStatus = 'pending' | 'validated' | 'review_required' | 'approved' | 'superseded' | 'blocked';

export type Fail = { ok: false; status: 400 | 403 | 404 | 409; error: string; errors?: string[] };
const fail = (status: Fail['status'], error: string, errors?: string[]): Fail => (errors ? { ok: false, status, error, errors } : { ok: false, status, error });
const adminOnly = (u: AuthUser): Fail | null => (u.role === 'admin' ? null : fail(403, 'Only admins can manage social prompts.'));

/** The two Logic Engine cells n8n writes, matched on Event ID. */
export type Cells = { 'Social Prompt': string; 'Social Prompt Status': string };

/** Failures for the same facts before the event is blocked. */
const MAX_FAILURES = 3;
const REASON_MAX = 500;
const ID_MAX = 100;
/** How long a reason can be in the one-line Social Prompt Status cell. */
const CELL_REASON_MAX = 200;

// ---- The switch ----

export async function socialMode(db: D1Database): Promise<Mode> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'social_prompts'").first<{ value: string }>();
  return (MODES as readonly string[]).includes(row?.value ?? '') ? (row!.value as Mode) : 'off';
}

/** Admins: off (nothing checked), shadow (checked and recorded, nothing held) or enforce (a failing post is held). */
export async function setSocialMode(db: D1Database, admin: AuthUser, mode: unknown, now: Date): Promise<{ ok: true; mode: Mode } | Fail> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  if (!(MODES as readonly unknown[]).includes(mode)) return fail(400, `Choose one of: ${MODES.join(', ')}.`);
  const before = await socialMode(db);
  const iso = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('social_prompts', ?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(mode, iso, admin.email),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         VALUES ('setting', 'social_prompts', 'staff', ?1, 'social_prompts.changed', ?2, ?3, 'organiser', ?4)`,
      )
      .bind(admin.email, before, mode, iso),
  ]);
  return { ok: true, mode: mode as Mode };
}

// ---- Reading an event and its versions ----

/** The events columns sourceFields reads (for `e`); the post check (src/social/check.ts) reads them too. */
export const EVENT_FIELDS =
  'e.event_id, e.event_name, e.display_name, e.source, e.frequency, e.description, e.category, e.visibility, e.price_display, e.default_capacity, e.social_values';

interface PromptRow {
  prompt_id: string;
  event_id: string;
  version: number;
  status: StoredStatus;
  source_fingerprint: string;
  master_prompt: string | null;
  ambiguities: string | null;
  validation_errors: string | null;
  created_at: string;
}

const list = (json: string | null): string[] => {
  try {
    const v: unknown = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > CELL_REASON_MAX ? `${flat.slice(0, CELL_REASON_MAX - 1)}…` : flat;
};

async function loadEvent(db: D1Database, eventId: string): Promise<{ row: Record<string, unknown>; fields: SourceFields; fp: string } | null> {
  const row = await db.prepare(`SELECT ${EVENT_FIELDS} FROM events e WHERE e.event_id = ?1`).bind(eventId).first<Record<string, unknown>>();
  if (!row) return null;
  const fields = sourceFields(row);
  return { row, fields, fp: await fingerprint(fields) };
}

/** The names of every other active event, as the sheet and the app write them: a prompt may mention none of them. */
const otherEventNames = (db: D1Database, eventId: string, own: Record<string, unknown>): Promise<string[]> =>
  activeEventNamesExcept(db, [eventId], [own.event_name, own.display_name]);

/**
 * The names of every active event but these ones, as the sheet and the app write them. A name one
 * of these events also has (a second listing of it) isn't counted: it can't make their own name a stranger.
 */
export async function activeEventNamesExcept(db: D1Database, eventIds: string[], theirNames: unknown[]): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT event_name, display_name FROM events WHERE active = 1 AND event_id NOT IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(eventIds))
    .all<{ event_name: string; display_name: string }>();
  const ownNames = new Set(
    theirNames.map(n =>
      String(n ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
  const names = new Set<string>();
  for (const r of results) {
    for (const n of [r.event_name, r.display_name]) {
      const name = String(n ?? '').trim();
      if (name && !ownNames.has(name.toLowerCase())) names.add(name);
    }
  }
  return [...names];
}

/** The newest version for these facts, if any: the one that counts for them. */
const slotRow = (db: D1Database, eventId: string, fp: string) =>
  db.prepare('SELECT * FROM social_prompts WHERE event_id = ?1 AND source_fingerprint = ?2 ORDER BY version DESC LIMIT 1').bind(eventId, fp).first<PromptRow>();

/** The event's newest version that isn't a waiting regenerate request. */
async function latestVersion(db: D1Database, eventId: string): Promise<number> {
  const r = await db
    .prepare("SELECT MAX(version) AS v FROM social_prompts WHERE event_id = ?1 AND status <> 'pending'")
    .bind(eventId)
    .first<{ v: number | null }>();
  return r?.v ?? 0;
}

/**
 * Whether a row settles these facts, so no new prompt is wanted: an approved version for them (it's
 * in use), or the event's newest version. An older review or blocked version for facts that have
 * come back after a newer version doesn't: the event is due again.
 */
const settles = (row: PromptRow | null, latest: number): row is PromptRow =>
  !!row && row.status !== 'pending' && (row.status === 'approved' || row.version === latest);

/** The approved prompt in use: the newest approved version, if its facts are still the event's. */
async function inUse(db: D1Database, eventId: string, fp: string): Promise<string> {
  const row = await db
    .prepare("SELECT master_prompt, source_fingerprint FROM social_prompts WHERE event_id = ?1 AND status = 'approved' ORDER BY version DESC LIMIT 1")
    .bind(eventId)
    .first<{ master_prompt: string | null; source_fingerprint: string }>();
  return row && row.source_fingerprint === fp ? (row.master_prompt ?? '') : '';
}

/**
 * The cells for a version. Social Prompt is always the prompt in use (blank when there is none),
 * so a version that needs review never replaces a working prompt in the sheet.
 */
function cellsFor(row: PromptRow, prompt: string): Cells {
  if (row.status === 'approved') return { 'Social Prompt': row.master_prompt ?? '', 'Social Prompt Status': `approved · v${row.version}` };
  if (row.status === 'review_required') {
    const why = list(row.ambiguities)[0] ?? list(row.validation_errors)[0] ?? 'needs review';
    return { 'Social Prompt': prompt, 'Social Prompt Status': `review · v${row.version}: ${oneLine(why)}` };
  }
  const why = list(row.validation_errors)[0] ?? 'blocked';
  return { 'Social Prompt': prompt, 'Social Prompt Status': `blocked · v${row.version}: ${oneLine(why)}` };
}

// ---- Writing versions ----

export interface NewPrompt {
  event_id: string;
  status: StoredStatus;
  fingerprint: string;
  /** JSON of the source fields the version was made from. */
  snapshot: string;
  now: string;
  master_prompt?: string | null;
  claims?: unknown;
  ambiguities?: string[];
  validation_errors?: string[];
  model?: string | null;
  job_id?: string | null;
  generated?: boolean;
  approved_by?: string | null;
  override_text?: string | null;
  override_reason?: string | null;
  /** The newest version for these facts when this one was decided on (null: none). Nothing is added if another has come since. */
  replaces?: string | null;
}

const asJson = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

/**
 * A new version. Its number (per event) and its RTD-SP id are worked out inside the INSERT, so two
 * versions made at once can never share one. Nothing happens when another version for these facts
 * has been added since this one was decided on (`replaces`), so a duplicate post adds nothing.
 */
export function insertPrompt(db: D1Database, p: NewPrompt): D1PreparedStatement {
  const approved = p.status === 'approved';
  return db
    .prepare(
      `INSERT INTO social_prompts (prompt_id, event_id, version, status, schema_version, instruction_version, source_fingerprint, source_snapshot,
         master_prompt, claims, ambiguities, validation_errors, generation_model, generation_job_id, generated_at, validated_at, approved_at, approved_by,
         override_text, override_reason, created_at)
       SELECT (SELECT printf('RTD-SP-%05d', COALESCE(MAX(CAST(substr(prompt_id, 8) AS INTEGER)), 0) + 1) FROM social_prompts), ?1,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM social_prompts WHERE event_id = ?1),
         ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
       WHERE COALESCE((SELECT prompt_id FROM social_prompts WHERE event_id = ?1 AND source_fingerprint = ?4 ORDER BY version DESC LIMIT 1), '') = ?19`,
    )
    .bind(
      p.event_id,
      p.status,
      INSTRUCTION_VERSION,
      p.fingerprint,
      p.snapshot,
      p.master_prompt ?? null,
      asJson(p.claims),
      asJson(p.ambiguities),
      asJson(p.validation_errors),
      p.model ?? null,
      p.job_id ?? null,
      p.generated ? p.now : null,
      p.status === 'pending' ? null : p.now,
      approved ? p.now : null,
      approved ? (p.approved_by ?? null) : null,
      p.override_text ?? null,
      p.override_reason ?? null,
      p.now,
      p.replaces ?? '',
    );
}

/** Fills a waiting regenerate request with its result; it keeps its version and its "regenerate" reason unless an admin's own reason replaces it. */
function fillPrompt(db: D1Database, promptId: string, p: NewPrompt): D1PreparedStatement {
  const approved = p.status === 'approved';
  return db
    .prepare(
      `UPDATE social_prompts SET status = ?2, instruction_version = ?3, master_prompt = ?4, claims = ?5, ambiguities = ?6, validation_errors = ?7,
         generation_model = ?8, generation_job_id = ?9, generated_at = ?10, validated_at = ?11, approved_at = ?12, approved_by = ?13,
         override_text = ?14, override_reason = COALESCE(?15, override_reason), written_at = NULL
       WHERE prompt_id = ?1 AND status = 'pending'`,
    )
    .bind(
      promptId,
      p.status,
      INSTRUCTION_VERSION,
      p.master_prompt ?? null,
      asJson(p.claims),
      asJson(p.ambiguities),
      asJson(p.validation_errors),
      p.model ?? null,
      p.job_id ?? null,
      p.generated ? p.now : null,
      p.now,
      approved ? p.now : null,
      approved ? (p.approved_by ?? null) : null,
      p.override_text ?? null,
      p.override_reason ?? null,
    );
}

/** Once a version is approved, every earlier approved version of the event is superseded. */
const supersede = (db: D1Database, eventId: string) =>
  db
    .prepare(
      `UPDATE social_prompts SET status = 'superseded'
       WHERE event_id = ?1 AND status = 'approved' AND version < (SELECT MAX(version) FROM social_prompts WHERE event_id = ?1 AND status = 'approved')`,
    )
    .bind(eventId);

/**
 * Stores a version for these facts: it fills a waiting regenerate request, or is a new version
 * (any older one for the facts stays as history). Returns the newest version for the facts (another
 * post's, if it got there first).
 */
async function store(db: D1Database, existing: PromptRow | null, p: NewPrompt): Promise<{ row: PromptRow; stored: boolean }> {
  const steps: D1PreparedStatement[] = [];
  // A waiting regenerate request is filled only while it is the event's newest version. One that a
  // version for other facts has overtaken since is closed, and the answer becomes a new version.
  const fill = existing?.status === 'pending' && existing.version > (await latestVersion(db, p.event_id));
  if (fill) steps.push(fillPrompt(db, existing.prompt_id, p));
  else {
    steps.push(insertPrompt(db, { ...p, replaces: existing?.prompt_id ?? null }));
    if (existing?.status === 'pending') {
      steps.push(
        db
          .prepare(
            `UPDATE social_prompts SET status = 'superseded' WHERE prompt_id = ?1 AND status = 'pending'
               AND EXISTS (SELECT 1 FROM social_prompts WHERE event_id = ?2 AND source_fingerprint = ?3 AND version > ?4)`,
          )
          .bind(existing.prompt_id, p.event_id, p.fingerprint, existing.version),
      );
    }
  }
  if (p.status === 'approved') steps.push(supersede(db, p.event_id));
  const [first] = await db.batch(steps);
  return { row: (await slotRow(db, p.event_id, p.fingerprint))!, stored: (first?.meta.changes ?? 0) > 0 };
}

const audit = (db: D1Database, eventId: string, actor: { type: 'n8n' | 'staff'; id: string }, action: string, value: unknown, iso: string) =>
  db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, new_value, source, created_at)
       VALUES ('social_prompt', ?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(eventId, actor.type, actor.id, action, JSON.stringify(value), actor.type === 'n8n' ? 'n8n' : 'organiser', iso);

const N8N = { type: 'n8n', id: 'n8n' } as const;

// ---- The builder (n8n) ----

export interface DuePrompt {
  event_id: string;
  fingerprint: string;
  request: { system: string; user: string };
  instruction_version: number;
}

/** An organiser edit not yet in the Logic Engine for event `e`. The post check (src/social/check.ts) uses these too. */
export const OPEN_SHEET_EDIT = `EXISTS (SELECT 1 FROM sheet_edits s WHERE s.event_id = e.event_id AND ${OPEN})`;
/** A host's change request for event `e` waiting for a decision, or approved and not yet in the sheet. */
export const PENDING_CHANGE_REQUEST = `EXISTS (SELECT 1 FROM event_change_requests r WHERE r.event_id = e.event_id
                      AND (r.status = 'pending' OR (r.status = 'approved' AND r.applied_at IS NULL)))`;

/**
 * The events that can have a prompt made now (?1 = today, London), with their next date: active,
 * Public or App Bookable, with a scheduled, visible date still to come, and no change on its way to
 * the Logic Engine. The builder's list and its answers both go by this.
 */
const ELIGIBLE = `SELECT * FROM (
  SELECT ${EVENT_FIELDS},
    (SELECT MIN(o.event_date) FROM occurrences o WHERE o.event_id = e.event_id AND o.status = 'scheduled' AND o.event_date >= ?1
       AND COALESCE(o.visibility, e.visibility) IN ('public', 'app_bookable')) AS next_date
  FROM events e
  WHERE e.active = 1 AND e.visibility IN ('public', 'app_bookable')
    AND NOT ${OPEN_SHEET_EDIT}
    AND NOT ${PENDING_CHANGE_REQUEST}
) WHERE next_date IS NOT NULL`;

const eligible = async (db: D1Database, eventId: string, now: Date): Promise<boolean> =>
  !!(await db.prepare(`${ELIGIBLE} AND event_id = ?2`).bind(londonDate(now), eventId).first());

/**
 * Events that need a prompt, soonest first: active, Public or App Bookable, with a scheduled date
 * still to come; no change on its way to the Logic Engine (an organiser edit, a host's request
 * waiting for a decision, or an approved one not yet in the sheet), since the facts may be about to
 * change; and nothing settled for their current facts, or an admin asked for a regenerate.
 */
export async function duePrompts(db: D1Database, now: Date, limit: number): Promise<DuePrompt[]> {
  const { results } = await db.prepare(`${ELIGIBLE} ORDER BY next_date, event_id LIMIT 500`).bind(londonDate(now)).all<Record<string, unknown>>();
  if (!results.length) return [];

  const ids = results.map(r => String(r.event_id));
  const { results: stored } = await db
    .prepare('SELECT * FROM social_prompts WHERE event_id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(ids))
    .all<PromptRow>();
  const byEvent = new Map<string, PromptRow[]>();
  for (const s of stored) byEvent.set(s.event_id, [...(byEvent.get(s.event_id) ?? []), s]);

  const due: DuePrompt[] = [];
  for (const row of results) {
    if (due.length >= limit) break;
    const fields = sourceFields(row);
    const fp = await fingerprint(fields);
    const rows = byEvent.get(fields.event_id) ?? [];
    const latest = Math.max(0, ...rows.filter(r => r.status !== 'pending').map(r => r.version));
    const newest = rows.filter(r => r.source_fingerprint === fp).sort((a, b) => b.version - a.version)[0] ?? null;
    if (settles(newest, latest)) continue;
    due.push({ event_id: fields.event_id, fingerprint: fp, request: buildRequest(fields), instruction_version: INSTRUCTION_VERSION });
  }
  return due;
}

export type ProposeResult =
  | { ok: true; status: PromptStatus; version: number; cells: Cells }
  /** A failed generation below the limit: nothing stored, and the event stays due. */
  | { ok: true; status: 'failed'; failures: number; version: null; cells: null };

const shortText = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A failure report's error as n8n sends it: text, or an error object (its message, or else the whole of it as JSON). */
function errorText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') {
    const message = (v as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return shortText(message, REASON_MAX);
    return shortText(JSON.stringify(v), REASON_MAX);
  }
  return shortText(String(v), REASON_MAX);
}

/** What the stored version says, for n8n. Null for a row that isn't an answer (one still waiting). */
const answer = (row: PromptRow, prompt: string): ProposeResult | null =>
  row.status === 'approved' || row.status === 'review_required' || row.status === 'blocked'
    ? { ok: true, status: row.status, version: row.version, cells: cellsFor(row, prompt) }
    : null;
/** Each copy of the schedule rule in a text, with the white space either side of it. */
const RULE_COPIES = new RegExp(`\\s*${SCHEDULE_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g');
const RACE: Fail = { ok: false, status: 409, error: 'Another answer for these facts is being stored just now. Drop this one.' };

/**
 * Gemini's answer for an event. Body: { fingerprint, job_id?, model?, output } with Gemini's raw
 * output (JSON or its text), or { fingerprint, job_id?, error } when the generation failed (a
 * timeout, a quota error). A fingerprint that is no longer the event's is refused (409 stale) and
 * nothing is stored: the event is due again, from its latest facts.
 */
export async function proposePrompt(db: D1Database, eventId: string, body: unknown, now: Date): Promise<ProposeResult | Fail> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.fingerprint !== 'string' || !b.fingerprint) return fail(400, 'fingerprint is required (from /due)');
  const error = errorText(b.error);
  if (!error && b.output === undefined) return fail(400, 'output (what Gemini returned) or error (why there is none) is required');

  const event = await loadEvent(db, eventId);
  if (!event) return fail(404, 'No event with that ID');
  if (b.fingerprint !== event.fp) return fail(409, "Stale: the event's facts changed since this was asked for. Drop it; the event is due again.");
  // It stopped running, lost its last date or has a change on its way since /due: nothing is stored.
  if (!(await eligible(db, eventId, now))) return fail(409, 'The event is no longer due (not running, no date to come, or a change on its way). Drop it.');

  const iso = now.toISOString();
  const [existing, latest] = await Promise.all([slotRow(db, eventId, event.fp), latestVersion(db, eventId)]);
  // These facts already have their answer (a duplicate post): hand back what is stored.
  if (settles(existing, latest)) return answer(existing, await inUse(db, eventId, event.fp)) ?? RACE;

  const meta = { model: shortText(b.model, ID_MAX), job_id: shortText(b.job_id, ID_MAX) };
  const base = { event_id: eventId, fingerprint: event.fp, snapshot: JSON.stringify(event.fields), now: iso, ...meta, generated: true };
  const verdict = error ? null : validatePrompt(b.output, event.fields, { otherEventNames: await otherEventNames(db, eventId, event.row) });

  if (!verdict || verdict.status === 'blocked') {
    const reason = error ?? verdict!.errors[0] ?? 'The output could not be read';
    await audit(db, eventId, N8N, 'social_prompt.failed', { fingerprint: event.fp, reason, job_id: meta.job_id }, iso).run();
    // Failures since the event's newest version (or regenerate request) count; older ones were dealt with.
    const since = await db.prepare('SELECT MAX(created_at) AS t FROM social_prompts WHERE event_id = ?1').bind(eventId).first<{ t: string | null }>();
    const { results: failures } = await db
      .prepare(
        `SELECT json_extract(new_value, '$.reason') AS reason FROM audit_log
         WHERE entity_id = ?1 AND action = 'social_prompt.failed' AND json_extract(new_value, '$.fingerprint') = ?2 AND created_at >= ?3
         ORDER BY audit_id`,
      )
      .bind(eventId, event.fp, since?.t ?? '')
      .all<{ reason: string }>();
    if (failures.length < MAX_FAILURES) return { ok: true, status: 'failed', failures: failures.length, version: null, cells: null };
    const { row, stored } = await store(db, existing, {
      ...base,
      status: 'blocked',
      validation_errors: ['generation failed', ...failures.map(f => String(f.reason))],
    });
    // Only what was stored is audited: when another post got there first, its answer comes back.
    if (stored)
      await audit(
        db,
        eventId,
        N8N,
        'social_prompt.generated',
        { version: row.version, status: row.status, fingerprint: event.fp, job_id: meta.job_id },
        iso,
      ).run();
    return answer(row, await inUse(db, eventId, event.fp)) ?? RACE;
  }

  const { row, stored } = await store(db, existing, {
    ...base,
    status: verdict.status,
    master_prompt: verdict.master_prompt,
    claims: verdict.claims,
    ambiguities: verdict.ambiguities,
    validation_errors: verdict.errors,
    approved_by: 'system',
  });
  if (stored)
    await audit(
      db,
      eventId,
      N8N,
      'social_prompt.generated',
      { version: row.version, status: row.status, fingerprint: event.fp, job_id: meta.job_id },
      iso,
    ).run();
  return answer(row, await inUse(db, eventId, event.fp)) ?? RACE;
}

/**
 * Versions whose cells aren't in the sheet yet: each event's newest one, once. The builder writes
 * the cells a proposal returns straight away; this also catches versions an admin approved, and
 * any whose write didn't finish.
 */
export async function promptsToWrite(db: D1Database): Promise<{ event_id: string; version: number; cells: Cells }[]> {
  const { results } = await db
    .prepare(
      `SELECT p.* FROM social_prompts p
       WHERE p.written_at IS NULL AND p.status IN ('approved', 'review_required', 'blocked')
         AND p.version = (SELECT MAX(q.version) FROM social_prompts q WHERE q.event_id = p.event_id AND q.status <> 'pending')
       ORDER BY p.created_at, p.prompt_id LIMIT 50`,
    )
    .all<PromptRow>();
  const out: { event_id: string; version: number; cells: Cells }[] = [];
  for (const row of results) {
    const event = await loadEvent(db, row.event_id);
    out.push({ event_id: row.event_id, version: row.version, cells: cellsFor(row, event ? await inUse(db, row.event_id, event.fp) : '') });
  }
  return out;
}

/** n8n wrote a version's cells. Saying so twice is fine. */
export async function markPromptWritten(db: D1Database, eventId: string, version: number, now: Date): Promise<'ok' | 'not_found'> {
  const res = await db
    .prepare("UPDATE social_prompts SET written_at = COALESCE(written_at, ?3) WHERE event_id = ?1 AND version = ?2 AND status <> 'pending'")
    .bind(eventId, version, now.toISOString())
    .run();
  return res.meta.changes > 0 ? 'ok' : 'not_found';
}

/** The event's newest approved version, and whether its facts are still the event's (only then is it usable). */
export async function currentPrompt(
  db: D1Database,
  eventId: string,
): Promise<{ version: number; master_prompt: string; fingerprint: string; current: boolean } | null> {
  const event = await loadEvent(db, eventId);
  if (!event) return null;
  const row = await db
    .prepare("SELECT version, master_prompt, source_fingerprint FROM social_prompts WHERE event_id = ?1 AND status = 'approved' ORDER BY version DESC LIMIT 1")
    .bind(eventId)
    .first<{ version: number; master_prompt: string | null; source_fingerprint: string }>();
  if (!row) return null;
  return { version: row.version, master_prompt: row.master_prompt ?? '', fingerprint: row.source_fingerprint, current: row.source_fingerprint === event.fp };
}

// ---- Admins ----

/**
 * Admins: make the event due again for its current facts. Stored as a waiting version (status
 * pending, override_reason "regenerate") that the next proposal fills. An approved version in use
 * stays in use until a new one is approved. Pressing it again while one waits changes nothing.
 */
export async function requestRegenerate(db: D1Database, admin: AuthUser, eventId: string, now: Date): Promise<{ ok: true } | Fail> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  const event = await loadEvent(db, eventId);
  if (!event) return fail(404, 'No event with that ID.');
  const iso = now.toISOString();
  const existing = await slotRow(db, eventId, event.fp);
  const steps: D1PreparedStatement[] = [];
  if (existing?.status !== 'pending') {
    steps.push(
      insertPrompt(db, {
        event_id: eventId,
        status: 'pending',
        fingerprint: event.fp,
        snapshot: JSON.stringify(event.fields),
        now: iso,
        override_reason: 'regenerate',
        replaces: existing?.prompt_id ?? null,
      }),
    );
  }
  steps.push(audit(db, eventId, { type: 'staff', id: admin.email }, 'social_prompt.regenerate_requested', { fingerprint: event.fp }, iso));
  await db.batch(steps);
  return { ok: true };
}

/**
 * Admins: approve a prompt for the event's current facts with a note. Body: { text?, reason }.
 * Without text, the version waiting for review is approved as Gemini wrote it. The text gets the
 * same checks on dates, times, prices, other events and names as a generated prompt (400 with
 * `errors`), and the schedule rule is added exactly once. It becomes a new approved version.
 */
export async function approveOverride(
  db: D1Database,
  admin: AuthUser,
  eventId: string,
  body: unknown,
  now: Date,
): Promise<{ ok: true; version: number } | Fail> {
  const denied = adminOnly(admin);
  if (denied) return denied;
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const event = await loadEvent(db, eventId);
  if (!event) return fail(404, 'No event with that ID.');
  const reason = shortText(b.reason, 500);
  if (!reason) return fail(400, 'Say why you are approving it (reason).');

  const existing = await slotRow(db, eventId, event.fp);
  const given = typeof b.text === 'string' && b.text.trim() ? b.text : existing?.master_prompt;
  if (!given?.trim()) return fail(400, 'There is no prompt for these facts to approve: paste the text.');
  // The rule is code's to add: take out every copy pasted in (with the blank lines around it, or
  // the spaces within a line), check the rest, then add it once at the end.
  const text = given
    .replace(RULE_COPIES, copy => (copy.includes('\n') ? '\n\n' : ' '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return fail(400, 'There is no prompt for these facts to approve: paste the text.');
  if ([...text].length > MAX_PROMPT_CHARS) return fail(400, `The prompt is over ${MAX_PROMPT_CHARS} characters.`);
  const errors = promptTextErrors(text, event.fields, await otherEventNames(db, eventId, event.row));
  if (errors.length) return fail(400, 'The prompt has problems, so it was not approved.', errors);

  const final = `${text}\n\n${SCHEDULE_RULE}`;
  const iso = now.toISOString();
  const { row, stored } = await store(db, existing, {
    event_id: eventId,
    status: 'approved',
    fingerprint: event.fp,
    snapshot: JSON.stringify(event.fields),
    now: iso,
    master_prompt: final,
    override_text: final,
    override_reason: reason,
    approved_by: admin.email,
  });
  if (!stored) return fail(409, 'The prompt for this event changed just now. Look again, then approve.');
  await audit(db, eventId, { type: 'staff', id: admin.email }, 'social_prompt.overridden', { version: row.version, fingerprint: event.fp, reason }, iso).run();
  return { ok: true, version: row.version };
}
