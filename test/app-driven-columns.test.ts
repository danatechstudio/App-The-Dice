// App-driven event setup (option A, 23 Oct 2026): every Logic Engine column a person fills in by
// hand can be changed from the app, through the same sheet_edits queue as the details. The sheet
// stays the master; a column RTD Event Sync doesn't send yet is never read as blank.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canon, cellsFor, checkRows, EXTRA, sheetValuesOf } from '../src/sync/sheetValues';
import { diaryRow, env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const AUTH = { Authorization: 'Bearer test-sync-token' };
const internal = (path: string, body: unknown = {}) => request(`/internal${path}`, json(body, AUTH));

const QUIZ = 'RTD-EVT-00004';
const DIARY = 'RTD-EVT-00008';
type Row = Record<string, unknown>;

/** The columns RTD Event Sync will send once n8n is changed, as the sheet holds them. */
const NEW_INDEX: Row = {
  Frequency: 'Monthly',
  'Post Frequency (Days)': 3,
  'Target Post Time': '6:00 PM',
  'Photo Folder ID': '1AbCdEfGhIjKlMnOpQrStUvWxYz',
  "Michelle's Standard Prompt": 'Write a warm post.\r\nMention the prizes.',
  'Michelles KPI Hook Prompt': 'Open with a question.',
  'TikTok Video Blueprint': '',
  'Banned Phrases': 'drop in, open table',
  'Organiser Email': 'dan@example.com',
  'App Capacity': '30',
  'Approved Facts': 'Prizes: cash\nBooking: essential',
  'People & Roles': 'Trixie - host',
};
// What the snapshot sends today: Frequency, Photo Folder ID, App Capacity and the three social columns.
const TODAY_INDEX: Row = { Frequency: 'Monthly', 'Photo Folder ID': '', 'App Capacity': '', 'Approved Facts': '', 'People & Roles': '', 'Banned Phrases': '' };
const quiz = (over: Row = {}) => indexRow(4, { 'Event Name': 'Quiz', 'Event Date': '23/10/2026', 'App Price': '£2', ...over });
const diary = (over: Row = {}) => diaryRow(8, { Date: '12/10/2026', ...over });

let run = 0;
const syncRows = (index: Row[], diaryRows: Row[] = [diary()]) => sync({ run_id: `r${++run}`, sources: { event_index: index, standard_diary: diaryRows } });
const edit = (id: string, values: Record<string, unknown>, extra: Row = {}) => request(`/api/staff/events/${id}/sheet-edit`, json({ values, ...extra }), DAN);
const sheetValues = async (id: string) =>
  JSON.parse((await env.DB.prepare('SELECT sheet_values FROM events WHERE event_id = ?1').bind(id).first<{ sheet_values: string }>())!.sheet_values) as Record<string, string>;
const errorsOf = async (res: Response) => (await res.json<{ errors?: Record<string, string>; error?: string }>());

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('sheet_writes', 'live', ?1, 'test') ON CONFLICT (key) DO UPDATE SET value = 'live'",
    ).bind(now),
  ]);
});
afterEach(() => vi.useRealTimers());

describe('the new columns, canonical', () => {
  it('keeps the sheet’s spelling of Frequency, whatever the case', () => {
    expect(canon('Frequency', 'weekly')).toBe('Weekly');
    expect(canon('Frequency', 'two-weekly ')).toBe('Two-Weekly');
    expect(canon('Frequency', 'BI-WEEKLY')).toBe('Bi-Weekly');
    expect(canon('Frequency', 'one-off')).toBe('One-off');
    expect(canon('Frequency', 'Every so often')).toBe('Every so often');
  });

  it('reads whole numbers and times the same however they are written', () => {
    expect(canon('Post Frequency (Days)', 7)).toBe('7');
    expect(canon('Post Frequency (Days)', '7.0')).toBe('7');
    expect(canon('Post Frequency (Days)', 'seven')).toBe('seven');
    expect(canon('App Capacity', '')).toBe('');
    expect(canon('Target Post Time', '6:00 PM')).toBe('18:00');
    expect(canon("Michelle's Standard Prompt", ' One\r\nTwo\r\n')).toBe('One\nTwo');
  });

  it('leaves out a new column the snapshot doesn’t carry, and keeps a blank one it does', () => {
    const before = sheetValuesOf('event_index', quiz());
    for (const c of ['Post Frequency (Days)', 'Target Post Time', "Michelle's Standard Prompt", 'Organiser Email']) expect(c in before).toBe(false);
    expect(before['Event Name']).toBe('Quiz');
    const after = sheetValuesOf('event_index', quiz(NEW_INDEX));
    expect(after).toMatchObject({
      Frequency: 'Monthly',
      'Post Frequency (Days)': '3',
      'Target Post Time': '18:00',
      "Michelle's Standard Prompt": 'Write a warm post.\nMention the prizes.',
      'TikTok Video Blueprint': '',
      'App Capacity': '30',
      'People & Roles': 'Trixie - host',
    });
  });

  it('gives the Standard Diary only Frequency, Approved Facts and People & Roles', () => {
    expect(EXTRA.standard_diary).toEqual(['Frequency', 'Approved Facts', 'People & Roles']);
    const v = sheetValuesOf('standard_diary', diary({ 'Approved Facts': 'Level: all', 'People & Roles': '', 'Banned Phrases': 'x', 'Organiser Email': 'a@b.co' }));
    expect(v).toMatchObject({ Frequency: 'Weekly', 'Approved Facts': 'Level: all', 'People & Roles': '' });
    expect('Banned Phrases' in v).toBe(false);
    expect('Organiser Email' in v).toBe(false);
  });

  it('writes the new cells with their exact headers', () => {
    expect(cellsFor(QUIZ, { "Michelle's Standard Prompt": 'A\nB', 'Target Post Time': '18:00', 'Post Frequency (Days)': '2' })).toEqual({
      'Event ID': QUIZ,
      "Michelle's Standard Prompt": 'A\nB',
      'Target Post Time': '18:00',
      'Post Frequency (Days)': '2',
    });
    const row = quiz(NEW_INDEX);
    expect(checkRows('event_index', QUIZ, { 'Michelles KPI Hook Prompt': { from: 'Open with a question.', to: 'Ask who’s coming.' } }, [row])).toMatchObject({
      action: 'write',
    });
  });
});

describe('the sync', () => {
  it('stores the new columns without changing any event’s hash', async () => {
    expect((await syncRows([quiz(TODAY_INDEX)])).status).toBe(200);
    const hash = async () => (await env.DB.prepare('SELECT source_hash AS h, updated_at AS u FROM events WHERE event_id = ?1').bind(QUIZ).first<{ h: string; u: string }>())!;
    const before = await hash();
    vi.setSystemTime(new Date('2026-10-12T10:15:00Z'));
    // Photo Folder ID and App Capacity are already hashed (as photo_folder_id, default_capacity): same values here.
    const res = await syncRows([quiz({ ...NEW_INDEX, 'Photo Folder ID': '', 'App Capacity': '' })], [diary({ 'Approved Facts': 'Level: all', 'People & Roles': '' })]);
    expect((await res.json<{ events_changed: number }>()).events_changed).toBe(0);
    expect(await hash()).toEqual(before);
    expect(await sheetValues(QUIZ)).toMatchObject({ "Michelle's Standard Prompt": 'Write a warm post.\nMention the prizes.', 'Post Frequency (Days)': '3' });
    expect(await sheetValues(DIARY)).toMatchObject({ 'Approved Facts': 'Level: all', 'People & Roles': '' });
  });

  it('marks a written prompt edit synced once the sheet shows it (headers with an apostrophe and brackets)', async () => {
    expect((await syncRows([quiz(NEW_INDEX)])).status).toBe(200);
    const res = await edit(QUIZ, { "Michelle's Standard Prompt": 'New prompt.', 'Post Frequency (Days)': '5' });
    expect(res.status).toBe(200);
    const { edits } = await (await internal('/sheet-edits/claim')).json<{ edits: { edit_id: string; claim: string }[] }>();
    const e = edits[0]!;
    const checked = await (await internal(`/sheet-edits/${e.edit_id}/check`, { claim: e.claim, rows: [quiz(NEW_INDEX)] })).json<{ action: string; cells: Row }>();
    expect(checked).toMatchObject({ action: 'write', cells: { "Michelle's Standard Prompt": 'New prompt.', 'Post Frequency (Days)': '5' } });
    const after = quiz({ ...NEW_INDEX, "Michelle's Standard Prompt": 'New prompt.', 'Post Frequency (Days)': 5 });
    expect(await (await internal(`/sheet-edits/${e.edit_id}/written`, { claim: e.claim, rows: [after] })).json()).toMatchObject({ ok: true });
    vi.setSystemTime(new Date('2026-10-12T10:15:00Z'));
    await syncRows([after]);
    expect((await env.DB.prepare('SELECT status FROM sheet_edits WHERE edit_id = ?1').bind(e.edit_id).first<{ status: string }>())!.status).toBe('synced');
  });
});

describe('changing the new columns', () => {
  it('refuses a column the sync hasn’t sent yet, and never treats it as blank', async () => {
    expect((await syncRows([quiz(TODAY_INDEX)])).status).toBe(200);
    const res = await edit(QUIZ, { "Michelle's Standard Prompt": 'Hello', 'Organiser Email': '' });
    expect(res.status).toBe(400);
    const { errors } = await errorsOf(res);
    expect(errors!["Michelle's Standard Prompt"]).toMatch(/not synced yet/i);
    expect(errors!['Organiser Email']).toMatch(/not synced yet/i);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sheet_edits').first<{ n: number }>())!.n).toBe(0);
  });

  it('queues a change with its from and to, in canonical form', async () => {
    expect((await syncRows([quiz(NEW_INDEX)])).status).toBe(200);
    const res = await edit(QUIZ, {
      Frequency: 'two-weekly',
      'Target Post Time': '19:15',
      'Photo Folder ID': 'https://drive.google.com/drive/u/0/folders/1ZyXwVuTsRqPoNmLkJiHgFeDcBa?usp=sharing',
      'Approved Facts': 'Prizes: cash\r\nBooking: essential\r\nAge: 12+',
      'App Capacity': '',
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ edit: { fields: unknown } }>()).edit.fields).toEqual({
      Frequency: { from: 'Monthly', to: 'Two-Weekly' },
      'Target Post Time': { from: '18:00', to: '19:15' },
      'Photo Folder ID': { from: '1AbCdEfGhIjKlMnOpQrStUvWxYz', to: '1ZyXwVuTsRqPoNmLkJiHgFeDcBa' },
      'Approved Facts': { from: 'Prizes: cash\nBooking: essential', to: 'Prizes: cash\nBooking: essential\nAge: 12+' },
      'App Capacity': { from: '30', to: '' },
    });
  });

  it('checks each value', async () => {
    expect((await syncRows([quiz(NEW_INDEX)])).status).toBe(200);
    const res = await edit(QUIZ, {
      Frequency: 'Bi-Weekly', // the Standard Diary's word, not Event Index's
      'Post Frequency (Days)': '61',
      'Target Post Time': 'teatime',
      'Photo Folder ID': 'not a folder',
      'Organiser Email': 'dan at example',
      'App Capacity': '2.5',
      'Banned Phrases': 'x'.repeat(5001),
      "Michelle's Standard Prompt": 'y'.repeat(20001),
      'Approved Facts': 'Prizes cash',
      'People & Roles': 'Trixie - legend',
    });
    expect(res.status).toBe(400);
    const { errors } = await errorsOf(res);
    expect(Object.keys(errors!).sort()).toEqual(
      ['Frequency', 'Post Frequency (Days)', 'Target Post Time', 'Photo Folder ID', 'Organiser Email', 'App Capacity', 'Banned Phrases', "Michelle's Standard Prompt", 'Approved Facts', 'People & Roles'].sort(),
    );
    expect(errors!['People & Roles']).toMatch(/host/);
    expect((await edit(QUIZ, { 'Post Frequency (Days)': 'seven' })).status).toBe(400);
    expect((await edit(QUIZ, { 'Post Frequency (Days)': '0' })).status).toBe(200);
  });

  it('allows a long prompt and keeps its line breaks', async () => {
    expect((await syncRows([quiz(NEW_INDEX)])).status).toBe(200);
    const long = Array.from({ length: 200 }, (_, i) => `Line ${i} of a long prompt.`).join('\r\n');
    const res = await edit(QUIZ, { 'TikTok Video Blueprint': long });
    expect(res.status).toBe(200);
    const to = (await res.json<{ edit: { fields: Record<string, { to: string }> } }>()).edit.fields['TikTok Video Blueprint']!.to;
    expect(to).toContain('\n');
    expect(to).not.toContain('\r');
  });

  it('changes a Standard Diary row’s own new columns, and refuses the others', async () => {
    expect((await syncRows([quiz(NEW_INDEX)], [diary({ 'Approved Facts': '', 'People & Roles': '' })])).status).toBe(200);
    expect((await edit(DIARY, { 'Banned Phrases': 'x' })).status).toBe(400);
    expect((await edit(DIARY, { Frequency: 'Two-Weekly' })).status).toBe(400);
    const res = await edit(DIARY, { Frequency: 'Bi-Weekly', 'People & Roles': 'Sam - runs it' });
    expect(res.status).toBe(200);
    expect((await res.json<{ edit: { fields: unknown } }>()).edit.fields).toEqual({
      Frequency: { from: 'Weekly', to: 'Bi-Weekly' },
      'People & Roles': { from: '', to: 'Sam - runs it' },
    });
  });

  it('never makes Day, Last Post, Next Post, Event ID, App Host Session or the social prompt editable', async () => {
    expect((await syncRows([quiz(NEW_INDEX)])).status).toBe(200);
    const res = await edit(QUIZ, { Day: 'Monday', 'Last Post': 'x', 'Next Post': 'x', 'Event ID': 'x', 'App Host Session': 'x', 'Social Prompt': 'x', 'Social Prompt Status': 'x' });
    expect(res.status).toBe(400);
    expect(Object.keys((await errorsOf(res)).errors!)).toHaveLength(7);
  });
});

describe('the event editor', () => {
  type Form = { sheet: Record<string, string | null>; frequency_options: string[]; pending_fields: Record<string, { from: string; to: string }>; unavailable: Record<string, string> };
  const form = async (id: string) => (await (await request(`/api/staff/events/${id}`, {}, DAN)).json<{ event: Form }>()).event;
  const save = (id: string, body: unknown) => request(`/api/staff/events/${id}`, json(body), DAN);
  const HOSTED = 'RTD-EVT-00006';
  const hosted = indexRow(6, { 'Event Name': 'Catan Club', 'App Host Session': 'RTD-HS-00001', ...NEW_INDEX });

  it('gives each new column its value, or null while the sync doesn’t send it', async () => {
    expect((await syncRows([quiz(TODAY_INDEX)])).status).toBe(200);
    const f = await form(QUIZ);
    expect(Object.keys(f.sheet)).toEqual([...EXTRA.event_index]);
    expect(f.sheet).toMatchObject({ Frequency: 'Monthly', 'Approved Facts': '', 'App Capacity': '', "Michelle's Standard Prompt": null, 'Organiser Email': null });
    expect(f.frequency_options).toEqual(['Weekly', 'Two-Weekly', 'Monthly', 'One-off']);
    const d = await form(DIARY);
    expect(Object.keys(d.sheet)).toEqual(['Frequency', 'Approved Facts', 'People & Roles']);
    expect(d.frequency_options).toEqual(['Weekly', 'Bi-Weekly', 'Monthly']);
  });

  it('sends the new columns through the Logic Engine queue, and shows them waiting', async () => {
    expect((await syncRows([quiz(NEW_INDEX)])).status).toBe(200);
    // Unchanged values are left out; the rest becomes one edit with the details.
    const res = await save(QUIZ, { details: { price: '£3' }, sheet: { 'Michelles KPI Hook Prompt': 'Ask a question.', 'Banned Phrases': 'drop in, open table' } });
    expect(res.status).toBe(200);
    expect((await res.json<{ sheet_edit: { fields: unknown } }>()).sheet_edit.fields).toEqual({
      'App Price': { from: '£2', to: '£3' },
      'Michelles KPI Hook Prompt': { from: 'Open with a question.', to: 'Ask a question.' },
    });
    expect((await form(QUIZ)).pending_fields).toEqual({
      'App Price': { from: '£2', to: '£3' },
      'Michelles KPI Hook Prompt': { from: 'Open with a question.', to: 'Ask a question.' },
    });
  });

  it('refuses a column not synced yet, one the tab hasn’t got, and a bad value', async () => {
    expect((await syncRows([quiz(TODAY_INDEX)])).status).toBe(200);
    const res = await save(QUIZ, { sheet: { 'Target Post Time': '18:00', 'App Capacity': 'lots' } });
    expect(res.status).toBe(400);
    const { errors } = await errorsOf(res);
    expect(errors!['Target Post Time']).toMatch(/not synced yet/);
    expect(errors!['App Capacity']).toMatch(/whole number/);
    const diaryRes = await save(DIARY, { sheet: { 'Banned Phrases': 'x', Day: 'Monday' } });
    expect(diaryRes.status).toBe(400);
    expect(Object.keys((await errorsOf(diaryRes)).errors!).sort()).toEqual(['Banned Phrases', 'Day']);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sheet_edits').first<{ n: number }>())!.n).toBe(0);
  });

  it('gives host sessions only the columns the host doesn’t own', async () => {
    expect((await syncRows([quiz(NEW_INDEX), hosted])).status).toBe(200);
    const f = await form(HOSTED);
    for (const c of ['Frequency', 'Organiser Email', 'App Capacity']) expect(f.sheet).not.toHaveProperty(c);
    expect(f.sheet).toHaveProperty('Approved Facts');
    expect(f.unavailable.sheet).toBeUndefined();
    const refused = await save(HOSTED, { sheet: { 'Organiser Email': 'me@example.com' } });
    expect(refused.status).toBe(400);
    expect((await errorsOf(refused)).errors!['Organiser Email']).toBeTruthy();
    expect((await save(HOSTED, { sheet: { 'Approved Facts': 'Prizes: none' } })).status).toBe(200);
  });
});
