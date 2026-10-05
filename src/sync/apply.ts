// Applies a Logic Engine snapshot posted by n8n. Reads current state, plans the
// changes in memory (plan.ts), then writes everything in one atomic D1 batch so
// a sync either lands completely or not at all. Uses a fixed, small number of
// queries regardless of sheet size (D1 caps queries per Worker invocation).

import { londonDate } from '../lib/time';
import { normaliseRows, type NormalisedEvent, type SheetRow, type Source, type SyncWarning } from './normalise';
import { planSync, type EventRow, type OccurrenceRow } from './plan';

export interface SyncPayload {
  run_id: string;
  sources: Partial<Record<Source, SheetRow[]>>;
}

export interface SyncResult {
  run_id: string;
  status: 'ok' | 'rejected' | 'duplicate';
  reason: string | null;
  rows_received: number;
  events_seen: number;
  events_changed: number;
  occurrences_created: number;
  occurrences_updated: number;
  warnings: SyncWarning[];
}

const SOURCES: Source[] = ['event_index', 'standard_diary'];
const MAX_ROWS_PER_SOURCE = 2000;

/** Returns the payload, or a message describing why it is invalid. */
export function parsePayload(body: unknown): SyncPayload | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (typeof b.run_id !== 'string' || !/^[A-Za-z0-9:_.-]{1,100}$/.test(b.run_id)) {
    return 'run_id must be 1-100 characters of letters, digits, colon, underscore, dot or hyphen';
  }
  if (!b.sources || typeof b.sources !== 'object') return 'sources must be an object';
  const src = b.sources as Record<string, unknown>;
  const sources: SyncPayload['sources'] = {};
  for (const key of Object.keys(src)) {
    if (!SOURCES.includes(key as Source)) return `Unknown source '${key}'`;
    const rows = src[key];
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
      return `sources.${key} must be an array of row objects`;
    }
    if (rows.length > MAX_ROWS_PER_SOURCE) return `sources.${key} has more than ${MAX_ROWS_PER_SOURCE} rows`;
    sources[key as Source] = rows as SheetRow[];
  }
  if (Object.keys(sources).length === 0) return 'At least one source is required';
  return { run_id: b.run_id, sources };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const j = (field: string) => `json_extract(value, '$.${field}')`;

export async function applySync(db: D1Database, payload: SyncPayload, nowDate = new Date()): Promise<SyncResult> {
  const now = nowDate.toISOString();
  const today = londonDate(nowDate);

  const prior = await db
    .prepare('SELECT * FROM sync_runs WHERE run_id = ?1')
    .bind(payload.run_id)
    .first<Omit<SyncResult, 'warnings'> & { warnings: string | null }>();
  if (prior) {
    return { ...prior, status: 'duplicate', warnings: prior.warnings ? JSON.parse(prior.warnings) : [] };
  }

  // --- normalise ---
  const warnings: SyncWarning[] = [];
  let events: NormalisedEvent[] = [];
  const skippedIds: string[] = [];
  let rowsReceived = 0;
  const present = SOURCES.filter(s => payload.sources[s]);
  for (const source of present) {
    const rows = payload.sources[source] ?? [];
    rowsReceived += rows.length;
    const r = normaliseRows(source, rows);
    events.push(...r.events);
    warnings.push(...r.warnings);
    skippedIds.push(...r.skippedIds);
  }
  // The same id on both tabs is as ambiguous as a duplicate within one.
  const sourcesById = new Map<string, Set<Source>>();
  for (const e of events) sourcesById.set(e.event_id, (sourcesById.get(e.event_id) ?? new Set()).add(e.source));
  const crossDupes = new Set([...sourcesById].filter(([, s]) => s.size > 1).map(([id]) => id));
  if (crossDupes.size) {
    for (const e of events.filter(ev => crossDupes.has(ev.event_id))) {
      warnings.push({ code: 'duplicate_event_id', source: e.source, row: e.source_row, event_name: e.event_name, detail: `${e.event_id} is used on both tabs` });
    }
    events = events.filter(e => !crossDupes.has(e.event_id));
    skippedIds.push(...crossDupes);
  }

  const base = {
    run_id: payload.run_id,
    rows_received: rowsReceived,
    events_seen: events.length,
    events_changed: 0,
    occurrences_created: 0,
    occurrences_updated: 0,
    warnings,
  };

  // --- circuit breaker: a broken read must never deactivate the diary ---
  const last = await db
    .prepare("SELECT events_seen FROM sync_runs WHERE status = 'ok' ORDER BY received_at DESC LIMIT 1")
    .first<{ events_seen: number }>();
  let rejection: string | null = null;
  if (events.length === 0) rejection = 'No usable rows in the payload';
  else if (last && last.events_seen >= 6 && events.length < last.events_seen / 2) {
    rejection = `Event count fell from ${last.events_seen} to ${events.length}; refusing to apply (check the sheet read)`;
  }
  if (rejection) {
    await db
      .prepare(
        `INSERT INTO sync_runs (run_id, source, status, reason, rows_received, events_seen, warnings, received_at)
         VALUES (?1, 'logic_engine', 'rejected', ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(payload.run_id, rejection, rowsReceived, events.length, JSON.stringify(warnings), now)
      .run();
    return { ...base, status: 'rejected', reason: rejection };
  }

  // --- current state ---
  const [eventRes, occRes, settingRes] = await db.batch([
    db.prepare(
      `SELECT event_id, source, source_row, event_name, display_name, category, description, frequency, repeatable,
              requires_redating, visibility, sheet_status, active, photo_folder_id, source_hash FROM events`,
    ),
    db
      .prepare(
        `SELECT occurrence_id, event_id, event_date, start_time, end_time, starts_at, ends_at, all_day, projected,
                status, rescheduled_to, completed_at
         FROM occurrences WHERE status = 'scheduled' OR event_date >= ?1`,
      )
      .bind(today),
    db.prepare("SELECT value FROM settings WHERE key = 'projection_weeks'"),
  ]);
  const projectionWeeks = Number((settingRes?.results[0] as { value?: string } | undefined)?.value ?? 6) || 6;

  const hashed = await Promise.all(
    events.map(async e => ({ ...e, source_hash: await sha256Hex(JSON.stringify(e)) })),
  );
  const plan = planSync({
    events: hashed,
    completeSources: present,
    skippedIds,
    existingEvents: (eventRes?.results ?? []) as unknown as EventRow[],
    existingOccurrences: (occRes?.results ?? []) as unknown as OccurrenceRow[],
    today,
    now,
    projectionWeeks,
  });

  // --- write everything atomically ---
  const writes: D1PreparedStatement[] = [];
  if (plan.eventUpserts.length) {
    writes.push(
      db
        .prepare(
          `INSERT INTO events (event_id, source, source_row, event_name, display_name, category, description, frequency,
             repeatable, requires_redating, visibility, sheet_status, active, photo_folder_id, source_hash,
             last_synced_at, created_at, updated_at)
           SELECT ${['event_id', 'source', 'source_row', 'event_name', 'display_name', 'category', 'description', 'frequency',
             'repeatable', 'requires_redating', 'visibility', 'sheet_status', 'active', 'photo_folder_id', 'source_hash'].map(j).join(', ')},
             ?2, ?2, ?2
           FROM json_each(?1) WHERE true
           ON CONFLICT (event_id) DO UPDATE SET
             source = excluded.source, source_row = excluded.source_row, event_name = excluded.event_name,
             display_name = excluded.display_name, category = excluded.category, description = excluded.description,
             frequency = excluded.frequency, repeatable = excluded.repeatable, requires_redating = excluded.requires_redating,
             visibility = excluded.visibility, sheet_status = excluded.sheet_status, active = excluded.active,
             photo_folder_id = excluded.photo_folder_id,
             updated_at = CASE WHEN events.source_hash IS excluded.source_hash THEN events.updated_at ELSE excluded.updated_at END,
             source_hash = excluded.source_hash, last_synced_at = excluded.last_synced_at`,
        )
        .bind(JSON.stringify(plan.eventUpserts), now),
    );
  }
  if (plan.eventDeactivations.length) {
    writes.push(
      db
        .prepare('UPDATE events SET active = 0, updated_at = ?2 WHERE event_id IN (SELECT value FROM json_each(?1))')
        .bind(JSON.stringify(plan.eventDeactivations), now),
    );
  }
  if (plan.occurrenceInserts.length) {
    writes.push(
      db
        .prepare(
          `INSERT INTO occurrences (occurrence_id, event_id, event_date, start_time, end_time, starts_at, ends_at, all_day,
             projected, status, created_at, updated_at)
           SELECT ${['occurrence_id', 'event_id', 'event_date', 'start_time', 'end_time', 'starts_at', 'ends_at', 'all_day',
             'projected', 'status'].map(j).join(', ')}, ?2, ?2
           FROM json_each(?1) WHERE true
           ON CONFLICT DO NOTHING`,
        )
        .bind(JSON.stringify(plan.occurrenceInserts), now),
    );
  }
  if (plan.occurrenceUpdates.length) {
    writes.push(
      db
        .prepare(
          `UPDATE occurrences SET
             status = u.status, rescheduled_to = u.rescheduled_to, start_time = u.start_time, end_time = u.end_time,
             starts_at = u.starts_at, ends_at = u.ends_at, all_day = u.all_day, projected = u.projected,
             completed_at = u.completed_at, updated_at = ?2
           FROM (SELECT ${['occurrence_id', 'status', 'rescheduled_to', 'start_time', 'end_time', 'starts_at', 'ends_at',
             'all_day', 'projected', 'completed_at'].map(f => `${j(f)} AS ${f}`).join(', ')} FROM json_each(?1)) AS u
           WHERE occurrences.occurrence_id = u.occurrence_id`,
        )
        .bind(JSON.stringify(plan.occurrenceUpdates), now),
    );
  }
  if (plan.audit.length) {
    writes.push(
      db
        .prepare(
          `INSERT INTO audit_log (entity_type, entity_id, occurrence_id, actor_type, actor_id, action, previous_value,
             new_value, source, created_at)
           SELECT ${j('entity_type')}, ${j('entity_id')}, ${j('occurrence_id')}, 'n8n', ?2, ${j('action')},
             ${j('previous_value')}, ${j('new_value')}, 'logic_engine_sync', ?3
           FROM json_each(?1)`,
        )
        .bind(JSON.stringify(plan.audit), payload.run_id, now),
    );
  }
  const result: SyncResult = {
    ...base,
    status: 'ok',
    reason: null,
    events_changed: plan.eventsChanged,
    occurrences_created: plan.occurrenceInserts.length,
    occurrences_updated: plan.occurrenceUpdates.length,
  };
  writes.push(
    db
      .prepare(
        `INSERT INTO sync_runs (run_id, source, status, reason, rows_received, events_seen, events_changed,
           occurrences_created, occurrences_updated, warnings, received_at)
         VALUES (?1, 'logic_engine', 'ok', NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(payload.run_id, rowsReceived, events.length, plan.eventsChanged, result.occurrences_created,
        result.occurrences_updated, JSON.stringify(warnings), now),
  );
  await db.batch(writes);
  return result;
}
