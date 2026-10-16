// Stage 5a (docs/RTD_EVENT_CONTROL_AUDIT.md G-7, D-7): a host's change to their live session
// needs an approver's go-ahead before anything public changes; a decline needs a reason.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const SAM = as('sam@example.com'); // hosts Catan Club
const ALEX = as('alex@example.com'); // another host
const MICHELLE = as('michelle@example.com'); // approver
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const AUTH = { Authorization: 'Bearer test-sync-token' };

const CATAN = 'RTD-HS-00001';
const CATAN_EVT = 'RTD-EVT-00002';
const catanRow = (over: Record<string, unknown> = {}) =>
  indexRow(2, {
    'Event Name': 'Catan Club', Frequency: 'Weekly', Day: 'Tuesday', 'Event Date': '13/10/2026', 'Event Time': '18:30', 'End Time': '21:00',
    'Base Details': 'Trade and build.', 'App Price': 'Free', 'App Capacity': '20', 'App Host Session': CATAN, 'App Category': 'Gaming', ...over,
  });
const quizRow = indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '08/10/2026' });
let run = 0;
const syncAll = (over: Record<string, unknown> = {}) => sync({ run_id: `r${++run}`, sources: { event_index: [catanRow(over), quizRow] } });

type Session = { session_id: string; start_time: string; price_pence: number; live: Record<string, unknown> | null; change: Record<string, unknown> | null };
const mySession = async () => (await (await request('/api/host/sessions', {}, SAM)).json<{ sessions: Session[] }>()).sessions.find(s => s.session_id === CATAN)!;
const ask = async (changes: Record<string, unknown>, who: Partial<Env> = SAM) => {
  const live = (await mySession()).live!;
  return request(`/api/host/sessions/${CATAN}/changes`, json({ ...live, ...changes }), who);
};
const decide = (id: string, body: Record<string, unknown>, who: Partial<Env> = MICHELLE) => request(`/api/staff/change-requests/${id}/decision`, json(body), who);
const pending = async () => (await (await request('/api/staff/change-requests', {}, MICHELLE)).json<{ requests: Record<string, unknown>[] }>()).requests;
const toApply = async () => (await (await request('/internal/host-changes', { headers: AUTH })).json<{ changes: Record<string, unknown>[] }>()).changes;
const outbox = async () => (await env.DB.prepare('SELECT kind, to_email, subject, html FROM outbox ORDER BY message_id').all<Record<string, string>>()).results;
const publicCatan = async () => {
  const { occurrences } = await (await request('/api/events')).json<{ occurrences: Record<string, unknown>[] }>();
  return occurrences.find(o => o.occurrence_id === 'RTD-OCC-00002-20261013')!;
};

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-alex', 'alex@example.com', 'Alex', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
  ]);
  await request('/api/host/sessions', json({ name: 'Catan Club', event_date: '2026-10-13', frequency: 'weekly', start_time: '18:30', end_time: '21:00', price_pence: 0, max_players: 20, description: 'Trade and build.' }), SAM);
  await request(`/api/staff/host-sessions/${CATAN}/decision`, json({ decision: 'approve' }), MICHELLE);
  expect((await syncAll()).status).toBe(200);
  await env.DB.prepare('DELETE FROM outbox').run();
});
afterEach(() => vi.useRealTimers());

describe('a host asks to change a live session', () => {
  it('changes nothing public until an approver approves it, then reaches the sheet and the diary', async () => {
    expect((await mySession()).live).toEqual({
      name: 'Catan Club', description: 'Trade and build.', event_date: '2026-10-13', start_time: '18:30', end_time: '21:00', price: 'Free', price_pence: 0, access: 'open',
    });
    const booked = await request('/api/bookings', json({ occurrence_id: 'RTD-OCC-00002-20261013', lead_name: 'Ava Player', email: 'ava@example.com', party_size: 2 }));
    expect(booked.status).toBe(201);
    await env.DB.prepare('DELETE FROM outbox').run();

    const res = await ask({ start_time: '19:00', price_pence: 300, note: 'A later start suits more people.' });
    expect(res.status).toBe(201);
    const { request: cr } = await res.json<{ request: Record<string, unknown> }>();
    expect(cr).toMatchObject({
      request_id: 'RTD-CR-00001',
      status: 'pending',
      host: 'Sam Host',
      bookings: 1,
      people: 2,
      changes: [
        { field: 'start_time', label: 'Start time', now: '18:30', proposed: '19:00' },
        { field: 'price', label: 'Cost per player', now: 'Free', proposed: '£3' },
      ],
    });
    expect((await outbox()).map(e => [e.kind, e.to_email, e.subject])).toEqual([['cafe_change_request', '@approvals', 'Change to approve: Catan Club']]);
    expect(await publicCatan()).toMatchObject({ start_time: '18:30', price_display: 'Free' });
    expect(await toApply()).toEqual([]);
    expect((await mySession()).change).toMatchObject({ request_id: 'RTD-CR-00001', status: 'pending' });

    expect((await decide('RTD-CR-00001', { decision: 'approve' })).status).toBe(200);
    const emails = await outbox();
    expect(emails.find(e => e.kind === 'host_change_decided')).toMatchObject({ to_email: 'sam@example.com', subject: 'Change approved: Catan Club' });
    const toAva = emails.find(e => e.kind === 'attendee_time_changed')!;
    expect(toAva).toMatchObject({ to_email: 'ava@example.com', subject: 'New time: Catan Club, Tue 13 Oct' });
    expect(toAva.html).toContain('7pm–9pm');
    expect(await mySession()).toMatchObject({ start_time: '19:00', price_pence: 300 });

    // Into the sheet: only the changed cells, matched on Event ID. Public once the sync brings them in.
    expect(await toApply()).toEqual([{ request_id: 'RTD-CR-00001', event_id: CATAN_EVT, row: { 'Event ID': CATAN_EVT, 'Event Time': '19:00', 'App Price': '£3' } }]);
    expect(await publicCatan()).toMatchObject({ start_time: '18:30' });
    expect(await (await request('/internal/host-changes/RTD-CR-00001/applied', { method: 'POST', headers: AUTH })).json()).toEqual({ ok: true, already: false });
    expect(await (await request('/internal/host-changes/RTD-CR-00001/applied', { method: 'POST', headers: AUTH })).json()).toEqual({ ok: true, already: true });
    expect(await toApply()).toEqual([]);
    expect((await syncAll({ 'Event Time': '19:00', 'App Price': '£3' })).status).toBe(200);
    expect(await publicCatan()).toMatchObject({ start_time: '19:00', price_display: '£3' });
    expect((await mySession()).change).toMatchObject({ status: 'approved', applied: true });

    const audit = await env.DB.prepare("SELECT action, actor_id FROM audit_log WHERE action LIKE 'host_session.change%' ORDER BY audit_id").all();
    expect(audit.results).toEqual([
      { action: 'host_session.change_requested', actor_id: 'sam@example.com' },
      { action: 'host_session.change_approved', actor_id: 'michelle@example.com' },
      { action: 'host_session.change_applied', actor_id: 'n8n' },
    ]);
  });

  it('needs a reason to decline, which the host is emailed', async () => {
    await ask({ name: 'Catan Night' });
    expect((await decide('RTD-CR-00001', { decision: 'decline' })).status).toBe(400);
    expect((await decide('RTD-CR-00001', { decision: 'decline', note: 'Keep the name: the posters use it.' })).status).toBe(200);
    const email = (await outbox()).find(e => e.kind === 'host_change_decided')!;
    expect(email).toMatchObject({ to_email: 'sam@example.com', subject: 'Change not approved: Catan Club' });
    expect(email.html).toContain('Keep the name: the posters use it.');
    expect(await toApply()).toEqual([]);
    expect((await decide('RTD-CR-00001', { decision: 'approve' })).status).toBe(409);
  });

  it('replaces a waiting request when the host asks again, and lets them withdraw it', async () => {
    await ask({ description: 'Trade, build and settle.' });
    await ask({ description: 'Trade, build and settle. Beginners welcome.' });
    const list = await pending();
    expect(list.map(r => [r.request_id, r.status])).toEqual([['RTD-CR-00002', 'pending']]);
    expect(await env.DB.prepare("SELECT status FROM event_change_requests WHERE request_id = 'RTD-CR-00001'").first()).toEqual({ status: 'superseded' });
    expect((await request('/api/host/changes/RTD-CR-00002/withdraw', json({}), ALEX)).status).toBe(409); // not Alex's
    expect((await request('/api/host/changes/RTD-CR-00002/withdraw', json({}), SAM)).status).toBe(200);
    expect((await request('/api/host/changes/RTD-CR-00002/withdraw', json({}), SAM)).status).toBe(409);
    expect(await pending()).toEqual([]);
  });

  it('refuses to approve when the sheet changed that field since it was asked for', async () => {
    await ask({ description: 'Trade, build and settle.' });
    expect((await syncAll({ 'Base Details': 'Edited in the sheet.' })).status).toBe(200);
    const res = await decide('RTD-CR-00001', { decision: 'approve' });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('description (now Edited in the sheet.)');
  });

  it('writes a new date with its day, and checks the form', async () => {
    expect((await ask({})).status).toBe(400); // nothing changed
    expect(await (await ask({ name: 'Quiz' })).json()).toMatchObject({ errors: { name: 'Another event is already called that. Choose a different name.' } });
    expect(await (await ask({ event_date: '2026-10-01' })).json()).toMatchObject({ errors: { event_date: expect.any(String) } });
    expect((await ask({ name: 'Something else' }, ALEX)).status).toBe(404); // not Alex's session
    expect((await decide('RTD-CR-00001', { decision: 'approve' }, SAM)).status).toBe(403); // hosts can't decide

    expect((await ask({ event_date: '2026-10-15' })).status).toBe(201); // to Thursdays
    await decide('RTD-CR-00001', { decision: 'approve' });
    expect((await toApply())[0]).toMatchObject({ row: { 'Event ID': CATAN_EVT, 'Event Date': '15/10/2026', Day: 'Thursday' } });
  });
});
