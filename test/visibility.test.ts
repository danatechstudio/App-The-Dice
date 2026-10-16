// The public never sees a date once it has ended (docs/RTD_EVENT_CONTROL_AUDIT.md, G-1).
// No sync runs after the seed, so every check here is enforced at read time, not by n8n.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { overview, sendReminder } from '../src/notify/alerts';
import { hasEnded, isUpcoming } from '../web/src/lib/upcoming';
import { env, freshDb, indexRow, request, sync } from './helpers';

const SHELL = `<!doctype html><html><head><title>Roll The Dice · Board Game Café</title>
<meta name="description" content="default" /><meta property="og:title" content="default" />
<meta property="og:description" content="default" /><meta property="og:image" content="/brand/og-default.png" />
</head><body><div id="app"></div></body></html>`;
const ASSETS = { fetch: async () => new Response(SHELL, { headers: { 'Content-Type': 'text/html' } }) } as unknown as Fetcher;
const page = (path: string) => request(path, {}, { ASSETS });

const at = (iso: string) => vi.setSystemTime(new Date(iso));
const listed = async (path = '/api/events') => (await (await request(path)).json<{ occurrences: { occurrence_id: string }[] }>()).occurrences.map(o => o.occurrence_id);

const QUIZ = 'RTD-OCC-00001-20261023'; // Fri 23 Oct, 18:30–22:00 BST: ends 21:00 UTC
const LATE = 'RTD-OCC-00002-20261023'; // 19:00–01:00 BST: ends 24 Oct 00:00 UTC
const BACK = 'RTD-OCC-00003-20261025'; // Sun 25 Oct (clocks went back that morning), 18:00–20:00 GMT
const OPEN = 'RTD-OCC-00004-20261024'; // Sat 24 Oct, all day
const KIDS = 'RTD-OCC-00005-20261022'; // weekly from Thu 22 Oct, 18:30–22:00 BST
const KIDS_NEXT = 'RTD-OCC-00005-20261029';

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-10-05T10:00:00Z');
  const res = await sync({
    run_id: 'seed',
    sources: {
      event_index: [
        indexRow(1, { 'Event Name': 'Quiz' }),
        indexRow(2, { 'Event Name': 'Late Game', 'Event Time': '19:00', 'End Time': '01:00' }),
        indexRow(3, { 'Event Name': 'Clocks Back', 'Event Date': '25/10/2026', 'Event Time': '18:00', 'End Time': '20:00' }),
        indexRow(4, { 'Event Name': 'Open Day', 'Event Date': '24/10/2026', 'Event Time': '', 'End Time': '' }),
        indexRow(5, { 'Event Name': 'Kids Club', 'Event Date': '22/10/2026', Frequency: 'Weekly' }),
      ],
    },
  });
  expect(res.status).toBe(200);
});
afterEach(() => vi.useRealTimers());

describe('a date that ended one second ago', () => {
  it('leaves the diary list, the event page and the deep link at its end, not at midnight', async () => {
    at('2026-10-23T20:59:59Z');
    expect(await listed()).toContain(QUIZ);
    expect((await request(`/api/occurrences/${QUIZ}`)).status).toBe(200);

    at('2026-10-23T21:00:01Z');
    expect(await listed()).not.toContain(QUIZ);
    expect(await listed('/api/events?category=Quiz')).not.toContain(QUIZ);
    const series = await (await request('/api/events/RTD-EVT-00001')).json<{ occurrences: unknown[] }>();
    expect(series.occurrences).toEqual([]);
    expect((await request(`/api/occurrences/${QUIZ}`)).status).toBe(410);
  });

  it('gives an old link only the name, the date, why, and the next date: never the details', async () => {
    at('2026-10-22T21:00:01Z');
    const res = await request(`/api/occurrences/${KIDS}`);
    expect(res.status).toBe(410);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: 'This event has finished.',
      gone: {
        occurrence_id: KIDS,
        event_id: 'RTD-EVT-00005',
        name: 'Kids Club',
        date: '2026-10-22',
        reason: 'finished',
        next: { occurrence_id: KIDS_NEXT, date: '2026-10-29', start_time: '18:30' },
      },
    });
    expect(text).not.toContain('Details for event');
    // A one-off that has finished has no next date.
    at('2026-10-23T21:00:01Z');
    expect((await (await request(`/api/occurrences/${QUIZ}`)).json<{ gone: { next: unknown } }>()).gone.next).toBeNull();
  });

  it('stops the calendar file and the Google Calendar link', async () => {
    at('2026-10-23T20:59:59Z');
    expect((await request(`/api/occurrences/${QUIZ}/calendar.ics`)).status).toBe(200);
    expect((await request(`/api/occurrences/${QUIZ}/google-calendar`)).status).toBe(302);
    at('2026-10-23T21:00:01Z');
    expect((await request(`/api/occurrences/${QUIZ}/calendar.ics`)).status).toBe(404);
    expect((await request(`/api/occurrences/${QUIZ}/google-calendar`)).status).toBe(404);
  });

  it('gives shared links the plain site preview, and moves an evergreen link on to the next date', async () => {
    at('2026-10-22T21:00:01Z');
    const old = await page(`/event/${KIDS}`);
    expect(old.status).toBe(410);
    const html = await old.text();
    expect(html).not.toContain('Kids Club');
    expect(html).toContain('<title>Roll The Dice · Board Game Café</title>');
    const evergreen = await (await page('/events/RTD-EVT-00005')).text();
    expect(evergreen).toContain('Thursday 29 October');

    at('2026-10-23T21:00:01Z');
    expect((await page('/events/RTD-EVT-00001')).status).toBe(404);
  });

  it("can't be picked for an admin's reminder", async () => {
    const admin = { user_id: 'u-admin', email: 'admin@example.com', display_name: 'Admin', role: 'admin' as const };
    const input = { occurrence_id: QUIZ, title: 'Quiz tonight', body: 'See you there', social: false, confirm: false };
    at('2026-10-23T21:00:01Z');
    expect((await overview(env.DB, new Date())).events.map(e => e.occurrence_id)).not.toContain(QUIZ);
    expect(await sendReminder(env.DB, admin, input, { now: new Date(), origin: 'https://rtd.test' })).toMatchObject({ ok: false, status: 409 });
  });
});

describe('caching never outlasts a date', () => {
  it('caps max-age at the seconds left before the first date in the response ends', async () => {
    at('2026-10-23T20:59:30Z');
    expect((await request('/api/events')).headers.get('Cache-Control')).toBe('public, max-age=30');
    expect((await request(`/api/occurrences/${QUIZ}`)).headers.get('Cache-Control')).toBe('public, max-age=30');
    expect((await page(`/event/${QUIZ}`)).headers.get('Cache-Control')).toBe('public, max-age=30');
    at('2026-10-05T10:00:00Z');
    expect((await request('/api/events')).headers.get('Cache-Control')).toBe('public, max-age=60');
  });
});

describe('times', () => {
  it('keeps an event that runs past midnight until it ends', async () => {
    at('2026-10-23T22:30:00Z'); // 23:30 BST on its own date
    expect(await listed()).toContain(LATE);
    at('2026-10-23T23:59:59Z'); // 00:59:59 BST the next day: the deep link still works
    expect((await request(`/api/occurrences/${LATE}`)).status).toBe(200);
    at('2026-10-24T00:00:01Z');
    expect((await request(`/api/occurrences/${LATE}`)).status).toBe(410);
  });

  it('keeps an all-day date until London midnight', async () => {
    at('2026-10-24T22:59:59Z'); // 23:59:59 BST
    expect(await listed()).toContain(OPEN);
    expect((await request(`/api/occurrences/${OPEN}`)).headers.get('Cache-Control')).toBe('public, max-age=1');
    at('2026-10-24T23:00:00Z'); // midnight BST
    expect(await listed()).not.toContain(OPEN);
    expect((await request(`/api/occurrences/${OPEN}`)).status).toBe(410);
  });

  it('uses GMT after the clocks go back', async () => {
    at('2026-10-25T19:59:59Z'); // 19:59:59 GMT
    expect(await listed()).toContain(BACK);
    at('2026-10-25T20:00:00Z');
    expect(await listed()).not.toContain(BACK);
  });

  it('uses BST after the clocks go forward, including for all-day dates', async () => {
    at('2027-03-01T10:00:00Z');
    await sync({
      run_id: 'spring',
      sources: {
        event_index: [
          indexRow(1, { 'Event Name': 'Quiz', 'Event Date': '28/03/2027' }), // 18:30–22:00 BST: ends 21:00 UTC
          indexRow(2, { 'Event Name': 'Late Game', 'Event Date': '28/03/2027', 'Event Time': '', 'End Time': '' }),
          indexRow(3, { 'Event Name': 'Clocks Back', 'Event Date': '30/03/2027' }),
          indexRow(4, { 'Event Name': 'Open Day', 'Event Date': '30/03/2027' }),
          indexRow(5, { 'Event Name': 'Kids Club', 'Event Date': '30/03/2027' }),
        ],
      },
    });
    at('2027-03-28T20:59:59Z');
    expect(await listed()).toEqual(expect.arrayContaining(['RTD-OCC-00001-20270328', 'RTD-OCC-00002-20270328']));
    at('2027-03-28T21:00:00Z');
    expect(await listed()).not.toContain('RTD-OCC-00001-20270328');
    expect(await listed()).toContain('RTD-OCC-00002-20270328');
    at('2027-03-28T23:00:00Z'); // midnight BST
    expect(await listed()).not.toContain('RTD-OCC-00002-20270328');
  });
});

describe('cancelled and moved dates', () => {
  it('are never listed, and an old link says what happened and where to go next', async () => {
    at('2026-10-20T10:00:00Z');
    await env.DB.prepare("UPDATE occurrences SET status = 'cancelled' WHERE occurrence_id = ?1").bind(KIDS).run();
    await env.DB.prepare("UPDATE occurrences SET status = 'rescheduled' WHERE occurrence_id = ?1").bind(QUIZ).run();
    expect(await listed()).not.toContain(KIDS);
    expect(await listed()).not.toContain(QUIZ);

    const cancelled = await request(`/api/occurrences/${KIDS}`);
    expect(cancelled.status).toBe(410);
    expect(await cancelled.json()).toMatchObject({ error: 'This date was cancelled.', gone: { reason: 'cancelled', next: { occurrence_id: KIDS_NEXT } } });
    expect(await (await request(`/api/occurrences/${QUIZ}`)).json()).toMatchObject({ gone: { reason: 'moved', next: null } });
    expect((await page(`/event/${KIDS}`)).status).toBe(410);
  });
});

describe('markets', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO markets (market_id, name, event_date, start_time, end_time, pitches, pitch_fee_pence, applications_close, payment_details, status, created_by, created_at, updated_at)
       VALUES ('RTD-MKT-00001', 'Winter Market', '2026-11-14', '10:00', '16:00', 20, 1500, '2026-11-07', 'Pay at the café', 'scheduled', 'admin@example.com', ?1, ?1)`,
    )
      .bind(new Date().toISOString())
      .run();
  });

  it('leave the vendor listing when they end (16:00 GMT)', async () => {
    at('2026-11-14T15:59:59Z');
    expect((await (await request('/api/markets')).json<{ markets: unknown[] }>()).markets).toHaveLength(1);
    expect((await request('/api/markets/RTD-MKT-00001')).status).toBe(200);
    at('2026-11-14T16:00:01Z');
    expect((await (await request('/api/markets')).json<{ markets: unknown[] }>()).markets).toHaveLength(0);
    expect((await request('/api/markets/RTD-MKT-00001')).status).toBe(404);
  });
});

// Home, Diary, Book, the splash, chips and the event page all filter with isUpcoming / hasEnded.
describe('the app re-checks what it was given (offline copies, the in-memory cache)', () => {
  const quiz = { date: '2026-10-23', ends_at: '2026-10-23T21:00:00.000Z' as string | null, status: 'scheduled' };

  it('treats a date as over from its end, past midnight and all day included', () => {
    expect(isUpcoming(quiz, new Date('2026-10-23T20:59:59Z'))).toBe(true);
    expect(hasEnded(quiz, new Date('2026-10-23T21:00:01Z'))).toBe(true);
    // 19:00–01:00 BST: still on at 23:30 on its own date (the old check hid it all evening).
    expect(isUpcoming({ ...quiz, ends_at: '2026-10-24T00:00:00.000Z' }, new Date('2026-10-23T22:30:00Z'))).toBe(true);
    const allDay = { ...quiz, ends_at: null };
    expect(isUpcoming(allDay, new Date('2026-10-23T22:59:59Z'))).toBe(true); // 23:59:59 BST
    expect(isUpcoming(allDay, new Date('2026-10-23T23:00:00Z'))).toBe(false);
    expect(isUpcoming({ ...quiz, status: 'cancelled' }, new Date('2026-10-20T10:00:00Z'))).toBe(false);
  });
});
