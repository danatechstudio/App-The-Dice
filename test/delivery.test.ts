// Stage 4b (docs/RTD_EVENT_CONTROL_AUDIT.md §5.2-5.3, G-3, G-4): telling people booked,
// by email and on the devices they opted in, when a date is cancelled or moved; and
// email delivery that retries, gives up visibly and never stops the queue.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../src/attention/attention';
import { remind } from '../src/attention/reminders';
import { drainBookingPushes } from '../src/bookings/devices';
import { applyRetention } from '../src/lib/privacy';
import { env, freshDb, indexRow, request, sync } from './helpers';
import { browser, decrypt } from './push-helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // host
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const AUTH = { Authorization: 'Bearer test-sync-token' };

const QUIZ = 'RTD-OCC-00004-20261008'; // the café's own one-off, Thu 8 Oct 19:30
const QUIZ_MOVED = 'RTD-OCC-00004-20261015';
const quizRow = (date = '08/10/2026') => indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': date, 'Event Time': '19:30', 'End Time': '22:00' });

type Sent = { url: string; body: Uint8Array };
let sent: Sent[] = [];
let statusFor: (url: string) => number = () => 201;
const ctx = () => ({ subject: 'https://rtd.example', now: new Date() });
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

const book = async (email: string, party = 2, occurrence = QUIZ) => {
  const res = await request('/api/bookings', json({ occurrence_id: occurrence, lead_name: `${email.split('@')[0]} Player`, email, party_size: party }));
  expect(res.status).toBe(201);
  const { booking, manage_path } = await res.json<{ booking: { booking_id: string }; manage_path: string }>();
  return { id: booking.booking_id, token: manage_path.split('#t=')[1]! };
};
const addDevice = (b: { id: string; token: string }, subscription: unknown) => request(`/api/bookings/${b.id}/device`, json({ token: b.token, subscription }));
const cancel = (occurrence = QUIZ) => request(`/api/host/occurrences/${occurrence}/cancel`, json({ message: 'The quizmaster is ill.' }), MICHELLE);
const emails = async () =>
  (await env.DB.prepare('SELECT message_id, kind, to_email, subject, html, booking_id FROM outbox ORDER BY message_id').all<Record<string, string | number | null>>()).results;
const pushes = async () =>
  (await env.DB.prepare('SELECT push_id, kind, booking_id, title, url, attempts, last_status, next_attempt_at, sent_at, dead_at FROM push_outbox ORDER BY push_id').all<Record<string, unknown>>()).results;
const collect = async () => (await (await request('/internal/outbox/collect', { method: 'POST', headers: AUTH })).json<{ messages: { message_id: number; subject: string }[] }>()).messages;
const failed = (id: number, error = 'Invalid To header') => request(`/internal/outbox/${id}/failed`, json({ error }, AUTH));
const attention = async () => (await (await request('/api/staff/attention', {}, MICHELLE)).json<{ open: Record<string, unknown>[]; resolved: Record<string, unknown>[] }>());

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("UPDATE settings SET value = 'on' WHERE key = 'needs_attention'"),
  ]);
  expect((await sync({ run_id: 'setup', sources: { event_index: [quizRow()] } })).status).toBe(200);
  sent = [];
  statusFor = () => 201;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push({ url: String(input), body: new Uint8Array(init?.body as Uint8Array) });
    return new Response(null, { status: statusFor(String(input)) });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('telling this device about a booking', () => {
  it('is opt-in per booking, with the link from the confirmation email', async () => {
    const ava = await book('ava@example.com');
    const phone = await browser('https://fcm.googleapis.com/fcm/send/ava-phone');
    expect((await addDevice({ ...ava, token: 'x'.repeat(40) }, phone.subscription)).status).toBe(404);
    expect((await addDevice(ava, { ...phone.subscription, endpoint: 'https://evil.example/x' })).status).toBe(400);
    expect((await addDevice(ava, phone.subscription, )).status).toBe(200);
    expect((await addDevice(ava, phone.subscription)).status).toBe(200); // again: no second row
    const view = (endpoint?: string) => request(`/api/bookings/${ava.id}/view`, json({ token: ava.token, endpoint }));
    expect((await (await view(phone.subscription.endpoint)).json<{ booking: Record<string, unknown> }>()).booking).toMatchObject({ this_device: true });
    expect((await (await view()).json<{ booking: Record<string, unknown> }>()).booking).toMatchObject({ this_device: false });

    // At most 3 devices a booking.
    for (const n of [2, 3]) expect((await addDevice(ava, { ...phone.subscription, endpoint: `https://fcm.googleapis.com/fcm/send/ava-${n}` })).status).toBe(200);
    expect((await addDevice(ava, { ...phone.subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/ava-4' })).status).toBe(409);

    // The browser renews its subscription: the device follows it.
    const renewed = await browser('https://fcm.googleapis.com/fcm/send/ava-phone-renewed');
    expect(await (await request('/api/bookings/devices/renew', json({ old_endpoint: phone.subscription.endpoint, subscription: renewed.subscription }))).json()).toEqual({ ok: true });
    expect((await (await view(renewed.subscription.endpoint)).json<{ booking: Record<string, unknown> }>()).booking).toMatchObject({ this_device: true });

    expect((await request(`/api/bookings/${ava.id}/device/remove`, json({ token: ava.token, endpoint: renewed.subscription.endpoint }))).status).toBe(200);
    expect((await (await view(renewed.subscription.endpoint)).json<{ booking: Record<string, unknown> }>()).booking).toMatchObject({ this_device: false });

    // Not once the booking is cancelled.
    expect((await request(`/api/bookings/${ava.id}/cancel`, json({ token: ava.token }))).status).toBe(200);
    expect((await addDevice(ava, renewed.subscription)).status).toBe(409);
  });
});

describe('cancelling a booked date', () => {
  it('emails everyone booked and pushes each device they opted in, exactly once', async () => {
    const ava = await book('ava@example.com', 2);
    const ben = await book('ben@example.com', 1);
    await book('cara@example.com', 1); // email only
    const avaPhone = await browser('https://fcm.googleapis.com/fcm/send/ava');
    const benPhone = await browser('https://web.push.apple.com/ben');
    expect((await addDevice(ava, avaPhone.subscription)).status).toBe(200);
    expect((await addDevice(ben, benPhone.subscription)).status).toBe(200);
    expect((await addDevice(ben, { ...benPhone.subscription, endpoint: 'https://web.push.apple.com/ben-old-ipad' })).status).toBe(200);
    await env.DB.prepare('DELETE FROM outbox').run();

    const res = await cancel();
    expect(await res.json()).toEqual({ ok: true, cancelled_bookings: 3 });
    expect((await cancel()).status).toBe(409); // a second click sends nothing
    const toPeople = (await emails()).filter(e => e.kind === 'attendee_date_cancelled');
    expect(toPeople.map(e => [e.to_email, e.booking_id])).toEqual([
      ['ava@example.com', 'RTD-BK-00001'],
      ['ben@example.com', 'RTD-BK-00002'],
      ['cara@example.com', 'RTD-BK-00003'],
    ]);
    expect((await pushes()).map(p => p.booking_id)).toEqual(['RTD-BK-00001', 'RTD-BK-00002', 'RTD-BK-00002']);

    // Ben's old iPad has gone: marked, never used again, and no email is affected.
    statusFor = url => (url.endsWith('ben-old-ipad') ? 410 : 201);
    expect(await drainBookingPushes(env.DB, ctx(), 20)).toEqual({ tried: 3, sent: 2, failed: 0, gone: 1 });
    const toAva = sent.find(s => s.url === avaPhone.subscription.endpoint)!;
    expect(JSON.parse(await decrypt(toAva.body, avaPhone))).toEqual({
      title: 'Cancelled: Quiz',
      body: 'Thu 8 Oct, 7:30pm. Your booking is cancelled; the email has the details.',
      url: `/event/${QUIZ}`,
      tag: 'booking-RTD-BK-00001',
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM booking_devices WHERE invalid_at IS NOT NULL AND endpoint LIKE '%ben-old-ipad'").first()).toEqual({ n: 1 });
    expect((await emails()).filter(e => e.kind === 'attendee_date_cancelled')).toHaveLength(3);
    // Nothing goes twice.
    expect(await drainBookingPushes(env.DB, ctx(), 20)).toEqual({ tried: 0, sent: 0, failed: 0, gone: 0 });
    expect(sent).toHaveLength(3);
  });

  it('tries a failing push service again later, gives up after the last try, and admins can see it', async () => {
    const ava = await book('ava@example.com');
    const phone = await browser('https://fcm.googleapis.com/fcm/send/flaky');
    await addDevice(ava, phone.subscription);
    statusFor = () => 503;
    expect((await cancel()).status).toBe(200);
    expect(await drainBookingPushes(env.DB, ctx(), 20)).toMatchObject({ tried: 1, failed: 1 });
    expect((await pushes())[0]).toMatchObject({ attempts: 1, last_status: 503, next_attempt_at: '2026-10-06T10:05:00.000Z', dead_at: null });
    expect(await drainBookingPushes(env.DB, ctx(), 20)).toMatchObject({ tried: 0 }); // not before then
    for (const minutes of [5, 15, 60, 240, 720]) {
      advance(minutes * 60_000);
      expect(await drainBookingPushes(env.DB, ctx(), 20)).toMatchObject({ tried: 1, failed: 1 });
    }
    expect((await pushes())[0]).toMatchObject({ attempts: 6, sent_at: null, dead_at: expect.any(String) });
    advance(24 * 3_600_000);
    expect(await drainBookingPushes(env.DB, ctx(), 20)).toMatchObject({ tried: 0 });
    const overview = await (await request('/api/staff/delivery', {}, MICHELLE)).json<{ push: Record<string, number>; pushes: Record<string, unknown>[] }>();
    expect(overview.push).toMatchObject({ failed: 1 });
    expect(overview.pushes).toEqual([expect.objectContaining({ booking_id: 'RTD-BK-00001', title: 'Cancelled: Quiz', attempts: 6, given_up: true })]);
    // The email was never held up.
    expect((await emails()).filter(e => e.kind === 'attendee_date_cancelled')).toHaveLength(1);
    expect((await request('/api/staff/delivery', {}, SAM)).status).toBe(403);
  });

  it('sends no messages to people when nobody had booked', async () => {
    expect(await (await cancel()).json()).toEqual({ ok: true, cancelled_bookings: 0 });
    expect((await emails()).map(e => e.kind)).toEqual(['cafe_date_cancelled']);
    expect(await pushes()).toEqual([]);
  });
});

describe('email delivery (n8n RTD Outbox)', () => {
  it('claims what it collects, so a second run in the same 10 minutes gets nothing', async () => {
    await book('ava@example.com');
    const first = await collect();
    expect(first.map(m => m.subject)).toContain("You're booked: Quiz, Thu 8 Oct");
    expect(await collect()).toEqual([]);
    // Neither sent nor failed (an older RTD Outbox, or a run that died): offered again after 10 minutes.
    advance(10 * 60_000 + 1000);
    expect((await collect()).map(m => m.message_id)).toEqual(first.map(m => m.message_id));
  });

  it('retries a failed email, opens an item when it was to a customer, and settles it when it goes', async () => {
    await book('ava@example.com');
    const [toAva, toCafe] = await collect();
    const res = await failed(toAva!.message_id);
    expect(await res.json()).toEqual({ ok: true, already: false, dead: false });
    expect(await (await failed(toAva!.message_id)).json()).toEqual({ ok: true, already: true, dead: false }); // the same attempt, reported twice
    expect((await failed(toCafe!.message_id)).status).toBe(200);
    expect((await failed(999)).status).toBe(404);
    expect((await request(`/internal/outbox/${toAva!.message_id}/failed`, { method: 'POST' })).status).toBe(401);

    // Only the email to the customer needs someone: the café's own copy just retries.
    const { open } = await attention();
    expect(open).toEqual([
      expect.objectContaining({
        kind: 'undelivered',
        name: 'Quiz',
        actions: ['dismiss'],
        undelivered: expect.objectContaining({
          subject: "You're booked: Quiz, Thu 8 Oct",
          attempts: 1,
          last_error: 'Invalid To header',
          next_attempt_at: '2026-10-06T10:05:00.000Z',
          given_up: false,
          contact: { name: 'ava Player', email: 'ava@example.com', mobile: null },
        }),
      }),
    ]);

    expect(await collect()).toEqual([]); // not before its next try
    advance(5 * 60_000);
    const again = await collect();
    expect(again.map(m => m.message_id).slice(0, 2)).toEqual([toAva!.message_id, toCafe!.message_id]);
    expect((await request(`/internal/outbox/${toAva!.message_id}/sent`, { method: 'POST', headers: AUTH })).status).toBe(200);
    const after = await attention();
    expect(after.open).toEqual([]);
    expect(after.resolved).toEqual([expect.objectContaining({ kind: 'undelivered', resolution: 'sent', resolved_by: 'system' })]);
  });

  it('gives up after six tries, where admins see it and can try again', async () => {
    await book('ava@example.com');
    const [toAva] = await collect();
    for (let i = 1; i <= 6; i++) {
      const res = await (await failed(toAva!.message_id, `Gmail error ${i}`)).json<{ dead: boolean }>();
      expect(res.dead).toBe(i === 6);
      advance(13 * 3_600_000);
      if (i < 6) expect((await collect()).map(m => m.message_id)).toContain(toAva!.message_id);
    }
    expect((await collect()).map(m => m.message_id)).not.toContain(toAva!.message_id);
    const overview = await (await request('/api/staff/delivery', {}, MICHELLE)).json<{ email: Record<string, number>; emails: Record<string, unknown>[] }>();
    expect(overview.email).toMatchObject({ failed: 1 });
    expect(overview.emails[0]).toMatchObject({ to: 'ava@example.com', attempts: 6, last_error: 'Gmail error 6', given_up: true, contact: { name: 'ava Player', mobile: null } });
    const item = (await attention()).open[0]!;
    expect(item.undelivered).toMatchObject({ given_up: true, next_attempt_at: null });

    expect((await request(`/api/staff/outbox/${toAva!.message_id}/retry`, json({}), MICHELLE)).status).toBe(200);
    expect((await collect()).map(m => m.message_id)).toContain(toAva!.message_id);
    expect((await request('/api/staff/outbox/999/retry', json({}), MICHELLE)).status).toBe(409);
  });
});

describe('a booked date the Logic Engine moves (G-4)', () => {
  const move = (date: string) => sync({ run_id: `move-${date.replace(/\//g, '')}`, sources: { event_index: [quizRow(date)] } });

  it('holds it under Needs attention, tells nobody, and when chosen tells them with a link to the new date', async () => {
    const ava = await book('ava@example.com', 2);
    const phone = await browser('https://fcm.googleapis.com/fcm/send/ava');
    await addDevice(ava, phone.subscription);
    await env.DB.prepare('DELETE FROM outbox').run();
    expect((await move('15/10/2026')).status).toBe(200);
    expect(await detect(env.DB, new Date())).toMatchObject({ opened: 1 });
    expect(await emails()).toEqual([]);
    expect(await pushes()).toEqual([]);

    const [item] = (await attention()).open;
    expect(item).toMatchObject({
      kind: 'moved',
      name: 'Quiz',
      occurrence_id: QUIZ,
      actions: ['tell', 'cancel', 'dismiss'],
      moved: { new_occurrence_id: QUIZ_MOVED, new_date: '2026-10-15', new_start_time: '19:30', can_tell: true, bookings: 1, people: 2 },
    });
    const res = await request(`/api/staff/attention/${item!.item_id}/resolve`, json({ action: 'tell', note: 'Same time, one week later.' }), MICHELLE);
    expect(res.status).toBe(200);
    expect((await request(`/api/staff/attention/${item!.item_id}/resolve`, json({ action: 'tell' }), MICHELLE)).status).toBe(409);

    expect(await env.DB.prepare('SELECT status, cancelled_by, cancel_message FROM bookings').first()).toEqual({ status: 'cancelled', cancelled_by: 'staff', cancel_message: 'Same time, one week later.' });
    const [moved] = await emails();
    expect(moved).toMatchObject({ kind: 'attendee_date_moved', to_email: 'ava@example.com', subject: 'Moved: Quiz, now Thu 15 Oct', booking_id: 'RTD-BK-00001' });
    expect(moved!.html).toContain(`/event/${QUIZ_MOVED}`);
    expect(moved!.html).toContain('Same time, one week later.');
    expect(await pushes()).toEqual([expect.objectContaining({ kind: 'date-moved', title: 'Moved: Quiz', url: `/event/${QUIZ_MOVED}` })]);
    await drainBookingPushes(env.DB, ctx(), 20);
    expect(JSON.parse(await decrypt(sent[0]!.body, phone))).toMatchObject({ body: 'Thu 8 Oct, 7:30pm has moved to Thu 15 Oct, 7:30pm. The email has the details.' });
    const audit = await env.DB.prepare("SELECT actor_id, new_value FROM audit_log WHERE action = 'occurrence.moved_bookings_cancelled'").first<{ actor_id: string; new_value: string }>();
    expect(audit?.actor_id).toBe('michelle@example.com');
    expect(JSON.parse(audit!.new_value)).toEqual({ how: 'tell', bookings: 1, people: 2, new_occurrence: QUIZ_MOVED });
  });

  it('can cancel their bookings instead, telling each person it is cancelled', async () => {
    await book('ava@example.com', 2);
    await env.DB.prepare('DELETE FROM outbox').run();
    await move('15/10/2026');
    await detect(env.DB, new Date());
    const [item] = (await attention()).open;
    expect((await request(`/api/staff/attention/${item!.item_id}/resolve`, json({ action: 'cancel' }), MICHELLE)).status).toBe(200);
    expect((await emails()).map(e => [e.kind, e.subject])).toEqual([['attendee_date_cancelled', 'Cancelled: Quiz, Thu 8 Oct']]);
    expect((await attention()).resolved[0]).toMatchObject({ kind: 'moved', resolution: 'cancelled', resolved_by: 'michelle@example.com' });
  });

  it('settles itself, with the bookings standing, if the date comes back', async () => {
    await book('ava@example.com', 2);
    await move('15/10/2026');
    await detect(env.DB, new Date());
    expect((await move('08/10/2026')).status).toBe(200);
    expect(await detect(env.DB, new Date())).toMatchObject({ settled: 1 });
    expect((await attention()).resolved[0]).toMatchObject({ kind: 'moved', resolution: 'dismissed', resolution_note: 'The date is back in the Logic Engine, so the bookings stand.' });
    expect(await env.DB.prepare('SELECT status FROM bookings').first()).toEqual({ status: 'confirmed' });
    expect((await emails()).filter(e => String(e.kind).startsWith('attendee_'))).toEqual([]);
  });

  it('emails the attention addresses at once', async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE settings SET value = 'on' WHERE key = 'attention_emails'"),
      env.DB.prepare("UPDATE settings SET value = 'info@example.com' WHERE key = 'attention_email_to'"),
    ]);
    await book('ava@example.com', 2);
    await move('15/10/2026');
    await detect(env.DB, new Date());
    expect(await remind(env.DB, new Date(), 'https://rtd.example')).toMatchObject({ notices: 1 });
    const notice = (await emails()).find(e => e.kind === 'attention_moved')!;
    expect(notice).toMatchObject({ to_email: 'info@example.com', subject: 'Needs attention: Quiz (Thu 8 Oct) has moved, with 1 booking' });
    expect(notice.html).toContain('Tell them it has moved');
  });
});

describe('privacy', () => {
  it('forgets booking devices the day after the date, keeping the record of what was sent', async () => {
    const ava = await book('ava@example.com');
    await addDevice(ava, (await browser('https://fcm.googleapis.com/fcm/send/ava')).subscription);
    await cancel();
    await drainBookingPushes(env.DB, ctx(), 20);
    vi.setSystemTime(new Date('2026-10-08T03:23:00Z'));
    await applyRetention(env.DB, new Date());
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM booking_devices').first()).toEqual({ n: 1 }); // on the day: kept
    vi.setSystemTime(new Date('2026-10-09T03:23:00Z'));
    await applyRetention(env.DB, new Date());
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM booking_devices').first()).toEqual({ n: 0 });
    expect((await pushes()).map(p => p.sent_at)).toEqual([expect.any(String)]);
  });
});
