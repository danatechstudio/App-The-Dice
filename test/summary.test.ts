import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // host

type Summary = { sections: Record<string, { count: number; parts?: Record<string, number>; info?: Record<string, number> }> };
const summary = async (who: Partial<Env>) => (await request('/api/staff/summary', {}, who)).json<Summary>();

const NOW = '2026-10-05T10:00:00Z';
const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(NOW),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(NOW),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(NOW),
  ]);
  // Three café events: in 3 days, in 10 days, and in 18 days.
  await sync({
    run_id: 'seed',
    sources: {
      event_index: [indexRow(1, { 'Event Date': '08/10/2026' }), indexRow(2, { 'Event Date': '15/10/2026' }), indexRow(3)],
      standard_diary: [],
    },
  });
});
afterEach(() => vi.useRealTimers());

describe('the organiser summary', () => {
  it('refuses signed-out callers and hosts', async () => {
    expect((await request('/api/staff/summary')).status).toBe(401);
    expect((await request('/api/staff/summary', {}, SAM)).status).toBe(403);
  });

  it('an approver gets five sections, an admin seven', async () => {
    const res = await request('/api/staff/summary', {}, DAN);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const dan = await res.json<Summary>();
    expect(Object.keys(dan.sections)).toEqual(['approve', 'attention', 'events', 'bookings', 'people', 'content', 'stats']);
    expect(dan.sections.events!.parts).toHaveProperty('sheet_edit_problems');
    const michelle = await summary(MICHELLE);
    expect(Object.keys(michelle.sections)).toEqual(['approve', 'attention', 'events', 'bookings', 'people']);
    expect(michelle.sections.events!.parts ?? {}).not.toHaveProperty('sheet_edit_problems');
  });

  it('is all clear on an empty database', async () => {
    for (const s of Object.values((await summary(DAN)).sections)) expect(s.count).toBe(0);
  });

  it('counts what waits for a decision', async () => {
    const app = (id: string, status: string) =>
      run(
        "INSERT INTO applications (application_id, email, display_name, role, about, status, created_at, updated_at) VALUES (?1, ?2, 'A', 'host', 'x', ?3, ?4, ?4)",
        id, `${id}@example.com`, status, NOW,
      );
    await app('RTD-APP-00001', 'pending');
    await app('RTD-APP-00002', 'pending');
    await app('RTD-APP-00003', 'declined');
    const session = (id: string, status: string) =>
      run(
        "INSERT INTO host_sessions (session_id, host_user_id, name, event_date, start_time, max_players, status, created_at, updated_at) VALUES (?1, 'u-sam', 'D&D', '2026-10-20', '18:00', 6, ?2, ?3, ?3)",
        id, status, NOW,
      );
    await session('RTD-HS-00001', 'submitted');
    await session('RTD-HS-00002', 'published');
    await run(
      "INSERT INTO event_change_requests (request_id, session_id, event_id, requested_by, published, proposed, status, created_at, updated_at) VALUES ('RTD-CR-00001', 'RTD-HS-00002', 'RTD-EVT-00001', 'sam@example.com', '{}', '{}', 'pending', ?1, ?1)",
      NOW,
    );
    await run(
      "INSERT INTO markets (market_id, name, event_date, start_time, pitches, pitch_fee_pence, applications_close, payment_details, status, created_by, created_at, updated_at) VALUES ('RTD-MKT-00001', 'Spooky', '2026-10-31', '10:00', 10, 1000, '2026-10-25', 'Bank', 'scheduled', 'dan@example.com', ?1, ?1)",
      NOW,
    );
    await run(
      "INSERT INTO market_applications (application_id, market_id, stall_name, contact_name, email, mobile, products, insured, status, submit_key, created_at, updated_at) VALUES ('RTD-MA-00001', 'RTD-MKT-00001', 'Stall', 'Jo', 'jo@example.com', '07000', 'Jam', 1, 'pending', 'k1', ?1, ?1)",
      NOW,
    );
    expect((await summary(MICHELLE)).sections.approve).toEqual({
      count: 5,
      parts: { join_requests: 2, sessions: 1, changes: 1, market_applications: 1 },
    });
  });

  it('counts open attention items only while attention is on', async () => {
    const item = (key: string, status: string) =>
      run("INSERT INTO attention_items (item_key, kind, event_id, status, opened_at) VALUES (?1, 'no_date', 'RTD-EVT-00003', ?2, ?3)", key, status, NOW);
    await item('a', 'open');
    await item('b', 'resolved');
    await run("INSERT OR REPLACE INTO settings (key, value, updated_at, updated_by) VALUES ('needs_attention', 'on', ?1, 'test')", NOW);
    expect((await summary(MICHELLE)).sections.attention!.parts!.open_items).toBe(1);
    await run("UPDATE settings SET value = 'off' WHERE key = 'needs_attention'");
    expect((await summary(MICHELLE)).sections.attention!.parts!.open_items).toBe(0);
  });

  it('counts given-up emails and pushes from the last 7 days', async () => {
    const email = (key: string, dead: string | null, sent: string | null) =>
      run("INSERT INTO outbox (dedupe_key, kind, subject, html, created_at, dead_at, sent_at) VALUES (?1, 'booking', 's', 'h', ?2, ?3, ?4)", key, daysAgo(12), dead, sent);
    await email('e1', daysAgo(2), null);
    await email('e2', daysAgo(9), null);
    await email('e3', null, daysAgo(1));
    const push = (key: string, status: number) =>
      run(
        "INSERT INTO push_outbox (dedupe_key, kind, device_id, booking_id, title, body, url, tag, last_status, dead_at, created_at) VALUES (?1, 'date-cancelled', 1, 'RTD-BK-1', 't', 'b', '/', 'x', ?2, ?3, ?3)",
        key, status, daysAgo(1),
      );
    await push('p1', 500);
    await push('p2', 410);
    expect((await summary(MICHELLE)).sections.attention).toEqual({ count: 2, parts: { open_items: 0, failed_deliveries: 2 } });
  });

  it('counts the admin-only problems', async () => {
    const edit = (id: string, status: string) =>
      run(
        "INSERT INTO sheet_edits (edit_id, event_id, source, target, fields, requested_by, status, created_at, updated_at) VALUES (?1, 'RTD-EVT-00001', 'event_index', 'staging', '{}', 'dan@example.com', ?2, ?3, ?3)",
        id, status, NOW,
      );
    await edit('RTD-SE-00001', 'conflict');
    await edit('RTD-SE-00002', 'dead');
    await edit('RTD-SE-00003', 'queued');
    await run("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('food_menu_sync', ?1, ?2, 'n8n')", JSON.stringify({ at: NOW, ok: false, errors: ['x'] }), NOW);
    await run(
      "INSERT INTO game_review (review_id, source_key, source_title, kind, entry, created_at, updated_at) VALUES ('R1', 'k', 'Catan', 'uncertain', '{}', ?1, ?1)",
      NOW,
    );
    const dan = await summary(DAN);
    expect(dan.sections.events).toEqual({ count: 2, parts: { sheet_edit_problems: 2 } });
    expect(dan.sections.content).toEqual({ count: 2, parts: { menu_sheet_problem: 1, games_to_review: 1 } });
    expect((await summary(MICHELLE)).sections.events!.count).toBe(0);
  });

  it('shows booked dates this week as information, not as waiting', async () => {
    const booking = (id: string, occ: string) =>
      run(
        "INSERT INTO bookings (booking_id, occurrence_id, lead_name, email, party_size, status, cancellation_token_hash, created_at, updated_at) VALUES (?1, ?2, 'Jo', 'jo@example.com', 2, 'confirmed', ?1, ?3, ?3)",
        id, occ, NOW,
      );
    await booking('RTD-BK-00001', 'RTD-OCC-00001-20261008');
    await booking('RTD-BK-00002', 'RTD-OCC-00002-20261015');
    expect((await summary(MICHELLE)).sections.bookings).toEqual({ count: 0, info: { booked_dates_7_days: 1 } });
  });

  it('changes nothing', async () => {
    const snapshot = async () =>
      env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM audit_log) a, (SELECT COUNT(*) FROM outbox) o, (SELECT COUNT(*) FROM attention_items) i, (SELECT COUNT(*) FROM settings) s, (SELECT MAX(updated_at) FROM settings) u",
      ).first();
    const before = await snapshot();
    await summary(DAN);
    await summary(MICHELLE);
    expect(await snapshot()).toEqual(before);
  });
});
