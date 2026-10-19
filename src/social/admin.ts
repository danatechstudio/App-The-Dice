// What the admin screens show about social prompts (spec §5): the switch, the prompts waiting for
// a person, the posts the check held (or, in Shadow, would have held), and one event's facts,
// prompt, versions and recent checks. Reading only: every change goes through the functions in
// src/social/prompts.ts (setSocialMode, requestRegenerate, approveOverride), which check and audit it.

import type { AuthUser } from '../lib/auth';
import { bannedPhrases } from './check';
import { fingerprint, parseFacts, parsePeople, sourceFields, type FactKey, type Person } from './facts';
import { approveOverride, currentPrompt, EVENT_FIELDS, requestRegenerate, setSocialMode, socialMode, type Fail, type Mode, type StoredStatus } from './prompts';

const DENIED: Fail = { ok: false, status: 403, error: 'Only admins can manage social prompts.' };
const denied = (u: AuthUser): Fail | null => (u.role === 'admin' ? null : DENIED);

/** How much of a post's text the lists carry; the full text stays in social_checks. */
const TEXT_SHOWN = 500;
const HELD_SHOWN = 50;
const CHECKS_SHOWN = 10;
const HISTORY_SHOWN = 30;
const REASON_MAX = 500;

const list = (json: string | null): string[] => {
  try {
    const v: unknown = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const shorten = (text: string | null): string | null => (text === null ? null : text.length > TEXT_SHOWN ? `${text.slice(0, TEXT_SHOWN - 1)}…` : text);

/** The event IDs a check was for, from its targets JSON. */
function targetIds(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return [
      ...new Set(v.map(t => (t && typeof t === 'object' ? (t as { event_id?: unknown }).event_id : null)).filter((id): id is string => typeof id === 'string')),
    ];
  } catch {
    return [];
  }
}

// ---- The panel (Organise › Events & dates) ----

export interface ReviewItem {
  event_id: string;
  name: string;
  status: 'review_required' | 'blocked';
  version: number;
  /** Gemini's questions and anything the checks found, in that order. */
  questions: string[];
}

export interface CheckRow {
  check_id: string;
  event_ids: string[];
  /** The events' names, in the same order (the ID when the event has gone). */
  names: string[];
  /** shadow: it would have been held; enforce: it was held. */
  mode: 'shadow' | 'enforce';
  kind: string;
  platform: string | null;
  result: 'pass' | 'fail';
  reasons: string[];
  created_at: string;
  /** The caption, shortened for the screen; null once it has been cleared (after 90 days). */
  text: string | null;
  image_text: string | null;
}

/**
 * The newest version of each event, when it needs a person: review_required or blocked. A waiting
 * regenerate request doesn't count as newer. The hub's count (src/staff/summary.ts) uses this rule.
 */
export const REVIEW_SQL = `SELECT p.* FROM social_prompts p
  WHERE p.status IN ('review_required', 'blocked')
    AND p.version = (SELECT MAX(q.version) FROM social_prompts q WHERE q.event_id = p.event_id AND q.status <> 'pending')`;

interface CheckDbRow {
  check_id: string;
  mode: 'shadow' | 'enforce';
  kind: string;
  platform: string | null;
  targets: string;
  text: string | null;
  image_text: string | null;
  result: 'pass' | 'fail';
  reasons: string | null;
  created_at: string;
}

async function checkRows(db: D1Database, rows: CheckDbRow[]): Promise<CheckRow[]> {
  const ids = [...new Set(rows.flatMap(r => targetIds(r.targets)))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { results } = await db
      .prepare('SELECT event_id, display_name FROM events WHERE event_id IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify(ids))
      .all<{ event_id: string; display_name: string }>();
    for (const r of results) names.set(r.event_id, r.display_name);
  }
  return rows.map(r => {
    const eventIds = targetIds(r.targets);
    return {
      check_id: r.check_id,
      event_ids: eventIds,
      names: eventIds.map(id => names.get(id) || id),
      mode: r.mode,
      kind: r.kind,
      platform: r.platform,
      result: r.result,
      reasons: list(r.reasons),
      created_at: r.created_at,
      text: shorten(r.text),
      image_text: shorten(r.image_text),
    };
  });
}

/** Admins: the switch, the prompts waiting for a person, and the last 50 posts that failed their check. */
export async function socialOverview(db: D1Database, admin: AuthUser): Promise<{ ok: true; mode: Mode; review: ReviewItem[]; held: CheckRow[] } | Fail> {
  const no = denied(admin);
  if (no) return no;
  const [mode, review, held] = await Promise.all([
    socialMode(db),
    db
      .prepare(
        `SELECT r.event_id, r.version, r.status, r.ambiguities, r.validation_errors, COALESCE(e.display_name, r.event_id) AS name
         FROM (${REVIEW_SQL}) r LEFT JOIN events e ON e.event_id = r.event_id
         ORDER BY r.created_at DESC, r.event_id`,
      )
      .all<{
        event_id: string;
        version: number;
        status: 'review_required' | 'blocked';
        ambiguities: string | null;
        validation_errors: string | null;
        name: string;
      }>(),
    db.prepare("SELECT * FROM social_checks WHERE result = 'fail' ORDER BY created_at DESC, check_id DESC LIMIT ?1").bind(HELD_SHOWN).all<CheckDbRow>(),
  ]);
  return {
    ok: true,
    mode,
    review: review.results.map(r => ({
      event_id: r.event_id,
      name: r.name,
      status: r.status,
      version: r.version,
      questions: [...list(r.ambiguities), ...list(r.validation_errors)],
    })),
    held: await checkRows(db, held.results),
  };
}

// ---- One event (the Edit event page) ----

export interface PromptVersion {
  version: number;
  status: StoredStatus;
  master_prompt: string | null;
  approved_by: string | null;
  generated_at: string | null;
  validated_at: string | null;
  approved_at: string | null;
  override_reason: string | null;
  created_at: string;
  /** Whether it was made from the event's facts as they are now. */
  current_facts: boolean;
}

export interface EventSocial {
  ok: true;
  mode: Mode;
  /** Approved Facts, People & Roles and Banned Phrases as the last sync read them, line by line. */
  facts: { key: FactKey; value: string }[];
  people: Person[];
  banned: string[];
  /** Lines of Approved Facts or People & Roles that can't be read. */
  parse_errors: string[];
  /** The event's newest version (a waiting regenerate request aside). */
  prompt: (PromptVersion & { questions: string[]; errors: string[] }) | null;
  /** The approved version posts use now, if any: null when there is none, or its facts are out of date. */
  in_use: number | null;
  /** An admin asked for a new prompt and the builder hasn't answered yet. */
  regenerating: boolean;
  history: PromptVersion[];
  checks: CheckRow[];
}

interface VersionRow extends Omit<PromptVersion, 'current_facts'> {
  source_fingerprint: string;
  ambiguities: string | null;
  validation_errors: string | null;
}

/** Admins: one event's facts, its prompt and versions, and its last 10 checks. */
export async function eventSocial(db: D1Database, admin: AuthUser, eventId: string): Promise<EventSocial | Fail> {
  const no = denied(admin);
  if (no) return no;
  const row = await db.prepare(`SELECT ${EVENT_FIELDS} FROM events e WHERE e.event_id = ?1`).bind(eventId).first<Record<string, unknown>>();
  if (!row) return { ok: false, status: 404, error: 'No event with that ID.' };
  const fields = sourceFields(row);
  const parsedFacts = parseFacts(fields.approved_facts);
  const parsedPeople = parsePeople(fields.people_roles);
  let banned = '';
  try {
    const social: unknown = typeof row.social_values === 'string' ? JSON.parse(row.social_values) : null;
    const cell = social && typeof social === 'object' ? (social as { banned_phrases?: unknown }).banned_phrases : null;
    banned = typeof cell === 'string' ? cell : '';
  } catch {
    // A value that won't read is the same as none.
  }

  const [inUse, versions, checks] = await Promise.all([
    currentPrompt(db, eventId),
    db
      .prepare(
        `SELECT version, status, master_prompt, approved_by, generated_at, validated_at, approved_at, override_reason, created_at,
           source_fingerprint, ambiguities, validation_errors
         FROM social_prompts WHERE event_id = ?1 ORDER BY version DESC LIMIT ?2`,
      )
      .bind(eventId, HISTORY_SHOWN)
      .all<VersionRow>(),
    db
      .prepare(
        `SELECT * FROM social_checks
         WHERE EXISTS (SELECT 1 FROM json_each(social_checks.targets) t WHERE json_extract(t.value, '$.event_id') = ?1)
         ORDER BY created_at DESC, check_id DESC LIMIT ?2`,
      )
      .bind(eventId, CHECKS_SHOWN)
      .all<CheckDbRow>(),
  ]);

  // The facts as they are now, which each version is compared with.
  const currentFp = await fingerprint(fields);
  const version = (v: VersionRow): PromptVersion => ({
    version: v.version,
    status: v.status,
    master_prompt: v.master_prompt,
    approved_by: v.approved_by,
    generated_at: v.generated_at,
    validated_at: v.validated_at,
    approved_at: v.approved_at,
    // "regenerate" marks a version an admin asked for (prompts.ts); it isn't a note anyone wrote.
    override_reason: v.override_reason === 'regenerate' ? null : v.override_reason,
    created_at: v.created_at,
    current_facts: v.source_fingerprint === currentFp,
  });
  const newest = versions.results.find(v => v.status !== 'pending') ?? null;
  const waiting = versions.results.find(v => v.status === 'pending' && v.source_fingerprint === currentFp);

  return {
    ok: true,
    mode: await socialMode(db),
    facts: Object.entries(parsedFacts.facts).flatMap(([key, values]) => (values ?? []).map(value => ({ key: key as FactKey, value }))),
    people: parsedPeople.people,
    banned: bannedPhrases(banned),
    parse_errors: [...parsedFacts.errors.map(e => `Approved Facts: ${e}`), ...parsedPeople.errors.map(e => `People & Roles: ${e}`)],
    prompt: newest ? { ...version(newest), questions: list(newest.ambiguities), errors: list(newest.validation_errors) } : null,
    in_use: inUse?.current ? inUse.version : null,
    regenerating: !!waiting && (!newest || waiting.version > newest.version),
    history: versions.results.filter(v => v.status !== 'pending').map(version),
    checks: await checkRows(db, checks.results),
  };
}

// ---- Changes, through src/social/prompts.ts ----

/** Admins: Off, Shadow or Enforce. */
export const setMode = (db: D1Database, admin: AuthUser, body: unknown, now: Date) =>
  setSocialMode(db, admin, body && typeof body === 'object' ? (body as { mode?: unknown }).mode : undefined, now);

/** Admins: the event is due again on the builder's next run. */
export const regenerate = (db: D1Database, admin: AuthUser, eventId: string, now: Date) => requestRegenerate(db, admin, eventId, now);

/**
 * Admins: approve their own text (or the version waiting for review, when no text is sent) with a
 * note. Body: { text?, reason }. The reason is needed, up to 500 characters. The text is checked as a
 * generated prompt's is; when it fails, 400 with every problem in `errors`.
 */
export async function approve(db: D1Database, admin: AuthUser, eventId: string, body: unknown, now: Date): Promise<{ ok: true; version: number } | Fail> {
  const no = denied(admin);
  if (no) return no;
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (b.text !== undefined && b.text !== null && typeof b.text !== 'string') return { ok: false, status: 400, error: 'The prompt (text) must be text.' };
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) return { ok: false, status: 400, error: 'Say why you are approving it (reason).', errors: ['Say why you are approving it.'] };
  if ([...reason].length > REASON_MAX)
    return { ok: false, status: 400, error: `Keep the reason to ${REASON_MAX} characters.`, errors: [`Keep the reason to ${REASON_MAX} characters.`] };
  return approveOverride(db, admin, eventId, { text: b.text, reason }, now);
}
