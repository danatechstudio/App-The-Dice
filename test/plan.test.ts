import { describe, expect, it } from 'vitest';
import { normaliseRows, type SheetRow } from '../src/sync/normalise';
import { occurrenceIdFor, planSync, type EventRow, type OccurrenceRow, type SyncPlan } from '../src/sync/plan';
import { indexRow } from './helpers';

/** In-memory stand-in for the database, so multi-day scenarios can be replayed. */
class State {
  events = new Map<string, EventRow>();
  occ = new Map<string, OccurrenceRow>();

  run(rows: SheetRow[], today: string, opts: { completeSources?: ('event_index' | 'standard_diary')[] } = {}): SyncPlan {
    const { events, skippedIds } = normaliseRows('event_index', rows);
    const plan = planSync({
      events: events.map(e => ({ ...e, source_hash: JSON.stringify(e) })),
      completeSources: opts.completeSources ?? ['event_index'],
      skippedIds,
      existingEvents: [...this.events.values()],
      existingOccurrences: [...this.occ.values()],
      today,
      now: `${today}T09:00:00.000Z`,
      projectionWeeks: 6,
    });
    for (const { changed: _changed, ...e } of plan.eventUpserts) this.events.set(e.event_id, e);
    for (const id of plan.eventDeactivations) this.events.set(id, { ...this.events.get(id)!, active: 0 });
    for (const o of plan.occurrenceInserts) if (!this.occ.has(o.occurrence_id)) this.occ.set(o.occurrence_id, o);
    for (const o of plan.occurrenceUpdates) this.occ.set(o.occurrence_id, o);
    return plan;
  }

  occurrences(eventId = 'RTD-EVT-00001') {
    return [...this.occ.values()]
      .filter(o => o.event_id === eventId)
      .sort((a, b) => a.event_date.localeCompare(b.event_date))
      .map(o => ({ date: o.event_date, status: o.status, projected: o.projected, to: o.rescheduled_to }));
  }
}

const occ = (date: string) => occurrenceIdFor('RTD-EVT-00001', date);

describe('planSync', () => {
  it('creates a weekly event with its next date confirmed and six weeks projected', () => {
    const s = new State();
    const plan = s.run([indexRow(1, { Frequency: 'Weekly', 'Event Date': '08/10/2026' })], '2026-10-05');
    expect(s.occurrences()).toEqual([
      { date: '2026-10-08', status: 'scheduled', projected: 0, to: null },
      { date: '2026-10-15', status: 'scheduled', projected: 1, to: null },
      { date: '2026-10-22', status: 'scheduled', projected: 1, to: null },
      { date: '2026-10-29', status: 'scheduled', projected: 1, to: null },
      { date: '2026-11-05', status: 'scheduled', projected: 1, to: null },
      { date: '2026-11-12', status: 'scheduled', projected: 1, to: null },
    ]);
    expect(plan.audit.map(a => a.action)).toEqual(['event.created', 'occurrence.created']);
    expect(s.occ.get(occ('2026-10-08'))).toMatchObject({ starts_at: '2026-10-08T17:30:00.000Z', ends_at: '2026-10-08T21:00:00.000Z' });
  });

  it('is a no-op when nothing has changed', () => {
    const s = new State();
    const rows = [indexRow(1, { Frequency: 'Weekly', 'Event Date': '08/10/2026' })];
    s.run(rows, '2026-10-05');
    const again = s.run(rows, '2026-10-05');
    expect(again.eventUpserts.map(e => e.changed)).toEqual([false]);
    expect(again.occurrenceInserts).toEqual([]);
    expect(again.occurrenceUpdates).toEqual([]);
    expect(again.audit).toEqual([]);
    expect(again.eventsChanged).toBe(0);
  });

  it('follows the weekly roll-forward: past date completed, projection confirmed, horizon extended', () => {
    const s = new State();
    s.run([indexRow(1, { Frequency: 'Weekly', 'Event Date': '08/10/2026' })], '2026-10-05');
    const plan = s.run([indexRow(1, { Frequency: 'Weekly', 'Event Date': '15/10/2026' })], '2026-10-09');
    expect(s.occurrences().slice(0, 2)).toEqual([
      { date: '2026-10-08', status: 'completed', projected: 0, to: null },
      { date: '2026-10-15', status: 'scheduled', projected: 0, to: null },
    ]);
    expect(s.occurrences().at(-1)).toEqual({ date: '2026-11-19', status: 'scheduled', projected: 1, to: null });
    expect(plan.audit.map(a => a.action)).toEqual(['occurrence.completed']);
  });

  it('keeps history when a monthly event expires and Michelle supplies the next date', () => {
    const s = new State();
    s.run([indexRow(1, { Frequency: 'Monthly', 'Event Date': '09/10/2026' })], '2026-10-05');
    // 10 Oct 01:15: Event Guard sets the passed monthly event Inactive; the date stays.
    const expired = s.run([indexRow(1, { Frequency: 'Monthly', 'Event Date': '09/10/2026', Status: 'Inactive' })], '2026-10-10');
    expect(expired.audit.map(a => a.action)).toEqual(['event.deactivated', 'occurrence.completed']);
    // Michelle picks 13 Nov in the date-change email: same row, new date, Active again.
    const redated = s.run([indexRow(1, { Frequency: 'Monthly', 'Event Date': '13/11/2026' })], '2026-10-11');
    expect(redated.audit.map(a => a.action)).toEqual(['event.activated', 'occurrence.created']);
    expect(s.occurrences()).toEqual([
      { date: '2026-10-09', status: 'completed', projected: 0, to: null },
      { date: '2026-11-13', status: 'scheduled', projected: 0, to: null },
    ]);
  });

  it('marks a future occurrence rescheduled when the date moves, and reinstates it if moved back', () => {
    const s = new State();
    s.run([indexRow(1, { 'Event Date': '23/10/2026' })], '2026-10-05');
    const moved = s.run([indexRow(1, { 'Event Date': '30/10/2026' })], '2026-10-06');
    expect(moved.audit.map(a => a.action)).toEqual(['occurrence.created', 'occurrence.rescheduled']);
    expect(s.occurrences()).toEqual([
      { date: '2026-10-23', status: 'rescheduled', projected: 0, to: occ('2026-10-30') },
      { date: '2026-10-30', status: 'scheduled', projected: 0, to: null },
    ]);
    s.run([indexRow(1, { 'Event Date': '23/10/2026' })], '2026-10-07');
    expect(s.occurrences()).toEqual([
      { date: '2026-10-23', status: 'scheduled', projected: 0, to: null },
      { date: '2026-10-30', status: 'rescheduled', projected: 0, to: occ('2026-10-23') },
    ]);
  });

  it('records a start-time change on the occurrence', () => {
    const s = new State();
    s.run([indexRow(1)], '2026-10-05');
    const plan = s.run([indexRow(1, { 'Event Time': '19:00' })], '2026-10-06');
    expect(plan.audit).toMatchObject([
      { action: 'occurrence.time_changed', previous_value: JSON.stringify({ start_time: '18:30', end_time: '22:00', all_day: 0 }) },
    ]);
    expect(s.occ.get(occ('2026-10-23'))).toMatchObject({ start_time: '19:00', starts_at: '2026-10-23T18:00:00.000Z' });
  });

  it('never creates occurrences for inactive events or past dates', () => {
    const s = new State();
    s.run([indexRow(1, { Status: 'Inactive' }), indexRow(2, { 'Event Date': '01/10/2026' })], '2026-10-05');
    expect(s.occ.size).toBe(0);
  });

  it('deactivates an event that vanished from a complete source, leaving other sources alone', () => {
    const s = new State();
    s.run([indexRow(1), indexRow(2)], '2026-10-05');
    const plan = s.run([indexRow(2)], '2026-10-06');
    expect(plan.eventDeactivations).toEqual(['RTD-EVT-00001']);
    expect(plan.audit.map(a => a.action)).toEqual(['event.missing_from_source']);
    expect(s.occurrences()).toEqual([{ date: '2026-10-23', status: 'rescheduled', projected: 0, to: null }]);

    const t = new State();
    t.run([indexRow(1), indexRow(2)], '2026-10-05');
    expect(t.run([indexRow(2)], '2026-10-06', { completeSources: ['standard_diary'] }).eventDeactivations).toEqual([]);
  });

  it('does not deactivate an event whose id was skipped as a duplicate', () => {
    const s = new State();
    s.run([indexRow(1), indexRow(2)], '2026-10-05');
    const plan = s.run([indexRow(1), indexRow(2), indexRow(3, { 'Event ID': 'RTD-EVT-00001' })], '2026-10-06');
    expect(plan.eventDeactivations).toEqual([]);
  });

  it('leaves staff cancellations alone even when the sheet still holds the date', () => {
    const s = new State();
    s.run([indexRow(1)], '2026-10-05');
    s.occ.set(occ('2026-10-23'), { ...s.occ.get(occ('2026-10-23'))!, status: 'cancelled' });
    const plan = s.run([indexRow(1, { 'Event Time': '19:00' })], '2026-10-06');
    expect(plan.occurrenceUpdates).toEqual([]);
    expect(s.occurrences()).toEqual([{ date: '2026-10-23', status: 'cancelled', projected: 0, to: null }]);
  });
});
