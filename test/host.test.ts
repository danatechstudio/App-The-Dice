import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, freshDb, request } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const HOST = as('sam@example.com');
const OTHER = as('alex@example.com');
const STAFF = as('michelle@example.com');
const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});

const session = (over: Record<string, unknown> = {}) => ({
  name: 'D&D One Shot',
  description: 'A beginner-friendly adventure. Characters provided.',
  event_date: '2026-10-24',
  start_time: '19:00',
  end_time: '22:00',
  price_pence: 500,
  max_players: 6,
  ...over,
});

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-alex', 'alex@example.com', 'Alex', 'host', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
  ]);
});
afterEach(() => vi.useRealTimers());

describe('host organiser', () => {
  it('needs a signed-in host', async () => {
    expect((await request('/api/host/me')).status).toBe(401);
    expect((await request('/api/host/me', {}, as('stranger@example.com'))).status).toBe(403);
    const me = await (await request('/api/host/me', {}, HOST)).json<{ user: { display_name: string }; can_review: boolean }>();
    expect(me).toMatchObject({ user: { display_name: 'Sam' }, can_review: false });
    expect((await (await request('/api/host/me', {}, STAFF)).json<{ can_review: boolean }>()).can_review).toBe(true);
  });

  it('creates numbered sessions with a readable price', async () => {
    const res = await request('/api/host/sessions', json(session()), HOST);
    expect(res.status).toBe(201);
    const { session: s } = await res.json<{ session: Record<string, unknown> }>();
    expect(s).toMatchObject({ session_id: 'RTD-HS-00001', status: 'submitted', price_label: '£5', max_players: 6, host_name: 'Sam' });
    const free = await (await request('/api/host/sessions', json(session({ price_pence: 0 })), HOST)).json<{ session: Record<string, unknown> }>();
    expect(free.session).toMatchObject({ session_id: 'RTD-HS-00002', price_label: 'Free' });
    const odd = await (await request('/api/host/sessions', json(session({ price_pence: 750 })), HOST)).json<{ session: Record<string, unknown> }>();
    expect(odd.session.price_label).toBe('£7.50');
  });

  it('explains each problem with the form', async () => {
    const res = await request('/api/host/sessions', json({ name: 'D', event_date: '2026-10-05', start_time: '19:00', end_time: '18:00', price_pence: 20000, max_players: 0 }), HOST);
    expect(res.status).toBe(400);
    const { errors } = await res.json<{ errors: Record<string, string> }>();
    expect(Object.keys(errors).sort()).toEqual(['end_time', 'event_date', 'max_players', 'name', 'price_pence']);
    expect(errors.event_date).toBe('Choose a date from tomorrow onwards.');
  });

  it('shows hosts only their own sessions, and lets them withdraw before approval is used', async () => {
    await request('/api/host/sessions', json(session()), HOST);
    await request('/api/host/sessions', json(session({ name: 'Learn Wingspan' })), OTHER);
    const mine = await (await request('/api/host/sessions', {}, HOST)).json<{ sessions: { name: string }[] }>();
    expect(mine.sessions.map(s => s.name)).toEqual(['D&D One Shot']);

    expect((await request('/api/host/sessions/RTD-HS-00001/withdraw', json({}), OTHER)).status).toBe(404);
    const done = await request('/api/host/sessions/RTD-HS-00001/withdraw', json({}), HOST);
    expect((await done.json<{ session: { status: string } }>()).session.status).toBe('withdrawn');
    expect((await request('/api/host/sessions/RTD-HS-00001/withdraw', json({}), HOST)).status).toBe(409);
  });

  it('refuses cross-site and non-JSON changes', async () => {
    expect((await request('/api/host/sessions', json(session(), { Origin: 'https://evil.example' }), HOST)).status).toBe(403);
    const form = await request('/api/host/sessions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=x' }, HOST);
    expect(form.status).toBe(415);
    expect((await request('/api/host/sessions', json(session(), { Origin: 'http://localhost' }), HOST)).status).toBe(201);
  });
});

describe('staff review', () => {
  beforeEach(async () => {
    await request('/api/host/sessions', json(session()), HOST);
    await request('/api/host/sessions', json(session({ name: 'Learn Wingspan', price_pence: 0 })), OTHER);
  });

  it('lists sessions waiting for a decision, for staff only', async () => {
    expect((await request('/api/staff/host-sessions', {}, HOST)).status).toBe(403);
    const { sessions } = await (await request('/api/staff/host-sessions', {}, STAFF)).json<{ sessions: { name: string; host_name: string }[] }>();
    expect(sessions.map(s => [s.name, s.host_name])).toEqual([
      ['D&D One Shot', 'Sam'],
      ['Learn Wingspan', 'Alex'],
    ]);
  });

  it('approves or declines once, with an audit trail', async () => {
    const ok = await request('/api/staff/host-sessions/RTD-HS-00001/decision', json({ decision: 'approve' }), STAFF);
    expect((await ok.json<{ session: { status: string } }>()).session.status).toBe('approved');
    expect((await request('/api/staff/host-sessions/RTD-HS-00001/decision', json({ decision: 'decline' }), STAFF)).status).toBe(409);
    const no = await request('/api/staff/host-sessions/RTD-HS-00002/decision', json({ decision: 'decline', note: 'Clashes with Quiz night' }), STAFF);
    expect((await no.json<{ session: { status: string; decision_note: string } }>()).session).toMatchObject({ status: 'declined', decision_note: 'Clashes with Quiz night' });
    expect((await request('/api/staff/host-sessions/RTD-HS-00009/decision', json({ decision: 'approve' }), STAFF)).status).toBe(404);
    expect((await request('/api/staff/host-sessions/RTD-HS-00001/decision', json({ decision: 'maybe' }), STAFF)).status).toBe(400);

    const audit = await env.DB.prepare("SELECT action, actor_id FROM audit_log WHERE entity_type = 'host_session' ORDER BY audit_id").all();
    expect(audit.results).toEqual([
      { action: 'host_session.submitted', actor_id: 'sam@example.com' },
      { action: 'host_session.submitted', actor_id: 'alex@example.com' },
      { action: 'host_session.approved', actor_id: 'michelle@example.com' },
      { action: 'host_session.declined', actor_id: 'michelle@example.com' },
    ]);
  });

  it('adds hosts, who can then sign in', async () => {
    expect((await request('/api/host/me', {}, as('jo@example.com'))).status).toBe(403);
    const bad = await request('/api/staff/hosts', json({ email: 'not-an-email', display_name: 'J' }), STAFF);
    expect(Object.keys((await bad.json<{ errors: object }>()).errors).sort()).toEqual(['display_name', 'email']);
    const res = await request('/api/staff/hosts', json({ email: 'Jo@Example.com', display_name: 'Jo' }), STAFF);
    expect(res.status).toBe(201);
    expect((await request('/api/host/me', {}, as('jo@example.com'))).status).toBe(200);
    expect((await request('/api/staff/hosts', json({ email: 'michelle@example.com', display_name: 'Michelle' }), STAFF)).status).toBe(409);
    const { hosts } = await (await request('/api/staff/hosts', {}, STAFF)).json<{ hosts: { email: string }[] }>();
    expect(hosts.map(h => h.email)).toContain('jo@example.com');
  });
});

describe('signing in', () => {
  it('sends people back to the organiser once Access has signed them in', async () => {
    const res = await request('/api/staff/sign-in', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/organise?signed-in=1');
  });

  it('says why nobody is signed in, without echoing the token', async () => {
    expect(await (await request('/api/host/me')).json()).toEqual({ error: 'Sign-in required', reason: 'missing' });
    const bad = await request('/api/host/me', { headers: { Cookie: 'CF_Authorization=not.a.jwt' } });
    expect(await bad.json()).toEqual({ error: 'Sign-in required', reason: 'invalid' });
  });
});

describe('one-off or weekly', () => {
  it('records how often a session runs, defaulting to one-off', async () => {
    const weekly = await (await request('/api/host/sessions', json(session({ frequency: 'weekly' })), HOST)).json<{ session: { frequency: string } }>();
    expect(weekly.session.frequency).toBe('weekly');
    const plain = await (await request('/api/host/sessions', json(session()), HOST)).json<{ session: { frequency: string } }>();
    expect(plain.session.frequency).toBe('one-off');
    const bad = await request('/api/host/sessions', json(session({ frequency: 'monthly' })), HOST);
    expect((await bad.json<{ errors: Record<string, string> }>()).errors).toEqual({ frequency: 'Choose one-off or weekly.' });
  });
});

describe('after a one-off session', () => {
  const AUTH = { Authorization: 'Bearer test-sync-token' };
  const decide = (id: string, decision: string) => request(`/api/staff/host-sessions/${id}/decision`, json({ decision }), STAFF);

  beforeEach(async () => {
    await request('/api/host/sessions', json(session({ name: 'Learn Root' })), HOST); // 1: one-off, approved, yesterday
    await request('/api/host/sessions', json(session({ name: 'Catan Club', frequency: 'weekly' })), HOST); // 2: weekly
    await request('/api/host/sessions', json(session({ name: 'Wingspan' })), OTHER); // 3: declined
    await request('/api/host/sessions', json(session({ name: 'Future Night' })), OTHER); // 4: still to come
    await request('/api/host/sessions', json(session({ name: 'Old Night' })), OTHER); // 5: a month ago
    for (const id of ['00001', '00002', '00004', '00005']) await decide(`RTD-HS-${id}`, 'approve');
    await decide('RTD-HS-00003', 'decline');
    await env.DB.prepare("UPDATE host_sessions SET event_date = '2026-10-04' WHERE session_id IN ('RTD-HS-00001', 'RTD-HS-00002', 'RTD-HS-00003')").run();
    await env.DB.prepare("UPDATE host_sessions SET event_date = '2026-09-04' WHERE session_id = 'RTD-HS-00005'").run();
  });

  it('lists only approved one-offs whose day has passed, for n8n to email', async () => {
    expect((await request('/internal/host-sessions/followups')).status).toBe(401);
    const { followups } = await (await request('/internal/host-sessions/followups', { headers: AUTH })).json<{ followups: unknown[] }>();
    expect(followups).toEqual([
      {
        session_id: 'RTD-HS-00001',
        name: 'Learn Root',
        event_date: '2026-10-04',
        host_email: 'sam@example.com',
        host_name: 'Sam',
        host_first_name: 'Sam',
        date_label: 'Sunday 4 October',
        organiser_url: 'http://localhost/organise',
      },
    ]);
  });

  it('marks each email sent once', async () => {
    const mark = (id: string) => request(`/internal/host-sessions/${id}/followup-sent`, { method: 'POST', headers: AUTH });
    expect((await mark('RTD-HS-00001')).status).toBe(200);
    expect((await mark('RTD-HS-00001')).status).toBe(409);
    expect((await mark('RTD-HS-00002')).status).toBe(404); // weekly sessions don't get one
    const { followups } = await (await request('/internal/host-sessions/followups', { headers: AUTH })).json<{ followups: unknown[] }>();
    expect(followups).toEqual([]);
    const audit = await env.DB.prepare("SELECT actor_type FROM audit_log WHERE action = 'host_session.followup_sent'").all();
    expect(audit.results).toEqual([{ actor_type: 'n8n' }]);
  });
});

describe('open or private', () => {
  it('records who can come, defaulting to open', async () => {
    const open = await (await request('/api/host/sessions', json(session()), HOST)).json<{ session: { access: string } }>();
    expect(open.session.access).toBe('open');
    const mine = await (await request('/api/host/sessions', json(session({ access: 'private' })), HOST)).json<{ session: { access: string } }>();
    expect(mine.session.access).toBe('private');
    const bad = await request('/api/host/sessions', json(session({ access: 'secret' })), HOST);
    expect((await bad.json<{ errors: Record<string, string> }>()).errors).toEqual({ access: 'Choose an open or private session.' });
  });
});
