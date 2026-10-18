// The admin event editor (docs/superpowers/specs/2026-10-18-admin-event-editor-design.md): admins
// see and change every event from one place; approvers and hosts keep exactly what they had.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diaryRow, env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // hosts Catan Club
const ALEX = as('alex@example.com'); // another host
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const AUTH = { Authorization: 'Bearer test-sync-token' };

const CATAN = 'RTD-HS-00001';
const CATAN_EVT = 'RTD-EVT-00002';
const QUIZ = 'RTD-EVT-00004';
const DIARY = 'RTD-EVT-00008';
type Row = Record<string, unknown>;
const catanRow = (over: Row = {}) =>
  indexRow(2, {
    'Event Name': 'Catan Club',
    Frequency: 'Weekly',
    Day: 'Tuesday',
    'Event Date': '13/10/2026',
    'Event Time': '18:30',
    'End Time': '21:00',
    'Base Details': 'Trade and build.',
    'App Price': 'Free',
    'App Capacity': '20',
    'App Host Session': CATAN,
    'App Category': 'Gaming',
    ...over,
  });
const rows = () => ({
  event_index: [
    catanRow(),
    indexRow(4),
    indexRow(5, { 'App Visibility': 'Private' }),
    indexRow(6, { 'App Visibility': 'Hidden' }),
    indexRow(7, { Status: 'Inactive' }),
  ],
  standard_diary: [diaryRow(8, { Date: '12/10/2026' })],
});
let run = 0;
const syncAll = () => sync({ run_id: `r${++run}`, sources: rows() });

type Event = Record<string, unknown> & { event_id: string };
const list = async (who: Partial<Env> = DAN) => (await (await request('/api/staff/events', {}, who)).json<{ events: Event[] }>()).events;
const form = async (id: string, who: Partial<Env> = DAN) => (await (await request(`/api/staff/events/${id}`, {}, who)).json<{ event: Event }>()).event;

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-alex', 'alex@example.com', 'Alex', 'host', 1, ?1, ?1)").bind(now),
  ]);
  await request(
    '/api/host/sessions',
    json({
      name: 'Catan Club',
      event_date: '2026-10-13',
      frequency: 'weekly',
      start_time: '18:30',
      end_time: '21:00',
      price_pence: 0,
      max_players: 20,
      description: 'Trade and build.',
    }),
    SAM,
  );
  await request(`/api/staff/host-sessions/${CATAN}/decision`, json({ decision: 'approve' }), MICHELLE);
  expect((await syncAll()).status).toBe(200);
  await env.DB.prepare('DELETE FROM outbox').run();
});
afterEach(() => vi.useRealTimers());

describe('every event, for admins', () => {
  it('lists every event to an admin, whatever its kind, visibility or status', async () => {
    const res = await request('/api/staff/events', {}, DAN);
    expect(res.status).toBe(200);
    const events = await list();
    const byId = Object.fromEntries(events.map(e => [e.event_id, e]));
    expect(Object.keys(byId).sort()).toEqual([CATAN_EVT, QUIZ, 'RTD-EVT-00005', 'RTD-EVT-00006', 'RTD-EVT-00007', DIARY]);
    expect(byId[CATAN_EVT]!.kind).toBe('host_session');
    expect(byId[QUIZ]!.kind).toBe('event_index');
    expect(byId[DIARY]!.kind).toBe('standard_diary');
    expect(byId['RTD-EVT-00005']!.visibility).toBe('private');
    expect(byId['RTD-EVT-00006']!.visibility).toBe('hidden');
    expect(byId['RTD-EVT-00007']!.active).toBe(false);
    expect(byId[QUIZ]!.active).toBe(true);
  });

  it('refuses approvers and hosts', async () => {
    for (const who of [MICHELLE, SAM]) {
      expect((await request('/api/staff/events', {}, who)).status).toBe(403);
      expect((await request(`/api/staff/events/${QUIZ}`, {}, who)).status).toBe(403);
    }
  });

  it('gives a café event its form', async () => {
    const e = await form(QUIZ);
    expect(e).toMatchObject({ kind: 'event_index', session_id: null, unavailable: {} });
    expect(e.details).toMatchObject({ name: 'Event 4', event_date: '2026-10-23', start_time: '18:30', end_time: '22:00', category: 'Quiz' });
    expect((e.dates as unknown[]).length).toBeGreaterThan(0);
    expect((e.dates as unknown[]).length).toBeLessThanOrEqual(12);
  });

  it('marks what a Standard Diary row has no column for', async () => {
    const e = await form(DIARY);
    expect(Object.keys(e.unavailable as object).sort()).toEqual(['active', 'end_time', 'price', 'start_time']);
    expect(e.details).toMatchObject({ name: 'Group 8', description: 'Notes for group 8' });
  });

  it('gives a host session its form with the session', async () => {
    const e = await form(CATAN_EVT);
    expect(e).toMatchObject({ kind: 'host_session', session_id: CATAN, booking_mode: 'required', places: 20 });
    expect(e.details).toMatchObject({ name: 'Catan Club', start_time: '18:30', price: 'Free' });
  });

  it('is 404 for an unknown event', async () => {
    expect((await request('/api/staff/events/RTD-EVT-09999', {}, DAN)).status).toBe(404);
  });
});
