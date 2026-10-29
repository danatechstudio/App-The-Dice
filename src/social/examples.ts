// Example posts beside each social prompt (.superpowers/sdd/2026-10-23-example-posts/brief.md). For each
// event that can have a prompt now, its newest version (approved, or waiting for review) gets one sample
// Facebook post, so admins can see what the prompt writes before (or after) they approve it. n8n asks
// which versions want one, has Gemini write it the way the live posting flow would (the layer, then
// Michelle's Standard Prompt from the sheet, then the date block of the next real date) and sends it
// back here. The app runs it through the same check a live event post gets and keeps the verdict.
//
// An example never changes the version's status, never posts, is never written to the sheet, records
// no social_checks row and doesn't mark the version as used. Its columns come with migration 0025;
// before that is applied, these functions throw an error that isMissingExampleColumns recognises.

import { londonDate } from '../lib/time';
import { checkExample, dateBlock, layerBlock, nextOccurrence, occurrenceLabel } from './check';
import { fingerprint, sourceFields } from './facts';
import { ELIGIBLE, errorText, EVENT_FIELDS, type Fail } from './prompts';

/** Answers (examples and failures) for one version before n8n stops asking. */
export const MAX_EXAMPLE_ATTEMPTS = 3;
/** Longest example accepted, once trimmed. */
export const EXAMPLE_TEXT_MAX = 5000;
const ID_MAX = 100;

/** For n8n to use in place of Michelle's Standard Prompt when the event's row has none. */
export const FALLBACK_PROMPT = 'Write one friendly Facebook post for Roll The Dice Café about this event, using only the details above.';

/** The event's newest version that isn't a waiting regenerate request (`p`). */
const NEWEST = "p.version = (SELECT MAX(q.version) FROM social_prompts q WHERE q.event_id = p.event_id AND q.status <> 'pending')";
/** A version that wants an example: its event's newest, approved or waiting for review, with text, and none yet (under three answers). */
const WANTS_EXAMPLE = `p.status IN ('approved', 'review_required') AND ${NEWEST}
  AND TRIM(COALESCE(p.master_prompt, '')) <> '' AND p.example_post IS NULL AND p.example_attempts < ${MAX_EXAMPLE_ATTEMPTS}`;

// Updates only while the version is still the event's newest, approved or waiting for review (?1 event, ?2 version).
const STILL = `event_id = ?1 AND version = ?2 AND status IN ('approved', 'review_required')
  AND version = (SELECT MAX(version) FROM social_prompts WHERE event_id = ?1 AND status <> 'pending')`;

/** A version (`p`) whose example would be held: there is one, and its verdict isn't a pass (one that won't read is held, as the screens show it). */
export const EXAMPLE_HELD = (p = 'p') =>
  `${p}.example_post IS NOT NULL AND NOT (COALESCE(json_valid(${p}.example_check), 0) AND json_extract(${p}.example_check, '$.passed') = 1)`;

/** Whether an error is D1 saying the example columns aren't there: migration 0025 isn't applied yet. */
export const isMissingExampleColumns = (e: unknown): boolean => /no such column:?\s*\S*example_/i.test(e instanceof Error ? e.message : String(e));

const fail = (status: Fail['status'], error: string): Fail => ({ ok: false, status, error });

export interface ExampleRequest {
  event_id: string;
  version: number;
  /** The date the example is about (the event's next date the public can see). */
  occurrence_id: string;
  /** What the live flow puts before today's caption prompt (layerBlock). */
  layer: string;
  /** What it puts after it (dateBlock). */
  date_block: string;
  /** For when the event's row has no Michelle's Standard Prompt. */
  fallback_prompt: string;
}

/**
 * The versions that want an example, soonest date first, up to `limit`: for each event that can have a
 * prompt now (ELIGIBLE, as the builder's list), its newest version when that is approved or waiting
 * for review, has text, has no example yet and has had fewer than three answers. An event with no date
 * the public can see (only a projected one) is left out: there is no date to write about.
 */
export async function examplesDue(db: D1Database, now: Date, limit: number): Promise<ExampleRequest[]> {
  const { results: events } = await db.prepare(`${ELIGIBLE} ORDER BY next_date, event_id LIMIT 500`).bind(londonDate(now)).all<Record<string, unknown>>();
  if (!events.length) return [];
  const { results: versions } = await db
    .prepare(`SELECT p.event_id, p.version, p.master_prompt FROM social_prompts p WHERE p.event_id IN (SELECT value FROM json_each(?1)) AND ${WANTS_EXAMPLE}`)
    .bind(JSON.stringify(events.map(e => String(e.event_id))))
    .all<{ event_id: string; version: number; master_prompt: string }>();
  const byEvent = new Map(versions.map(v => [v.event_id, v]));

  const out: ExampleRequest[] = [];
  for (const row of events) {
    if (out.length >= limit) break;
    const fields = sourceFields(row);
    const version = byEvent.get(fields.event_id);
    if (!version) continue;
    const occ = await nextOccurrence(db, fields.event_id, now);
    if (!occ) continue;
    out.push({
      event_id: fields.event_id,
      version: version.version,
      occurrence_id: occ.occurrence_id,
      layer: layerBlock(version.master_prompt, fields.approved_facts, fields.people_roles),
      date_block: dateBlock(occurrenceLabel(occ.event_date, occ.start_time || null)),
      fallback_prompt: FALLBACK_PROMPT,
    });
  }
  return out;
}

export type ExampleResult = { ok: true; passed: boolean; problems: string[] } | { ok: true };

/**
 * n8n's answer for a version. Body: { version, job_id?, model?, text } with the example, or
 * { version, job_id?, error } when Gemini couldn't write one. A text is checked as a live Facebook
 * event post about the event's next date and stored with the verdict; an error is noted. Either
 * counts as an answer. 409 when the version is no longer the event's newest (nothing is stored).
 */
export async function storeExample(db: D1Database, eventId: string, body: unknown, now: Date): Promise<ExampleResult | Fail> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.version !== 'number' || !Number.isInteger(b.version) || b.version < 1) return fail(400, 'version is required (from /examples-due)');
  const version = b.version;
  let text: string | null = null;
  let error: string | null = null;
  if (b.text !== undefined) {
    if (typeof b.text !== 'string' || !b.text.trim()) return fail(400, 'text must be the example post');
    text = b.text.trim();
    if (text.length > EXAMPLE_TEXT_MAX) return fail(400, `text is over ${EXAMPLE_TEXT_MAX} characters`);
  } else {
    error = errorText(b.error);
    if (!error) return fail(400, 'text (the example post) or error (why there is none) is required');
  }
  const shortText = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, ID_MAX) : null);
  const jobId = shortText(b.job_id);

  const event = await db.prepare(`SELECT ${EVENT_FIELDS} FROM events e WHERE e.event_id = ?1`).bind(eventId).first<Record<string, unknown>>();
  if (!event) return fail(404, 'No event with that ID');
  const row = await db
    .prepare(
      `SELECT p.status, p.source_fingerprint, CASE WHEN ${NEWEST} THEN 1 ELSE 0 END AS newest
       FROM social_prompts p WHERE p.event_id = ?1 AND p.version = ?2 AND p.status <> 'pending'`,
    )
    .bind(eventId, version)
    .first<{ status: string; source_fingerprint: string; newest: number }>();
  if (!row) return fail(404, 'No version with that number for that event');
  const STALE = fail(409, "Stale: that version isn't the event's newest prompt any more. Drop it; the newer one is listed instead.");
  if (row.newest !== 1 || !['approved', 'review_required'].includes(row.status)) return STALE;

  // Stored only while the version is still the event's newest, so an answer racing a new version stores nothing.
  if (error !== null) {
    const res = await db
      .prepare(`UPDATE social_prompts SET example_attempts = example_attempts + 1, example_error = ?3, example_job_id = COALESCE(?4, example_job_id) WHERE ${STILL}`)
      .bind(eventId, version, error, jobId)
      .run();
    return res.meta.changes > 0 ? { ok: true } : STALE;
  }

  const problems = await exampleProblems(db, event, version, row.source_fingerprint, text!, now);
  const passed = problems.length === 0;
  const res = await db
    .prepare(
      `UPDATE social_prompts SET example_post = ?3, example_check = ?4, example_model = ?5, example_job_id = ?6, example_generated_at = ?7,
         example_attempts = example_attempts + 1, example_error = NULL
       WHERE ${STILL}`,
    )
    .bind(eventId, version, text, JSON.stringify({ passed, problems }), shortText(b.model), jobId, now.toISOString())
    .run();
  return res.meta.changes > 0 ? { ok: true, passed, problems } : STALE;
}

/**
 * The problems a live Facebook post about the event's next date would get for this example: the post check (checkExample), and
 * whether the version was made from the event's facts as they are now. The check doesn't look at the prompt (it may still need
 * review). storeExample and recheckExample both use it, so a re-check is the same check as the first one.
 */
async function exampleProblems(db: D1Database, event: Record<string, unknown>, version: number, sourceFingerprint: string, text: string, now: Date): Promise<string[]> {
  const fields = sourceFields(event);
  const problems = await checkExample(db, fields.event_id, version, text, now);
  if (sourceFingerprint !== (await fingerprint(fields)))
    problems.unshift(`${fields.name || fields.event_id}: prompt out of date (the facts changed since version ${version} was made)`);
  return problems;
}

/**
 * Runs the current post check on a version's stored example, without Gemini, and keeps the new verdict: the same check as
 * storeExample (the event's next date, its facts now), with no social_checks row and nothing else about the example changed.
 * 404 when there is no such version or it has no example; 409 when it isn't the event's newest any more.
 */
export async function recheckExample(db: D1Database, eventId: string, version: number, now: Date): Promise<{ ok: true; passed: boolean; problems: string[] } | Fail> {
  const event = await db.prepare(`SELECT ${EVENT_FIELDS} FROM events e WHERE e.event_id = ?1`).bind(eventId).first<Record<string, unknown>>();
  if (!event) return fail(404, 'No event with that ID');
  const row = await db
    .prepare(
      `SELECT p.status, p.source_fingerprint, p.example_post, CASE WHEN ${NEWEST} THEN 1 ELSE 0 END AS newest
       FROM social_prompts p WHERE p.event_id = ?1 AND p.version = ?2 AND p.status <> 'pending'`,
    )
    .bind(eventId, version)
    .first<{ status: string; source_fingerprint: string; example_post: string | null; newest: number }>();
  if (!row) return fail(404, 'No version with that number for that event');
  if (row.newest !== 1 || !['approved', 'review_required'].includes(row.status)) return fail(409, "That version isn't the event's newest prompt any more.");
  if (row.example_post === null) return fail(404, 'That version has no example post to re-check');
  const problems = await exampleProblems(db, event, version, row.source_fingerprint, row.example_post, now);
  const passed = problems.length === 0;
  // Only over the same example: one written meanwhile keeps its own verdict.
  await db
    .prepare(`UPDATE social_prompts SET example_check = ?3 WHERE ${STILL} AND example_post = ?4`)
    .bind(eventId, version, JSON.stringify({ passed, problems }), row.example_post)
    .run();
  return { ok: true, passed, problems };
}

/**
 * Fix for a version whose example would be held: re-check it first ('passes' when it does now); when it still fails, clear
 * the example (no post or verdict, no answers yet) so /examples-due lists the version again ('rewriting'). The caller wakes
 * the prompt builder. The prompt itself is never changed.
 */
export async function fixExample(db: D1Database, eventId: string, version: number, now: Date): Promise<{ ok: true; example: 'passes' | 'rewriting' } | Fail> {
  const re = await recheckExample(db, eventId, version, now);
  if (!re.ok) return re;
  if (re.passed) return { ok: true, example: 'passes' };
  await db
    .prepare(
      `UPDATE social_prompts SET example_post = NULL, example_check = NULL, example_model = NULL, example_job_id = NULL, example_generated_at = NULL,
         example_attempts = 0, example_error = NULL
       WHERE ${STILL}`,
    )
    .bind(eventId, version)
    .run();
  return { ok: true, example: 'rewriting' };
}
