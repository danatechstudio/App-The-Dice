// Stage 5b (docs/RTD_EVENT_CONTROL_AUDIT.md §5): approvers and admins change one date in the
// app: hide it or show it again, and its own description and price label. The sync never
// touches these; nothing hidden by the sheet is ever made public here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../src/attention/attention';
import { env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // host
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const QUIZ = 'RTD-OCC-00004-20261008'; // Thu 8 Oct, a one-off
const CHESS = 'RTD-OCC-00002-20261013'; // weekly, Tuesdays
const rows = () => [
  indexRow(2, { 'Event Name': 'Chess Club', Frequency: 'Weekly', Day: 'Tuesday', 'Event Date': '13/10/2026', 'Event Time': '18:00', 'End Time': '20:00', 'Base Details': 'All levels.', 'App Price': '£2' }),
  indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '08/10/2026', 'Event Time': '19:30', 'End Time': '22:00', 'Base Details': 'Teams of six.' }),
  indexRow(5, { 'Event Name': 'Staff Party', Day: 'Friday', 'Event Date': '09/10/2026', 'App Visibility': 'Hidden' }),
];
let run = 0;
const syncAll = () => sync({ run_id: `r${++run}`, sources: { event_index: rows() } });
const edit = (id: string, body: Record<string, unknown>, who: Partial<Env> = MICHELLE) => request(`/api/staff/dates/${id}`, json(body), who);
const listed = async () => (await (await request('/api/events')).json<{ occurrences: { occurrence_id: string }[] }>()).occurrences.map(o => o.occurrence_id);
const publicDate = async (id: string) => (await (await request(`/api/occurrences/${id}`)).json<{ occurrence: Record<string, unknown> }>()).occurrence;

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
  ]);
  expect((await syncAll()).status).toBe(200);
});
afterEach(() => vi.useRealTimers());

describe('changing one date in the app', () => {
  it('lists the dates coming up, but never the ones the sheet hides', async () => {
    const res = await request('/api/staff/dates', {}, MICHELLE);
    const { dates } = await res.json<{ dates: Record<string, unknown>[] }>();
    expect(dates.map(d => d.occurrence_id)).toContain(QUIZ);
    expect(dates.map(d => d.name)).not.toContain('Staff Party');
    expect(dates.find(d => d.occurrence_id === QUIZ)).toMatchObject({ hidden: false, description: null, event_description: 'Teams of six.', price: null, bookings: 0 });
    expect((await request('/api/staff/dates', {}, SAM)).status).toBe(403);
  });

  it('hides a date in the app and shows it again, and the sync leaves it alone', async () => {
    expect(await (await edit(CHESS, { hidden: true })).json()).toMatchObject({ date: { hidden: true } });
    expect(await listed()).not.toContain(CHESS);
    expect(await listed()).toContain('RTD-OCC-00002-20261020'); // only that date
    expect((await request(`/api/occurrences/${CHESS}`)).status).toBe(404);
    expect((await syncAll()).status).toBe(200);
    expect(await listed()).not.toContain(CHESS);
    expect(await (await edit(CHESS, { hidden: false })).json()).toMatchObject({ date: { hidden: false } });
    expect(await listed()).toContain(CHESS);
    const audit = await env.DB.prepare("SELECT occurrence_id, actor_id, previous_value, new_value FROM audit_log WHERE action = 'occurrence.edited' ORDER BY audit_id").all();
    expect(audit.results).toEqual([
      { occurrence_id: CHESS, actor_id: 'michelle@example.com', previous_value: '{"hidden":false}', new_value: '{"hidden":true}' },
      { occurrence_id: CHESS, actor_id: 'michelle@example.com', previous_value: '{"hidden":true}', new_value: '{"hidden":false}' },
    ]);
  });

  it('asks before hiding a date people have booked, and their bookings stand', async () => {
    const booked = await (await request('/api/bookings', json({ occurrence_id: QUIZ, lead_name: 'Ava Player', email: 'ava@example.com', party_size: 2 }))).json<{ manage_path: string }>();
    const warned = await edit(QUIZ, { hidden: true });
    expect(warned.status).toBe(409);
    expect(await warned.json()).toEqual({ warning: { bookings: 1, people: 2 } });
    expect(await listed()).toContain(QUIZ);
    expect((await edit(QUIZ, { hidden: true, confirm: true })).status).toBe(200);
    expect(await listed()).not.toContain(QUIZ);
    const token = booked.manage_path.split('#t=')[1]!;
    const view = await (await request('/api/bookings/RTD-BK-00001/view', json({ token }))).json<{ booking: Record<string, unknown> }>();
    expect(view.booking).toMatchObject({ status: 'confirmed', party_size: 2 });
  });

  it('gives one date its own description and price, and back to the event’s', async () => {
    const res = await edit(CHESS, { description: 'Halloween special: spooky openings.', price: '£3' });
    expect(await res.json()).toMatchObject({ date: { description: 'Halloween special: spooky openings.', price: '£3' } });
    expect(await publicDate(CHESS)).toMatchObject({ description: 'Halloween special: spooky openings.', price_display: '£3' });
    expect(await publicDate('RTD-OCC-00002-20261020')).toMatchObject({ description: 'All levels.', price_display: '£2' });
    expect((await syncAll()).status).toBe(200);
    expect(await publicDate(CHESS)).toMatchObject({ description: 'Halloween special: spooky openings.' });
    // Empty, or the same as the event's: no override.
    expect(await (await edit(CHESS, { description: '', price: '£2' })).json()).toMatchObject({ date: { description: null, price: null } });
    expect(await publicDate(CHESS)).toMatchObject({ description: 'All levels.', price_display: '£2' });
  });

  it('checks the form, and only changes dates still to come', async () => {
    expect((await edit(CHESS, { price: 'x'.repeat(31) })).status).toBe(400);
    expect((await edit(CHESS, { hidden: 'yes' })).status).toBe(400);
    expect((await edit(CHESS, { hidden: true }, SAM)).status).toBe(403);
    expect((await edit('RTD-OCC-nonsense', { hidden: true })).status).toBe(404);
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
    expect((await edit(QUIZ, { hidden: true })).status).toBe(404); // finished
  });

  it('still raises Needs attention when a hidden last date ends', async () => {
    await env.DB.prepare("UPDATE settings SET value = 'on' WHERE key = 'needs_attention'").run();
    await edit(QUIZ, { hidden: true });
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
    await detect(env.DB, new Date());
    const item = await env.DB.prepare("SELECT kind FROM attention_items WHERE item_key = ?1").bind(`expired:${QUIZ}`).first();
    expect(item).toEqual({ kind: 'expired' });
  });
});
