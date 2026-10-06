import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, freshDb, request } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin: approves café team requests
const MICHELLE = as('michelle@example.com'); // staff: approves hosts and sessions
const SAM = as('sam@example.com'); // already a host
const NEWBIE = as('newbie@example.com'); // signed in, no access yet
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const AUTH = { Authorization: 'Bearer test-sync-token' };
type App = Record<string, unknown> & { application_id: string; status: string };

const apply = (who: Record<string, string>, body: Record<string, unknown>) => request('/api/join/apply', json(body), who);
const decide = (who: Record<string, string>, id: string, decision: string, note?: string) =>
  request(`/api/staff/applications/${id}/decision`, json({ decision, note }), who);

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam', 'host', 1, ?1, ?1)").bind(now),
  ]);
});
afterEach(() => vi.useRealTimers());

describe('asking to join', () => {
  it('needs a sign-in, and knows who already has access', async () => {
    expect((await request('/api/join/me')).status).toBe(401);
    expect(await (await request('/api/join/me', {}, NEWBIE)).json()).toEqual({ email: 'newbie@example.com', has_access: false, application: null });
    expect((await (await request('/api/join/me', {}, SAM)).json<{ has_access: boolean }>()).has_access).toBe(true);
    expect((await apply(SAM, { role: 'staff', display_name: 'Sam', about: 'Front of house' })).status).toBe(409);
  });

  it('checks the form and takes one request at a time', async () => {
    const bad = await apply(NEWBIE, { role: 'boss', display_name: 'N', about: '' });
    expect(bad.status).toBe(400);
    expect(Object.keys((await bad.json<{ errors: object }>()).errors).sort()).toEqual(['about', 'display_name', 'role']);

    const ok = await apply(NEWBIE, { role: 'host', display_name: 'Nina Newbie', about: 'Beginner D&D one-shots' });
    expect(ok.status).toBe(201);
    expect((await ok.json<{ application: App }>()).application).toMatchObject({ application_id: 'RTD-APP-00001', status: 'pending', role: 'host' });
    expect((await apply(NEWBIE, { role: 'host', display_name: 'Nina', about: 'Again' })).status).toBe(409);

    expect((await request('/api/join/withdraw', json({}), NEWBIE)).status).toBe(200);
    expect((await request('/api/join/withdraw', json({}), NEWBIE)).status).toBe(409);
    expect((await apply(NEWBIE, { role: 'staff', display_name: 'Nina Newbie', about: 'Front of house' })).status).toBe(201);
  });

  it('limits requests to three a day', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await apply(NEWBIE, { role: 'host', display_name: 'Nina', about: 'Catan nights' })).status).toBe(201);
      await request('/api/join/withdraw', json({}), NEWBIE);
    }
    expect((await apply(NEWBIE, { role: 'host', display_name: 'Nina', about: 'Catan nights' })).status).toBe(429);
  });
});

describe('approving join requests', () => {
  beforeEach(async () => {
    await apply(NEWBIE, { role: 'host', display_name: 'Nina Newbie', about: 'Beginner D&D one-shots' }); // RTD-APP-00001
    await apply(as('barista@example.com'), { role: 'staff', display_name: 'Bea Barista', about: 'Front of house' }); // 00002
  });

  it('shows staff the host requests, and admins the café team requests too', async () => {
    const staffView = await (await request('/api/staff/applications', {}, MICHELLE)).json<{ applications: App[] }>();
    expect(staffView.applications.map(a => a.application_id)).toEqual(['RTD-APP-00001']);
    const adminView = await (await request('/api/staff/applications', {}, DAN)).json<{ applications: App[] }>();
    expect(adminView.applications.map(a => a.application_id)).toEqual(['RTD-APP-00001', 'RTD-APP-00002']);
    expect((await request('/api/staff/applications', {}, SAM)).status).toBe(403);
  });

  it('lets staff approve a host, who can then use the organiser', async () => {
    expect((await request('/api/host/me', {}, NEWBIE)).status).toBe(403);
    const res = await decide(MICHELLE, 'RTD-APP-00001', 'approve');
    expect((await res.json<{ application: App }>()).application).toMatchObject({ status: 'approved', decided_by: 'michelle@example.com' });
    const me = await (await request('/api/host/me', {}, NEWBIE)).json<{ user: { role: string; display_name: string }; can_review: boolean }>();
    expect(me).toMatchObject({ user: { role: 'host', display_name: 'Nina Newbie' }, can_review: false });
    expect((await decide(MICHELLE, 'RTD-APP-00001', 'decline')).status).toBe(409);
  });

  it('keeps café team approval for admins', async () => {
    expect((await decide(MICHELLE, 'RTD-APP-00002', 'approve')).status).toBe(403);
    expect((await decide(DAN, 'RTD-APP-00002', 'approve')).status).toBe(200);
    const me = await (await request('/api/host/me', {}, as('barista@example.com'))).json<{ user: { role: string }; can_review: boolean; is_admin: boolean }>();
    expect(me).toMatchObject({ user: { role: 'staff' }, can_review: true, is_admin: false });
  });

  it('tells the applicant when a request is declined, and lets them ask again', async () => {
    await decide(MICHELLE, 'RTD-APP-00001', 'decline', 'We have a D&D host already. Fancy a board game night?');
    const me = await (await request('/api/join/me', {}, NEWBIE)).json<{ application: App }>();
    expect(me.application).toMatchObject({ status: 'declined', decision_note: 'We have a D&D host already. Fancy a board game night?' });
    expect((await apply(NEWBIE, { role: 'host', display_name: 'Nina Newbie', about: 'Catan nights' })).status).toBe(201);
  });

  it('records every step in the audit log', async () => {
    await decide(MICHELLE, 'RTD-APP-00001', 'approve');
    await decide(DAN, 'RTD-APP-00002', 'decline');
    const { results } = await env.DB.prepare("SELECT action, actor_id FROM audit_log WHERE entity_type IN ('application', 'user') ORDER BY audit_id").all();
    expect(results).toEqual([
      { action: 'application.host.submitted', actor_id: 'newbie@example.com' },
      { action: 'application.staff.submitted', actor_id: 'barista@example.com' },
      { action: 'application.approved', actor_id: 'michelle@example.com' },
      { action: 'user.granted_host', actor_id: 'michelle@example.com' },
      { action: 'application.declined', actor_id: 'dan@example.com' },
    ]);
  });
});

describe('the café team and removing access', () => {
  it('lists the team for admins only', async () => {
    expect((await request('/api/staff/team', {}, MICHELLE)).status).toBe(403);
    const { team } = await (await request('/api/staff/team', {}, DAN)).json<{ team: { email: string; role: string }[] }>();
    expect(team.map(t => [t.email, t.role])).toEqual([
      ['dan@example.com', 'admin'],
      ['michelle@example.com', 'staff'],
    ]);
  });

  it('lets staff remove hosts, and only admins remove staff', async () => {
    expect((await request('/api/staff/users/u-sam/remove', json({}), MICHELLE)).status).toBe(200);
    expect((await request('/api/host/me', {}, SAM)).status).toBe(403);
    expect((await request('/api/staff/users/u-mich/remove', json({}), MICHELLE)).status).toBe(403); // their own access
    expect((await request('/api/staff/users/u-dan/remove', json({}), MICHELLE)).status).toBe(403); // an admin
    expect((await request('/api/staff/users/u-mich/remove', json({}), DAN)).status).toBe(200);
    expect((await request('/api/host/me', {}, MICHELLE)).status).toBe(403);
    expect((await request('/api/staff/users/u-dan/remove', json({}), DAN)).status).toBe(403);
  });

  it('lets someone who was removed ask again', async () => {
    await request('/api/staff/users/u-sam/remove', json({}), MICHELLE);
    expect((await (await request('/api/join/me', {}, SAM)).json<{ has_access: boolean }>()).has_access).toBe(false);
    const res = await apply(SAM, { role: 'host', display_name: 'Sam', about: 'Back for more Root' });
    expect(res.status).toBe(201);
    const { application } = await res.json<{ application: App }>();
    expect((await decide(MICHELLE, application.application_id, 'approve')).status).toBe(200);
    expect((await request('/api/host/me', {}, SAM)).status).toBe(200);
    // Same users row as before, so the audit trail follows one person.
    const users = await env.DB.prepare("SELECT user_id, active FROM users WHERE email = 'sam@example.com'").all();
    expect(users.results).toEqual([{ user_id: 'u-sam', active: 1 }]);
    const granted = await env.DB.prepare("SELECT entity_id FROM audit_log WHERE action = 'user.granted_host'").first();
    expect(granted).toEqual({ entity_id: 'u-sam' });
  });
});

describe('emails for n8n', () => {
  beforeEach(async () => {
    await apply(NEWBIE, { role: 'host', display_name: 'Nina Newbie', about: 'Beginner D&D one-shots' });
    await apply(as('barista@example.com'), { role: 'staff', display_name: 'Bea Barista', about: 'Front of house' });
  });

  it('sends host requests to the café and café team requests to the admins, once', async () => {
    expect((await request('/internal/applications/new')).status).toBe(401);
    const body = await (await request('/internal/applications/new', { headers: AUTH })).json<{ organiser_url: string; applications: App[] }>();
    expect(body.organiser_url).toBe('http://localhost/organise');
    expect(body.applications.map(a => [a.application_id, a.role_label, a.notify, a.notify_cafe])).toEqual([
      ['RTD-APP-00001', 'host', [], true],
      ['RTD-APP-00002', 'café team', ['dan@example.com'], false],
    ]);
    const mark = (id: string) => request(`/internal/applications/${id}/approver-notified`, { method: 'POST', headers: AUTH });
    expect(await (await mark('RTD-APP-00001')).json()).toEqual({ ok: true, already: false });
    expect(await (await mark('RTD-APP-00001')).json()).toEqual({ ok: true, already: true });
    expect((await mark('RTD-APP-09999')).status).toBe(404);
    const after = await (await request('/internal/applications/new', { headers: AUTH })).json<{ applications: App[] }>();
    expect(after.applications.map(a => a.application_id)).toEqual(['RTD-APP-00002']);
  });

  it('tells applicants the outcome, once', async () => {
    await decide(MICHELLE, 'RTD-APP-00001', 'approve');
    const { applications } = await (await request('/internal/applications/decided', { headers: AUTH })).json<{ applications: App[] }>();
    expect(applications).toEqual([expect.objectContaining({ application_id: 'RTD-APP-00001', status: 'approved', first_name: 'Nina', email: 'newbie@example.com' })]);
    await request('/internal/applications/RTD-APP-00001/applicant-notified', { method: 'POST', headers: AUTH });
    expect((await (await request('/internal/applications/decided', { headers: AUTH })).json<{ applications: App[] }>()).applications).toEqual([]);
  });

  it('tells hosts when the café approves or declines a session, once', async () => {
    const session = { name: 'Root Night', event_date: '2026-10-24', start_time: '19:00', price_pence: 0, max_players: 4, access: 'private' };
    await request('/api/host/sessions', json(session), SAM);
    await request('/api/host/sessions', json({ ...session, name: 'Wingspan' }), SAM);
    await request('/api/host/sessions', json({ ...session, name: 'Still Waiting' }), SAM);
    await request('/api/staff/host-sessions/RTD-HS-00001/decision', json({ decision: 'approve' }), MICHELLE);
    await request('/api/staff/host-sessions/RTD-HS-00002/decision', json({ decision: 'decline', note: 'Full that night' }), MICHELLE);
    const { sessions } = await (await request('/internal/host-sessions/decided', { headers: AUTH })).json<{ sessions: Record<string, unknown>[] }>();
    expect(sessions).toEqual([
      expect.objectContaining({ session_id: 'RTD-HS-00001', approved: true, private: true, when: 'Saturday 24 October', host_first_name: 'Sam' }),
      expect.objectContaining({ session_id: 'RTD-HS-00002', approved: false, decision_note: 'Full that night', host_email: 'sam@example.com' }),
    ]);
    await request('/internal/host-sessions/RTD-HS-00001/host-notified', { method: 'POST', headers: AUTH });
    const after = await (await request('/internal/host-sessions/decided', { headers: AUTH })).json<{ sessions: { session_id: string }[] }>();
    expect(after.sessions.map(s => s.session_id)).toEqual(['RTD-HS-00002']);
  });
});
