import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRetention } from '../src/lib/privacy';
import { env, freshDb, indexRow, request, sync } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // host
const json = (body: unknown, extra: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});
const AUTH = { Authorization: 'Bearer test-sync-token' };

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const JPEG = `data:image/jpeg;base64,${b64([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 200 }, (_, i) => i % 256)])}`;
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 100 }, () => 7)]);

const MARKET = {
  name: 'Christmas Makers Market',
  description: 'Local makers, crafts and gifts.',
  event_date: '2026-12-05',
  start_time: '10:00',
  end_time: '16:00',
  pitches: 2,
  pitch_fee_pence: 1500,
  applications_close: '2026-11-20',
  payment_details: 'Bank transfer to Roll The Dice\nSort code 00-00-00, account 00000000',
};
const create = (over: Record<string, unknown> = {}, who: Partial<Env> = DAN) => request('/api/staff/markets', json({ ...MARKET, ...over }), who);

const VENDOR = {
  stall_name: 'Dice & Slice',
  contact_name: 'Ava Maker',
  email: 'ava@example.com',
  mobile: '07700 900123',
  products: 'Hand-painted dice trays and miniatures, £5 to £40',
  links: 'instagram.com/diceandslice\nhttps://etsy.com/shop/diceandslice',
  insured: true,
  insurer: 'Craft Cover',
  insurance_expiry: '2027-03-31',
  notes: 'Near a plug, please',
};
const apply = (over: Record<string, unknown> = {}, id = 'RTD-MKT-00001') => request(`/api/markets/${id}/apply`, json({ ...VENDOR, ...over }));

type Outbox = { kind: string; to_email: string | null; reply_to: string | null; subject: string; html: string; dedupe_key: string };
const outbox = async () => (await env.DB.prepare('SELECT kind, to_email, reply_to, subject, html, dedupe_key FROM outbox ORDER BY message_id').all<Outbox>()).results;
const decide = (id: string, decision: 'approve' | 'decline', note = '') => request(`/api/staff/market-applications/${id}/decision`, json({ decision, note }), MICHELLE);

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
  ]);
});
afterEach(() => vi.useRealTimers());

describe('setting up a market', () => {
  it('is for admins only, and checks every field', async () => {
    expect((await create({}, MICHELLE)).status).toBe(403);
    expect((await create({}, SAM)).status).toBe(403);
    const bad = await create({ name: 'X', event_date: '2026-10-01', pitches: 0, pitch_fee_pence: 1500, payment_details: '', applications_close: '2026-12-25' });
    expect(bad.status).toBe(400);
    expect(Object.keys((await bad.json<{ errors: Record<string, string> }>()).errors).sort()).toEqual(['applications_close', 'event_date', 'name', 'payment_details', 'pitches']);
    // Applications must close by the market day; no payment details are needed when there's no fee.
    const late = await create({ applications_close: '2026-12-06' });
    expect((await late.json<{ errors: Record<string, string> }>()).errors).toHaveProperty('applications_close');
    expect((await create({ pitch_fee_pence: 0, payment_details: '' })).status).toBe(201);
  });

  it('goes into the Logic Engine through the host sessions feed, then links to its event', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect((await res.json<{ market: Record<string, unknown> }>()).market).toMatchObject({ market_id: 'RTD-MKT-00001', status: 'scheduled', created_by: 'dan@example.com' });

    const feed = await (await request('/internal/host-sessions/to-publish', { headers: AUTH })).json<{ sessions: { session_id: string; clash_suffix?: string; row: Record<string, string> }[] }>();
    expect(feed.sessions).toEqual([
      {
        session_id: 'RTD-MKT-00001',
        clash_suffix: '2026',
        row: {
          'Event Name': 'Christmas Makers Market',
          Frequency: 'One-off',
          Day: 'Saturday',
          'Event Date': '05/12/2026',
          'Event Time': '10:00',
          'End Time': '16:00',
          'Base Details': 'Local makers, crafts and gifts.',
          Status: 'Active',
          'Organiser Email': 'dan@example.com',
          'App Visibility': 'Public',
          'App Category': 'Market',
          'App Price': '',
          'App Capacity': '',
          'App Host Session': 'RTD-MKT-00001',
        },
      },
    ]);
    expect((await request('/internal/host-sessions/RTD-MKT-00001/published', { method: 'POST', headers: AUTH })).status).toBe(200);
    expect((await (await request('/internal/host-sessions/to-publish', { headers: AUTH })).json<{ sessions: unknown[] }>()).sessions).toEqual([]);

    const row = indexRow(9, { 'Event Name': 'Christmas Makers Market', Day: 'Saturday', 'Event Date': '05/12/2026', 'Event Time': '10:00', 'App Category': 'Market', 'App Host Session': 'RTD-MKT-00001' });
    expect((await sync({ run_id: 'm1', sources: { event_index: [row] } })).status).toBe(200);
    const market = await env.DB.prepare("SELECT status, event_id FROM markets WHERE market_id = 'RTD-MKT-00001'").first();
    expect(market).toEqual({ status: 'published', event_id: 'RTD-EVT-00009' });
    // Its diary page: vendors apply; customers don't book it.
    const occ = await (await request('/api/occurrences/RTD-OCC-00009-20261205')).json<{ occurrence: Record<string, unknown> }>();
    expect(occ.occurrence).toMatchObject({ market_id: 'RTD-MKT-00001', bookable: false });
    expect(await (await request('/api/bookings/availability/RTD-OCC-00009-20261205')).json()).toEqual({ bookable: false });
    expect((await (await request('/api/markets/RTD-MKT-00001')).json<{ market: Record<string, unknown> }>()).market).toMatchObject({ occurrence_id: 'RTD-OCC-00009-20261205' });
  });

  it("can't drop below the vendors already approved", async () => {
    await create();
    await apply();
    await decide('RTD-MV-00001', 'approve');
    await apply({ email: 'bea@example.com', stall_name: 'Bea Bakes' });
    await decide('RTD-MV-00002', 'approve');
    const res = await request('/api/staff/markets/RTD-MKT-00001', json({ ...MARKET, pitches: 1 }), DAN);
    expect(res.status).toBe(409);
    expect((await request('/api/staff/markets/RTD-MKT-00001', json({ ...MARKET, pitches: 3 }), DAN)).status).toBe(200);
    expect((await request('/api/staff/markets/RTD-MKT-00001', json({ ...MARKET, pitches: 3 }), MICHELLE)).status).toBe(403);
  });
});

describe('vendors applying', () => {
  beforeEach(async () => {
    expect((await create()).status).toBe(201);
  });

  it('lists the market without saying who applied', async () => {
    await apply();
    const { markets } = await (await request('/api/markets')).json<{ markets: Record<string, unknown>[] }>();
    expect(markets).toEqual([
      {
        market_id: 'RTD-MKT-00001',
        name: 'Christmas Makers Market',
        description: 'Local makers, crafts and gifts.',
        event_date: '2026-12-05',
        start_time: '10:00',
        end_time: '16:00',
        pitch_fee: '£15',
        pitches: 2,
        pitches_left: 2,
        applications_close: '2026-11-20',
        open: true,
        occurrence_id: null,
      },
    ]);
    expect(JSON.stringify(markets)).not.toContain('Bank transfer');
    expect((await request('/api/markets/RTD-MKT-99999')).status).toBe(404);
  });

  it('takes an application, with photos, and emails the vendor and the approvers', async () => {
    const res = await apply({ stall_name: 'Dice <b>& Slice</b>', photos: [{ data: JPEG }, { data: PNG }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ application: { application_id: 'RTD-MV-00001', market_id: 'RTD-MKT-00001', stall_name: 'Dice <b>& Slice</b>', waitlisted: false } });

    const [toVendor, toApprovers] = await outbox();
    expect(toVendor).toMatchObject({ kind: 'market_applied', to_email: 'ava@example.com', reply_to: '@approvals', dedupe_key: 'market-applied:RTD-MV-00001' });
    expect(toVendor!.subject).toBe("We've got your application: Christmas Makers Market, Sat 5 Dec");
    expect(toVendor!.html).toContain('RTD-MV-00001');
    expect(toVendor!.html).toContain('The pitch fee is £15');
    expect(toVendor!.html).not.toContain('Sort code'); // only once approved
    expect(toApprovers).toMatchObject({ kind: 'market_application', to_email: '@approvals', reply_to: 'ava@example.com' });
    for (const bit of ['Dice &lt;b&gt;&amp; Slice&lt;/b&gt;', '07700 900123', 'instagram.com/diceandslice<br>https://etsy.com', 'Yes, Craft Cover, until Wed 31 Mar 2027', '2, in the organiser', '0 of 2 approved']) {
      expect(toApprovers!.html).toContain(bit);
    }
    expect(toApprovers!.html).not.toContain('<b>&');

    // Approvers see the photos; nobody else can.
    const { applications } = await (await request('/api/staff/market-applications', {}, MICHELLE)).json<{ applications: { photos: string[]; insured: boolean; email: string }[] }>();
    expect(applications[0]).toMatchObject({ insured: true, email: 'ava@example.com' });
    expect(applications[0]!.photos).toHaveLength(2);
    const photo = await request(`/api/staff/market-photos/${applications[0]!.photos[0]}`, {}, MICHELLE);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('Content-Type')).toBe('image/jpeg');
    expect(photo.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await photo.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect((await request(`/api/staff/market-photos/${applications[0]!.photos[1]}`, {}, MICHELLE)).headers.get('Content-Type')).toBe('image/png');
    expect((await request(`/api/staff/market-photos/${applications[0]!.photos[0]}`)).status).toBe(401);
    expect((await request(`/api/staff/market-photos/${applications[0]!.photos[0]}`, {}, SAM)).status).toBe(403);
  });

  it('checks the form, the photos and the honeypot', async () => {
    const res = await apply({ email: 'nope', mobile: '12', products: 'cake', insured: undefined });
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json<{ errors: Record<string, string> }>()).errors).sort()).toEqual(['email', 'insured', 'mobile', 'products']);
    expect((await (await apply({ insurer: '', insurance_expiry: '' })).json<{ errors: Record<string, string> }>()).errors).toMatchObject({ insurer: expect.any(String), insurance_expiry: expect.any(String) });
    expect((await (await apply({ photos: [{ data: b64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) }] })).json<{ errors: Record<string, string> }>()).errors.photos).toBe('Photos must be JPEG, PNG or WebP images.');
    expect((await apply({ photos: [{ data: JPEG }, { data: JPEG }, { data: JPEG }, { data: JPEG }] })).status).toBe(400);
    expect((await apply({ website: 'http://spam.example' })).status).toBe(400);
    expect((await apply({}, 'RTD-MKT-99999')).status).toBe(404);
    expect(await outbox()).toEqual([]);
  });

  it('takes one application per email per market, and only a few a day', async () => {
    expect((await apply()).status).toBe(201);
    expect((await apply()).status).toBe(409);
    expect((await apply({ email: 'AVA@example.com' })).status).toBe(409);
    await create({ name: 'Spring Market', event_date: '2027-03-06', applications_close: '2027-02-27' });
    await create({ name: 'Summer Market', event_date: '2027-06-05', applications_close: '2027-05-29' });
    await create({ name: 'Autumn Market', event_date: '2027-09-04', applications_close: '2027-08-28' });
    expect((await apply({}, 'RTD-MKT-00002')).status).toBe(201);
    expect((await apply({}, 'RTD-MKT-00003')).status).toBe(201);
    expect((await apply({}, 'RTD-MKT-00004')).status).toBe(429);
  });

  it('closes after the closing date', async () => {
    vi.setSystemTime(new Date('2026-11-21T10:00:00Z'));
    const res = await apply();
    expect(res.status).toBe(409);
    expect((await (await request('/api/markets/RTD-MKT-00001')).json<{ market: { open: boolean } }>()).market.open).toBe(false);
  });
});

describe('approving vendors', () => {
  beforeEach(async () => {
    await create();
    await apply();
    await apply({ email: 'bea@example.com', stall_name: 'Bea Bakes', contact_name: 'Bea Baker', insured: false });
    await env.DB.prepare('DELETE FROM outbox').run();
  });

  it('emails an approved vendor the payment details, with their reference', async () => {
    const res = await decide('RTD-MV-00001', 'approve', 'Pitch 4, by the window.');
    expect(res.status).toBe(200);
    const [mail] = await outbox();
    expect(mail).toMatchObject({ kind: 'market_approved', to_email: 'ava@example.com', reply_to: '@approvals', subject: "You're in: Christmas Makers Market, Sat 5 Dec" });
    for (const bit of ['Pitch fee:</strong> £15', 'Bank transfer to Roll The Dice<br>Sort code 00-00-00, account 00000000', 'use your reference, <strong>RTD-MV-00001</strong>', 'Pitch 4, by the window.']) {
      expect(mail!.html).toContain(bit);
    }
    expect((await decide('RTD-MV-00001', 'decline')).status).toBe(409); // already decided
    const audit = await env.DB.prepare("SELECT actor_id, action, new_value FROM audit_log WHERE entity_id = 'RTD-MV-00001' ORDER BY audit_id").all();
    expect(audit.results).toEqual([
      { actor_id: 'RTD-MV-00001', action: 'market_application.submitted', new_value: '{"market_id":"RTD-MKT-00001","waitlisted":0,"photos":0}' },
      { actor_id: 'michelle@example.com', action: 'market_application.approved', new_value: '{"note":true}' },
    ]);
    expect(JSON.stringify(audit.results)).not.toContain('ava@');
  });

  it('declines with a note', async () => {
    expect((await decide('RTD-MV-00002', 'decline', 'We have two bakers already.')).status).toBe(200);
    const [mail] = await outbox();
    expect(mail).toMatchObject({ kind: 'market_declined', to_email: 'bea@example.com', subject: 'Your application: Christmas Makers Market, Sat 5 Dec' });
    expect(mail!.html).toContain('We have two bakers already.');
    expect(mail!.html).not.toContain('Sort code');
  });

  it('puts later applicants on the waiting list, and frees a pitch when someone drops out', async () => {
    await decide('RTD-MV-00001', 'approve');
    await decide('RTD-MV-00002', 'approve');
    expect((await (await request('/api/markets/RTD-MKT-00001')).json<{ market: Record<string, unknown> }>()).market).toMatchObject({ pitches_left: 0, open: true });
    const late = await apply({ email: 'cal@example.com', stall_name: 'Cal Candles' });
    expect((await late.json<{ application: { waitlisted: boolean } }>()).application.waitlisted).toBe(true);
    const ack = (await outbox()).find(m => m.dedupe_key === 'market-applied:RTD-MV-00003')!;
    expect(ack.html).toContain('waiting list');
    expect((await outbox()).find(m => m.dedupe_key === 'market-new:RTD-MV-00003')!.subject).toContain('(waiting list)');

    const full = await decide('RTD-MV-00003', 'approve');
    expect(full.status).toBe(409);
    expect((await full.json<{ error: string }>()).error).toContain('All 2 pitches are taken');
    expect((await request('/api/staff/market-applications/RTD-MV-00002/withdraw', json({}), MICHELLE)).status).toBe(200);
    expect((await decide('RTD-MV-00003', 'approve')).status).toBe(200);
    const { applications } = await (await request('/api/staff/market-applications', {}, MICHELLE)).json<{ applications: { application_id: string; status: string }[] }>();
    expect(applications.map(a => [a.application_id, a.status])).toEqual([
      ['RTD-MV-00001', 'approved'],
      ['RTD-MV-00002', 'withdrawn'],
      ['RTD-MV-00003', 'approved'],
    ]);
  });

  it('is for approvers and admins only', async () => {
    expect((await request('/api/staff/market-applications/RTD-MV-00001/decision', json({ decision: 'approve' }), SAM)).status).toBe(403);
    expect((await request('/api/staff/market-applications', {}, SAM)).status).toBe(403);
    expect((await request('/api/staff/market-applications/RTD-MV-00001/decision', json({ decision: 'approve' }), DAN)).status).toBe(200);
  });
});

describe('the market spreadsheet', () => {
  it('sends each application once, again when it changes, and erased when it is erased', async () => {
    await create();
    await apply({ photos: [{ data: JPEG }] });
    const feed = async () => (await (await request('/internal/market-applications/sheet', { headers: AUTH })).json<{ rows: { application_id: string; hash: string; row: Record<string, string> }[] }>()).rows;
    let rows = await feed();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).toEqual({
      'Application ID': 'RTD-MV-00001',
      Market: 'Christmas Makers Market',
      'Market Date': '05/12/2026',
      Status: 'Waiting for a decision',
      'Waiting List': 'No',
      'Stall Name': 'Dice & Slice',
      'Contact Name': 'Ava Maker',
      Email: 'ava@example.com',
      Mobile: '07700 900123',
      'What They Sell': 'Hand-painted dice trays and miniatures, £5 to £40',
      Links: 'instagram.com/diceandslice\nhttps://etsy.com/shop/diceandslice',
      Insured: 'Yes',
      Insurer: 'Craft Cover',
      'Insurance Expiry': '31/03/2027',
      Photos: '1 (in the organiser)',
      Notes: 'Near a plug, please',
      'Pitch Fee': '£15',
      Applied: '2026-10-06 10:00',
      Decided: '',
      'Decided By': '',
      'Decision Note': '',
      'Organiser Link': 'http://localhost/organise#market-applications',
    });
    expect((await request('/internal/market-applications/RTD-MV-00001/sheet-synced', json({ hash: rows[0]!.hash }, AUTH))).status).toBe(200);
    expect(await feed()).toEqual([]);
    expect((await request('/internal/market-applications/RTD-MV-00001/sheet-synced', json({ hash: 'nope' }, AUTH))).status).toBe(404);

    await decide('RTD-MV-00001', 'approve');
    rows = await feed();
    expect(rows[0]!.row).toMatchObject({ Status: 'Approved', 'Decided By': 'michelle@example.com' });
    await request('/internal/market-applications/RTD-MV-00001/sheet-synced', json({ hash: rows[0]!.hash }, AUTH));

    // A year after the market: erased in the app, its photo deleted, and the sheet row cleared.
    const photoId = (await env.DB.prepare('SELECT photo_id FROM market_photos').first<{ photo_id: string }>())!.photo_id;
    expect(await env.IMAGES.get(`vendor:${photoId}`)).not.toBeNull();
    vi.setSystemTime(new Date('2027-12-06T03:23:00Z'));
    expect(await applyRetention(env.DB, new Date(), env.IMAGES)).toMatchObject({ vendors: 1 });
    expect(await env.IMAGES.get(`vendor:${photoId}`)).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM market_photos').first()).toEqual({ n: 0 });
    rows = await feed();
    expect(rows[0]!.row).toMatchObject({ Status: 'Erased', 'Stall Name': 'Erased', 'Contact Name': 'Erased', Email: '', Mobile: '', 'What They Sell': '', Links: '', Insurer: '', Notes: '', Photos: 'None' });
    expect((await request('/internal/market-applications/sheet')).status).toBe(401);
  });
});
