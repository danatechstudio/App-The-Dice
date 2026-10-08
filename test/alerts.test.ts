import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { absoluteImage, autoReminder, BATCH, defaultReminder, drain } from '../src/notify/alerts';
import { applyRetention } from '../src/lib/privacy';
import { env, freshDb, indexRow, request, sync } from './helpers';
import { browser, decrypt } from './push-helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // host
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const AUTH = { Authorization: 'Bearer test-sync-token' };

const QUIZ = 'RTD-OCC-00004-20261008'; // Thu 8 Oct 2026, 18:30
const BINGO = 'RTD-OCC-00005-20261020'; // Tue 20 Oct 2026

type Sent = { url: string; headers: Headers; body: Uint8Array };
let sent: Sent[] = [];
let statusFor: (url: string) => number = () => 201;

const on = (sub: unknown, headers: Record<string, string> = {}) => request('/api/alerts/subscribe', json(sub, headers));
const remind = (body: Record<string, unknown> = {}, who: Partial<Env> = DAN) =>
  request('/api/staff/reminders', json({ occurrence_id: QUIZ, title: 'Quiz night on Thursday', body: 'Teams of up to 6. Book your table in the app.', ...body }), who);
const sends = async () =>
  (await env.DB.prepare('SELECT kind, event_id, occurrence_id, title, sent_by, devices, delivered, failed, social FROM push_sends ORDER BY send_id').all()).results;
const ctx = (now = new Date()) => ({ subject: 'https://rtd.example', now });

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
  ]);
  const rows = [
    indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '08/10/2026' }),
    indexRow(5, { 'Event Name': 'Bingo', Day: 'Tuesday', 'Event Date': '20/10/2026' }),
    indexRow(7, { 'Event Name': 'Staff Party', Day: 'Wednesday', 'Event Date': '07/10/2026', 'App Visibility': 'Hidden' }),
  ];
  expect((await sync({ run_id: 'setup', sources: { event_index: rows } })).status).toBe(200);
  sent = [];
  statusFor = () => 201;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: new Uint8Array(init?.body as Uint8Array) });
    return new Response(null, { status: statusFor(String(input)) });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('turning event alerts on and off', () => {
  it('needs no account, and only takes a real push subscription from the app itself', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/ava');
    expect((await request('/api/alerts/key')).status).toBe(200);
    expect((await on({ ...b.subscription, endpoint: 'https://evil.example/x' })).status).toBe(400);
    expect((await on(b.subscription, { Origin: 'https://evil.example' })).status).toBe(403);
    const res = await on(b.subscription, { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await env.DB.prepare('SELECT device_label FROM alert_subscriptions').first()).toEqual({ device_label: 'Android, Chrome' });
    // Turning on twice is fine.
    expect((await on(b.subscription)).status).toBe(200);
    expect(await (await request('/api/alerts/status', json({ endpoint: b.subscription.endpoint }))).json()).toEqual({ on: true });
    expect(await (await request('/api/alerts/unsubscribe', json({ endpoint: b.subscription.endpoint }))).json()).toEqual({ on: false });
    expect(await (await request('/api/alerts/status', json({ endpoint: b.subscription.endpoint }))).json()).toEqual({ on: false });
  });

  it('limits how many new devices one network can add in an hour', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/0');
    const ip = { 'CF-Connecting-IP': '203.0.113.9' };
    for (let i = 0; i < 20; i++) expect((await on({ ...b.subscription, endpoint: `https://fcm.googleapis.com/fcm/send/${i}` }, ip)).status).toBe(200);
    expect((await on({ ...b.subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/20' }, ip)).status).toBe(429);
    // A device already on can still renew, and another network isn't affected.
    expect((await on({ ...b.subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/3' }, ip)).status).toBe(200);
    expect((await on({ ...b.subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/20' }, { 'CF-Connecting-IP': '198.51.100.1' })).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-06T11:01:00Z'));
    expect((await on({ ...b.subscription, endpoint: 'https://fcm.googleapis.com/fcm/send/21' }, ip)).status).toBe(200);
    // The network address is only kept scrambled.
    expect(JSON.stringify((await env.DB.prepare('SELECT * FROM alert_subscriptions').all()).results)).not.toContain('203.0.113.9');
  });

  it('moves alerts to the new subscription when the browser renews it', async () => {
    const old = await browser('https://updates.push.services.mozilla.com/wpush/v2/old');
    const renewed = await browser('https://updates.push.services.mozilla.com/wpush/v2/new');
    const renew = () => request('/api/alerts/renew', json({ old_endpoint: old.subscription.endpoint, subscription: renewed.subscription }));
    expect(await (await renew()).json()).toEqual({ renewed: false }); // alerts weren't on
    await on(old.subscription);
    expect(await (await renew()).json()).toEqual({ renewed: true });
    expect((await env.DB.prepare('SELECT endpoint FROM alert_subscriptions').all()).results).toEqual([{ endpoint: renewed.subscription.endpoint }]);
  });
});

describe("an admin's reminder", () => {
  it('is for admins only, about a public date still to come', async () => {
    expect((await remind({}, MICHELLE)).status).toBe(403);
    expect((await remind({}, SAM)).status).toBe(403);
    expect((await request('/api/staff/reminders', {}, MICHELLE)).status).toBe(403);
    const bad = await remind({ occurrence_id: 'nope', title: 'Hi', body: '' });
    expect(bad.status).toBe(400);
    expect(Object.keys((await bad.json<{ errors: Record<string, string> }>()).errors).sort()).toEqual(['body', 'occurrence_id', 'title']);
    expect((await remind({ body: 'x'.repeat(181) })).status).toBe(400);
    expect((await remind({ occurrence_id: 'RTD-OCC-00007-20261007' })).status).toBe(404); // hidden
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z')); // the quiz was yesterday
    const past = await remind();
    expect(past.status).toBe(409);
    expect(await past.json()).toEqual({ error: "That date isn't coming up any more." });
    expect(await sends()).toEqual([]);
  });

  it('goes to every device with alerts on, encrypted for each, and opens the event', async () => {
    const ava = await browser('https://fcm.googleapis.com/fcm/send/ava');
    const ben = await browser('https://web.push.apple.com/ben');
    await on(ava.subscription);
    await on(ben.subscription);
    const res = await remind();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ send: { send_id: 1, devices: 2, social: true } });
    expect(sent.map(s => s.url).sort()).toEqual([ben.subscription.endpoint, ava.subscription.endpoint].sort());
    const toAva = sent.find(s => s.url === ava.subscription.endpoint)!;
    expect(JSON.parse(await decrypt(toAva.body, ava))).toEqual({
      title: 'Quiz night on Thursday',
      body: 'Teams of up to 6. Book your table in the app.',
      url: `/event/${QUIZ}`,
      tag: 'event-RTD-EVT-00004',
      send_id: 1,
    });
    expect(toAva.headers.get('TTL')).toBe('43200');
    expect(toAva.headers.get('Urgency')).toBe('normal');
    expect(await sends()).toEqual([
      { kind: 'manual', event_id: 'RTD-EVT-00004', occurrence_id: QUIZ, title: 'Quiz night on Thursday', sent_by: 'dan@example.com', devices: 2, delivered: 2, failed: 0, social: 'pending' },
    ]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM push_deliveries').first()).toEqual({ n: 0 });
    const audit = await env.DB.prepare("SELECT actor_id, action, new_value FROM audit_log WHERE action = 'push.reminder_sent'").first<{ new_value: string }>();
    expect(audit).toMatchObject({ actor_id: 'dan@example.com', action: 'push.reminder_sent' });
    expect(JSON.parse(audit!.new_value)).toEqual({ devices: 2, social: true, after_warning: false });
  });

  it('warns about a second reminder for the same event within 24 hours, and sends it once confirmed', async () => {
    expect((await remind()).status).toBe(201);
    vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    const again = await remind({ title: 'Last call for the quiz' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      warning: { send_id: 1, kind: 'manual', title: 'Quiz night on Thursday', sent_by: 'dan@example.com', created_at: '2026-10-06T10:00:00.000Z' },
    });
    expect(await sends()).toHaveLength(1);
    // Another event isn't affected.
    expect((await remind({ occurrence_id: BINGO, title: 'Bingo is back' })).status).toBe(201);
    expect((await remind({ title: 'Last call for the quiz', confirm: true })).status).toBe(201);
    expect((await sends()).map(s => s.title)).toEqual(['Quiz night on Thursday', 'Bingo is back', 'Last call for the quiz']);
    // A day after the last one, no warning.
    vi.setSystemTime(new Date('2026-10-07T15:01:00Z'));
    expect((await remind({ title: 'Tomorrow: quiz night' })).status).toBe(201);
  });

  it('can leave Facebook out', async () => {
    expect(await (await remind({ social: false })).json()).toEqual({ send: { send_id: 1, devices: 0, social: false } });
    expect((await sends())[0]).toMatchObject({ social: null });
    expect(await (await request('/internal/social-posts', { headers: AUTH })).json()).toEqual({ posts: [] });
  });
});

describe('sending in batches', () => {
  it(`sends ${BATCH} at a time, and the every-minute Cron Trigger sends the rest`, async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/0');
    for (let i = 0; i < BATCH + 5; i++) await on({ ...b.subscription, endpoint: `https://fcm.googleapis.com/fcm/send/${i}` });
    expect((await remind()).status).toBe(201);
    expect(sent).toHaveLength(BATCH);
    // One signed token per push service, not per device.
    expect(new Set(sent.map(s => s.headers.get('Authorization'))).size).toBe(1);
    vi.setSystemTime(new Date('2026-10-06T10:01:00Z'));
    const run = createExecutionContext();
    await worker.scheduled!({ scheduledTime: Date.now(), cron: '* * * * *', noRetry: () => {} } as ScheduledController, env, run);
    await waitOnExecutionContext(run);
    expect(sent).toHaveLength(BATCH + 5);
    expect(new Set(sent.map(s => s.url)).size).toBe(BATCH + 5);
    expect((await sends())[0]).toMatchObject({ devices: BATCH + 5, delivered: BATCH + 5 });
    expect(await drain(env.DB, ctx())).toEqual({ sent: 0, failed: 0 });
  });

  it('forgets devices that are gone, or have failed 5 times in a row', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/0');
    for (const name of ['ok', 'gone', 'flaky']) await on({ ...b.subscription, endpoint: `https://fcm.googleapis.com/fcm/send/${name}` });
    await env.DB.prepare("UPDATE alert_subscriptions SET failures = 4 WHERE endpoint LIKE '%flaky'").run();
    statusFor = url => (url.endsWith('gone') ? 410 : url.endsWith('flaky') ? 500 : 201);
    expect((await remind()).status).toBe(201);
    expect((await sends())[0]).toMatchObject({ devices: 3, delivered: 1, failed: 2 });
    expect((await env.DB.prepare('SELECT endpoint, failures, last_sent_at FROM alert_subscriptions').all()).results).toEqual([
      { endpoint: 'https://fcm.googleapis.com/fcm/send/ok', failures: 0, last_sent_at: '2026-10-06T10:00:00.000Z' },
    ]);
  });

  it("doesn't send to a device whose alerts were turned off after the reminder was queued", async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/0');
    await on(b.subscription);
    // Queued by the automatic reminder (which doesn't send straight away), then turned off.
    vi.setSystemTime(new Date('2026-10-06T19:00:00Z'));
    expect(await autoReminder(env.DB, new Date())).toMatchObject({ devices: 1 });
    await request('/api/alerts/unsubscribe', json({ endpoint: b.subscription.endpoint }));
    expect(await drain(env.DB, ctx())).toEqual({ sent: 0, failed: 0 });
    expect(sent).toEqual([]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM push_deliveries').first()).toEqual({ n: 0 });
  });

  it('picks up a batch a stopped run had claimed, five minutes later', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/0');
    await on(b.subscription);
    vi.setSystemTime(new Date('2026-10-06T19:00:00Z'));
    await autoReminder(env.DB, new Date());
    await env.DB.prepare("UPDATE push_deliveries SET claim = 'stuck', claimed_at = '2026-10-06T18:58:00.000Z'").run();
    expect(await drain(env.DB, ctx())).toEqual({ sent: 0, failed: 0 });
    vi.setSystemTime(new Date('2026-10-06T19:04:00Z'));
    expect(await drain(env.DB, ctx())).toEqual({ sent: 1, failed: 0 });
  });
});

describe('the automatic reminder', () => {
  const at = async (iso: string) => {
    vi.setSystemTime(new Date(iso));
    return autoReminder(env.DB, new Date());
  };

  beforeEach(async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/0');
    await on(b.subscription);
  });

  it('goes at 8pm London time, about an event in the next three days, with no Facebook post', async () => {
    expect(await at('2026-10-06T18:59:00Z')).toBeNull(); // 7:59pm BST
    expect(await at('2026-10-06T19:00:00Z')).toEqual({ send_id: 1, devices: 1, occurrence_id: QUIZ });
    expect(await sends()).toEqual([
      { kind: 'auto', event_id: 'RTD-EVT-00004', occurrence_id: QUIZ, title: 'Quiz', sent_by: 'auto', devices: 1, delivered: 0, failed: 0, social: null },
    ]);
    expect(await env.DB.prepare('SELECT body FROM push_sends').first()).toEqual({ body: 'Thu 8 Oct, 6:30pm–10pm. Book your place in the app.' });
  });

  it('goes at most once every 48 hours, whatever admins send', async () => {
    expect(await at('2026-10-06T19:00:00Z')).not.toBeNull();
    expect(await at('2026-10-06T19:30:00Z')).toBeNull();
    // Bingo is three days ahead on the 17th; admins' reminders don't reset the clock.
    vi.setSystemTime(new Date('2026-10-07T09:00:00Z'));
    expect((await remind({ occurrence_id: BINGO })).status).toBe(201);
    expect(await at('2026-10-07T19:00:00Z')).toBeNull(); // 24 hours on
    expect(await at('2026-10-17T19:00:00Z')).toEqual({ send_id: 3, devices: 1, occurrence_id: BINGO });
    expect(await at('2026-10-18T19:00:00Z')).toBeNull();
  });

  it('skips events reminded about in the last 48 hours, and sends nothing when no event fits', async () => {
    expect((await remind()).status).toBe(201); // the quiz, at 10am
    expect(await at('2026-10-06T19:00:00Z')).toBeNull();
    expect(await at('2026-10-21T19:00:00Z')).toBeNull(); // nothing on after Bingo
    expect((await sends()).filter(s => s.kind === 'auto')).toEqual([]);
  });

  it('waits until someone has alerts on', async () => {
    await env.DB.prepare('DELETE FROM alert_subscriptions').run();
    expect(await at('2026-10-06T19:00:00Z')).toBeNull();
  });

  it('is queued and sent by the Cron Trigger', async () => {
    vi.setSystemTime(new Date('2026-10-06T19:00:00Z'));
    const run = createExecutionContext();
    await worker.scheduled!({ scheduledTime: Date.now(), cron: '* * * * *', noRetry: () => {} } as ScheduledController, env, run);
    await waitOnExecutionContext(run);
    expect(sent).toHaveLength(1);
    expect((await sends())[0]).toMatchObject({ kind: 'auto', delivered: 1 });
  });
});

describe('the Facebook post (n8n RTD Event Reminders To Facebook)', () => {
  it('queues the same words with a link to the event, for n8n to post and report back', async () => {
    expect((await request('/internal/social-posts')).status).toBe(401);
    expect((await remind()).status).toBe(201);
    const { posts } = await (await request('/internal/social-posts', { headers: AUTH })).json<{ posts: unknown[] }>();
    expect(posts).toEqual([
      { send_id: 1, text: `Quiz night on Thursday\n\nTeams of up to 6. Book your table in the app.\n\nhttp://localhost/event/${QUIZ}`, image_url: null },
    ]);
    const done = (id: number, body: unknown) => request(`/internal/social-posts/${id}/done`, json(body, AUTH));
    expect((await done(1, { post_id: 'buffer-123' })).status).toBe(200);
    expect((await done(1, { post_id: 'buffer-123' })).status).toBe(404); // only once
    expect(await (await request('/internal/social-posts', { headers: AUTH })).json()).toEqual({ posts: [] });
    expect(await env.DB.prepare('SELECT social, social_post_id, social_error FROM push_sends').first()).toEqual({ social: 'posted', social_post_id: 'buffer-123', social_error: null });
  });

  it("records why a post failed, for admins to see", async () => {
    await remind();
    expect((await request('/internal/social-posts/1/failed', json({ error: 'Channel disconnected' }, AUTH))).status).toBe(200);
    const { recent } = await (await request('/api/staff/reminders', {}, DAN)).json<{ recent: { social: string; social_error: string }[] }>();
    expect(recent[0]).toMatchObject({ social: 'failed', social_error: 'Channel disconnected' });
  });

  it("uses the event's photo, from the app or the web", () => {
    expect(absoluteImage('/images/abc', 'https://rtd.example')).toBe('https://rtd.example/images/abc');
    expect(absoluteImage('https://cdn.example/p.jpg', 'https://rtd.example')).toBe('https://cdn.example/p.jpg');
    expect(absoluteImage('http://insecure.example/p.jpg', 'https://rtd.example')).toBeNull();
    expect(absoluteImage(null, 'https://rtd.example')).toBeNull();
  });
});

describe('for admins in the organiser', () => {
  it('shows devices, the next date of each public event with its last reminder, and the latest reminders', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/0');
    await on(b.subscription);
    await remind();
    const data = await (await request('/api/staff/reminders', {}, DAN)).json<{
      devices: number;
      last_auto_at: string | null;
      events: { occurrence_id: string; name: string; suggested: { title: string; body: string }; last_sent_at: string | null }[];
      recent: unknown[];
    }>();
    expect(data.devices).toBe(1);
    expect(data.last_auto_at).toBeNull();
    expect(data.events.map(e => [e.occurrence_id, e.last_sent_at])).toEqual([
      [QUIZ, '2026-10-06T10:00:00.000Z'],
      [BINGO, null],
    ]);
    expect(data.events[1]!.suggested).toEqual({ title: 'Bingo', body: 'Tue 20 Oct, 6:30pm–10pm. Book your place in the app.' });
    expect(data.recent).toHaveLength(1);
  });

  it('suggests a reminder that fits the event', () => {
    expect(defaultReminder({ name: 'Market', date: '2026-12-05', start_time: null, end_time: null, bookable: false })).toEqual({
      title: 'Market',
      body: 'Sat 5 Dec. Tap to see the details.',
    });
  });
});

describe('what is kept', () => {
  it('erases the scrambled network address after 2 days, and drops reminders still unsent after a day', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/0');
    await on(b.subscription, { 'CF-Connecting-IP': '203.0.113.9' });
    vi.setSystemTime(new Date('2026-10-06T19:00:00Z'));
    await autoReminder(env.DB, new Date());
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM push_deliveries').first()).toEqual({ n: 1 });
    await applyRetention(env.DB, new Date('2026-10-07T03:23:00Z'));
    expect(await env.DB.prepare('SELECT ip_hash IS NOT NULL AS kept FROM alert_subscriptions').first()).toEqual({ kept: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM push_deliveries').first()).toEqual({ n: 1 });
    await applyRetention(env.DB, new Date('2026-10-09T03:23:00Z'));
    expect(await env.DB.prepare('SELECT ip_hash FROM alert_subscriptions').first()).toEqual({ ip_hash: null });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM push_deliveries').first()).toEqual({ n: 0 });
  });
});
