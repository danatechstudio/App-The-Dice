// Needs attention (docs/RTD_EVENT_CONTROL_AUDIT.md G-2, Stage 3b): one item per
// situation, settled only by an explicit decision or by the Logic Engine answering it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_NEW, detect, type AttentionItem } from '../src/attention/attention';
import { diaryRow, env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const ADMIN = as('dan@example.com');
const STAFF = as('michelle@example.com');
const HOST = as('sam@example.com');
const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const internal = (path: string, init: RequestInit = {}) =>
  request(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: 'Bearer test-sync-token', 'Content-Type': 'application/json' } });

const at = (iso: string) => vi.setSystemTime(new Date(iso));

type Overview = { enabled: boolean; blocked: number; open: AttentionItem[]; resolved: AttentionItem[]; no_end_time: { name: string }[] };
const overview = async (who = STAFF) => (await request('/api/staff/attention', {}, who)).json<Overview>();
const resolve = (id: number, body: unknown, who = STAFF) => request(`/api/staff/attention/${id}/resolve`, post(body), who);
const fixes = async () => (await (await internal('/internal/sheet-fixes')).json<{ fixes: { event_id: string; key: string; row: Record<string, string> }[] }>()).fixes;
const byName = (list: AttentionItem[], name: string) => list.filter(i => i.name === name);

/** The Logic Engine: Bingo is a monthly one, Kids Club rolls on weekly, D&D and Cleeples have no usable date. */
const rows = (over: Record<number, Record<string, unknown>> = {}) => ({
  event_index: [
    indexRow(1, { 'Event Name': 'Bingo', Frequency: 'Monthly', 'Event Date': '09/10/2026', ...over[1] }),
    indexRow(2, { 'Event Name': 'Kids Club', Frequency: 'Weekly', 'Event Date': '08/10/2026', ...over[2] }),
    indexRow(3, { 'Event Name': 'D&D', 'Event Date': '', ...over[3] }),
    indexRow(4, { 'Event Name': 'Cleeples', Frequency: 'Weekly', 'Event Date': 'Every Thursday', ...over[4] }),
    indexRow(5, { 'Event Name': 'One Shot', 'Event Date': '10/10/2026', 'App Host Session': 'RTD-HS-00001', ...over[5] }),
    indexRow(6, { 'Event Name': 'Food1', 'Event Date': '', 'App Visibility': 'Hidden', ...over[6] }),
  ],
  standard_diary: [diaryRow(7, { Group: 'Brownies', Frequency: 'One Off', Date: '', ...over[7] })],
});
let run = 0;
const resync = (over: Record<number, Record<string, unknown>> = {}) => sync({ run_id: `r${++run}`, sources: rows(over) });

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-10-05T10:00:00Z');
  const t = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(t),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(t),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam', 'host', 1, ?1, ?1)").bind(t),
  ]);
  expect((await resync()).status).toBe(200);
});
afterEach(() => vi.useRealTimers());

describe('switching it on', () => {
  it('is off until an admin switches it on, and only admins can', async () => {
    expect(await overview()).toEqual({ enabled: false });
    expect(await detect(env.DB, new Date())).toEqual({ opened: 0, settled: 0, blocked: 0 });
    expect((await request('/api/staff/attention/switch', post({ on: true }), STAFF)).status).toBe(403);
    expect((await request('/api/staff/attention', {}, HOST)).status).toBe(403);
    expect(await (await request('/api/staff/attention/switch', post({ on: true }), ADMIN)).json()).toEqual({ enabled: true });
    expect((await overview()).enabled).toBe(true);
    const audit = await env.DB.prepare("SELECT actor_id, action FROM audit_log WHERE entity_id = 'needs_attention'").all();
    expect(audit.results).toEqual([{ actor_id: 'dan@example.com', action: 'attention.switched_on' }]);
  });
});

describe('finding what needs attention', () => {
  beforeEach(async () => {
    await request('/api/staff/attention/switch', post({ on: true }), ADMIN);
  });

  it('lists events with no usable date straight away, and never hidden ones', async () => {
    const { open } = await overview();
    expect(open.map(i => [i.name, i.kind, i.detail_kind, i.detail, i.sheet, i.actions])).toEqual([
      ['D&D', 'no_date', 'blank', null, 'auto', ['renew', 'archive', 'dismiss']],
      ['Cleeples', 'no_date', 'text', 'Every Thursday', 'auto', ['renew', 'archive', 'dismiss']],
      ['Brownies', 'no_date', 'blank', null, 'manual', ['archive', 'dismiss']],
    ]);
    expect(open[0]!.ref).toMatch(/^RTD-ATT-\d{5}$/);
  });

  it('opens exactly one item when a date ends with nothing after it, however often it runs', async () => {
    at('2026-10-09T20:59:59Z'); // Bingo is still on
    expect(byName((await overview()).open, 'Bingo')).toEqual([]);
    at('2026-10-10T12:00:00Z');
    for (let i = 0; i < 3; i++) await detect(env.DB, new Date());
    const bingo = byName((await overview()).open, 'Bingo');
    expect(bingo).toHaveLength(1);
    expect(bingo[0]).toMatchObject({ kind: 'expired', occurrence_id: 'RTD-OCC-00001-20261009', date: '2026-10-09', actions: ['renew', 'archive', 'complete'] });
    // Kids Club's 8 October has ended too, but its next date is already there.
    expect(byName((await overview()).open, 'Kids Club')).toEqual([]);
    const opened = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'attention.opened' AND occurrence_id = 'RTD-OCC-00001-20261009'").first<{ n: number }>();
    expect(opened?.n).toBe(1);
  });

  it("closes a one-off host session by itself: the host is invited to run it again", async () => {
    at('2026-10-11T12:00:00Z');
    const { open, resolved } = await overview();
    expect(byName(open, 'One Shot')).toEqual([]);
    expect(byName(resolved, 'One Shot')[0]).toMatchObject({ resolution: 'completed', resolved_by: 'system' });
  });

  it('settles itself when the Logic Engine answers: a new date arrives, a no-date event is switched off or its date changes', async () => {
    at('2026-10-10T12:00:00Z');
    await detect(env.DB, new Date());
    // Michelle sets Bingo's next date in the sheet; D&D is switched off; Cleeples' text changes.
    await resync({ 1: { 'Event Date': '06/11/2026' }, 3: { Status: 'Inactive' }, 4: { 'Event Date': 'Thursdays' } });
    const { open, resolved } = await overview();
    expect(byName(resolved, 'Bingo')[0]).toMatchObject({ resolution: 'renewed', resolved_by: 'sheet' });
    const row = await env.DB.prepare("SELECT new_occurrence_id FROM attention_items WHERE item_key = 'expired:RTD-OCC-00001-20261009'").first();
    expect(row).toEqual({ new_occurrence_id: 'RTD-OCC-00001-20261106' });
    expect(byName(resolved, 'D&D')[0]).toMatchObject({ resolution: 'archived', resolved_by: 'sheet' });
    expect(byName(resolved, 'Cleeples')[0]).toMatchObject({ resolution: 'dismissed', detail: 'Every Thursday' });
    expect(byName(open, 'Cleeples')).toMatchObject([{ detail: 'Thursdays' }]);
  });

  it("opens nothing when far too much appears at once (a broken sheet read), and says so", async () => {
    const many = Array.from({ length: MAX_NEW + 1 }, (_, i) => indexRow(100 + i, { 'Event Name': `Blank ${i}`, 'Event Date': '' }));
    await sync({ run_id: 'flood', sources: { ...rows(), event_index: [...rows().event_index, ...many] } });
    await env.DB.prepare('DELETE FROM attention_items').run();
    const res = await overview();
    expect(res.blocked).toBe(MAX_NEW + 4);
    expect(res.open).toEqual([]);
  });

  it('lists dates that will only show for an hour because they have no end time', async () => {
    await resync({ 2: { 'End Time': '' } });
    expect((await overview()).no_end_time.map(e => e.name)).toEqual(['Kids Club']);
  });
});

describe('resolving one', () => {
  let items: Record<string, AttentionItem>;
  beforeEach(async () => {
    await request('/api/staff/attention/switch', post({ on: true }), ADMIN);
    at('2026-10-10T12:00:00Z');
    items = Object.fromEntries((await overview()).open.map(i => [i.name, i]));
  });

  it("sets a new date, which reaches the Logic Engine once and then clears", async () => {
    const dd = items['D&D']!;
    expect((await resolve(dd.item_id, { action: 'renew', date: '2026-10-10' })).status).toBe(400); // today
    expect((await resolve(dd.item_id, { action: 'renew', date: '2027-12-01' })).status).toBe(400); // over a year
    const res = await resolve(dd.item_id, { action: 'renew', date: '2026-10-24', note: 'Back on the 24th' });
    expect(res.status).toBe(200);
    expect((await res.json<{ item: AttentionItem }>()).item).toMatchObject({ status: 'resolved', resolution: 'renewed', renew_date: '2026-10-24', resolved_by: 'michelle@example.com', renew_waiting: true });
    expect((await resolve(dd.item_id, { action: 'archive' })).status).toBe(409); // already sorted

    expect(await fixes()).toEqual([{ event_id: 'RTD-EVT-00003', key: 'renew:2026-10-24', row: { 'Event ID': 'RTD-EVT-00003', Status: 'Active', 'Event Date': '24/10/2026' } }]);
    await internal('/internal/sheet-fixes/RTD-EVT-00003/done', post({ key: 'renew:2026-10-24' }));
    expect(await fixes()).toEqual([]);
    // n8n wrote it; the next sync brings the date in, and the item stops waiting.
    await resync({ 3: { 'Event Date': '24/10/2026' } });
    expect(byName((await overview()).resolved, 'D&D')[0]).toMatchObject({ renew_waiting: false });
    const audit = await env.DB.prepare("SELECT actor_type, actor_id, action FROM audit_log WHERE entity_id = ?1 AND actor_type = 'staff'").bind(dd.ref).all();
    expect(audit.results).toEqual([{ actor_type: 'staff', actor_id: 'michelle@example.com', action: 'attention.resolved' }]);
  });

  it('archives: an active Event Index row is switched off (its date cell written back as it was); an inactive one is left alone', async () => {
    expect((await resolve(items.Cleeples!.item_id, { action: 'archive' })).status).toBe(200);
    expect(await fixes()).toEqual([
      { event_id: 'RTD-EVT-00004', key: expect.stringMatching(/^archive:\d+$/), row: { 'Event ID': 'RTD-EVT-00004', Status: 'Inactive', 'Event Date': 'Every Thursday' } },
    ]);
    // Bingo: the Event Guard has already switched it off, so nothing goes to the sheet.
    await resync({ 1: { Status: 'Inactive' } });
    const bingo = byName((await overview()).open, 'Bingo')[0]!;
    expect(bingo.inactive).toBe(true);
    expect((await resolve(bingo.item_id, { action: 'archive', note: 'Not running Bingo for now' })).status).toBe(200);
    expect((await fixes()).map(f => f.event_id)).toEqual(['RTD-EVT-00004']);
  });

  it("doesn't renew what the app can't write: the Standard Diary, and hosts' sessions", async () => {
    const brownies = items.Brownies!;
    const res = await resolve(brownies.item_id, { action: 'renew', date: '2026-10-24' });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('Standard Diary');
    expect((await resolve(brownies.item_id, { action: 'complete' })).status).toBe(409); // not for a missing date
    expect((await resolve(brownies.item_id, { action: 'archive' })).status).toBe(200);
    expect(await fixes()).toEqual([]); // changed in the sheet by hand
  });

  it('never reopens something that has been sorted', async () => {
    const bingo = items.Bingo!;
    expect((await resolve(bingo.item_id, { action: 'complete', note: 'Last one of the year' })).status).toBe(200);
    expect((await resolve(items.Cleeples!.item_id, { action: 'dismiss' })).status).toBe(200);
    at('2026-10-12T12:00:00Z');
    await detect(env.DB, new Date());
    const { open } = await overview();
    expect(open.map(i => i.name)).toEqual(['D&D', 'Brownies']);
  });

  it('needs approver or admin access', async () => {
    expect((await resolve(items.Bingo!.item_id, { action: 'complete' }, HOST)).status).toBe(403);
    expect((await resolve(999, { action: 'complete' })).status).toBe(404);
    expect((await resolve(items.Bingo!.item_id, { action: 'shrug' })).status).toBe(400);
  });
});
