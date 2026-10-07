import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { applyRetention, monthsBefore } from '../src/lib/privacy';
import { env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const QUIZ = 'RTD-OCC-00004-20261008'; // Thu 8 Oct 2026
const BINGO = 'RTD-OCC-00005-20261020'; // Tue 20 Oct 2026

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const rows = [
    indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '08/10/2026' }),
    indexRow(5, { 'Event Name': 'Bingo', Day: 'Tuesday', 'Event Date': '20/10/2026' }),
  ];
  expect((await sync({ run_id: 'setup', sources: { event_index: rows } })).status).toBe(200);
});
afterEach(() => vi.useRealTimers());

const book = (occurrence: string, email: string, extra: Record<string, unknown> = {}) =>
  request('/api/bookings', json({ occurrence_id: occurrence, lead_name: 'Ava Player', email, mobile: '07700 900123', notes: 'Window seat', party_size: 2, ...extra }), {});

describe('the privacy notice', () => {
  it('names the café, with no contact address until one is set', async () => {
    const res = await request('/api/privacy');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await res.json()).toEqual({ controller: 'Roll The Dice Board Game Café, Cleethorpes', contact_email: null, booking_retention_months: 12 });
  });

  it('takes the name, contact address and keep-for from the settings', async () => {
    const now = '2026-10-07T00:00:00Z';
    await env.DB.batch([
      env.DB.prepare("UPDATE settings SET value = 'Roll The Dice Ltd' WHERE key = 'privacy_controller'"),
      env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('privacy_contact_email', 'hello@cafe.example', ?1)").bind(now),
      env.DB.prepare("UPDATE settings SET value = '6' WHERE key = 'booking_retention_months'"),
    ]);
    expect(await (await request('/api/privacy')).json()).toEqual({ controller: 'Roll The Dice Ltd', contact_email: 'hello@cafe.example', booking_retention_months: 6 });
    // Nonsense is ignored rather than shown.
    await env.DB.batch([
      env.DB.prepare("UPDATE settings SET value = 'not an address' WHERE key = 'privacy_contact_email'"),
      env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'booking_retention_months'"),
    ]);
    expect(await (await request('/api/privacy')).json()).toMatchObject({ contact_email: null, booking_retention_months: 12 });
  });

  it('is linked from the booking confirmation', async () => {
    expect((await book(QUIZ, 'ava@example.com')).status).toBe(201);
    const mail = await env.DB.prepare("SELECT html FROM outbox WHERE kind = 'booking_confirmed'").first<{ html: string }>();
    expect(mail!.html).toContain('href="http://localhost/privacy"');
  });
});

describe('months before', () => {
  it('counts back calendar months, keeping to real dates', () => {
    expect(monthsBefore('2026-10-07', 12)).toBe('2025-10-07');
    expect(monthsBefore('2026-01-15', 1)).toBe('2025-12-15');
    expect(monthsBefore('2026-03-31', 1)).toBe('2026-02-28');
    expect(monthsBefore('2024-03-31', 1)).toBe('2024-02-29');
    expect(monthsBefore('2026-10-07', 24)).toBe('2024-10-07');
  });
});

describe('erasing details that are no longer needed', () => {
  it("erases a booking's contact details 12 months after the event, keeping the numbers", async () => {
    expect((await book(QUIZ, 'ava@example.com')).status).toBe(201); // RTD-BK-00001, Thu 8 Oct 2026
    expect((await book(BINGO, 'bea@example.com', { lead_name: 'Bea' })).status).toBe(201); // RTD-BK-00002, Tue 20 Oct 2026

    vi.setSystemTime(new Date('2027-10-08T03:23:00Z')); // the day before the cut-off reaches the Quiz
    expect(await applyRetention(env.DB, new Date())).toMatchObject({ bookings: 0 });

    vi.setSystemTime(new Date('2027-10-09T03:23:00Z'));
    expect(await applyRetention(env.DB, new Date())).toMatchObject({ bookings: 1 });
    const rows = await env.DB.prepare('SELECT booking_id, lead_name, email, mobile, notes, ip_hash, party_size, status, erased_at FROM bookings ORDER BY booking_id').all();
    expect(rows.results).toEqual([
      { booking_id: 'RTD-BK-00001', lead_name: 'Erased', email: 'erased-RTD-BK-00001', mobile: null, notes: null, ip_hash: null, party_size: 2, status: 'confirmed', erased_at: '2027-10-09T03:23:00.000Z' },
      { booking_id: 'RTD-BK-00002', lead_name: 'Bea', email: 'bea@example.com', mobile: '07700 900123', notes: 'Window seat', ip_hash: null, party_size: 2, status: 'confirmed', erased_at: null },
    ]);
    // Once only.
    expect(await applyRetention(env.DB, new Date())).toMatchObject({ bookings: 0 });
  });

  it('keeps the scrambled network address for 2 days only', async () => {
    expect((await request('/api/bookings', json({ occurrence_id: QUIZ, lead_name: 'Ava', email: 'ava@example.com', party_size: 1 }), {})).status).toBe(201);
    await env.DB.prepare("UPDATE bookings SET ip_hash = 'abc123'").run(); // the test request has no network address
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    expect(await applyRetention(env.DB, new Date())).toMatchObject({ network_hashes: 0 });
    vi.setSystemTime(new Date('2026-10-08T10:00:01Z'));
    expect(await applyRetention(env.DB, new Date())).toMatchObject({ network_hashes: 1 });
    expect(await env.DB.prepare('SELECT ip_hash, email FROM bookings').first()).toEqual({ ip_hash: null, email: 'ava@example.com' });
  });

  it('erases join requests that were declined or withdrawn 12 months ago', async () => {
    const insert = (id: string, status: string, decided: string | null, updated: string) =>
      env.DB.prepare(
        `INSERT INTO applications (application_id, email, display_name, role, about, status, decision_note, decided_at, created_at, updated_at)
         VALUES (?1, ?2, 'Nina', 'host', 'Catan nights', ?3, 'Not this time', ?4, ?5, ?5)`,
      ).bind(id, `${id}@example.com`, status, decided, updated);
    await env.DB.batch([
      insert('RTD-APP-00001', 'declined', '2025-09-01T10:00:00Z', '2025-09-01T10:00:00Z'),
      insert('RTD-APP-00002', 'withdrawn', null, '2025-09-02T10:00:00Z'),
      insert('RTD-APP-00003', 'declined', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z'), // only a month ago
      insert('RTD-APP-00004', 'approved', '2025-01-01T10:00:00Z', '2025-01-01T10:00:00Z'), // a host now
      insert('RTD-APP-00005', 'pending', null, '2025-01-01T10:00:00Z'),
    ]);
    expect(await applyRetention(env.DB, new Date())).toMatchObject({ requests: 2 });
    const rows = await env.DB.prepare('SELECT application_id, display_name, email, about, decision_note FROM applications ORDER BY application_id').all();
    expect(rows.results.map(r => [r.application_id, r.display_name])).toEqual([
      ['RTD-APP-00001', 'Erased'],
      ['RTD-APP-00002', 'Erased'],
      ['RTD-APP-00003', 'Nina'],
      ['RTD-APP-00004', 'Nina'],
      ['RTD-APP-00005', 'Nina'],
    ]);
    expect(rows.results[0]).toEqual({ application_id: 'RTD-APP-00001', display_name: 'Erased', email: 'erased-RTD-APP-00001', about: '', decision_note: null });
  });

  it('keeps people out of the audit log, which can never be erased', async () => {
    expect((await book(QUIZ, 'ava@example.com')).status).toBe(201);
    const manage = await env.DB.prepare('SELECT booking_id FROM bookings').first<{ booking_id: string }>();
    expect(manage).toEqual({ booking_id: 'RTD-BK-00001' });
    await request('/api/join/apply', json({ display_name: 'Nina Newbie', about: 'Beginner-friendly Catan nights' }), as('nina@example.com'));
    const audit = await env.DB.prepare("SELECT actor_id, new_value FROM audit_log WHERE actor_type = 'customer' ORDER BY audit_id").all<{ actor_id: string; new_value: string | null }>();
    expect(audit.results.map(r => r.actor_id)).toEqual(['RTD-BK-00001', 'RTD-APP-00001']);
    const everything = JSON.stringify(audit.results);
    for (const personal of ['ava@example.com', 'nina@example.com', 'Nina', 'Catan']) expect(everything).not.toContain(personal);
  });

  it('runs every day from the Cron Trigger', async () => {
    expect((await book(QUIZ, 'ava@example.com')).status).toBe(201);
    vi.setSystemTime(new Date('2027-11-01T03:23:00Z'));
    const ctx = createExecutionContext();
    await worker.scheduled!({ scheduledTime: Date.now(), cron: '23 3 * * *', noRetry: () => {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.DB.prepare('SELECT lead_name FROM bookings').first()).toEqual({ lead_name: 'Erased' });
  });
});
