import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const SAM = as('sam@example.com'); // hosts every session here
const ALEX = as('alex@example.com'); // another host
const MICHELLE = as('michelle@example.com'); // approver
const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});
const AUTH = { Authorization: 'Bearer test-sync-token' };

const ROOT = 'RTD-OCC-00001-20261008'; // open one-off, Thu 8 Oct 19:00, £5, 4 places
const CATAN = 'RTD-OCC-00002-20261013'; // open weekly from Tue 13 Oct, free, 20 places
const BIRTHDAY = 'RTD-OCC-00003-20261009'; // private
const QUIZ = 'RTD-OCC-00004-20261008'; // the café's own event: no App Capacity, so no limit

type Outbox = { kind: string; to_email: string | null; reply_to: string | null; subject: string; html: string; dedupe_key: string };
const outbox = async () => (await env.DB.prepare('SELECT kind, to_email, reply_to, subject, html, dedupe_key FROM outbox ORDER BY message_id').all<Outbox>()).results;
const book = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  request('/api/bookings', json({ occurrence_id: ROOT, lead_name: 'Ava Player', email: 'ava@example.com', party_size: 2, ...over }, headers));
const availability = async (id: string) => (await request(`/api/bookings/availability/${id}`)).json<Record<string, unknown>>();
const tokenFrom = (path: string) => path.split('#t=')[1]!;

const rows = () => [
  indexRow(1, { 'Event Name': 'Root Night', Day: 'Thursday', 'Event Date': '08/10/2026', 'Event Time': '19:00', 'End Time': '22:00', 'App Price': '£5', 'App Capacity': '4', 'App Host Session': 'RTD-HS-00001', 'App Category': 'Gaming' }),
  indexRow(2, { 'Event Name': 'Catan Club', Frequency: 'Weekly', Day: 'Tuesday', 'Event Date': '13/10/2026', 'Event Time': '18:30', 'End Time': '', 'App Price': 'Free', 'App Capacity': '20', 'App Host Session': 'RTD-HS-00002', 'App Category': 'Gaming' }),
  indexRow(3, { 'Event Name': 'Birthday', Day: 'Friday', 'Event Date': '09/10/2026', 'App Visibility': 'Private', 'App Capacity': '6', 'App Host Session': 'RTD-HS-00003' }),
  indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '08/10/2026' }),
];

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z')); // 11:00 in London
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-alex', 'alex@example.com', 'Alex', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
  ]);
  const base = { start_time: '19:00', end_time: '22:00', price_pence: 500, max_players: 4 };
  await request('/api/host/sessions', json({ ...base, name: 'Root Night', event_date: '2026-10-08' }), SAM);
  await request('/api/host/sessions', json({ ...base, name: 'Catan Club', event_date: '2026-10-13', frequency: 'weekly', start_time: '18:30', end_time: '', price_pence: 0, max_players: 20 }), SAM);
  await request('/api/host/sessions', json({ ...base, name: 'Birthday', event_date: '2026-10-09', access: 'private', max_players: 6 }), SAM);
  for (const id of ['RTD-HS-00001', 'RTD-HS-00002', 'RTD-HS-00003']) {
    await request(`/api/staff/host-sessions/${id}/decision`, json({ decision: 'approve' }), MICHELLE);
  }
  expect((await sync({ run_id: 'setup', sources: { event_index: rows() } })).status).toBe(200);
  await env.DB.prepare('DELETE FROM outbox').run();
});
afterEach(() => vi.useRealTimers());

describe('what can be booked', () => {
  it('takes bookings for every public event, but never private ones', async () => {
    expect(await availability(ROOT)).toEqual({ bookable: true, open: true, reason: null, capacity: 4, places_left: 4, max_party: 4 });
    expect(await availability(QUIZ)).toEqual({ bookable: true, open: true, reason: null, capacity: null, places_left: null, max_party: 10 });
    expect(await availability(BIRTHDAY)).toEqual({ bookable: false });
    expect(await availability('RTD-OCC-nonsense')).toEqual({ bookable: false });
    const { occurrences } = await (await request('/api/events')).json<{ occurrences: { occurrence_id: string; bookable: boolean }[] }>();
    expect(Object.fromEntries(occurrences.filter(o => [ROOT, BIRTHDAY, QUIZ].includes(o.occurrence_id)).map(o => [o.occurrence_id, o.bookable]))).toEqual({
      [ROOT]: true,
      [BIRTHDAY]: false,
      [QUIZ]: true,
    });
    expect((await book({ occurrence_id: BIRTHDAY })).status).toBe(404);
  });

  it('has no limit on numbers for an event without App Capacity', async () => {
    for (let i = 0; i < 4; i++) expect((await book({ occurrence_id: QUIZ, email: `team${i}@example.com`, party_size: 10 })).status).toBe(201);
    expect(await availability(QUIZ)).toMatchObject({ open: true, places_left: null, max_party: 10 });
    expect((await book({ occurrence_id: QUIZ, email: 'big@example.com', party_size: 11 })).status).toBe(400); // still 10 a booking
  });

  it('is never cached', async () => {
    expect((await request(`/api/bookings/availability/${ROOT}`)).headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('booking', () => {
  it('books, then emails the person, the café and the host', async () => {
    const res = await book({ lead_name: 'Ava <b>Player</b>', mobile: '07700 900123', notes: 'First time playing!' });
    expect(res.status).toBe(201);
    const body = await res.json<{ booking: Record<string, unknown>; manage_path: string; availability: Record<string, unknown> }>();
    expect(body.booking).toMatchObject({ booking_id: 'RTD-BK-00001', party_size: 2, name: 'Root Night', event_date: '2026-10-08' });
    expect(body.manage_path).toMatch(/^\/booking\/RTD-BK-00001#t=[\w-]{30,}$/);
    expect(body.availability).toMatchObject({ places_left: 2, max_party: 2 });

    const [toGuest, toCafe, toHost] = await outbox();
    // Replies to the confirmation reach the café's bookings inbox (info@, filled in by n8n).
    expect(toGuest).toMatchObject({ kind: 'booking_confirmed', to_email: 'ava@example.com', reply_to: '@bookings', subject: "You're booked: Root Night, Thu 8 Oct", dedupe_key: 'booking-confirmed:RTD-BK-00001' });
    expect(toGuest!.html).toContain(`http://localhost${body.manage_path}`);
    expect(toGuest!.html).toContain('Thursday 8 October, 7pm–10pm');
    expect(toGuest!.html).toContain('£5 per player, paid at the café');
    expect(toGuest!.html).toContain('Ava &lt;b&gt;Player&lt;/b&gt;');
    expect(toGuest!.html).not.toContain('<b>Player');
    expect(toGuest!.html).toContain('Hosted by:</strong> Sam');
    // The café gets every booking, with how to reach the person; replying reaches them.
    expect(toCafe).toMatchObject({ kind: 'cafe_new_booking', to_email: '@bookings', reply_to: 'ava@example.com', subject: 'New booking: Root Night, Thu 8 Oct (2 places)', dedupe_key: 'booking-new-cafe:RTD-BK-00001' });
    for (const bit of ['ava@example.com', '07700 900123', 'First time playing!', 'RTD-BK-00001', '2 of 4 places now booked', 'Hosted by:</strong> Sam Host', 'Ava &lt;b&gt;Player']) expect(toCafe!.html).toContain(bit);
    // The host gets names and numbers, not contact details.
    expect(toHost).toMatchObject({ kind: 'host_new_booking', to_email: 'sam@example.com', reply_to: null, subject: 'New booking: Root Night, Thu 8 Oct' });
    expect(toHost!.html).toContain('2 of 4 places are now taken');
    expect(toHost!.html).toContain('First time playing!');
    expect(toHost!.html).not.toContain('07700');

    const audit = await env.DB.prepare("SELECT entity_id, occurrence_id, actor_type, action FROM audit_log WHERE entity_type = 'booking'").all();
    expect(audit.results).toEqual([{ entity_id: 'RTD-BK-00001', occurrence_id: ROOT, actor_type: 'customer', action: 'booking.created' }]);
  });

  it("emails the café, not a host, for the café's own events", async () => {
    expect((await book({ occurrence_id: QUIZ, party_size: 6 })).status).toBe(201);
    const mail = await outbox();
    expect(mail.map(m => [m.kind, m.to_email])).toEqual([
      ['booking_confirmed', 'ava@example.com'],
      ['cafe_new_booking', '@bookings'],
    ]);
    expect(mail[0]!.html).not.toContain('Hosted by');
    expect(mail[0]!.html).not.toContain('Cost:'); // the sheet has no price for it, so none is promised
    expect(mail[1]!.html).toContain('6 places now booked');
  });

  it('explains each problem with the form', async () => {
    const res = await book({ lead_name: 'A', email: 'nope', mobile: 'call me', party_size: 0, notes: 'x'.repeat(301) });
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json<{ errors: object }>()).errors).sort()).toEqual(['email', 'lead_name', 'mobile', 'notes', 'party_size']);
    expect((await book({ website: 'http://spam.example' })).status).toBe(400); // the hidden field
    for (const email of ['ava@example.com,eve@example.com', 'ava@example.com;eve@x.com', 'Ava <ava@example.com>', 'ava@localhost']) {
      expect((await book({ email })).status, email).toBe(400);
    }
    expect(await outbox()).toEqual([]);
    expect((await book({ email: " O'Neil.Ava+rtd@Example.co.uk " })).status).toBe(201);
  });

  it('never books more people than there are places', async () => {
    expect((await book({ party_size: 3 })).status).toBe(201);
    const tooMany = await book({ email: 'ben@example.com', party_size: 2 });
    expect(tooMany.status).toBe(409);
    expect((await tooMany.json<{ error: string }>()).error).toBe('Only 1 place left.');
    expect((await book({ email: 'ben@example.com', party_size: 1 })).status).toBe(201);
    expect(await availability(ROOT)).toMatchObject({ open: false, reason: 'full', places_left: 0 });
    expect((await book({ email: 'cat@example.com', party_size: 1 })).status).toBe(409);
  });

  it('takes one booking per person per date', async () => {
    expect((await book()).status).toBe(201);
    expect((await book({ email: 'AVA@example.com', party_size: 1 })).status).toBe(409);
  });

  it('limits how many bookings one email address or network makes', async () => {
    const weeks = ['20261013', '20261020', '20261027', '20261103', '20261110', '20261117'];
    for (const d of weeks.slice(0, 5)) expect((await book({ occurrence_id: `RTD-OCC-00002-${d}`, party_size: 1 })).status).toBe(201);
    const sixth = await book({ occurrence_id: 'RTD-OCC-00002-20261117', party_size: 1 });
    expect(sixth.status).toBe(429);
    const ip = { 'CF-Connecting-IP': '203.0.113.9' };
    for (let i = 0; i < 10; i++) expect((await book({ occurrence_id: CATAN, email: `p${i}@example.com`, party_size: 1 }, ip)).status).toBe(201);
    expect((await book({ occurrence_id: CATAN, email: 'p10@example.com', party_size: 1 }, ip)).status).toBe(429);
  });

  it('closes once the session has started', async () => {
    vi.setSystemTime(new Date('2026-10-08T18:05:00Z')); // 19:05 in London
    expect(await availability(ROOT)).toMatchObject({ open: false, reason: 'closed' });
    expect((await book()).status).toBe(409);
  });
});

describe('the Manage / Cancel link', () => {
  it('shows the booking only with its secret, and lets the person cancel', async () => {
    const { manage_path } = await (await book()).json<{ manage_path: string }>();
    const token = tokenFrom(manage_path);
    await env.DB.prepare('DELETE FROM outbox').run();
    expect((await request('/api/bookings/RTD-BK-00001/view', json({ token: 'x'.repeat(32) }))).status).toBe(404);
    const view = await (await request('/api/bookings/RTD-BK-00001/view', json({ token }))).json<{ booking: Record<string, unknown> }>();
    expect(view.booking).toMatchObject({ booking_id: 'RTD-BK-00001', name: 'Root Night', party_size: 2, status: 'confirmed', can_cancel: true });

    expect((await request('/api/bookings/RTD-BK-00001/cancel', json({ token: 'x'.repeat(32) }))).status).toBe(404);
    expect((await request('/api/bookings/RTD-BK-00001/cancel', json({ token }))).status).toBe(200);
    expect((await request('/api/bookings/RTD-BK-00001/cancel', json({ token }))).status).toBe(409);
    expect(await availability(ROOT)).toMatchObject({ places_left: 4 });
    const [toCafe, toHost] = await outbox();
    expect(toCafe).toMatchObject({ kind: 'cafe_booking_cancelled', to_email: '@bookings', reply_to: 'ava@example.com', subject: 'Booking cancelled: Root Night, Thu 8 Oct (2 places)' });
    expect(toCafe!.html).toContain('0 of 4 places now booked');
    expect(toHost).toMatchObject({ kind: 'host_booking_cancelled', to_email: 'sam@example.com', subject: 'Booking cancelled: Root Night, Thu 8 Oct' });
    expect(toHost!.html).toContain('0 of 4 places are now taken');
  });

  it('refuses cross-site and non-JSON requests', async () => {
    const res = await request('/api/bookings', { ...json({ occurrence_id: ROOT }), headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect((await request('/api/bookings', { method: 'POST', body: 'x' })).status).toBe(415);
  });
});

describe('the host', () => {
  it('sees who is booked on each upcoming date, without their contact details', async () => {
    await book({ notes: 'Bringing a friend' });
    await book({ occurrence_id: CATAN, email: 'ben@example.com', lead_name: 'Ben', party_size: 1 });
    const { sessions } = await (await request('/api/host/sessions', {}, SAM)).json<{ sessions: { session_id: string; dates: Record<string, unknown>[] }[] }>();
    const root = sessions.find(s => s.session_id === 'RTD-HS-00001')!;
    expect(root.dates).toEqual([
      expect.objectContaining({ occurrence_id: ROOT, status: 'scheduled', capacity: 4, booked: 2, bookings: [{ booking_id: 'RTD-BK-00001', lead_name: 'Ava Player', party_size: 2, notes: 'Bringing a friend' }] }),
    ]);
    expect(sessions.find(s => s.session_id === 'RTD-HS-00002')!.dates.length).toBeGreaterThan(3); // the weekly dates ahead
  });

  it("can't cancel someone else's session or a café event; an approver can", async () => {
    expect((await request(`/api/host/occurrences/${ROOT}/cancel`, json({}), ALEX)).status).toBe(403);
    expect((await request(`/api/host/occurrences/${QUIZ}/cancel`, json({}), SAM)).status).toBe(403);
    expect((await request('/api/host/occurrences/RTD-OCC-09999-20261008/cancel', json({}), MICHELLE)).status).toBe(404);
    expect((await request(`/api/host/occurrences/${ROOT}/cancel`, json({ message: 'Sorry, the café is closed for a private event' }), MICHELLE)).status).toBe(200);
    const notices = await outbox();
    expect(notices).toEqual([expect.objectContaining({ kind: 'host_date_cancelled', to_email: 'sam@example.com', subject: 'The café cancelled: Root Night, Thu 8 Oct' })]);
  });

  it('cancels a date: everyone booked and the café are emailed, and it leaves the diary', async () => {
    await book({ lead_name: 'Ava Player' });
    await book({ email: 'ben@example.com', lead_name: 'Ben', party_size: 1 });
    await env.DB.prepare('DELETE FROM outbox').run();
    const res = await request(`/api/host/occurrences/${ROOT}/cancel`, json({ message: 'Not enough players, sorry! <3' }), SAM);
    expect(await res.json()).toEqual({ ok: true, cancelled_bookings: 2 });
    expect((await request(`/api/host/occurrences/${ROOT}/cancel`, json({}), SAM)).status).toBe(409);

    const mail = await outbox();
    expect(mail.map(m => [m.kind, m.to_email, m.reply_to])).toEqual([
      ['attendee_date_cancelled', 'ava@example.com', '@bookings'],
      ['attendee_date_cancelled', 'ben@example.com', '@bookings'],
      ['cafe_date_cancelled', '@bookings', 'sam@example.com'],
    ]);
    expect(mail[0]!.subject).toBe('Cancelled: Root Night, Thu 8 Oct');
    expect(mail[0]!.html).toContain('cancelled by the host');
    expect(mail[0]!.html).toContain('A message from Sam: "Not enough players, sorry! &lt;3"');
    expect(mail[2]!.html).toContain('2 bookings (3 places) were cancelled');

    const statuses = await env.DB.prepare('SELECT status, cancelled_by FROM bookings ORDER BY booking_id').all();
    expect(statuses.results).toEqual([{ status: 'cancelled', cancelled_by: 'host' }, { status: 'cancelled', cancelled_by: 'host' }]);
    expect(await availability(ROOT)).toMatchObject({ open: false, reason: 'cancelled' });
    const diary = await (await request('/api/events')).json<{ occurrences: { occurrence_id: string }[] }>();
    expect(diary.occurrences.map(o => o.occurrence_id)).not.toContain(ROOT);
    const occ = await (await request(`/api/occurrences/${ROOT}`)).json<{ occurrence: { status: string } }>();
    expect(occ.occurrence.status).toBe('cancelled');

    // The next sync of the unchanged sheet doesn't bring it back.
    await sync({ run_id: 'after-cancel', sources: { event_index: rows() } });
    expect(await availability(ROOT)).toMatchObject({ reason: 'cancelled' });
    const audit = await env.DB.prepare("SELECT actor_type, action FROM audit_log WHERE occurrence_id = ?1 AND actor_type != 'n8n'").bind(ROOT).all();
    expect(audit.results).toEqual([
      { actor_type: 'customer', action: 'booking.created' },
      { actor_type: 'customer', action: 'booking.created' },
      { actor_type: 'host', action: 'occurrence.cancelled' },
    ]);
  });

  it('lets approvers see every hosted date, and booked café dates, with contact details', async () => {
    await book({ mobile: '07700 900123' });
    expect((await request('/api/staff/booked-dates', {}, SAM)).status).toBe(403);
    const list = async () => (await (await request('/api/staff/booked-dates', {}, MICHELLE)).json<{ dates: Record<string, unknown>[] }>()).dates;
    // A café date only appears once someone books it.
    expect((await list()).map(d => d.occurrence_id)).not.toContain(QUIZ);
    await book({ occurrence_id: QUIZ, email: 'quiz@example.com', lead_name: 'Quiz Team', party_size: 5 });
    const dates = await list();
    expect(dates.find(d => d.occurrence_id === QUIZ)).toMatchObject({
      event_name: 'Quiz',
      session: null,
      capacity: null,
      booked: 5,
      bookings: [expect.objectContaining({ lead_name: 'Quiz Team', email: 'quiz@example.com' })],
    });
    expect(dates.find(d => d.occurrence_id === ROOT)).toMatchObject({
      session: { name: 'Root Night', host_name: 'Sam Host', access: 'open' },
      bookings: [{ booking_id: 'RTD-BK-00001', lead_name: 'Ava Player', email: 'ava@example.com', mobile: '07700 900123', party_size: 2, notes: null }],
    });
    expect(dates.find(d => d.occurrence_id === BIRTHDAY)).toMatchObject({ session: { access: 'private' }, booked: 0 });
  });
});

describe("the café's own events", () => {
  it('lets an approver cancel a date: everyone booked is emailed, and the bookings inbox keeps a record', async () => {
    await book({ occurrence_id: QUIZ, party_size: 4 });
    await env.DB.prepare('DELETE FROM outbox').run();
    const res = await request(`/api/host/occurrences/${QUIZ}/cancel`, json({ message: 'The quizmaster is ill, sorry!' }), MICHELLE);
    expect(await res.json()).toEqual({ ok: true, cancelled_bookings: 1 });
    const mail = await outbox();
    expect(mail.map(m => [m.kind, m.to_email, m.reply_to])).toEqual([
      ['attendee_date_cancelled', 'ava@example.com', '@bookings'],
      ['cafe_date_cancelled', '@bookings', null],
    ]);
    expect(mail[0]!.html).toContain('cancelled by the café');
    expect(mail[0]!.html).toContain('A message from the café: "The quizmaster is ill, sorry!"');
    expect(mail[1]!.subject).toBe('Cancelled: Quiz, Thu 8 Oct');
    expect(mail[1]!.html).toContain('Michelle cancelled');
    expect(mail[1]!.html).toContain('The Logic Engine is updated for you');
    expect(await availability(QUIZ)).toMatchObject({ reason: 'cancelled' });
  });
});

describe('emails for n8n', () => {
  const collect = async () =>
    (await request('/internal/outbox/collect', { method: 'POST', headers: AUTH })).json<{ queued_numbers: number; queued_alerts: number; messages: Record<string, unknown>[] }>();

  it('gives n8n each email once, and keeps the café address out of the app', async () => {
    expect((await request('/internal/outbox/collect', { method: 'POST' })).status).toBe(401);
    await book();
    vi.setSystemTime(new Date('2026-10-06T07:00:00Z')); // 08:00 London: too early for numbers emails
    const first = await collect();
    expect(first.queued_numbers).toBe(0);
    // null = the café's general address; "@bookings" = the bookings inbox. n8n fills both in.
    expect(first.messages.map(m => [m.to, m.reply_to])).toEqual([
      ['ava@example.com', '@bookings'],
      ['@bookings', 'ava@example.com'],
      ['sam@example.com', null],
    ]);
    const id = first.messages[0]!.message_id;
    expect(await (await request(`/internal/outbox/${id}/sent`, { method: 'POST', headers: AUTH })).json()).toEqual({ ok: true, already: false });
    expect(await (await request(`/internal/outbox/${id}/sent`, { method: 'POST', headers: AUTH })).json()).toEqual({ ok: true, already: true });
    expect((await request('/internal/outbox/999/sent', { method: 'POST', headers: AUTH })).status).toBe(404);
    expect((await collect()).messages).toHaveLength(2);
  });

  it('emails each host the numbers two days before, with the option to cancel', async () => {
    await book({ lead_name: 'Ava Player', party_size: 2 });
    await env.DB.prepare('DELETE FROM outbox').run();
    const run = await collect(); // 11:00 on Tue 6 Oct: Root Night is on Thu 8 Oct
    expect(run.queued_numbers).toBe(1);
    const [numbers] = await outbox();
    expect(numbers).toMatchObject({ kind: 'host_numbers', to_email: 'sam@example.com', subject: 'Root Night, Thu 8 Oct: 2 of 4 places booked', dedupe_key: `host-numbers:${ROOT}` });
    expect(numbers!.html).toContain('<li>Ava Player (2 places)</li>');
    expect(numbers!.html).toContain('cancel this date in <a href="http://localhost/organise">the organiser</a>');
    expect((await collect()).queued_numbers).toBe(0); // once only

    vi.setSystemTime(new Date('2026-10-11T10:00:00Z')); // Sun 11 Oct: Catan on Tue 13 Oct, nobody booked
    expect((await collect()).queued_numbers).toBe(1);
    const catan = (await outbox()).at(-1)!;
    expect(catan.subject).toBe('Catan Club, Tue 13 Oct: 0 of 20 places booked');
    expect(catan.html).toContain('Nobody has booked a place yet.');
  });

  it("emails the bookings inbox the numbers two days before a café event people have booked", async () => {
    await book({ occurrence_id: QUIZ, lead_name: 'Quiz Team', email: 'quiz@example.com', mobile: '07700 900456', party_size: 5, notes: 'Table near the bar?' });
    await env.DB.prepare('DELETE FROM outbox').run();
    const run = await collect(); // Tue 6 Oct: Root Night (host) and Quiz (café) are both on Thu 8 Oct
    expect(run.queued_numbers).toBe(2);
    const quiz = (await outbox()).find(m => m.kind === 'cafe_numbers')!;
    expect(quiz).toMatchObject({ to_email: '@bookings', subject: 'Quiz, Thu 8 Oct: 5 places booked', dedupe_key: `cafe-numbers:${QUIZ}` });
    for (const bit of ['Quiz Team', 'quiz@example.com', '07700 900456', 'Table near the bar?']) expect(quiz.html).toContain(bit);
    expect((await collect()).queued_numbers).toBe(0); // once only
    // Café events nobody has booked don't get one.
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    expect((await outbox()).filter(m => m.kind === 'cafe_numbers')).toHaveLength(1);
  });

  it('warns the bookings inbox when a booked date disappears from the Logic Engine', async () => {
    await book({ occurrence_id: QUIZ, party_size: 3 });
    await env.DB.prepare('DELETE FROM outbox').run();
    // The café deletes the Quiz row from the sheet instead of cancelling it in the app.
    await sync({ run_id: 'quiz-gone', sources: { event_index: rows().slice(0, 3) } });
    vi.setSystemTime(new Date('2026-10-06T07:30:00Z')); // before 09:00: wait
    expect((await collect()).queued_alerts).toBe(0);
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
    expect((await collect()).queued_alerts).toBe(1);
    const alert = (await outbox()).find(m => m.kind === 'cafe_orphaned_bookings')!;
    expect(alert).toMatchObject({ to_email: '@bookings', subject: 'Check bookings: Quiz, Thu 8 Oct' });
    expect(alert.html).toContain('no longer in the Logic Engine');
    expect(alert.html).toContain('ava@example.com');
    expect((await collect()).queued_alerts).toBe(0); // once only
  });

  it('never sends a numbers email for a private or cancelled date', async () => {
    await request(`/api/host/occurrences/${ROOT}/cancel`, json({}), SAM);
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z')); // Birthday (private) is on Fri 9 Oct
    await env.DB.prepare('DELETE FROM outbox').run();
    expect((await collect()).queued_numbers).toBe(0);
  });
});

describe('keeping cancelled dates out of the Logic Engine', () => {
  const fixes = async () => (await (await request('/internal/sheet-fixes', { headers: AUTH })).json<{ fixes: Record<string, unknown>[] }>()).fixes;
  const done = (eventId: string, key: string) => request(`/internal/sheet-fixes/${eventId}/done`, json({ key }, AUTH));

  it('makes a cancelled one-off Inactive, matched on its Event ID, once', async () => {
    expect(await fixes()).toEqual([]);
    await request(`/api/host/occurrences/${ROOT}/cancel`, json({}), SAM);
    expect(await fixes()).toEqual([
      { event_id: 'RTD-EVT-00001', key: 'inactive', row: { 'Event ID': 'RTD-EVT-00001', Status: 'Inactive', 'Event Date': '08/10/2026' } },
    ]);
    expect((await done('RTD-EVT-00001', 'inactive')).status).toBe(200);
    expect((await done('RTD-EVT-09999', 'inactive')).status).toBe(404);
    expect(await fixes()).toEqual([]);
  });

  it("does the same for the café's own events", async () => {
    await request(`/api/host/occurrences/${QUIZ}/cancel`, json({}), MICHELLE);
    expect(await fixes()).toEqual([{ event_id: 'RTD-EVT-00004', key: 'inactive', row: { 'Event ID': 'RTD-EVT-00004', Status: 'Inactive', 'Event Date': '08/10/2026' } }]);
  });

  it('keeps the retired App Host Session feed empty, so an old workflow changes nothing', async () => {
    await request(`/api/host/occurrences/${ROOT}/cancel`, json({}), SAM);
    expect(await (await request('/internal/host-sessions/sheet-fixes', { headers: AUTH })).json()).toEqual({ fixes: [] });
  });

  it("moves a weekly session's sheet date past the cancelled weeks", async () => {
    await request(`/api/host/occurrences/${CATAN}/cancel`, json({}), SAM);
    expect(await fixes()).toEqual([expect.objectContaining({ key: 'date:2026-10-20', row: { 'Event ID': 'RTD-EVT-00002', Status: 'Active', 'Event Date': '20/10/2026' } })]);
    await request('/api/host/occurrences/RTD-OCC-00002-20261020/cancel', json({}), SAM);
    expect(await fixes()).toEqual([expect.objectContaining({ key: 'date:2026-10-27' })]);
    // Once the sheet has moved on, the next sync makes 27 Oct the sheet's date, and nothing is left to fix.
    await done('RTD-EVT-00002', 'date:2026-10-27');
    const moved = rows().map(r => ((r as Record<string, unknown>)['App Host Session'] === 'RTD-HS-00002' ? { ...r, 'Event Date': '27/10/2026' } : r));
    await sync({ run_id: 'moved', sources: { event_index: moved } });
    expect(await fixes()).toEqual([]);
    expect(await availability(CATAN)).toMatchObject({ reason: 'cancelled' });
    expect(await availability('RTD-OCC-00002-20261027')).toMatchObject({ open: true });
  });
});
