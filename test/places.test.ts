import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diaryRow, env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const SAM = as('sam@example.com'); // hosts both sessions
const ALEX = as('alex@example.com'); // another host
const MICHELLE = as('michelle@example.com'); // approver
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const ROOT = 'RTD-OCC-00001-20261008'; // Sam's one-off, 4 places
const CATAN_1 = 'RTD-OCC-00002-20261013'; // Sam's weekly, 20 places
const CATAN_2 = 'RTD-OCC-00002-20261020';
const QUIZ = 'RTD-OCC-00004-20261008'; // the café's own one-off: no App Capacity
const CLUB_1 = 'RTD-OCC-00024-20261012'; // a weekly Standard Diary group
const CLUB_2 = 'RTD-OCC-00024-20261019';

const rows = (quizCapacity = '') => [
  indexRow(1, { 'Event Name': 'Root Night', Day: 'Thursday', 'Event Date': '08/10/2026', 'Event Time': '19:00', 'App Capacity': '4', 'App Host Session': 'RTD-HS-00001', 'App Category': 'Gaming' }),
  indexRow(2, { 'Event Name': 'Catan Club', Frequency: 'Weekly', Day: 'Tuesday', 'Event Date': '13/10/2026', 'Event Time': '18:30', 'App Capacity': '20', 'App Host Session': 'RTD-HS-00002', 'App Category': 'Gaming' }),
  indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '08/10/2026', 'App Capacity': quizCapacity }),
];
const syncAll = (runId: string, quizCapacity = '') => sync({ run_id: runId, sources: { event_index: rows(quizCapacity), standard_diary: [diaryRow(24, { Group: 'Chess Club' })] } });

const book = (occurrence: string, email: string, party = 2) =>
  request('/api/bookings', json({ occurrence_id: occurrence, lead_name: 'Ava Player', email, party_size: party }));
const availability = async (id: string) => (await request(`/api/bookings/availability/${id}`)).json<Record<string, unknown>>();
const post = (path: string, body: unknown, who: Partial<Env>) => request(path, json(body), who);

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
  const base = { start_time: '19:00', end_time: '22:00', price_pence: 0, max_players: 4 };
  await request('/api/host/sessions', json({ ...base, name: 'Root Night', event_date: '2026-10-08' }), SAM);
  await request('/api/host/sessions', json({ ...base, name: 'Catan Club', event_date: '2026-10-13', frequency: 'weekly', start_time: '18:30', max_players: 20 }), SAM);
  for (const id of ['RTD-HS-00001', 'RTD-HS-00002']) await request(`/api/staff/host-sessions/${id}/decision`, json({ decision: 'approve' }), MICHELLE);
  expect((await syncAll('setup')).status).toBe(200);
});
afterEach(() => vi.useRealTimers());

describe('a host changes the places on their own session', () => {
  it('changes every date at once, with no new approval', async () => {
    const res = await post('/api/host/sessions/RTD-HS-00002/places', { places: 8 }, SAM);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ places: 8 });
    expect(await availability(CATAN_1)).toMatchObject({ capacity: 8, places_left: 8 });
    expect(await availability(CATAN_2)).toMatchObject({ capacity: 8 });
    const { sessions } = await (await request('/api/host/sessions', {}, SAM)).json<{ sessions: { session_id: string; status: string; max_players: number }[] }>();
    expect(sessions.find(s => s.session_id === 'RTD-HS-00002')).toMatchObject({ status: 'published', max_players: 8 });
    const audit = await env.DB.prepare("SELECT actor_type, actor_id, action, previous_value, new_value FROM audit_log WHERE action LIKE '%places%'").all();
    expect(audit.results).toEqual([{ actor_type: 'host', actor_id: 'sam@example.com', action: 'host_session.places_changed', previous_value: '20', new_value: '8' }]);
  });

  it('never goes below what is already booked, and says which date', async () => {
    expect((await book(CATAN_2, 'a@example.com', 5)).status).toBe(201);
    const res = await post('/api/host/sessions/RTD-HS-00002/places', { places: 4 }, SAM);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "5 places are already booked on Tue 20 Oct, so it can't go below 5.", errors: { places: expect.any(String) } });
    expect(await availability(CATAN_1)).toMatchObject({ capacity: 20 });
    expect((await post('/api/host/sessions/RTD-HS-00002/places', { places: 5 }, SAM)).status).toBe(200);
    expect(await availability(CATAN_2)).toMatchObject({ capacity: 5, places_left: 0, open: false, reason: 'full' });
  });

  it('only for their own live sessions, and only sensible numbers', async () => {
    expect((await post('/api/host/sessions/RTD-HS-00002/places', { places: 8 }, ALEX)).status).toBe(403);
    expect((await post('/api/host/sessions/RTD-HS-99999/places', { places: 8 }, SAM)).status).toBe(404);
    for (const places of [0, 101, 2.5, '8', null]) expect((await post('/api/host/sessions/RTD-HS-00002/places', { places }, SAM)).status).toBe(400);
    await request('/api/host/sessions', json({ name: 'Waiting', event_date: '2026-10-30', start_time: '19:00', end_time: '', price_pence: 0, max_players: 4 }), SAM);
    const waiting = await post('/api/host/sessions/RTD-HS-00003/places', { places: 8 }, SAM);
    expect(waiting.status).toBe(409);
    expect((await waiting.json<{ error: string }>()).error).toContain('once the session is live');
  });

  it('can set one date on its own, then put it back', async () => {
    expect((await post(`/api/host/occurrences/${CATAN_2}/places`, { places: 12 }, SAM)).status).toBe(200);
    expect(await availability(CATAN_1)).toMatchObject({ capacity: 20 });
    expect(await availability(CATAN_2)).toMatchObject({ capacity: 12 });
    const { sessions } = await (await request('/api/host/sessions', {}, SAM)).json<{ sessions: { session_id: string; dates?: { occurrence_id: string; capacity: number; own_capacity: number | null }[] }[] }>();
    const dates = sessions.find(s => s.session_id === 'RTD-HS-00002')!.dates!;
    expect(dates.find(d => d.occurrence_id === CATAN_2)).toMatchObject({ capacity: 12, own_capacity: 12 });
    expect(dates.find(d => d.occurrence_id === CATAN_1)).toMatchObject({ capacity: 20, own_capacity: null });
    // A new number for every date replaces it.
    expect((await post('/api/host/sessions/RTD-HS-00002/places', { places: 10 }, SAM)).status).toBe(200);
    expect(await availability(CATAN_2)).toMatchObject({ capacity: 10 });
    expect((await post(`/api/host/occurrences/${CATAN_2}/places`, { places: 3 }, SAM)).status).toBe(200);
    expect(await (await post(`/api/host/occurrences/${CATAN_2}/places`, { places: null }, SAM)).json()).toEqual({ capacity: 10 });
    expect(await availability(CATAN_2)).toMatchObject({ capacity: 10 });
  });

  it("can't change someone else's date, or one that has started", async () => {
    expect((await post(`/api/host/occurrences/${CATAN_2}/places`, { places: 12 }, ALEX)).status).toBe(403);
    expect((await post(`/api/host/occurrences/${QUIZ}/places`, { places: 12 }, SAM)).status).toBe(403);
    vi.setSystemTime(new Date('2026-10-08T18:30:00Z')); // 19:30 in London: Root Night has started
    expect((await post(`/api/host/occurrences/${ROOT}/places`, { places: 6 }, SAM)).status).toBe(409);
  });
});

describe('an approver sets places for café events', () => {
  it('lists every café event people can book, with its places', async () => {
    const res = await request('/api/staff/event-places', {}, MICHELLE);
    expect(res.status).toBe(200);
    const { events } = await res.json<{ events: Record<string, unknown>[] }>();
    expect(events.map(e => e.name)).toEqual(['Quiz', 'Chess Club']); // not hosts' sessions
    expect(events[0]).toMatchObject({ event_id: 'RTD-EVT-00004', source: 'event_index', sheet_places: null, app_places: null, places: null, most_booked: 0, next_date: '2026-10-08' });
    expect((await request('/api/staff/event-places', {}, SAM)).status).toBe(403);
  });

  it('limits a café event that had no limit, and the limit holds', async () => {
    expect((await book(QUIZ, 'big@example.com', 10)).status).toBe(201);
    const low = await post('/api/staff/events/RTD-EVT-00004/places', { places: 8 }, MICHELLE);
    expect(low.status).toBe(409);
    expect((await low.json<{ error: string }>()).error).toBe("10 places are already booked on Thu 8 Oct, so it can't go below 10.");
    expect((await post('/api/staff/events/RTD-EVT-00004/places', { places: 12 }, MICHELLE)).status).toBe(200);
    expect(await availability(QUIZ)).toMatchObject({ capacity: 12, places_left: 2, max_party: 2 });
    expect((await book(QUIZ, 'three@example.com', 3)).status).toBe(409);
    expect((await book(QUIZ, 'two@example.com', 2)).status).toBe(201);
    expect(await availability(QUIZ)).toMatchObject({ open: false, reason: 'full' });
    // No limit again.
    expect((await post('/api/staff/events/RTD-EVT-00004/places', { places: null }, MICHELLE)).status).toBe(200);
    expect(await availability(QUIZ)).toMatchObject({ open: true, capacity: null, places_left: null });
  });

  it('works for Standard Diary groups, which have no App Capacity column', async () => {
    expect((await post('/api/staff/events/RTD-EVT-00024/places', { places: 16 }, MICHELLE)).status).toBe(200);
    expect(await availability(CLUB_1)).toMatchObject({ capacity: 16 });
    expect(await availability(CLUB_2)).toMatchObject({ capacity: 16 });
    // One date on its own, by an approver.
    expect((await post(`/api/host/occurrences/${CLUB_2}/places`, { places: 30 }, MICHELLE)).status).toBe(200);
    expect(await availability(CLUB_2)).toMatchObject({ capacity: 30 });
    const audit = await env.DB.prepare("SELECT entity_type, actor_type, action, new_value FROM audit_log WHERE action LIKE '%places%' ORDER BY audit_id").all();
    expect(audit.results).toEqual([
      { entity_type: 'event', actor_type: 'staff', action: 'event.places_changed', new_value: '16' },
      { entity_type: 'occurrence', actor_type: 'staff', action: 'occurrence.places_changed', new_value: '30' },
    ]);
  });

  it("leaves hosts' sessions to the host, apart from single dates", async () => {
    const res = await post('/api/staff/events/RTD-EVT-00002/places', { places: 8 }, MICHELLE);
    expect(res.status).toBe(409);
    expect((await post(`/api/host/occurrences/${CATAN_1}/places`, { places: 8 }, MICHELLE)).status).toBe(200);
    expect((await post('/api/staff/events/RTD-EVT-99999/places', { places: 8 }, MICHELLE)).status).toBe(404);
    expect((await post('/api/staff/events/RTD-EVT-00004/places', { places: 501 }, MICHELLE)).status).toBe(400);
  });
});

describe('the sheet and the app', () => {
  it('keeps the number set in the app through syncs, until App Capacity changes in the sheet', async () => {
    expect((await post('/api/staff/events/RTD-EVT-00004/places', { places: 30 }, MICHELLE)).status).toBe(200);
    expect((await syncAll('again')).status).toBe(200);
    expect(await availability(QUIZ)).toMatchObject({ capacity: 30 });
    // Someone sets App Capacity in the sheet: the sheet's number wins now.
    expect((await syncAll('sheet-changed', '40')).status).toBe(200);
    expect(await availability(QUIZ)).toMatchObject({ capacity: 40 });
    const row = await env.DB.prepare("SELECT capacity_override FROM events WHERE event_id = 'RTD-EVT-00004'").first();
    expect(row).toEqual({ capacity_override: null });
  });

  it("keeps a host's new number, and a date's own number, through syncs", async () => {
    expect((await post('/api/host/sessions/RTD-HS-00002/places', { places: 8 }, SAM)).status).toBe(200);
    expect((await post(`/api/host/occurrences/${CATAN_2}/places`, { places: 6 }, SAM)).status).toBe(200);
    expect((await syncAll('again')).status).toBe(200);
    expect(await availability(CATAN_1)).toMatchObject({ capacity: 8 });
    expect(await availability(CATAN_2)).toMatchObject({ capacity: 6 });
  });
});
