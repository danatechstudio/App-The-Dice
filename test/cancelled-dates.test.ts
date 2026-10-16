// Stage 4c (docs/RTD_EVENT_CONTROL_AUDIT.md G-13): a date cancelled in the app is never
// left advertised in the sheet. A monthly row is switched off for us and Needs attention
// asks for its next date; the Standard Diary can't be written, so the café is asked to
// change the tab, and the item clears itself when the sheet changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../src/attention/attention';
import { remind } from '../src/attention/reminders';
import { diaryRow, env, freshDb, indexRow, request, sync } from './helpers';

const MICHELLE = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'michelle@example.com' }; // approver
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const AUTH = { Authorization: 'Bearer test-sync-token' };

const SOCIAL = 'RTD-EVT-00006'; // the café's own monthly, Thu 8 Oct
const QUIZ = 'RTD-OCC-00004-20261008'; // a one-off
const CLUB = 'RTD-EVT-00024'; // a weekly Standard Diary group, Mon 12 Oct in the sheet

const social = (over: Record<string, unknown> = {}) =>
  indexRow(6, { 'Event Name': 'Board Game Social', Frequency: 'Monthly', Day: 'Thursday', 'Event Date': '08/10/2026', 'Event Time': '19:00', 'End Time': '22:00', ...over });
const quiz = (over: Record<string, unknown> = {}) => indexRow(4, { 'Event Name': 'Quiz', Day: 'Thursday', 'Event Date': '08/10/2026', ...over });
const club = (over: Record<string, unknown> = {}) => diaryRow(24, { Group: 'Chess Club', Date: '12/10/2026', ...over });
let run = 0;
const syncAll = (rows: { social?: Record<string, unknown>; quiz?: Record<string, unknown>; club?: Record<string, unknown> } = {}) =>
  sync({ run_id: `run-${++run}`, sources: { event_index: [social(rows.social), quiz(rows.quiz)], standard_diary: [club(rows.club)] } });

const cancel = (occurrence: string) => request(`/api/host/occurrences/${occurrence}/cancel`, json({}), MICHELLE);
const fixes = async () => (await (await request('/internal/sheet-fixes', { headers: AUTH })).json<{ fixes: { event_id: string; key: string; row: Record<string, string> }[] }>()).fixes;
const attention = async () => (await (await request('/api/staff/attention', {}, MICHELLE)).json<{ open: Record<string, unknown>[]; resolved: Record<string, unknown>[] }>());
const outbox = async () => (await env.DB.prepare('SELECT kind, to_email, subject, html FROM outbox ORDER BY message_id').all<Record<string, string>>()).results;

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("UPDATE settings SET value = 'on' WHERE key = 'needs_attention'"),
  ]);
  expect((await syncAll()).status).toBe(200);
});
afterEach(() => vi.useRealTimers());

describe('a cancelled monthly date', () => {
  it('is switched off in the sheet, and Needs attention asks for its next date', async () => {
    expect((await cancel('RTD-OCC-00006-20261008')).status).toBe(200);
    expect(await fixes()).toEqual([{ event_id: SOCIAL, key: 'inactive:2026-10-08', row: { 'Event ID': SOCIAL, Status: 'Inactive', 'Event Date': '08/10/2026' } }]);
    const notice = (await outbox()).find(e => e.kind === 'cafe_date_cancelled')!;
    expect(notice.html).toContain("switched off in the Logic Engine within 15 minutes");

    expect(await detect(env.DB, new Date())).toMatchObject({ opened: 1 });
    const { open } = await attention();
    expect(open).toEqual([expect.objectContaining({ kind: 'cancelled', name: 'Board Game Social', date: '2026-10-08', actions: ['renew', 'archive', 'dismiss'] })]);

    // n8n switches the row off; the item waits for a decision.
    expect((await request(`/internal/sheet-fixes/${SOCIAL}/done`, json({ key: 'inactive:2026-10-08' }, AUTH))).status).toBe(200);
    expect(await fixes()).toEqual([]);
    expect((await syncAll({ social: { Status: 'Inactive' } })).status).toBe(200);
    expect(await detect(env.DB, new Date())).toEqual({ opened: 0, settled: 0, blocked: 0 });

    // Its next date: the row goes Active again with it.
    const item = open[0]!;
    expect((await request(`/api/staff/attention/${item.item_id}/resolve`, json({ action: 'renew', date: '2026-11-12' }), MICHELLE)).status).toBe(200);
    expect(await fixes()).toEqual([{ event_id: SOCIAL, key: 'renew:2026-11-12', row: { 'Event ID': SOCIAL, Status: 'Active', 'Event Date': '12/11/2026' } }]);
    await request(`/internal/sheet-fixes/${SOCIAL}/done`, json({ key: 'renew:2026-11-12' }, AUTH));
    expect((await syncAll({ social: { 'Event Date': '12/11/2026' } })).status).toBe(200);
    expect(await fixes()).toEqual([]);
    expect(await detect(env.DB, new Date())).toEqual({ opened: 0, settled: 0, blocked: 0 });
  });

  it('is never also shown as expired, though the date before it has ended', async () => {
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
    expect((await syncAll({ social: { 'Event Date': '12/11/2026' } })).status).toBe(200); // 8 Oct is over; next is 12 Nov
    expect((await cancel('RTD-OCC-00006-20261112')).status).toBe(200);
    await detect(env.DB, new Date());
    const kinds = (await attention()).open.filter(i => i.name === 'Board Game Social').map(i => [i.kind, i.date]);
    expect(kinds).toEqual([['cancelled', '2026-11-12']]);
  });

  it('a later month is switched off too', async () => {
    await cancel('RTD-OCC-00006-20261008');
    await request(`/internal/sheet-fixes/${SOCIAL}/done`, json({ key: 'inactive:2026-10-08' }, AUTH));
    await syncAll({ social: { 'Event Date': '12/11/2026' } }); // Active with next month's date, set in the sheet by hand
    expect((await cancel('RTD-OCC-00006-20261112')).status).toBe(200);
    expect((await fixes()).map(f => f.key)).toEqual(['inactive:2026-11-12']);
  });
});

describe('a cancelled Standard Diary date', () => {
  it('asks the café to change the tab, and clears itself when the sheet changes', async () => {
    expect((await cancel('RTD-OCC-00024-20261012')).status).toBe(200);
    expect(await fixes()).toEqual([]); // the app can't write the Standard Diary
    const notice = (await outbox()).find(e => e.kind === 'cafe_date_cancelled')!;
    expect(notice.html).toContain("the app can't change that tab");

    await detect(env.DB, new Date());
    const [item] = (await attention()).open;
    expect(item).toMatchObject({ kind: 'cancelled', name: 'Chess Club', source: 'standard_diary', date: '2026-10-12', actions: ['dismiss'] });
    expect((await request(`/api/staff/attention/${item!.item_id}/resolve`, json({ action: 'renew', date: '2026-10-19' }), MICHELLE)).status).toBe(409);

    expect((await syncAll({ club: { Date: '19/10/2026' } })).status).toBe(200);
    expect(await detect(env.DB, new Date())).toMatchObject({ settled: 1 });
    expect((await attention()).resolved[0]).toMatchObject({ kind: 'cancelled', resolution: 'renewed', resolved_by: 'sheet' });
  });

  it('clears itself once the date has passed', async () => {
    await cancel('RTD-OCC-00024-20261012');
    await detect(env.DB, new Date());
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    expect(await detect(env.DB, new Date())).toMatchObject({ settled: 1 });
    expect((await attention()).resolved[0]).toMatchObject({ kind: 'cancelled', resolution: 'completed', resolved_by: 'system' });
  });

  it("asks nothing for a later week that isn't the sheet's date yet", async () => {
    expect((await cancel('RTD-OCC-00024-20261019')).status).toBe(200);
    expect(await detect(env.DB, new Date())).toMatchObject({ opened: 0 });
  });

  it('is emailed to the attention addresses', async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE settings SET value = 'on' WHERE key = 'attention_emails'"),
      env.DB.prepare("UPDATE settings SET value = 'info@example.com' WHERE key = 'attention_email_to'"),
    ]);
    await cancel('RTD-OCC-00024-20261012');
    await detect(env.DB, new Date());
    expect(await remind(env.DB, new Date(), 'https://rtd.example')).toMatchObject({ notices: 1 });
    expect((await outbox()).find(e => e.kind === 'attention_cancelled')).toMatchObject({
      to_email: 'info@example.com',
      subject: 'Needs attention: Chess Club (Mon 12 Oct) was cancelled: change the Standard Diary',
    });
  });
});

describe('a cancelled one-off', () => {
  it("is switched off in the sheet as before, and isn't listed as a missing date meanwhile", async () => {
    expect((await cancel(QUIZ)).status).toBe(200);
    expect((await fixes()).map(f => [f.event_id, f.key])).toEqual([['RTD-EVT-00004', 'inactive']]);
    expect(await detect(env.DB, new Date())).toEqual({ opened: 0, settled: 0, blocked: 0 });
  });
});
