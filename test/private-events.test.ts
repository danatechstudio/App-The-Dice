// Private events show as private games (docs/superpowers/specs/2026-10-18-private-events-design.md):
// name, time and description, never price, places, photo or booking; people ask to join through a
// message form that goes to the café, and to the host for a host's session.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRetention } from '../src/lib/privacy';
import { env, freshDb, indexRow, request, sync } from './helpers';

const SHELL = `<!doctype html><html><head><title>Roll The Dice · Board Game Café</title>
<meta name="description" content="default" /><meta property="og:title" content="default" />
<meta property="og:description" content="default" /><meta property="og:image" content="/brand/og-default.png" />
</head><body><div id="app"></div></body></html>`;
const ASSETS = { fetch: async () => new Response(SHELL, { headers: { 'Content-Type': 'text/html' } }) } as unknown as Fetcher;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers },
  body: JSON.stringify(body),
});
const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });

const ARKHAM = 'RTD-OCC-00003-20261010'; // a café-run private game
const QUIZ = 'RTD-OCC-00001-20261023'; // public
const CAMPAIGN = 'RTD-OCC-00008-20261007'; // Sam's private host session
const HIDDEN = 'RTD-OCC-00004-20261011';
const message = (over: Record<string, unknown> = {}) => ({
  name: 'Ava Player',
  email: 'ava@example.com',
  message: 'I play most Saturdays. Room for one more?',
  consent: true,
  website: '',
  ...over,
});
const enquire = (id: string, body: unknown, ip = '203.0.113.7') => request(`/api/occurrences/${id}/enquiry`, json(body, { 'CF-Connecting-IP': ip }));
const outbox = async () =>
  (await env.DB.prepare('SELECT kind, to_email, reply_to, subject, html FROM outbox ORDER BY message_id').all<Record<string, string>>()).results;
const enquiries = async () => Number(await env.DB.prepare('SELECT COUNT(*) AS n FROM enquiries').first('n'));

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
  ]);
  const SAM = as('sam@example.com');
  await request(
    '/api/host/sessions',
    json({
      name: 'Campaign Night',
      event_date: '2026-10-07',
      frequency: 'weekly',
      start_time: '18:30',
      end_time: '22:00',
      price_pence: 0,
      max_players: 5,
      description: 'A long campaign.',
      access: 'private',
    }),
    SAM,
  );
  await request('/api/staff/host-sessions/RTD-HS-00001/decision', json({ decision: 'approve' }), as('michelle@example.com'));
  await sync({
    run_id: 'seed',
    sources: {
      event_index: [
        indexRow(1, { 'Event Name': 'Quiz' }),
        indexRow(3, {
          'Event Name': 'Arkham Horror Card Game',
          'Event Date': '10/10/2026',
          'App Visibility': 'Private',
          'Base Details': 'Edge of the Earth campaign.',
          'App Price': '£4',
        }),
        indexRow(4, { 'Event Name': 'Food1', 'Event Date': '11/10/2026', 'App Visibility': 'Hidden' }),
        indexRow(8, {
          'Event Name': 'Campaign Night',
          Frequency: 'Weekly',
          'Event Date': '07/10/2026',
          'App Visibility': 'Private',
          'App Capacity': '5',
          'App Host Session': 'RTD-HS-00001',
        }),
      ],
    },
  });
  await env.DB.prepare('DELETE FROM outbox').run();
});
afterEach(() => vi.useRealTimers());

describe('a private game in public', () => {
  it('gives its page a share preview with its name, never its price', async () => {
    const res = await request(`/event/${ARKHAM}`, {}, { ASSETS });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('og:title" content="Arkham Horror Card Game · Saturday 10 October');
    expect(html).not.toContain('£4');
  });

  it('keeps its price out of the calendar file too', async () => {
    const ics = await (await request(`/api/occurrences/${ARKHAM}/calendar.ics`)).text();
    expect(ics).toContain('SUMMARY:Arkham Horror Card Game');
    expect(ics).not.toContain('£4');
  });

  it('never takes a booking', async () => {
    const res = await request('/api/bookings', json({ occurrence_id: ARKHAM, lead_name: 'Ava', email: 'ava@example.com', party_size: 1 }));
    expect(res.status).toBe(404);
  });
});

describe('asking to join', () => {
  it('emails the café, with reply-to the person asking', async () => {
    const res = await enquire(ARKHAM, message());
    expect(res.status).toBe(201);
    const mail = await outbox();
    expect(mail.map(m => [m.kind, m.to_email, m.reply_to])).toEqual([['private_game_enquiry', '@bookings', 'ava@example.com']]);
    expect(mail[0]!.subject).toBe('Someone would like to join: Arkham Horror Card Game, Sat 10 Oct');
    expect(mail[0]!.html).toContain('Room for one more?');
    expect(await enquiries()).toBe(1);
  });

  it('emails the host too, for a host’s private session', async () => {
    expect((await enquire(CAMPAIGN, message())).status).toBe(201);
    expect((await outbox()).map(m => m.to_email).sort()).toEqual(['@bookings', 'sam@example.com']);
  });

  it('escapes what people write', async () => {
    await enquire(ARKHAM, message({ name: '<b>Ava</b>', message: '<script>x</script>' }));
    const html = (await outbox())[0]!.html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('checks the form', async () => {
    const res = await enquire(ARKHAM, message({ name: '', email: 'not-an-email', message: '', consent: false }));
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json<{ errors: Record<string, string> }>()).errors).sort()).toEqual(['consent', 'email', 'message', 'name']);
    expect((await enquire(ARKHAM, message({ message: 'x'.repeat(1001) }))).status).toBe(400);
    expect(await enquiries()).toBe(0);
  });

  it('only takes messages for a private game still to come', async () => {
    expect((await enquire(QUIZ, message())).status).toBe(404);
    expect((await enquire(HIDDEN, message())).status).toBe(404);
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    expect((await enquire(ARKHAM, message())).status).toBe(404);
    expect(await outbox()).toEqual([]);
  });

  it('pretends to send when the trap field is filled, and sends nothing', async () => {
    expect((await enquire(ARKHAM, message({ website: 'http://spam.example' }))).status).toBe(201);
    expect(await outbox()).toEqual([]);
    expect(await enquiries()).toBe(0);
  });

  it('takes at most 3 messages an hour from one network', async () => {
    for (let i = 0; i < 3; i++) expect((await enquire(ARKHAM, message({ email: `p${i}@example.com` }))).status).toBe(201);
    expect((await enquire(ARKHAM, message({ email: 'p4@example.com' }))).status).toBe(429);
    expect((await enquire(ARKHAM, message({ email: 'p5@example.com' }), '198.51.100.9')).status).toBe(201);
    vi.setSystemTime(new Date('2026-10-05T11:01:00Z'));
    expect((await enquire(ARKHAM, message({ email: 'p6@example.com' }))).status).toBe(201);
  });
});

describe('keeping messages', () => {
  it('forgets the network after 2 days and the message after 90', async () => {
    await enquire(ARKHAM, message());
    await applyRetention(env.DB, new Date('2026-10-08T10:00:00Z'));
    expect(await env.DB.prepare('SELECT ip_hash FROM enquiries').first('ip_hash')).toBeNull();
    await applyRetention(env.DB, new Date('2026-12-20T10:00:00Z'));
    expect(await enquiries()).toBe(1);
    await applyRetention(env.DB, new Date('2027-01-04T10:00:00Z'));
    expect(await enquiries()).toBe(0);
  });
});
