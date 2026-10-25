// "Run now" calls to n8n (src/n8n/trigger.ts, docs/RTD_N8N_WORKFLOWS.md#instant-triggers): an edit
// wakes the Sheet Writer, a written edit wakes Event Sync, a sync that changed events or a
// Regenerate wakes the Prompt Builder. Fire and forget; the schedules stay as the safety net.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, freshDb, indexRow, request } from './helpers';

const BASE = 'https://n8n.example.test/webhook';
const ON: Partial<Env> = { N8N_WEBHOOK_BASE: BASE };
const DAN: Partial<Env> = { ...ON, ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'dan@example.com' };
const AUTH = { Authorization: 'Bearer test-sync-token' };
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const internal = (path: string, body: unknown = {}, over: Partial<Env> = ON) => request(`/internal${path}`, json(body, AUTH), over);

const QUIZ = 'RTD-EVT-00004';
const quiz = (over: Record<string, unknown> = {}) =>
  indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '15/10/2026', 'Event Time': '19:30', 'End Time': '22:00', 'Base Details': 'Teams of six.', 'App Price': '£2', 'App Capacity': '', 'App Host Session': '', ...over });
let run = 0;
const snapshot = (rows = [quiz()], over: Partial<Env> = ON) => internal('/sync/logic-engine', { run_id: `r${++run}`, sources: { event_index: rows } }, over);
const edit = (values: Record<string, string>, who: Partial<Env> = DAN) => request(`/api/staff/events/${QUIZ}/sheet-edit`, json({ values }), who);
const setMode = (mode: string) => request('/api/staff/sheet-sync/mode', json({ mode }), DAN);

type Call = { url: string; auth: string | null; body: Record<string, unknown> };
let calls: Call[];
let answer: () => Promise<Response>;
const paths = () => calls.map(c => c.url.replace(BASE, ''));
const later = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now).run();
  calls = [];
  answer = async () => new Response('{"message":"Workflow was started"}', { status: 200 });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get('Authorization'), body: JSON.parse(String(init?.body ?? '{}')) });
    return answer();
  });
  expect((await snapshot([quiz()], { N8N_WEBHOOK_BASE: '' })).status).toBe(200);
  expect((await setMode('live')).status).toBe(200);
  later(120_000); // the set-up sync is long past
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the Sheet Writer', () => {
  it('is called when an admin queues an edit, with the bearer token', async () => {
    expect((await edit({ 'End Time': '22:30' })).status).toBe(200);
    expect(calls).toEqual([{ url: `${BASE}/rtd-sheet-writer-run`, auth: 'Bearer test-sync-token', body: { reason: 'edit_queued', event_id: QUIZ } }]);
  });

  it('is not called when N8N_WEBHOOK_BASE is unset', async () => {
    expect((await edit({ 'End Time': '22:30' }, { ...DAN, N8N_WEBHOOK_BASE: '' })).status).toBe(200);
    expect((await edit({ 'End Time': '22:30' }, { ...DAN, N8N_WEBHOOK_BASE: undefined })).status).toBe(409); // one change at a time
    expect(calls).toEqual([]);
  });

  it('is not called for an edit that is refused', async () => {
    expect((await edit({ 'Event Name': '' })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('is called once for a burst, and again once a run has started', async () => {
    await edit({ 'End Time': '22:30' });
    // A second queued change within 15 s: the run that was asked for hasn't claimed yet, so it takes both.
    later(5_000);
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run(); // free the event for another change
    await edit({ 'End Time': '22:45' });
    expect(paths()).toEqual(['/rtd-sheet-writer-run']);
    // The run claims; a change after that needs another run, even inside the 15 s.
    later(2_000);
    await internal('/sheet-edits/claim');
    later(1_000);
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run();
    await edit({ 'End Time': '23:00' });
    expect(paths()).toEqual(['/rtd-sheet-writer-run', '/rtd-sheet-writer-run']);
    // After 15 s it's called again whatever happened.
    later(16_000);
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run();
    await edit({ 'End Time': '23:15' });
    expect(paths()).toHaveLength(3);
  });

  it('keeps the edit when n8n fails or answers 404, and lets the next change try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer = async () => {
      throw new Error('network down');
    };
    const res = await edit({ 'End Time': '22:30' });
    expect(res.status).toBe(200);
    expect((await res.json<{ edit: { status: string } }>()).edit.status).toBe('queued');
    answer = async () => new Response('not registered', { status: 404 });
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run();
    expect((await edit({ 'End Time': '22:45' })).status).toBe(200);
    expect(paths()).toEqual(['/rtd-sheet-writer-run', '/rtd-sheet-writer-run']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/network down/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/404/));
  });

  it('is called when the event editor queues a change', async () => {
    const res = await request(`/api/staff/events/${QUIZ}`, json({ details: { name: 'Quiz Night' } }), DAN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sheet_edit: { status: 'queued' } });
    expect(calls).toEqual([{ url: `${BASE}/rtd-sheet-writer-run`, auth: 'Bearer test-sync-token', body: { reason: 'edit_queued', event_id: QUIZ } }]);
  });

  it('is called when a change is queued again from the conflict screen', async () => {
    await edit({ 'End Time': '22:30' });
    const id = (await env.DB.prepare('SELECT edit_id FROM sheet_edits').first<{ edit_id: string }>())!.edit_id;
    await env.DB.prepare("UPDATE sheet_edits SET status = 'dead' WHERE edit_id = ?1").bind(id).run();
    later(20_000);
    expect((await request(`/api/staff/sheet-edits/${id}/resolve`, json({ action: 'retry' }), DAN)).status).toBe(200);
    expect(paths()).toEqual(['/rtd-sheet-writer-run', '/rtd-sheet-writer-run']);
  });
});

describe('Event Sync', () => {
  async function writtenEdit() {
    await edit({ 'End Time': '22:30' });
    const { edits } = await (await internal('/sheet-edits/claim')).json<{ edits: { edit_id: string; claim: string }[] }>();
    const e = edits[0]!;
    await internal(`/sheet-edits/${e.edit_id}/check`, { claim: e.claim, rows: [quiz()] });
    calls = [];
    return internal(`/sheet-edits/${e.edit_id}/written`, { claim: e.claim, rows: [quiz({ 'End Time': '22:30' })] });
  }

  it('is called when the Sheet Writer reports a change written', async () => {
    const res = await writtenEdit();
    expect(await res.json()).toMatchObject({ ok: true, result: 'ok' });
    expect(calls).toEqual([{ url: `${BASE}/rtd-event-sync-run`, auth: 'Bearer test-sync-token', body: { reason: 'edit_written', event_id: QUIZ } }]);
  });

  it('is called straight after a finished sync, but not while its own call may still be running', async () => {
    // A snapshot that has arrived is a sync that has finished: starting another is safe.
    await snapshot([quiz()]);
    later(5_000);
    await writtenEdit();
    expect(paths()).toEqual(['/rtd-event-sync-run']);
    // That call's run hasn't sent its snapshot yet, so a second call would overlap it.
    later(10_000);
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run();
    await writtenEdit();
    expect(paths()).toEqual([]);
    // Once its snapshot arrives, the next written edit calls again.
    await snapshot([quiz()]);
    later(1_000);
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run();
    await writtenEdit();
    expect(paths()).toEqual(['/rtd-event-sync-run']);
    // A call whose run never reported back doesn't block for more than 30 s.
    later(31_000);
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run();
    await writtenEdit();
    expect(paths()).toEqual(['/rtd-event-sync-run']);
  });

  it('answers n8n the same when the call fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer = async () => new Response('down', { status: 500 });
    const res = await writtenEdit();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: 'ok' });
    expect(paths()).toEqual(['/rtd-event-sync-run']);
  });

  it('is not called for a change written to the test copy', async () => {
    await setMode('staging');
    await writtenEdit();
    expect(paths()).toEqual([]);
  });
});

describe('the Prompt Builder', () => {
  it('is called after a sync that changed events, never after one that changed none', async () => {
    const res = await snapshot([quiz({ 'Base Details': 'Teams of four.' })]);
    expect(await res.json()).toMatchObject({ status: 'ok', events_changed: 1 });
    expect(calls).toEqual([{ url: `${BASE}/rtd-prompt-builder-run`, auth: 'Bearer test-sync-token', body: { reason: 'events_changed' } }]);
    later(20_000);
    expect(await (await snapshot([quiz({ 'Base Details': 'Teams of four.' })])).json()).toMatchObject({ status: 'ok', events_changed: 0 });
    expect(paths()).toEqual(['/rtd-prompt-builder-run']);
  });

  it('answers the sync the same when the call fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer = async () => {
      throw new Error('timeout');
    };
    const res = await snapshot([quiz({ 'Base Details': 'Teams of four.' })]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', events_changed: 1 });
  });

  it('debounces, unless a run has started since the last call', async () => {
    await snapshot([quiz({ 'Base Details': 'A' })]);
    later(5_000);
    await snapshot([quiz({ 'Base Details': 'B' })]);
    expect(paths()).toEqual(['/rtd-prompt-builder-run']);
    await request('/internal/social-prompts/due', { headers: AUTH }, ON);
    later(1_000);
    await snapshot([quiz({ 'Base Details': 'C' })]);
    expect(paths()).toEqual(['/rtd-prompt-builder-run', '/rtd-prompt-builder-run']);
  });

  it('is called when an admin presses Regenerate', async () => {
    const res = await request(`/api/staff/events/${QUIZ}/social/regenerate`, json({}), DAN);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: `${BASE}/rtd-prompt-builder-run`, auth: 'Bearer test-sync-token', body: { reason: 'regenerate', event_id: QUIZ } }]);
    expect((await request('/api/staff/events/RTD-EVT-09999/social/regenerate', json({}), DAN)).status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});
