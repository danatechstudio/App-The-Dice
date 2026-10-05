import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAccessToken } from '../src/lib/auth';
import { env, freshDb, indexRow, request, sync } from './helpers';

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
  await sync({
    run_id: 'seed',
    sources: {
      event_index: [
        indexRow(1, { 'Event Name': 'Quiz' }),
        indexRow(2, { 'Event Name': 'Spooky Market', 'Event Date': '17/10/2026', 'App Category': 'Market' }),
        indexRow(3, { 'Event Name': 'Members Night', 'Event Date': '10/10/2026', 'App Visibility': 'Private' }),
        indexRow(4, { 'Event Name': 'Food1', 'Event Date': '11/10/2026', 'App Visibility': 'Hidden' }),
        indexRow(5, { 'Event Name': 'BookClub', 'Event Date': '12/10/2026', Status: 'Inactive' }),
        indexRow(6, { 'Event Name': 'D&D One Shot', 'Event Date': '18/10/2026', 'App Visibility': 'App Bookable', 'App Category': 'Gaming' }),
      ],
    },
  });
});
afterEach(() => vi.useRealTimers());

describe('public diary API', () => {
  it('lists only active Public and App Bookable occurrences, in date order', async () => {
    const res = await request('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const body = await res.json<{ occurrences: { name: string; date: string; visibility: string }[] }>();
    expect(body.occurrences.map(o => [o.name, o.date, o.visibility])).toEqual([
      ['Spooky Market', '2026-10-17', 'public'],
      ['D&D One Shot', '2026-10-18', 'app_bookable'],
      ['Quiz', '2026-10-23', 'public'],
    ]);
  });

  it('filters by category and date range, and validates both', async () => {
    const market = await (await request('/api/events?category=Market')).json<{ occurrences: unknown[] }>();
    expect(market.occurrences).toHaveLength(1);
    const range = await (await request('/api/events?from=2026-10-18&to=2026-10-20')).json<{ occurrences: { name: string }[] }>();
    expect(range.occurrences.map(o => o.name)).toEqual(['D&D One Shot']);
    expect((await request('/api/events?category=Karaoke')).status).toBe(400);
    expect((await request('/api/events?from=yesterday')).status).toBe(400);
    expect((await request('/api/events?from=2026-13-45')).status).toBe(400);
    expect((await request('/api/events?to=2026-02-30')).status).toBe(400);
    expect((await request('/api/events?from=2026-10-10&to=2026-10-01')).status).toBe(400);
    expect((await request('/api/events?from=2026-10-10&to=2027-10-01')).status).toBe(400);
  });

  it('never lists the past', async () => {
    const body = await (await request('/api/events?from=2026-09-01&to=2026-10-20')).json<{ from: string }>();
    expect(body.from).toBe('2026-10-05');
  });

  it('serves an event page and a deep-linked occurrence', async () => {
    const event = await request('/api/events/RTD-EVT-00001');
    expect(event.status).toBe(200);
    expect(await event.json()).toMatchObject({ event: { name: 'Quiz' }, occurrences: [{ occurrence_id: 'RTD-OCC-00001-20261023' }] });
    const occ = await request('/api/occurrences/RTD-OCC-00001-20261023');
    expect(await occ.json()).toMatchObject({ occurrence: { name: 'Quiz', starts_at: '2026-10-23T17:30:00.000Z', all_day: false } });
  });

  it('hides private, hidden and inactive events everywhere', async () => {
    for (const id of ['RTD-EVT-00003', 'RTD-EVT-00004', 'RTD-EVT-00005']) {
      expect((await request(`/api/events/${id}`)).status).toBe(404);
    }
    expect((await request('/api/occurrences/RTD-OCC-00003-20261010')).status).toBe(404);
    expect((await request('/api/events/not-an-id')).status).toBe(404);
  });

  it('reports sync health', async () => {
    expect(await (await request('/api/health')).json()).toEqual({ ok: true, last_sync: '2026-10-05T10:00:00.000Z' });
  });
});

describe('staff API and Cloudflare Access', () => {
  const TEAM = 'https://rtd-test.cloudflareaccess.com';
  const AUD = 'test-aud-tag';
  let token: (email: string, opts?: { aud?: string; iss?: string; exp?: string }) => Promise<string>;
  let jwks: { keys: unknown[] };

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
    token = (email, opts = {}) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(opts.iss ?? TEAM)
        .setAudience(opts.aud ?? AUD)
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '1h')
        .sign(privateKey);
  });

  beforeEach(async () => {
    vi.useRealTimers(); // JWT expiry is checked against the real clock
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json(jwks);
      return realFetch(input, init);
    });
    const now = new Date().toISOString();
    await env.DB.batch(
      [
        ['u1', 'staff@example.com', 'staff', 1],
        ['u2', 'host@example.com', 'host', 1],
        ['u3', 'admin@example.com', 'admin', 1],
        ['u4', 'former@example.com', 'staff', 0],
      ].map(([id, email, role, active]) =>
        env.DB.prepare('INSERT INTO users (user_id, email, role, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)')
          .bind(id, email, role, active, now),
      ),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const asUser = async (path: string, email: string) =>
    request(path, { headers: { 'Cf-Access-Jwt-Assertion': await token(email) } }, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });

  it('requires sign-in', async () => {
    const res = await request('/api/staff/me', {}, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('lets nobody in while Access is not configured', async () => {
    const res = await request('/api/staff/me', { headers: { 'Cf-Access-Jwt-Assertion': await token('staff@example.com') } });
    expect(res.status).toBe(401);
  });

  it('admits staff and admin, and refuses hosts, unknown and disabled accounts', async () => {
    const staff = await asUser('/api/staff/me', 'Staff@Example.com');
    expect(staff.status).toBe(200);
    expect(staff.headers.get('Cache-Control')).toBe('no-store');
    expect(await staff.json()).toEqual({ user: { user_id: 'u1', email: 'staff@example.com', role: 'staff' } });
    expect((await asUser('/api/staff/me', 'admin@example.com')).status).toBe(200);
    expect((await asUser('/api/staff/me', 'host@example.com')).status).toBe(403);
    expect((await asUser('/api/staff/me', 'stranger@example.com')).status).toBe(403);
    expect((await asUser('/api/staff/me', 'former@example.com')).status).toBe(403);
  });

  it('shows staff the sync runs and audit history', async () => {
    const runs = await (await asUser('/api/staff/sync-runs', 'staff@example.com')).json<{ sync_runs: { run_id: string }[] }>();
    expect(runs.sync_runs.map(r => r.run_id)).toEqual(['seed']);
    const audit = await (await asUser('/api/staff/audit?entity_id=RTD-EVT-00001', 'staff@example.com')).json<{ audit: { action: string }[] }>();
    expect(audit.audit.map(a => a.action)).toEqual(['occurrence.created', 'event.created']);
  });

  it('rejects tokens for another audience or issuer, or expired ones', async () => {
    const opts = { teamDomain: TEAM, audience: AUD };
    expect(await verifyAccessToken(await token('staff@example.com'), opts)).toBe('staff@example.com');
    expect(await verifyAccessToken(await token('staff@example.com', { aud: 'other-app' }), opts)).toBeNull();
    expect(await verifyAccessToken(await token('staff@example.com', { iss: 'https://evil.cloudflareaccess.com' }), opts)).toBeNull();
    expect(await verifyAccessToken(await token('staff@example.com', { exp: '-1m' }), opts)).toBeNull();
    expect(await verifyAccessToken('not-a-jwt', opts)).toBeNull();
  });
});
