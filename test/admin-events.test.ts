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
    'Approved Facts': 'Booking: essential',
    'People & Roles': '',
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

const book = (occurrenceId: string, party: number, email = 'ava@example.com') =>
  request('/api/bookings', json({ occurrence_id: occurrenceId, lead_name: 'Ava Player', email, party_size: party }));
const CATAN_13 = 'RTD-OCC-00002-20261013';

describe('places and booking on host sessions', () => {
  it('lets an admin change a host session’s places and booking', async () => {
    expect((await request(`/api/host/sessions/${CATAN}/places`, json({ places: 12 }), DAN)).status).toBe(200);
    expect((await form(CATAN_EVT)).places).toBe(12);
    expect((await request(`/api/staff/events/${CATAN_EVT}/booking-mode`, json({ mode: 'optional' }), DAN)).status).toBe(200);
    expect((await form(CATAN_EVT)).booking_mode).toBe('optional');
    const audit = await env.DB.prepare("SELECT actor_type, actor_id FROM audit_log WHERE action = 'host_session.places_changed'").first();
    expect(audit).toEqual({ actor_type: 'staff', actor_id: 'dan@example.com' });
  });

  it('still refuses an approver on a host session’s booking', async () => {
    expect((await request(`/api/staff/events/${CATAN_EVT}/booking-mode`, json({ mode: 'optional' }), MICHELLE)).status).toBe(409);
    expect((await request(`/api/host/sessions/${CATAN}/places`, json({ places: 12 }), MICHELLE)).status).toBe(403);
  });

  it('never lets places go below what is booked, for an admin too', async () => {
    expect((await book(CATAN_13, 3)).status).toBe(201);
    const res = await request(`/api/host/sessions/${CATAN}/places`, json({ places: 2 }), DAN);
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('already booked');
  });
});

describe('a host can only touch their own sessions', () => {
  it('refuses another host everywhere', async () => {
    expect((await request(`/api/host/sessions/${CATAN}/places`, json({ places: 5 }), ALEX)).status).toBe(403);
    expect((await request(`/api/host/occurrences/${CATAN_13}/places`, json({ places: 5 }), ALEX)).status).toBe(403);
    expect((await request(`/api/host/occurrences/${CATAN_13}/cancel`, json({ message: 'No' }), ALEX)).status).toBe(403);
    expect((await request(`/api/host/sessions/${CATAN}/changes`, json({ name: 'Mine now' }), ALEX)).status).toBe(404);
    expect((await request(`/api/staff/events/${QUIZ}/places`, json({ places: 5 }), ALEX)).status).toBe(403);
    expect((await request(`/api/staff/events/${CATAN_EVT}`, json({ details: { name: 'Mine now' } }), ALEX)).status).toBe(403);
    expect((await form(CATAN_EVT)).details).toMatchObject({ name: 'Catan Club' });
    expect((await form(CATAN_EVT)).places).toBe(20);
  });
});

const save = (id: string, body: unknown, who: Partial<Env> = DAN) => request(`/api/staff/events/${id}`, json(body), who);
const stop = (id: string, body: unknown = {}, who: Partial<Env> = DAN) => request(`/api/staff/events/${id}/stop`, json(body), who);
const toApply = async () =>
  (await (await request('/internal/host-changes', { headers: AUTH })).json<{ changes: { request_id: string; row: Row }[] }>()).changes;
const outbox = async () => (await env.DB.prepare('SELECT kind, to_email, subject, html FROM outbox ORDER BY message_id').all<Record<string, string>>()).results;

describe('an admin changes a host session', () => {
  it('applies an admin’s change straight away, emails the host and booked people', async () => {
    expect((await book(CATAN_13, 2)).status).toBe(201);
    await env.DB.prepare('DELETE FROM outbox').run();
    const res = await save(CATAN_EVT, { details: { start_time: '19:00', name: 'Catan Night' } });
    expect(res.status).toBe(200);
    const { change } = await res.json<{ change: Record<string, unknown> }>();
    expect(change).toMatchObject({ status: 'approved', decided_by: 'dan@example.com' });
    expect(await env.DB.prepare('SELECT origin FROM event_change_requests WHERE request_id = ?1').bind(change.request_id).first('origin')).toBe('admin');
    const mail = await outbox();
    expect(mail.filter(m => m.kind === 'host_change_by_admin').map(m => [m.to_email, m.subject])).toEqual([
      ['sam@example.com', 'Your session was changed: Catan Club'],
    ]);
    expect(mail.filter(m => m.kind === 'attendee_time_changed').map(m => m.to_email)).toEqual(['ava@example.com']);
    const [row] = await toApply();
    expect(row!.row).toMatchObject({ 'Event ID': CATAN_EVT, 'Event Name': 'Catan Night', 'Event Time': '19:00' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'host_session.changed_by_admin'").first('n')).toBe(1);
  });

  it('writes Hidden and Inactive for a host session', async () => {
    expect((await save(CATAN_EVT, { visibility: 'hidden' })).status).toBe(200);
    const [first] = await toApply();
    expect(first!.row).toEqual({ 'Event ID': CATAN_EVT, 'App Visibility': 'Hidden' });
    await request(`/internal/host-changes/${first!.request_id}/applied`, json({}, AUTH));
    expect((await stop(CATAN_EVT)).status).toBe(200);
    const [second] = await toApply();
    expect(second!.row).toEqual({ 'Event ID': CATAN_EVT, Status: 'Inactive' });
  });

  it('asks the admin to decide a pending host request first', async () => {
    const live = (await (await request('/api/host/sessions', {}, SAM)).json<{ sessions: { session_id: string; live: Row }[] }>()).sessions[0]!.live!;
    expect((await request(`/api/host/sessions/${CATAN}/changes`, json({ ...live, start_time: '19:30' }), SAM)).status).toBe(201);
    const res = await save(CATAN_EVT, { details: { name: 'Catan Night' } });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('RTD-CR-00001');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM event_change_requests').first('n')).toBe(1);
  });

  it('refuses to move a booked date', async () => {
    expect((await book(CATAN_13, 2)).status).toBe(201);
    const res = await save(CATAN_EVT, { details: { event_date: '2026-10-20' } });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('Cancel this date first');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM event_change_requests').first('n')).toBe(0);
  });

  it('says when nothing has changed', async () => {
    expect((await save(CATAN_EVT, { details: { name: 'Catan Club' }, visibility: 'public' })).status).toBe(400);
  });
});

const setLive = () =>
  env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('sheet_writes', 'live', '2026-10-01', 'test') ON CONFLICT (key) DO UPDATE SET value = 'live'",
  ).run();

describe('an admin changes a café event', () => {
  beforeEach(setLive);

  it('queues café detail changes for the Logic Engine and applies places at once', async () => {
    const res = await save(QUIZ, { details: { name: 'Big Quiz' }, visibility: 'private', places: 40, booking_mode: 'required' });
    expect(res.status).toBe(200);
    const out = await res.json<{ sheet_edit: { fields: unknown; status: string }; places: number; booking_mode: string }>();
    expect(out.sheet_edit.fields).toEqual({ 'Event Name': { from: 'Event 4', to: 'Big Quiz' }, 'App Visibility': { from: 'public', to: 'private' } });
    expect(out.sheet_edit.status).toBe('queued');
    expect(
      await env.DB.prepare('SELECT capacity_override AS c, booking_mode AS m, display_name AS n FROM events WHERE event_id = ?1').bind(QUIZ).first(),
    ).toEqual({
      c: 40,
      m: 'required',
      n: 'Event 4',
    });
  });

  it('writes a Standard Diary row’s own columns', async () => {
    const res = await save(DIARY, { details: { description: 'Bring a friend.' }, visibility: 'hidden' });
    expect(res.status).toBe(200);
    expect((await res.json<{ sheet_edit: { fields: unknown } }>()).sheet_edit.fields).toEqual({
      Notes: { from: 'Notes for group 8', to: 'Bring a friend.' },
      'App Visibility': { from: 'public', to: 'hidden' },
    });
  });

  it('refuses a column the Standard Diary hasn’t got', async () => {
    const res = await save(DIARY, { details: { start_time: '19:00' } });
    expect(res.status).toBe(400);
    expect((await res.json<{ errors: Record<string, string> }>()).errors.start_time).toContain('Standard Diary');
  });

  it('refuses while a Logic Engine change is on its way', async () => {
    expect((await save(QUIZ, { details: { name: 'Big Quiz' } })).status).toBe(200);
    const res = await save(QUIZ, { details: { description: 'New' } });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('still on its way');
  });

  it('refuses an event not in the last sync', async () => {
    await env.DB.prepare('UPDATE events SET last_synced_at = NULL WHERE event_id = ?1').bind(QUIZ).run();
    const res = await save(QUIZ, { details: { name: 'Big Quiz' } });
    expect(res.status).toBe(409);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sheet_edits').first('n')).toBe(0);
  });

  it('refuses to move a booked café date', async () => {
    expect((await book('RTD-OCC-00004-20261023', 2)).status).toBe(201);
    const res = await save(QUIZ, { details: { event_date: '2026-10-30' } });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('Cancel this date first');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sheet_edits').first('n')).toBe(0);
  });

  it('applies nothing when the details are refused', async () => {
    const res = await save(QUIZ, { details: { start_time: '25:00' }, places: 40 });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare('SELECT capacity_override FROM events WHERE event_id = ?1').bind(QUIZ).first('capacity_override')).toBeNull();
  });

  it('warns that people booked will be emailed a new time, then queues it', async () => {
    expect((await book('RTD-OCC-00004-20261023', 2)).status).toBe(201);
    const first = await save(QUIZ, { details: { start_time: '19:00' } });
    expect(first.status).toBe(409);
    expect((await first.json<{ warning: string }>()).warning).toContain('emailed the new time');
    expect((await save(QUIZ, { details: { start_time: '19:00' }, confirm: true })).status).toBe(200);
  });

  it('ignores details sent unchanged, so places still save', async () => {
    const res = await save(QUIZ, { details: { name: 'Event 4' }, visibility: 'public', places: 40 });
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).sheet_edit).toBeUndefined();
    expect(await env.DB.prepare('SELECT capacity_override FROM events WHERE event_id = ?1').bind(QUIZ).first('capacity_override')).toBe(40);
    expect((await save(CATAN_EVT, { details: { name: 'Catan Club' }, places: 15 })).status).toBe(200);
  });

  it('refuses approvers', async () => {
    expect((await save(QUIZ, { details: { name: 'Big Quiz' } }, MICHELLE)).status).toBe(403);
  });
});

describe("an admin sets a host session's posting, Michelle's voice and social facts", () => {
  beforeEach(setLive);

  it('offers those columns and the category in the form, and nothing the host owns', async () => {
    const e = await form(CATAN_EVT);
    expect(Object.keys(e.sheet as object).sort()).toEqual(
      [
        'Approved Facts',
        'Banned Phrases',
        "Michelle's Standard Prompt",
        'Michelles KPI Hook Prompt',
        'People & Roles',
        'Photo Folder ID',
        'Post Frequency (Days)',
        'Target Post Time',
        'TikTok Video Blueprint',
      ].sort(),
    );
    expect(e.sheet).toMatchObject({ 'Approved Facts': 'Booking: essential', 'People & Roles': '', 'Photo Folder ID': '' });
    expect(e.unavailable).toEqual({});
  });

  it('queues the social columns and the category for the Logic Engine', async () => {
    const res = await save(CATAN_EVT, { sheet: { 'Approved Facts': 'Booking: essential\nLevel: all', 'People & Roles': 'Sam - host' }, details: { category: 'Social' } });
    expect(res.status).toBe(200);
    const out = await res.json<{ sheet_edit: { fields: unknown }; change?: unknown }>();
    expect(out.sheet_edit.fields).toEqual({
      'App Category': { from: 'Gaming', to: 'Social' },
      'Approved Facts': { from: 'Booking: essential', to: 'Booking: essential\nLevel: all' },
      'People & Roles': { from: '', to: 'Sam - host' },
    });
    expect(out.change).toBeUndefined();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM event_change_requests').first('n')).toBe(0);
    expect((await form(CATAN_EVT)).pending_fields).toMatchObject({ 'People & Roles': { from: '', to: 'Sam - host' } });
  });

  it("sends the host's details as a change and the social columns to the Logic Engine in one save", async () => {
    const res = await save(CATAN_EVT, { details: { name: 'Catan Night' }, sheet: { 'People & Roles': 'Sam - host' } });
    expect(res.status).toBe(200);
    const out = await res.json<{ sheet_edit: { fields: unknown }; change: Record<string, unknown> }>();
    expect(out.sheet_edit.fields).toEqual({ 'People & Roles': { from: '', to: 'Sam - host' } });
    expect(out.change).toMatchObject({ status: 'approved' });
    const [row] = await toApply();
    expect(row!.row).toEqual({ 'Event ID': CATAN_EVT, 'Event Name': 'Catan Night' });
  });

  it('refuses a column the host owns, and sends nothing', async () => {
    const res = await save(CATAN_EVT, { sheet: { Frequency: 'Monthly', 'People & Roles': 'Sam - host' } });
    expect(res.status).toBe(400);
    expect((await res.json<{ errors: Record<string, string> }>()).errors.Frequency).toContain("can't be changed");
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sheet_edits').first('n')).toBe(0);
  });

  it('sends nothing when the host change is refused', async () => {
    const live = (await (await request('/api/host/sessions', {}, SAM)).json<{ sessions: { live: Row }[] }>()).sessions[0]!.live!;
    expect((await request(`/api/host/sessions/${CATAN}/changes`, json({ ...live, start_time: '19:30' }), SAM)).status).toBe(201);
    expect((await save(CATAN_EVT, { details: { name: 'Catan Night' }, sheet: { 'People & Roles': 'Sam - host' } })).status).toBe(409);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sheet_edits').first('n')).toBe(0);
    // The social columns alone don't wait for the host's request.
    expect((await save(CATAN_EVT, { sheet: { 'People & Roles': 'Sam - host' } })).status).toBe(200);
  });
});

describe('stop running an event', () => {
  beforeEach(setLive);

  it('warns, then cancels every booked date and stops the event', async () => {
    expect((await save(DIARY, { booking_mode: 'optional' })).status).toBe(200);
    expect((await book('RTD-OCC-00008-20261012', 2)).status).toBe(201);
    expect((await book('RTD-OCC-00008-20261019', 1, 'ben@example.com')).status).toBe(201);
    await env.DB.prepare('DELETE FROM outbox').run();
    const first = await stop(DIARY, { message: 'The group has ended.' });
    expect(first.status).toBe(409);
    expect((await first.json<{ warning: unknown }>()).warning).toEqual({ dates: 2, bookings: 2, people: 3 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM occurrences WHERE status = 'cancelled'").first('n')).toBe(0);

    const res = await stop(DIARY, { message: 'The group has ended.', confirm: true });
    expect(res.status).toBe(200);
    const out = await res.json<{ cancelled_dates: number; cancelled_bookings: number; sheet_edit: { fields: Record<string, { to: string }> }; note: string }>();
    expect(out).toMatchObject({ cancelled_dates: 2, cancelled_bookings: 2 });
    expect(out.sheet_edit.fields['App Visibility']!.to).toBe('hidden');
    expect(out.note).toContain('no Status column');
    const mail = await env.DB.prepare("SELECT to_email FROM outbox WHERE kind = 'attendee_date_cancelled' ORDER BY to_email").all<{ to_email: string }>();
    expect(mail.results.map(m => m.to_email)).toEqual(['ava@example.com', 'ben@example.com']);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'event.stopped'").first('n')).toBe(1);
  });

  it('stops without asking when nobody is booked', async () => {
    const res = await stop(QUIZ);
    expect(res.status).toBe(200);
    const out = await res.json<{ cancelled_dates: number; sheet_edit: { fields: Record<string, { to: string }> } }>();
    expect(out.cancelled_dates).toBe(0);
    expect(out.sheet_edit.fields.Status!.to).toBe('Inactive');
  });

  it('stops a host session through the approved-change path', async () => {
    expect((await stop(CATAN_EVT)).status).toBe(200);
    const [row] = await toApply();
    expect(row!.row).toEqual({ 'Event ID': CATAN_EVT, Status: 'Inactive' });
  });

  it('leaves a date that has already started, and still stops the event', async () => {
    expect((await book('RTD-OCC-00004-20261023', 2)).status).toBe(201);
    vi.setSystemTime(new Date('2026-10-23T18:00:00Z')); // 19:00 in London: the 18:30 start has passed
    const res = await stop(QUIZ, { confirm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cancelled_dates: 0, cancelled_bookings: 0 });
  });

  it('cancels nothing while another change is on its way', async () => {
    expect((await book('RTD-OCC-00004-20261023', 2)).status).toBe(201);
    expect((await save(QUIZ, { details: { name: 'Big Quiz' } })).status).toBe(200);
    const res = await stop(QUIZ, { confirm: true });
    expect(res.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM occurrences WHERE status = 'cancelled'").first('n')).toBe(0);
  });

  it('refuses approvers', async () => {
    expect((await stop(QUIZ, {}, MICHELLE)).status).toBe(403);
  });
});

describe('review fixes', () => {
  beforeEach(setLive);
  const count = async (sql: string) => Number(await env.DB.prepare(sql).first('n'));

  it('applies booking before details, so a warned save sends nothing twice', async () => {
    expect((await book(CATAN_13, 2)).status).toBe(201);
    await env.DB.prepare('DELETE FROM outbox').run();
    const first = await save(CATAN_EVT, { details: { start_time: '19:00' }, booking_mode: 'none' });
    expect(first.status).toBe(409);
    expect(await count('SELECT COUNT(*) AS n FROM event_change_requests')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM outbox')).toBe(0);
    expect((await save(CATAN_EVT, { details: { start_time: '19:00' }, booking_mode: 'none', confirm: true })).status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM event_change_requests')).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'attendee_time_changed'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'host_change_by_admin'")).toBe(1);
  });

  it('queues no café change when places are refused', async () => {
    expect((await book('RTD-OCC-00004-20261023', 3)).status).toBe(201);
    const res = await save(QUIZ, { details: { name: 'Big Quiz' }, places: 2 });
    expect(res.status).toBe(409);
    expect(await count('SELECT COUNT(*) AS n FROM sheet_edits')).toBe(0);
  });

  it('refuses a second admin change to a session while the first is on its way', async () => {
    expect((await save(CATAN_EVT, { details: { start_time: '19:00' } })).status).toBe(200);
    expect((await form(CATAN_EVT)).pending).toEqual({ kind: 'change_on_way', id: 'RTD-CR-00001' });
    const again = await save(CATAN_EVT, { details: { start_time: '19:00' } });
    expect(again.status).toBe(409);
    expect((await again.json<{ error: string }>()).error).toContain('RTD-CR-00001');
    expect(await count('SELECT COUNT(*) AS n FROM event_change_requests')).toBe(1);
  });

  it('cancels nothing when the event could not then be stopped', async () => {
    expect((await book('RTD-OCC-00004-20261023', 2)).status).toBe(201);
    await env.DB.prepare("UPDATE settings SET value = 'off' WHERE key = 'sheet_writes'").run();
    expect((await stop(QUIZ, { confirm: true })).status).toBe(409);
    await env.DB.prepare("UPDATE settings SET value = 'live' WHERE key = 'sheet_writes'").run();
    await env.DB.prepare('UPDATE events SET last_synced_at = NULL WHERE event_id = ?1').bind(QUIZ).run();
    expect((await stop(QUIZ, { confirm: true })).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM occurrences WHERE status = 'cancelled'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM bookings WHERE status = 'cancelled'")).toBe(0);
  });

  it('only stops through Stop running, never a plain save', async () => {
    expect((await save(QUIZ, { active: false })).status).toBe(400);
  });

  it('starts a stopped café event again', async () => {
    const res = await save('RTD-EVT-00007', { active: true });
    expect(res.status).toBe(200);
    expect((await res.json<{ sheet_edit: { fields: unknown } }>()).sheet_edit.fields).toEqual({ Status: { from: 'Inactive', to: 'Active' } });
  });

  it('starts a stopped host session again, and changes nothing else until then', async () => {
    expect((await stop(CATAN_EVT)).status).toBe(200);
    const [stopped] = await toApply();
    await request(`/internal/host-changes/${stopped!.request_id}/applied`, json({}, AUTH));
    expect(
      (await sync({ run_id: `r${++run}`, sources: { ...rows(), event_index: [catanRow({ Status: 'Inactive' }), ...rows().event_index.slice(1)] } })).status,
    ).toBe(200);
    expect((await form(CATAN_EVT)).active).toBe(false);
    const early = await save(CATAN_EVT, { details: { name: 'Catan Night' } });
    expect(early.status).toBe(409);
    expect((await early.json<{ error: string }>()).error).toContain('Start it running');
    expect((await save(CATAN_EVT, { active: true })).status).toBe(200);
    const [started] = await toApply();
    expect(started!.row).toEqual({ 'Event ID': CATAN_EVT, Status: 'Active' });
  });
});
