// Works out every database change a sync needs, without touching the database.
//
// The Logic Engine only ever holds an event's *next* date and overwrites it in
// place. This turns that into occurrence history:
//   - the sheet's date becomes an occurrence (id = event + date, so repeat syncs are no-ops);
//   - weekly / fortnightly events also get projected occurrences ahead, flagged `projected`;
//   - scheduled occurrences whose date has passed become `completed`;
//   - future scheduled occurrences the sheet no longer implies become `rescheduled`
//     (pointing at the new date, or null while a new date is awaited).
// Nothing is ever deleted or moved to a different date.

import { addDays, occurrenceInstants } from '../lib/time';
import type { NormalisedEvent, Source } from './normalise';

export interface EventRow {
  event_id: string;
  source: Source | 'app';
  source_row: number | null;
  event_name: string;
  display_name: string;
  category: string | null;
  description: string | null;
  frequency: string;
  repeatable: number;
  requires_redating: number;
  visibility: string;
  sheet_status: string | null;
  active: number;
  photo_folder_id: string | null;
  price_display: string | null;
  default_capacity: number | null;
  host_session_id: string | null;
  market_id: string | null;
  source_hash: string | null;
}

export interface OccurrenceRow {
  occurrence_id: string;
  event_id: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  starts_at: string | null;
  ends_at: string | null;
  all_day: number;
  projected: number;
  status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled';
  rescheduled_to: string | null;
  completed_at: string | null;
}

export interface AuditRow {
  entity_type: 'event' | 'occurrence';
  entity_id: string;
  occurrence_id: string | null;
  action: string;
  previous_value: string | null;
  new_value: string | null;
}

export interface SyncPlan {
  eventUpserts: (EventRow & { changed: boolean })[];
  /** Events that vanished from a fully-synced source: set inactive, never deleted. */
  eventDeactivations: string[];
  occurrenceInserts: OccurrenceRow[];
  occurrenceUpdates: OccurrenceRow[];
  audit: AuditRow[];
  eventsChanged: number;
}

export interface PlanInput {
  events: (NormalisedEvent & { source_hash: string })[];
  /** Sources fully present in this payload: their events missing from it are deactivated. */
  completeSources: Source[];
  /** Ids skipped as ambiguous (duplicates): never treated as missing. */
  skippedIds: string[];
  existingEvents: EventRow[];
  existingOccurrences: OccurrenceRow[];
  today: string;
  /** ISO instant of this sync, used for completed_at. */
  now: string;
  projectionWeeks: number;
}

export function occurrenceIdFor(eventId: string, date: string): string {
  return `RTD-OCC-${eventId.replace(/^RTD-EVT-/, '')}-${date.replace(/-/g, '')}`;
}

const EVENT_FIELDS = [
  'event_name', 'display_name', 'category', 'description', 'frequency', 'repeatable',
  'requires_redating', 'visibility', 'sheet_status', 'active', 'photo_folder_id', 'source_row',
  'price_display', 'default_capacity', 'host_session_id', 'market_id',
] as const;

function cadenceDays(e: NormalisedEvent): number | null {
  if (e.frequency === 'weekly') return 7;
  if (e.frequency === 'fortnightly') return 14;
  // Standard Diary monthly groups are rolled forward 28 days by RTD Master V1, so
  // projecting at that cadence matches the sheet. Event Index monthly dates vary.
  if (e.frequency === 'monthly' && e.source === 'standard_diary') return 28;
  return null;
}

function toEventRow(e: NormalisedEvent & { source_hash: string }): EventRow {
  return {
    event_id: e.event_id,
    source: e.source,
    source_row: e.source_row,
    event_name: e.event_name,
    display_name: e.display_name,
    category: e.category,
    description: e.description,
    frequency: e.frequency,
    repeatable: e.repeatable ? 1 : 0,
    requires_redating: e.requires_redating ? 1 : 0,
    visibility: e.visibility,
    sheet_status: e.sheet_status,
    active: e.active ? 1 : 0,
    photo_folder_id: e.photo_folder_id,
    price_display: e.price_display,
    default_capacity: e.default_capacity,
    host_session_id: e.host_session_id,
    market_id: e.market_id,
    source_hash: e.source_hash,
  };
}

const pick = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.map(k => [k, o[k] ?? null]));

export function planSync(input: PlanInput): SyncPlan {
  const { today, now } = input;
  const plan: SyncPlan = { eventUpserts: [], eventDeactivations: [], occurrenceInserts: [], occurrenceUpdates: [], audit: [], eventsChanged: 0 };
  const existingById = new Map(input.existingEvents.map(e => [e.event_id, e]));
  const occsByEvent = new Map<string, OccurrenceRow[]>();
  for (const o of input.existingOccurrences) {
    const list = occsByEvent.get(o.event_id) ?? [];
    list.push(o);
    occsByEvent.set(o.event_id, list);
  }

  const updateOcc = (o: OccurrenceRow) => plan.occurrenceUpdates.push(o);

  for (const e of input.events) {
    // --- event row ---
    const row = toEventRow(e);
    const before = existingById.get(e.event_id);
    const changed = !before || before.source_hash !== row.source_hash;
    plan.eventUpserts.push({ ...row, changed });
    if (!before) {
      plan.eventsChanged++;
      plan.audit.push({
        entity_type: 'event', entity_id: e.event_id, occurrence_id: null, action: 'event.created',
        previous_value: null, new_value: JSON.stringify(pick(row as unknown as Record<string, unknown>, EVENT_FIELDS)),
      });
    } else if (changed) {
      const diffKeys = EVENT_FIELDS.filter(k => (before[k] ?? null) !== (row[k] ?? null));
      if (diffKeys.length) {
        plan.eventsChanged++;
        plan.audit.push({
          entity_type: 'event', entity_id: e.event_id, occurrence_id: null,
          action: before.active && !row.active ? 'event.deactivated' : !before.active && row.active ? 'event.activated' : 'event.updated',
          previous_value: JSON.stringify(pick(before as unknown as Record<string, unknown>, diffKeys)),
          new_value: JSON.stringify(pick(row as unknown as Record<string, unknown>, diffKeys)),
        });
      }
    }

    // --- occurrences the sheet currently implies ---
    const expected = new Map<string, { projected: boolean }>();
    const next = e.next;
    if (e.active && next) {
      expected.set(next.date, { projected: false });
      const cadence = cadenceDays(e);
      if (cadence) {
        const horizon = addDays(today, input.projectionWeeks * 7);
        for (let d = addDays(next.date, cadence); d <= horizon; d = addDays(d, cadence)) {
          expected.set(d, { projected: true });
        }
      }
    }
    const targetId = next && e.active && next.date >= today ? occurrenceIdFor(e.event_id, next.date) : null;
    const existing = occsByEvent.get(e.event_id) ?? [];
    const existingByDate = new Map(existing.map(o => [o.event_date, o]));

    for (const [date, spec] of expected) {
      if (date < today || !next) continue; // never create occurrences in the past
      const times = { start_time: next.start_time, end_time: next.end_time, all_day: next.all_day ? 1 : 0 };
      const { startsAt, endsAt } = occurrenceInstants(date, next.start_time, next.end_time);
      const id = occurrenceIdFor(e.event_id, date);
      const ex = existingByDate.get(date);
      if (!ex) {
        plan.occurrenceInserts.push({
          occurrence_id: id, event_id: e.event_id, event_date: date, ...times, starts_at: startsAt, ends_at: endsAt,
          projected: spec.projected ? 1 : 0, status: 'scheduled', rescheduled_to: null, completed_at: null,
        });
        if (!spec.projected) {
          plan.audit.push({
            entity_type: 'occurrence', entity_id: e.event_id, occurrence_id: id, action: 'occurrence.created',
            previous_value: null, new_value: JSON.stringify({ event_date: date, ...times }),
          });
        }
        continue;
      }
      if (ex.status === 'cancelled' || ex.status === 'completed') continue; // staff decisions and history stick
      const upd: OccurrenceRow = { ...ex };
      let dirty = false;
      if (ex.status === 'rescheduled') {
        upd.status = 'scheduled';
        upd.rescheduled_to = null;
        dirty = true;
        if (!spec.projected) {
          plan.audit.push({
            entity_type: 'occurrence', entity_id: e.event_id, occurrence_id: id, action: 'occurrence.reinstated',
            previous_value: JSON.stringify({ status: ex.status }), new_value: JSON.stringify({ status: 'scheduled' }),
          });
        }
      }
      if (ex.start_time !== times.start_time || ex.end_time !== times.end_time || ex.all_day !== times.all_day) {
        if (!spec.projected) {
          plan.audit.push({
            entity_type: 'occurrence', entity_id: e.event_id, occurrence_id: id, action: 'occurrence.time_changed',
            previous_value: JSON.stringify({ start_time: ex.start_time, end_time: ex.end_time, all_day: ex.all_day }),
            new_value: JSON.stringify(times),
          });
        }
        Object.assign(upd, times, { starts_at: startsAt, ends_at: endsAt });
        dirty = true;
      }
      if (ex.projected && !spec.projected) {
        upd.projected = 0; // the sheet has reached this date
        dirty = true;
      }
      if (dirty) updateOcc(upd);
    }

    // --- scheduled occurrences the sheet no longer implies ---
    for (const ex of existing) {
      if (ex.status !== 'scheduled') continue;
      if (ex.event_date < today) {
        updateOcc({ ...ex, status: 'completed', completed_at: now });
        if (!ex.projected) {
          plan.audit.push({
            entity_type: 'occurrence', entity_id: e.event_id, occurrence_id: ex.occurrence_id, action: 'occurrence.completed',
            previous_value: JSON.stringify({ status: 'scheduled' }), new_value: JSON.stringify({ status: 'completed' }),
          });
        }
      } else if (!expected.has(ex.event_date)) {
        updateOcc({ ...ex, status: 'rescheduled', rescheduled_to: targetId });
        if (!ex.projected) {
          plan.audit.push({
            entity_type: 'occurrence', entity_id: e.event_id, occurrence_id: ex.occurrence_id, action: 'occurrence.rescheduled',
            previous_value: JSON.stringify({ status: 'scheduled', event_date: ex.event_date }),
            new_value: JSON.stringify({ status: 'rescheduled', rescheduled_to: targetId }),
          });
        }
      }
    }
  }

  // --- events that disappeared from a fully-synced source ---
  const seen = new Set([...input.events.map(e => e.event_id), ...input.skippedIds]);
  for (const ex of input.existingEvents) {
    if (seen.has(ex.event_id) || ex.source === 'app' || !input.completeSources.includes(ex.source)) continue;
    if (ex.active) {
      plan.eventDeactivations.push(ex.event_id);
      plan.eventsChanged++;
      plan.audit.push({
        entity_type: 'event', entity_id: ex.event_id, occurrence_id: null, action: 'event.missing_from_source',
        previous_value: JSON.stringify({ active: 1 }), new_value: JSON.stringify({ active: 0 }),
      });
    }
    for (const o of occsByEvent.get(ex.event_id) ?? []) {
      if (o.status !== 'scheduled') continue;
      updateOcc(o.event_date < today
        ? { ...o, status: 'completed', completed_at: now }
        : { ...o, status: 'rescheduled', rescheduled_to: null });
    }
  }

  return plan;
}
