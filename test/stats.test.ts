import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, freshDb, indexRow, request, sync } from './helpers';
import { browser } from './push-helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
let ipSeq = 0;
/** Each test its own address, so the per-minute limit from one test can't touch another. */
let ip = '';
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': PHONE, 'CF-Connecting-IP': ip, ...headers },
  body: JSON.stringify(body),
});
const hit = (hits: unknown[], headers: Record<string, string> = {}) => request('/api/stats', json({ hits }, headers));
const counts = async () =>
  (await env.DB.prepare('SELECT day, metric, event_id, count FROM stats_daily ORDER BY day, metric, event_id').all()).results;

const QUIZ = 'RTD-OCC-00004-20261008';
const QUIZ_EVENT = 'RTD-EVT-00004';
const BINGO_EVENT = 'RTD-EVT-00005';

beforeEach(async () => {
  await freshDb();
  ip = `203.0.113.${++ipSeq}`;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
  ]);
  const rows = [
    indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '08/10/2026' }),
    indexRow(5, { 'Event Name': 'Bingo', Day: 'Tuesday', 'Event Date': '20/10/2026' }),
  ];
  expect((await sync({ run_id: 'setup', sources: { event_index: rows } })).status).toBe(200);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('counting what people do in the app', () => {
  it('adds each view or tap to a daily total, with nothing about the person', async () => {
    const res = await hit([{ m: 'app_open' }, { m: 'event_view', e: QUIZ_EVENT }, { m: 'event_view', e: QUIZ_EVENT }, { m: 'share_tap', e: BINGO_EVENT }]);
    expect(res.status).toBe(204);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    await hit([{ m: 'event_view', e: QUIZ_EVENT }]);
    vi.setSystemTime(new Date('2026-10-06T23:30:00Z')); // 00:30 on the 7th in London
    await hit([{ m: 'app_open' }]);
    expect(await counts()).toEqual([
      { day: '2026-10-06', metric: 'app_open', event_id: '', count: 1 },
      { day: '2026-10-06', metric: 'event_view', event_id: QUIZ_EVENT, count: 3 },
      { day: '2026-10-06', metric: 'share_tap', event_id: BINGO_EVENT, count: 1 },
      { day: '2026-10-07', metric: 'app_open', event_id: '', count: 1 },
    ]);
    // Only the totals table changes: nothing else is kept.
    expect(JSON.stringify(await counts())).not.toContain(ip);
  });

  it('ignores anything it doesn’t know, and events that don’t exist', async () => {
    await hit([
      { m: 'made_up' },
      { m: 'event_view' }, // no event
      { m: 'event_view', e: 'not-an-id' },
      { m: 'event_view', e: 'RTD-EVT-99999' }, // no such event
      { m: 'alerts_on' }, // only the server counts these
      { m: 'app_open', e: QUIZ_EVENT }, // an app count, whatever the page says
    ]);
    expect(await counts()).toEqual([{ day: '2026-10-06', metric: 'app_open', event_id: '', count: 1 }]);
    expect((await request('/api/stats', json('nonsense'))).status).toBe(204);
  });

  it('takes at most 10 counts a request, and 60 a minute from one address', async () => {
    await hit(Array.from({ length: 15 }, () => ({ m: 'diary_view' })));
    expect(await counts()).toEqual([{ day: '2026-10-06', metric: 'diary_view', event_id: '', count: 10 }]);
    for (let i = 0; i < 6; i++) await hit(Array.from({ length: 10 }, () => ({ m: 'diary_view' })));
    expect((await counts())[0]).toMatchObject({ count: 60 }); // the 7th batch went over
    vi.setSystemTime(new Date('2026-10-06T10:01:00Z'));
    await hit([{ m: 'diary_view' }]);
    expect((await counts())[0]).toMatchObject({ count: 61 });
  });

  it("doesn't count robots, the café team and hosts, or other sites", async () => {
    await hit([{ m: 'app_open' }], { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
    await hit([{ m: 'app_open' }], { 'User-Agent': 'facebookexternalhit/1.1' });
    await hit([{ m: 'app_open' }], { 'User-Agent': '' });
    await hit([{ m: 'app_open' }], { Cookie: 'theme=1; CF_Authorization=eyJhbGciOi' });
    expect((await hit([{ m: 'app_open' }], { Origin: 'https://evil.example' })).status).toBe(403);
    expect(await counts()).toEqual([]);
  });

  it('counts a tap on an event reminder against its event and the reminder', async () => {
    await env.DB.prepare(
      `INSERT INTO push_sends (kind, event_id, occurrence_id, title, body, url, sent_by, created_at)
       VALUES ('manual', ?1, ?2, 'Quiz night', 'Thursday', '/event/x', 'dan@example.com', '2026-10-06T09:00:00Z')`,
    )
      .bind(QUIZ_EVENT, QUIZ)
      .run();
    await hit([{ m: 'reminder_open', e: QUIZ_EVENT, s: 1 }]);
    await hit([{ m: 'reminder_open', e: QUIZ_EVENT, s: 1 }]);
    await hit([{ m: 'reminder_open', e: BINGO_EVENT, s: 1 }]); // not that reminder's event
    expect(await env.DB.prepare('SELECT opened FROM push_sends').first()).toEqual({ opened: 2 });
    expect((await counts()).map(r => [r.metric, r.event_id, r.count])).toEqual([
      ['reminder_open', QUIZ_EVENT, 2],
      ['reminder_open', BINGO_EVENT, 1],
    ]);
  });

  it('counts event alerts turned on (new devices only) and off', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/ava');
    await request('/api/alerts/subscribe', json(b.subscription));
    await request('/api/alerts/subscribe', json(b.subscription)); // already on
    await request('/api/alerts/unsubscribe', json({ endpoint: b.subscription.endpoint }));
    await request('/api/alerts/unsubscribe', json({ endpoint: b.subscription.endpoint })); // already off
    expect((await counts()).map(r => [r.metric, r.count])).toEqual([
      ['alerts_off', 1],
      ['alerts_on', 1],
    ]);
  });
});

describe('stats for admins', () => {
  const stats = async (days = 7, who: Partial<Env> = DAN) => request(`/api/staff/stats?days=${days}`, {}, who);
  const book = (party: number) =>
    request(
      '/api/bookings',
      json({ occurrence_id: QUIZ, lead_name: 'Ava Player', email: `ava${party}@example.com`, mobile: '07700 900123', party_size: party, notes: '' }),
    );

  it('are for admins only', async () => {
    expect((await stats(7, MICHELLE)).status).toBe(403);
    expect((await stats(14)).status).toBe(400);
    expect((await stats(30)).status).toBe(200);
  });

  it('show totals against the period before, day by day, and every event', async () => {
    // The week before: 2 views of the quiz, one booking.
    vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
    await hit([{ m: 'event_view', e: QUIZ_EVENT }, { m: 'event_view', e: QUIZ_EVENT }, { m: 'app_open' }]);
    await env.DB.prepare('INSERT INTO stats_daily VALUES (?1, ?2, ?3, ?4)').bind('2026-09-29', 'install', '', 1).run();
    // This week.
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    await hit([{ m: 'event_view', e: QUIZ_EVENT }, { m: 'book_tap', e: QUIZ_EVENT }, { m: 'home_screen_open' }]);
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
    await hit([
      { m: 'event_view', e: QUIZ_EVENT },
      { m: 'event_view', e: BINGO_EVENT },
      { m: 'event_view', e: BINGO_EVENT },
      { m: 'event_view', e: BINGO_EVENT },
      { m: 'calendar_tap', e: QUIZ_EVENT },
      { m: 'diary_view' },
    ]);
    expect((await book(2)).status).toBe(201);
    expect((await book(3)).status).toBe(201);

    const res = await stats(7);
    const s = await res.json<{
      from: string;
      to: string;
      counting_since: string;
      totals: Record<string, number>;
      previous: Record<string, number>;
      daily: { day: string; event_view: number }[];
      events: Record<string, unknown>[];
    }>();
    expect(s).toMatchObject({ from: '2026-09-30', to: '2026-10-06', counting_since: '2026-09-28' });
    expect(s.totals).toMatchObject({ event_view: 5, book_tap: 1, calendar_tap: 1, bookings: 2, places: 5, home_screen_open: 1, diary_view: 1 });
    expect(s.previous).toMatchObject({ event_view: 2, app_open: 1, install: 1, bookings: 0 });
    expect(s.daily).toHaveLength(7);
    expect(s.daily.at(-1)).toEqual({ day: '2026-10-06', event_view: 4, app_open: 0, home_screen_open: 0 });
    expect(s.daily.at(-2)).toMatchObject({ day: '2026-10-05', event_view: 1, home_screen_open: 1 });
    // Most viewed first.
    expect(s.events).toEqual([
      { event_id: BINGO_EVENT, name: 'Bingo', event_view: 3, book_tap: 0, bookings: 0, places: 0, calendar_tap: 0, share_tap: 0, reminder_open: 0 },
      { event_id: QUIZ_EVENT, name: 'Quiz', event_view: 2, book_tap: 1, bookings: 2, places: 5, calendar_tap: 1, share_tap: 0, reminder_open: 0 },
    ]);
  });

  it('tells apart events with the same name', async () => {
    await env.DB.prepare("UPDATE events SET display_name = 'Quiz' WHERE event_id = ?1").bind(BINGO_EVENT).run();
    await hit([{ m: 'event_view', e: QUIZ_EVENT }, { m: 'event_view', e: BINGO_EVENT }, { m: 'event_view', e: BINGO_EVENT }]);
    const { events } = await (await stats(7)).json<{ events: { name: string }[] }>();
    expect(events.map(e => e.name)).toEqual(['Quiz (Tue 20 Oct)', 'Quiz (Thu 8 Oct)']);
  });
});
