// Booking modes (docs/RTD_EVENT_CONTROL_AUDIT.md G-5, D-6; Stage 4a): whether people
// need to book: Not required ('none'), Optional or Required. Defaults by kind; an
// approver changes it in the organiser; bookings already made always stand.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diaryRow, env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const SAM = as('sam@example.com'); // host
const MICHELLE = as('michelle@example.com'); // approver
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const ROOT = 'RTD-OCC-00001-20261008'; // Sam's session, 4 places
const QUIZ = 'RTD-OCC-00004-20261008'; // the café's own event
const PARTY = 'RTD-OCC-00005-20261010'; // a private café event
const CLUB = 'RTD-OCC-00024-20261012'; // a weekly Standard Diary group
const QUIZ_EVT = 'RTD-EVT-00004';
const CLUB_EVT = 'RTD-EVT-00024';

const rows = () => [
  indexRow(1, { 'Event Name': 'Root Night', Day: 'Thursday', 'Event Date': '08/10/2026', 'Event Time': '19:00', 'App Capacity': '4', 'App Host Session': 'RTD-HS-00001', 'App Category': 'Gaming' }),
  indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '08/10/2026', 'Event Time': '19:30' }),
  indexRow(5, { 'Event Name': 'Party', Day: 'Saturday', 'Event Date': '10/10/2026', 'App Visibility': 'Private' }),
];
const syncAll = (runId: string) => sync({ run_id: runId, sources: { event_index: rows(), standard_diary: [diaryRow(24, { Group: 'Chess Club' })] } });

const book = (occurrence: string, email: string, party = 2) =>
  request('/api/bookings', json({ occurrence_id: occurrence, lead_name: 'Ava Player', email, party_size: party }));
const availability = async (id: string) => (await request(`/api/bookings/availability/${id}`)).json<Record<string, unknown>>();
const setMode = (eventId: string, body: unknown, who: Partial<Env> = MICHELLE) => request(`/api/staff/events/${eventId}/booking-mode`, json(body), who);
const listed = async () => {
  const { occurrences } = await (await request('/api/events')).json<{ occurrences: { occurrence_id: string; booking_mode: string; bookable: boolean }[] }>();
  return Object.fromEntries(occurrences.filter(o => [ROOT, QUIZ, PARTY, CLUB].includes(o.occurrence_id)).map(o => [o.occurrence_id, [o.booking_mode, o.bookable]]));
};
const panel = async (eventId: string) => {
  const { events } = await (await request('/api/staff/event-places', {}, MICHELLE)).json<{ events: Record<string, unknown>[] }>();
  return events.find(e => e.event_id === eventId);
};

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
  ]);
  await request('/api/host/sessions', json({ name: 'Root Night', event_date: '2026-10-08', start_time: '19:00', end_time: '22:00', price_pence: 0, max_players: 4 }), SAM);
  await request('/api/staff/host-sessions/RTD-HS-00001/decision', json({ decision: 'approve' }), MICHELLE);
  expect((await syncAll('setup')).status).toBe(200);
});
afterEach(() => vi.useRealTimers());

describe('booking modes', () => {
  it('defaults by kind: café events Optional, hosts’ sessions Required, Standard Diary groups Not required', async () => {
    expect(await listed()).toEqual({
      [ROOT]: ['required', true],
      [QUIZ]: ['optional', true],
      [PARTY]: ['none', false], // private: nothing about it leaves the server
      [CLUB]: ['none', false],
    });
    expect(await availability(QUIZ)).toMatchObject({ bookable: true, mode: 'optional', open: true });
    expect(await availability(ROOT)).toMatchObject({ bookable: true, mode: 'required', open: true });
    expect(await availability(CLUB)).toEqual({ bookable: false, mode: 'none' });
    const res = await book(CLUB, 'ava@example.com');
    expect(res.status).toBe(404);
    expect((await res.json<{ error: string }>()).error).toBe('No booking needed for this one: just come along.');
    expect(await panel(CLUB_EVT)).toMatchObject({ booking_mode: 'none', booking_mode_set: null, booking_mode_default: 'none', bookings: 0 });
  });

  it('lets an approver change it, back to the default too, and audits each change', async () => {
    expect((await setMode(CLUB_EVT, { mode: 'optional' })).status).toBe(200);
    expect((await listed())[CLUB]).toEqual(['optional', true]);
    expect((await book(CLUB, 'ava@example.com')).status).toBe(201);

    const res = await setMode(QUIZ_EVT, { mode: 'required' });
    expect(await res.json()).toEqual({ booking_mode: 'required', booking_mode_set: 'required' });
    expect((await listed())[QUIZ]).toEqual(['required', true]);
    expect(await panel(QUIZ_EVT)).toMatchObject({ booking_mode: 'required', booking_mode_set: 'required', booking_mode_default: 'optional' });

    expect(await (await setMode(QUIZ_EVT, { mode: 'default' })).json()).toEqual({ booking_mode: 'optional', booking_mode_set: null });
    expect((await listed())[QUIZ]).toEqual(['optional', true]);

    // The sheet sync leaves it alone.
    expect((await syncAll('again')).status).toBe(200);
    expect((await listed())[CLUB]).toEqual(['optional', true]);

    const audit = await env.DB.prepare("SELECT entity_id, actor_id, previous_value, new_value FROM audit_log WHERE action = 'event.booking_mode_changed' ORDER BY audit_id").all();
    expect(audit.results).toEqual([
      { entity_id: CLUB_EVT, actor_id: 'michelle@example.com', previous_value: 'default (none)', new_value: 'optional' },
      { entity_id: QUIZ_EVT, actor_id: 'michelle@example.com', previous_value: 'default (optional)', new_value: 'required' },
      { entity_id: QUIZ_EVT, actor_id: 'michelle@example.com', previous_value: 'required', new_value: 'default (optional)' },
    ]);
  });

  it('warns before switching to Not required with people booked, and their bookings stand', async () => {
    const { manage_path } = await (await book(QUIZ, 'ava@example.com', 3)).json<{ manage_path: string }>();
    expect(await panel(QUIZ_EVT)).toMatchObject({ bookings: 1 });

    const warned = await setMode(QUIZ_EVT, { mode: 'none' });
    expect(warned.status).toBe(409);
    expect(await warned.json()).toEqual({ warning: { bookings: 1, people: 3 } });
    expect((await listed())[QUIZ]).toEqual(['optional', true]); // nothing changed

    expect((await setMode(QUIZ_EVT, { mode: 'none', confirm: true })).status).toBe(200);
    expect((await listed())[QUIZ]).toEqual(['none', false]);
    expect(await availability(QUIZ)).toEqual({ bookable: false, mode: 'none' });
    expect((await book(QUIZ, 'late@example.com')).status).toBe(404);

    // The booking stands: still confirmed, and its link still shows and cancels it.
    const token = manage_path.split('#t=')[1]!;
    const view = await (await request('/api/bookings/RTD-BK-00001/view', json({ token }))).json<{ booking: Record<string, unknown> }>();
    expect(view.booking).toMatchObject({ status: 'confirmed', party_size: 3, can_cancel: true });
    expect((await request('/api/bookings/RTD-BK-00001/cancel', json({ token }))).status).toBe(200);
  });

  it('says it differently when the places run out: Optional can still come along, Required is full', async () => {
    expect((await request(`/api/staff/events/${QUIZ_EVT}/places`, json({ places: 2 }), MICHELLE)).status).toBe(200);
    expect((await book(QUIZ, 'ava@example.com', 2)).status).toBe(201);
    const optional = await book(QUIZ, 'ben@example.com', 1);
    expect(optional.status).toBe(409);
    expect((await optional.json<{ error: string }>()).error).toBe('All the places you can reserve have gone, but you can still come along on the day.');
    expect((await setMode(QUIZ_EVT, { mode: 'required' })).status).toBe(200);
    expect((await (await book(QUIZ, 'ben@example.com', 1)).json<{ error: string }>()).error).toBe('Sorry, this one is full.');
  });

  it("refuses hosts' sessions, markets, unknown events and modes, and anyone but approvers", async () => {
    expect(await (await setMode('RTD-EVT-00001', { mode: 'none' })).json()).toMatchObject({ error: "This is a host's session: people always book those." });
    expect((await setMode('RTD-EVT-00001', { mode: 'none' })).status).toBe(409);
    expect((await setMode('RTD-EVT-09999', { mode: 'none' })).status).toBe(404);
    expect((await setMode(QUIZ_EVT, { mode: 'sometimes' })).status).toBe(400);
    expect((await setMode(QUIZ_EVT, {})).status).toBe(400);
    expect((await setMode(QUIZ_EVT, { mode: 'none' }, SAM)).status).toBe(403);
    expect((await setMode(QUIZ_EVT, { mode: 'none' }, {})).status).toBe(401);
    expect((await listed())[QUIZ]).toEqual(['optional', true]);
  });
});
