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
