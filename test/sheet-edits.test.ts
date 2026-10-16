// Stage 6 (docs/RTD_EVENT_CONTROL_AUDIT.md §4, D-13): admins change an event's Logic Engine
// columns from the organiser. Nothing changes in the app until the sheet holds the change and
// the next sync reads it; a sheet that moved on is a conflict, never overwritten silently.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canon, cellsFor, checkRows, sheetValuesOf } from '../src/sync/sheetValues';
import { env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const AUTH = { Authorization: 'Bearer test-sync-token' };
const internal = (path: string, body: unknown = {}) => request(`/internal${path}`, json(body, AUTH));

const QUIZ = 'RTD-EVT-00004';
const CHESS = 'RTD-EVT-00002';
type Row = Record<string, unknown>;
const quiz = (over: Row = {}): Row =>
  indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '15/10/2026', 'Event Time': '19:30', 'End Time': '22:00', 'Base Details': 'Teams of six.', 'App Price': '£2', 'App Capacity': '', 'App Host Session': '', ...over });
const chess = (over: Row = {}): Row =>
  indexRow(2, { 'Event Name': 'Chess Club', Frequency: 'Weekly', Day: 'Tuesday', 'Event Date': '13/10/2026', 'Event Time': '18:00', 'End Time': '20:00', 'Base Details': 'All levels.', 'App Price': '', 'App Capacity': '', 'App Host Session': '', ...over });
const catan = indexRow(6, { 'Event Name': 'Catan Club', 'Event Date': '16/10/2026', 'App Price': 'Free', 'App Host Session': 'RTD-HS-00001' });
let run = 0;
const syncRows = (rows: Row[]) => sync({ run_id: `r${++run}`, sources: { event_index: rows } });

const setMode = (mode: string, who: Partial<Env> = DAN) => request('/api/staff/sheet-sync/mode', json({ mode }), who);
const edit = (id: string, values: Record<string, string>, extra: Row = {}, who: Partial<Env> = DAN) =>
  request(`/api/staff/events/${id}/sheet-edit`, json({ values, ...extra }), who);
const resolve = (id: string, action: string) => request(`/api/staff/sheet-edits/${id}/resolve`, json({ action }), DAN);
type Claimed = { edit_id: string; claim: string; event_id: string; target: string; tab: string };
const claim = async () => (await (await internal('/sheet-edits/claim')).json<{ mode: string; edits: Claimed[] }>());
const check = async (e: Claimed, rows: Row[]) => (await internal(`/sheet-edits/${e.edit_id}/check`, { claim: e.claim, rows })).json<Record<string, unknown>>();
const written = async (e: Claimed, rows: Row[]) => (await internal(`/sheet-edits/${e.edit_id}/written`, { claim: e.claim, rows })).json<Record<string, unknown>>();
const editRow = (id: string) => env.DB.prepare('SELECT * FROM sheet_edits WHERE edit_id = ?1').bind(id).first<Record<string, unknown>>();
const publicQuiz = async () => (await (await request('/api/occurrences/RTD-OCC-00004-20261015')).json<{ occurrence: Record<string, unknown> }>()).occurrence;

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
  ]);
  expect((await syncRows([chess(), quiz(), catan])).status).toBe(200);
});
afterEach(() => vi.useRealTimers());

describe('canonical sheet values', () => {
  it('treats the same value written two ways as equal', () => {
    expect(canon('Event Time', '6:30 PM')).toBe('18:30');
    expect(canon('Event Time', 0.770833333)).toBe('18:30');
    expect(canon('Event Date', '5/1/2027')).toBe('2027-01-05');
    expect(canon('Event Date', 'Every Thursday')).toBe('Every Thursday');
    expect(canon('App Visibility', 'App Bookable')).toBe('app_bookable');
    expect(canon('App Visibility', '')).toBe('hidden');
    expect(canon('Status', 'active ')).toBe('Active');
    expect(canon('App Category', 'quiz')).toBe('Quiz');
    expect(canon('Base Details', ' Line one\r\nline two ')).toBe('Line one\nline two');
    expect(sheetValuesOf('standard_diary', { Group: 'Arkham', Notes: '', Date: '12/10/2026', 'App Visibility': 'Public', 'App Category': 'Club' }))
      .toEqual({ Group: 'Arkham', Notes: '', Date: '2026-10-12', 'App Visibility': 'public', 'App Category': 'Club' });
  });

  it('writes cells the way the sheet holds them, with the Day for a date', () => {
    expect(cellsFor(QUIZ, { 'Event Date': '2026-10-22', 'App Visibility': 'app_bookable', 'End Time': '' }))
      .toEqual({ 'Event ID': QUIZ, 'Event Date': '22/10/2026', Day: 'Thursday', 'App Visibility': 'App Bookable', 'End Time': '' });
  });

  it('checks a row: write, nothing to do, conflict, or an error', () => {
    const fields = { 'End Time': { from: '22:00', to: '22:30' }, 'Base Details': { from: 'Teams of six.', to: 'Teams of four.' } };
    expect(checkRows('event_index', QUIZ, fields, [chess(), quiz()])).toMatchObject({ action: 'write', changes: { 'End Time': '22:30', 'Base Details': 'Teams of four.' } });
    // One already done in the sheet: only the other is written.
    expect(checkRows('event_index', QUIZ, fields, [quiz({ 'End Time': '10:30 PM' })])).toMatchObject({ action: 'write', changes: { 'Base Details': 'Teams of four.' } });
    expect(checkRows('event_index', QUIZ, fields, [quiz({ 'End Time': '22:30', 'Base Details': 'Teams of four.' })])).toMatchObject({ action: 'none' });
    expect(checkRows('event_index', QUIZ, fields, [quiz({ 'Base Details': 'Teams of eight.' })])).toEqual({
      action: 'conflict', columns: ['Base Details'], found: { 'End Time': '22:00', 'Base Details': 'Teams of eight.' },
    });
    expect(checkRows('event_index', QUIZ, fields, [chess()])).toEqual({ action: 'error', error: `No row in Event Index has Event ID ${QUIZ}` });
    expect(checkRows('event_index', QUIZ, fields, [quiz(), quiz({ row_number: 9 })])).toMatchObject({ action: 'error', error: expect.stringContaining('on 2 rows') });
    const { 'End Time': _gone, ...renamed } = quiz();
    expect(checkRows('event_index', QUIZ, fields, [renamed])).toMatchObject({ action: 'error', error: expect.stringContaining("no 'End Time' column") });
  });
});

describe('the sync keeps the sheet values', () => {
  it('stores them on each event without changing its hash', async () => {
    const before = await env.DB.prepare('SELECT source_hash, sheet_values, updated_at FROM events WHERE event_id = ?1').bind(QUIZ).first<{ sheet_values: string }>();
    expect(JSON.parse(before!.sheet_values)).toMatchObject({ 'Event Name': 'Quiz', 'Event Date': '2026-10-15', 'End Time': '22:00', 'App Visibility': 'public', 'App Price': '£2' });
    const again = await (await syncRows([chess(), quiz(), catan])).json<{ events_changed: number }>();
    expect(again.events_changed).toBe(0);
  });
});

describe('changing an event from the organiser', () => {
  it('is closed while switched off, and only for admins', async () => {
    expect((await edit(QUIZ, { 'End Time': '22:30' })).status).toBe(409);
    expect((await setMode('live', MICHELLE)).status).toBe(403);
    expect((await setMode('sideways')).status).toBe(400);
    expect((await setMode('live')).status).toBe(200);
    expect((await edit(QUIZ, { 'End Time': '22:30' }, {}, MICHELLE)).status).toBe(403);
    expect((await request('/api/staff/sheet-sync', {}, MICHELLE)).status).toBe(403);
    expect((await request('/api/staff/sheet-events', {}, MICHELLE)).status).toBe(403);
    const audit = await env.DB.prepare("SELECT actor_id, previous_value, new_value FROM audit_log WHERE action = 'sheet_writes.changed'").first();
    expect(audit).toEqual({ actor_id: 'dan@example.com', previous_value: 'off', new_value: 'live' });
  });

  it('lists the café’s events with their sheet values, never host sessions', async () => {
    const { events } = await (await request('/api/staff/sheet-events', {}, DAN)).json<{ events: { event_id: string; values: Record<string, string>; tab: string }[] }>();
    expect(events.map(e => e.event_id).sort()).toEqual([CHESS, QUIZ]);
    expect(events.find(e => e.event_id === QUIZ)).toMatchObject({ tab: 'Event Index', values: { 'Event Time': '19:30', 'Base Details': 'Teams of six.' } });
  });

  it('reaches the sheet, then the app at the next sync, with no echo', async () => {
    await setMode('live');
    const res = await edit(QUIZ, { 'Event Name': 'Quiz', 'End Time': '22:30', 'Base Details': 'Teams of four.', 'App Price': '£2' }, { note: 'Shorter night' });
    expect(res.status).toBe(200);
    const { edit: e } = await res.json<{ edit: Record<string, unknown> }>();
    expect(e).toMatchObject({
      edit_id: 'RTD-SE-00001', status: 'queued', target: 'live', tab: 'Event Index',
      fields: { 'End Time': { from: '22:00', to: '22:30' }, 'Base Details': { from: 'Teams of six.', to: 'Teams of four.' } },
    });
    expect(Object.keys(e.fields as object)).toEqual(['End Time', 'Base Details']); // only what changes
    // Nothing public changes yet.
    expect(await publicQuiz()).toMatchObject({ end_time: '22:00', description: 'Teams of six.' });

    const { edits } = await claim();
    expect(edits).toEqual([{ edit_id: 'RTD-SE-00001', claim: expect.any(String), event_id: QUIZ, target: 'live', tab: 'Event Index' }]);
    expect((await claim()).edits).toEqual([]); // claimed for 10 minutes
    expect(await check(edits[0]!, [chess(), quiz()])).toEqual({
      action: 'write', tab: 'Event Index', cells: { 'Event ID': QUIZ, 'End Time': '22:30', 'Base Details': 'Teams of four.' },
    });
    const sheetNow = [chess(), quiz({ 'End Time': '22:30', 'Base Details': 'Teams of four.' })];
    expect(await written(edits[0]!, sheetNow)).toEqual({ ok: true, result: 'ok' });
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'written', written_at: '2026-10-12T10:00:00.000Z' });
    expect(await publicQuiz()).toMatchObject({ end_time: '22:00' }); // the sync brings it in

    vi.setSystemTime(new Date('2026-10-12T10:15:00Z'));
    expect((await syncRows([...sheetNow, catan])).status).toBe(200);
    expect(await publicQuiz()).toMatchObject({ end_time: '22:30', description: 'Teams of four.' });
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'synced', settled_at: '2026-10-12T10:15:00.000Z' });
    expect((await claim()).edits).toEqual([]); // nothing goes back
    const actions = await env.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'sheet_edit.%' ORDER BY audit_id").all();
    expect(actions.results.map(r => r.action)).toEqual(['sheet_edit.requested', 'sheet_edit.written']);
  });

  it('records a conflict when the sheet moved on: neither side is overwritten', async () => {
    await setMode('live');
    await edit(QUIZ, { 'Base Details': 'Teams of four.' });
    const [e] = (await claim()).edits;
    expect(await check(e!, [quiz({ 'Base Details': 'Teams of eight, bring pens.' })])).toEqual({ action: 'skip', status: 'conflict' });
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'conflict', found: JSON.stringify({ 'Base Details': 'Teams of eight, bring pens.' }), claim: null });
    const mail = await env.DB.prepare("SELECT to_email, subject, html FROM outbox WHERE kind = 'sheet_edit_conflict'").first<Record<string, string>>();
    expect(mail).toMatchObject({ to_email: 'dan@example.com', subject: 'Not written, the sheet changed: Quiz' });
    expect(mail!.html).toContain('Teams of eight, bring pens.');
    expect((await written(e!, [quiz()])).result).toBe('already'); // a stale run can't settle it
    // Another change to the same event waits until this is sorted.
    expect((await edit(QUIZ, { 'End Time': '23:00' })).status).toBe(409);

    // Write mine: checked again against what the sheet has now.
    expect((await resolve('RTD-SE-00001', 'write_mine')).status).toBe(200);
    const [again] = (await claim()).edits;
    expect(await check(again!, [quiz({ 'Base Details': 'Teams of eight, bring pens.' })])).toMatchObject({ action: 'write', cells: { 'Base Details': 'Teams of four.' } });
  });

  it('keeps the sheet’s value when asked', async () => {
    await setMode('live');
    await edit(QUIZ, { 'Base Details': 'Teams of four.' });
    const [e] = (await claim()).edits;
    await check(e!, [quiz({ 'Base Details': 'Changed by hand.' })]);
    expect((await resolve('RTD-SE-00001', 'keep_sheet')).status).toBe(200);
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'cancelled', resolution: 'kept_sheet', resolved_by: 'dan@example.com' });
    expect((await resolve('RTD-SE-00001', 'keep_sheet')).status).toBe(409);
    expect((await edit(QUIZ, { 'End Time': '23:00' })).status).toBe(200); // free again
  });

  it('writes nothing when the sheet already has the change', async () => {
    await setMode('live');
    await edit(QUIZ, { 'End Time': '22:30' });
    const [e] = (await claim()).edits;
    expect(await check(e!, [quiz({ 'End Time': '10:30pm' })])).toEqual({ action: 'skip', status: 'written' });
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'written', cells: '{}' });
  });

  it('marks a written change overtaken if the sheet changes again before the app sees it', async () => {
    await setMode('live');
    await edit(QUIZ, { 'End Time': '22:30' });
    const [e] = (await claim()).edits;
    await check(e!, [quiz()]);
    await written(e!, [quiz({ 'End Time': '22:30' })]);
    // A sync that may have read the sheet before the write proves nothing.
    vi.setSystemTime(new Date('2026-10-12T10:01:00Z'));
    await syncRows([chess(), quiz({ 'End Time': '23:00' }), catan]);
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'written' });
    vi.setSystemTime(new Date('2026-10-12T10:15:00Z'));
    await syncRows([chess(), quiz({ 'End Time': '23:00' }), catan]);
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'overtaken' });
    expect(await publicQuiz()).toMatchObject({ end_time: '23:00' }); // the sheet's value stands
  });

  it('only tries it out in shadow mode, and only writes the test copy in staging mode', async () => {
    await setMode('shadow');
    await edit(QUIZ, { 'End Time': '22:30' });
    const [s] = (await claim()).edits;
    expect(s).toMatchObject({ target: 'shadow' });
    expect(await check(s!, [quiz()])).toEqual({ action: 'skip', status: 'dry_run' });
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'dry_run', cells: JSON.stringify({ 'Event ID': QUIZ, 'End Time': '22:30' }) });

    await setMode('staging');
    await edit(QUIZ, { 'End Time': '22:45' });
    const [t] = (await claim()).edits;
    expect(t).toMatchObject({ edit_id: 'RTD-SE-00002', target: 'staging' });
    expect(await check(t!, [quiz()])).toMatchObject({ action: 'write' });
    await written(t!, [quiz({ 'End Time': '22:45' })]);
    vi.setSystemTime(new Date('2026-10-12T10:15:00Z'));
    await syncRows([chess(), quiz(), catan]); // the live sheet never had it
    expect(await editRow('RTD-SE-00002')).toMatchObject({ status: 'written' });
    expect(await publicQuiz()).toMatchObject({ end_time: '22:00' });
  });

  it('holds live changes while the mode is off or a trial', async () => {
    await setMode('live');
    await edit(QUIZ, { 'End Time': '22:30' });
    await setMode('shadow');
    expect((await claim()).edits).toEqual([]);
    await setMode('off');
    expect(await claim()).toEqual({ mode: 'off', edits: [] });
    expect((await resolve('RTD-SE-00001', 'withdraw')).status).toBe(200);
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'cancelled', resolution: 'withdrawn' });
  });

  it('tries again after a failure, then gives up where the admin can see it', async () => {
    await setMode('live');
    await edit(QUIZ, { 'End Time': '22:30' });
    let [e] = (await claim()).edits;
    // No row with that Event ID counts as a failed try.
    expect(await check(e!, [chess()])).toMatchObject({ action: 'skip', status: 'queued', error: expect.stringContaining('No row') });
    expect(await editRow('RTD-SE-00001')).toMatchObject({ attempts: 1, next_attempt_at: '2026-10-12T10:05:00.000Z', claim: null });
    expect((await claim()).edits).toEqual([]); // not before its time
    const waits = ['10:05', '10:20', '11:20', '15:20', '2026-10-13T03:20'];
    for (const [i, at] of waits.entries()) {
      vi.setSystemTime(new Date(at.includes('T') ? `${at}:00Z` : `2026-10-12T${at}:00Z`));
      [e] = (await claim()).edits;
      expect(e).toBeDefined();
      const res = await (await internal(`/sheet-edits/${e!.edit_id}/failed`, { claim: e!.claim, error: 'Google: quota exceeded' })).json<{ result: string }>();
      expect(res.result).toBe(i < 4 ? 'retry' : 'dead');
      // Failing twice in one claim counts once.
      expect((await (await internal(`/sheet-edits/${e!.edit_id}/failed`, { claim: e!.claim, error: 'again' })).json<{ result: string }>()).result).toBe('already');
    }
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'dead', attempts: 6, last_error: 'Google: quota exceeded' });
    expect(await env.DB.prepare("SELECT to_email FROM outbox WHERE kind = 'sheet_edit_dead'").first()).toEqual({ to_email: 'dan@example.com' });
    expect((await resolve('RTD-SE-00001', 'retry')).status).toBe(200);
    expect((await claim()).edits).toHaveLength(1);
  });

  it('gives up at once when the cells read back wrong', async () => {
    await setMode('live');
    await edit(QUIZ, { 'Event Date': '2026-10-22' });
    const [e] = (await claim()).edits;
    expect(await check(e!, [quiz()])).toMatchObject({ cells: { 'Event ID': QUIZ, 'Event Date': '22/10/2026', Day: 'Thursday' } });
    expect(await written(e!, [quiz({ 'Event Date': '10/22/2026' })])).toEqual({ ok: false, result: 'mismatch' });
    expect(await editRow('RTD-SE-00001')).toMatchObject({ status: 'dead', last_error: "After writing, Event Date reads '10/22/2026', not '22/10/2026'" });
  });

  it('checks the form', async () => {
    await setMode('live');
    const bad = async (values: Record<string, string>) => (await (await edit(QUIZ, values)).json<{ errors: Record<string, string> }>()).errors;
    expect(await bad({ 'Event Name': 'Chess Club' })).toEqual({ 'Event Name': 'Another row in the Logic Engine already has this name.' });
    expect(await bad({ 'Event Date': '2026-10-01' })).toEqual({ 'Event Date': 'Choose today or a later date.' });
    expect(await bad({ 'Event Date': '2026-02-30' })).toEqual({ 'Event Date': 'Choose a date.' });
    expect(await bad({ 'Event Time': '', 'End Time': '22:30' })).toEqual({ 'End Time': 'Add a start time, or clear the end time.' });
    expect(await bad({ 'App Visibility': 'everyone', Status: 'Paused', 'App Category': 'Bingo' })).toEqual({
      'App Visibility': 'Choose who can see it.', Status: 'Choose Active or Inactive.', 'App Category': 'Choose a category.',
    });
    expect(await bad({ Frequency: 'Weekly' })).toEqual({ Frequency: "Frequency can't be changed from the app." });
    expect((await edit(QUIZ, { 'Event Time': '19:30' })).status).toBe(400); // nothing changed
    expect((await edit('RTD-EVT-00006', { 'End Time': '22:30' })).status).toBe(409); // a host's session
    expect((await edit('RTD-EVT-99999', { 'End Time': '22:30' })).status).toBe(404);
  });

  it('asks first when people have booked', async () => {
    await setMode('live');
    expect((await request('/api/bookings', json({ occurrence_id: 'RTD-OCC-00004-20261015', lead_name: 'Ava Player', email: 'ava@example.com', party_size: 3 }))).status).toBe(201);
    const moved = await edit(QUIZ, { 'Event Date': '2026-10-22' });
    expect(moved.status).toBe(409);
    expect((await moved.json<{ warning: string }>()).warning).toBe(
      '1 booking (3 places) on Thursday 15 October. Once the change reaches the app, it asks you under Needs attention whether to tell them or cancel their bookings.',
    );
    const off = await edit(QUIZ, { Status: 'Inactive' });
    expect((await off.json<{ warning: string }>()).warning).toContain('1 booking (3 places) on dates to come');
    expect((await edit(QUIZ, { 'Event Date': '2026-10-22' }, { confirm: true })).status).toBe(200);
  });

  it('shows the queue and the last sync to admins', async () => {
    await setMode('live');
    await edit(QUIZ, { 'End Time': '22:30' });
    const res = await (await request('/api/staff/sheet-sync', {}, DAN)).json<Record<string, any>>();
    expect(res).toMatchObject({ mode: 'live', counts: { queued: 1, conflict: 0, dead: 0 }, last_sync: { status: 'ok' } });
    expect(res.edits[0]).toMatchObject({ edit_id: 'RTD-SE-00001', name: 'Quiz', status: 'queued' });
    expect(res.edits[0]).not.toHaveProperty('claim');
  });
});
