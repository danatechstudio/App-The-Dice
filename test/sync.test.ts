import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diaryRow, env, freshDb, indexRow, request, sync } from './helpers';

const rows = () => [
  indexRow(1, { 'Event Name': 'Quiz', Frequency: 'Monthly' }),
  indexRow(2, { 'Event Name': 'Kids Chess Club', Frequency: 'Weekly', 'Event Date': '08/10/2026', 'App Category': 'Club' }),
  indexRow(3, { 'Event Name': 'Food1', 'Event Date': '', 'App Visibility': 'Hidden', 'App Category': '' }),
  indexRow(4, { 'Event Name': 'Cleeples', 'Event Date': 'Every Thursday', 'App Category': 'Gaming' }),
  indexRow(5, { 'Event Name': 'BookClub', Status: 'Inactive', 'Event Date': '27/10/2026', 'App Category': 'Club' }),
  indexRow(6, { 'Event Name': 'Spooky Market', 'Event Date': '17/10/2026', 'App Category': 'Market' }),
];

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('POST /internal/sync/logic-engine', () => {
  it('rejects a missing, malformed or wrong bearer token, saying which', async () => {
    const wrong = await sync({ run_id: 'a', sources: {} }, 'wrong');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Token does not match INTERNAL_SYNC_TOKEN' });
    const missing = await request('/internal/sync/logic-engine', { method: 'POST', body: '{}' });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Missing Authorization header' });
    const bare = await request('/internal/sync/logic-engine', { method: 'POST', body: '{}', headers: { Authorization: 'test-sync-token' } });
    expect(bare.status).toBe(401);
    expect(await bare.json()).toEqual({ error: "Authorization header must be 'Bearer <token>'" });
  });

  it('ignores stray whitespace around the token and secret', async () => {
    const res = await request(
      '/internal/sync/logic-engine',
      { method: 'POST', body: '{}', headers: { Authorization: '  bearer   test-sync-token \n' } },
      { INTERNAL_SYNC_TOKEN: 'test-sync-token\n' },
    );
    expect(res.status).toBe(400); // past auth; the empty body is what fails
  });

  it('reports a missing server secret as a configuration problem', async () => {
    const res = await request(
      '/internal/sync/logic-engine',
      { method: 'POST', body: '{}', headers: { Authorization: 'Bearer anything' } },
      { INTERNAL_SYNC_TOKEN: '' },
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/no INTERNAL_SYNC_TOKEN secret/);
  });

  it('rejects malformed payloads', async () => {
    expect((await sync({ sources: { event_index: [] } })).status).toBe(400); // no run_id
    expect((await sync({ run_id: 'bad id!', sources: { event_index: [] } })).status).toBe(400);
    expect((await sync({ run_id: 'r1', sources: { other_tab: [] } })).status).toBe(400);
    expect((await sync({ run_id: 'r1', sources: { event_index: [1, 2] } })).status).toBe(400);
    expect((await sync({ run_id: 'r1', sources: {} })).status).toBe(400);
  });

  it('applies a snapshot: events, occurrences, audit and run record', async () => {
    const res = await sync({ run_id: 'exec-100', sources: { event_index: rows(), standard_diary: [diaryRow(24)] } });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ status: 'ok', rows_received: 7, events_seen: 7, events_changed: 7 });
    expect((body.warnings as { code: string }[]).map(w => w.code)).toEqual(['invalid_date']);

    const events = await env.DB.prepare('SELECT event_id, display_name, active, visibility FROM events ORDER BY event_id').all();
    expect(events.results).toHaveLength(7);

    const occ = await env.DB.prepare(
      "SELECT event_id, event_date, projected FROM occurrences WHERE projected = 0 ORDER BY event_id",
    ).all();
    expect(occ.results).toEqual([
      { event_id: 'RTD-EVT-00001', event_date: '2026-10-23', projected: 0 },
      { event_id: 'RTD-EVT-00002', event_date: '2026-10-08', projected: 0 },
      { event_id: 'RTD-EVT-00006', event_date: '2026-10-17', projected: 0 },
      { event_id: 'RTD-EVT-00024', event_date: '2026-10-12', projected: 0 },
    ]);
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = 'exec-100'").first<{ n: number }>();
    expect(audit?.n).toBe(7 + 4); // 7 events created + 4 confirmed occurrences
    const run = await env.DB.prepare("SELECT status FROM sync_runs WHERE run_id = 'exec-100'").first();
    expect(run).toEqual({ status: 'ok' });
  });

  it('is idempotent: a repeated run_id is a no-op and a new run with the same data changes nothing', async () => {
    const payload = { run_id: 'exec-1', sources: { event_index: rows() } };
    await sync(payload);
    const dup = await (await sync(payload)).json<Record<string, unknown>>();
    expect(dup.status).toBe('duplicate');

    const again = await (await sync({ ...payload, run_id: 'exec-2' })).json<Record<string, unknown>>();
    expect(again).toMatchObject({ status: 'ok', events_changed: 0, occurrences_created: 0, occurrences_updated: 0 });
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM occurrences) AS occ, (SELECT COUNT(*) FROM audit_log WHERE actor_id = 'exec-2') AS audit",
    ).first();
    expect(counts).toEqual({ occ: 8, audit: 0 }); // Quiz, Spooky Market, Chess + its 5 weekly projections
  });

  it('refuses a snapshot that would wipe out most events', async () => {
    await sync({ run_id: 'good', sources: { event_index: rows() } });
    const res = await sync({ run_id: 'broken-read', sources: { event_index: rows().slice(0, 2) } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'rejected' });
    const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE active = 1').first<{ n: number }>();
    expect(active?.n).toBe(5); // unchanged
    const empty = await sync({ run_id: 'empty', sources: { event_index: [] } });
    expect(empty.status).toBe(409);
    // n8n retrying the same run must not turn a refusal into a success
    const retry = await sync({ run_id: 'broken-read', sources: { event_index: rows().slice(0, 2) } });
    expect(retry.status).toBe(409);
  });

  it('records occurrence history across days', async () => {
    await sync({ run_id: 'd1', sources: { event_index: rows() } });
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
    const moved = rows().map(r => (r['Event Name'] === 'Kids Chess Club' ? { ...r, 'Event Date': '15/10/2026' } : r));
    await sync({ run_id: 'd2', sources: { event_index: moved } });
    const chess = await env.DB.prepare(
      "SELECT event_date, status, projected FROM occurrences WHERE event_id = 'RTD-EVT-00002' ORDER BY event_date LIMIT 2",
    ).all();
    expect(chess.results).toEqual([
      { event_date: '2026-10-08', status: 'completed', projected: 0 },
      { event_date: '2026-10-15', status: 'scheduled', projected: 0 },
    ]);
  });
});

describe('audit_log', () => {
  it('is append-only', async () => {
    await sync({ run_id: 'a1', sources: { event_index: rows() } });
    await expect(env.DB.prepare("UPDATE audit_log SET action = 'x'").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);
  });
});
