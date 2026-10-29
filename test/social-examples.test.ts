// Example posts beside each social prompt (.superpowers/sdd/2026-10-23-example-posts/brief.md).
// n8n asks which prompt versions want an example, has Gemini write one Facebook post the way the live
// posting flow would (the event layer, Michelle's Standard Prompt, the next date), and sends it back.
// The app runs it through the same check as a live event post and keeps it beside the prompt. The
// example never changes the prompt's status, never posts, and is never written to the sheet.
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/lib/auth';
import { dateBlock, layerBlock } from '../src/social/check';
import { fingerprint, sourceFields } from '../src/social/facts';
import { SCHEDULE_RULE } from '../src/social/instruction';
import { approveOverride, requestRegenerate, setSocialMode } from '../src/social/prompts';
import { env, freshDb, indexRow, request, sync } from './helpers';

// Monday 19 October 2026, 11:00 in London.
const NOW = new Date('2026-10-19T10:00:00Z');
const AUTH = { Authorization: 'Bearer test-sync-token', 'Content-Type': 'application/json' };
const admin: AuthUser = { user_id: 'u-dan', email: 'dan@example.com', display_name: 'Dan', role: 'admin' };

const QUIZ = 'RTD-EVT-00001'; // Friday 23 October, 18:30
const QUIZ_OCC = 'RTD-OCC-00001-20261023';
const BINGO = 'RTD-EVT-00002'; // Wednesday 21 October, no time
const DND = 'RTD-EVT-00007'; // Friday 30 October, 18:30
const QUIZ_PROMPT = 'Write about Quiz, a family quiz night with prizes at stake, at Roll The Dice in Cleethorpes.';
const BINGO_PROMPT = 'Write about Bingo at Roll The Dice in Cleethorpes. Eyes down for a full house.';
const DND_PROMPT =
  'Write about Dungeons & Dragons, a hosted game at Roll The Dice in Cleethorpes. MoreThanABitDicey hosts her infamous DnD sessions. ' +
  'Booking is essential. Never describe it as open play or a drop-in, and never add other people, prizes or levels.';
const GOOD = 'Quiz Night is on Friday 23 October at 6:30pm. Teams welcome. #QuizNight';

const quizRow = (over: Record<string, unknown> = {}) =>
  indexRow(1, {
    'Event Name': 'Quiz',
    'Base Details': 'A family quiz night with prizes at stake!',
    'Approved Facts': 'Prizes: cash prizes',
    'People & Roles': 'Trixie — sets up',
    ...over,
  });
const bingoRow = () => indexRow(2, { 'Event Name': 'Bingo', 'Base Details': 'Eyes down for a full house.', 'Event Date': '21/10/2026', 'Event Time': '', 'End Time': '' });
const dndRow = () =>
  indexRow(7, {
    'Event Name': 'Dungeons & Dragons',
    'Base Details': 'MoreThanABitDicey hosts her infamous DnD sessions!',
    'App Category': 'Gaming',
    'Event Date': '30/10/2026',
    'Approved Facts': 'Booking: essential',
    'People & Roles': 'MoreThanABitDicey — host',
  });
// No prompt at all; and a private event with an approved one.
const plainRow = () => indexRow(3, { 'Event Name': 'Board Games' });
const privateRow = () => indexRow(4, { 'Event Name': 'Staff Night', 'App Visibility': 'Private' });

const get = (path: string, headers: Record<string, string> = AUTH) => request(path, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = AUTH) =>
  request(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const due = async (limit?: number) =>
  (await (await get(`/internal/social-prompts/examples-due${limit === undefined ? '' : `?limit=${limit}`}`)).json<{ examples: Example[] }>()).examples;
const example = (id: string, body: unknown) => post(`/internal/social-prompts/${id}/example`, body);
const row = (id: string, version: number) =>
  env.DB.prepare('SELECT * FROM social_prompts WHERE event_id = ?1 AND version = ?2').bind(id, version).first<Record<string, unknown>>();
const checks = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM social_checks').first<{ n: number }>())!.n;

interface Example {
  event_id: string;
  version: number;
  occurrence_id: string;
  layer: string;
  date_block: string;
  fallback_prompt: string;
}

let runs = 0;
async function setUp() {
  expect((await sync({ run_id: `ex-${++runs}`, sources: { event_index: [quizRow(), bingoRow(), dndRow(), plainRow(), privateRow()] } })).status).toBe(200);
  expect(await approveOverride(env.DB, admin, QUIZ, { text: QUIZ_PROMPT, reason: 'First prompt' }, NOW)).toEqual({ ok: true, version: 1 });
  expect(await approveOverride(env.DB, admin, BINGO, { text: BINGO_PROMPT, reason: 'First prompt' }, NOW)).toEqual({ ok: true, version: 1 });
  // The Staff Night prompt is approved, but the event is private: no example.
  await env.DB.prepare("UPDATE events SET visibility = 'public' WHERE event_id = 'RTD-EVT-00004'").run();
  expect(await approveOverride(env.DB, admin, 'RTD-EVT-00004', { text: 'Write about Staff Night at Roll The Dice.', reason: 'x' }, NOW)).toMatchObject({ ok: true });
  await env.DB.prepare("UPDATE events SET visibility = 'private' WHERE event_id = 'RTD-EVT-00004'").run();
  // Dungeons & Dragons: a version that needs review.
  const ev = await env.DB.prepare('SELECT * FROM events WHERE event_id = ?1').bind(DND).first<Record<string, unknown>>();
  const res = await post(`/internal/social-prompts/${DND}`, {
    fingerprint: await fingerprint(sourceFields(ev!)),
    job_id: 'exec-1',
    output: {
      status: 'review_required',
      master_prompt: DND_PROMPT,
      claims: [{ claim: 'Dungeons & Dragons', source_field: 'name' }],
      ambiguities: [],
      questions: ['Is it for beginners?'],
    },
  });
  expect(await res.json()).toMatchObject({ status: 'review_required', version: 1 });
}

describe('migration 0025', () => {
  beforeEach(freshDb);

  it('adds the example columns to social_prompts, empty, with no attempts', async () => {
    const { results } = await env.DB.prepare("SELECT name, type, \"notnull\" AS nn, dflt_value FROM pragma_table_info('social_prompts') WHERE name LIKE 'example%'").all<{
      name: string;
      type: string;
      nn: number;
      dflt_value: string | null;
    }>();
    expect(Object.fromEntries(results.map(r => [r.name, [r.type, r.nn, r.dflt_value]]))).toEqual({
      example_post: ['TEXT', 0, null],
      example_check: ['TEXT', 0, null],
      example_model: ['TEXT', 0, null],
      example_job_id: ['TEXT', 0, null],
      example_generated_at: ['TEXT', 0, null],
      example_attempts: ['INTEGER', 1, '0'],
      example_error: ['TEXT', 0, null],
    });
    expect((await sync({ run_id: 'mig', sources: { event_index: [indexRow(1)] } })).status).toBe(200);
    await env.DB.prepare(
      "INSERT INTO social_prompts (prompt_id, event_id, version, status, source_fingerprint, source_snapshot, created_at) VALUES ('RTD-SP-00001', 'RTD-EVT-00001', 1, 'approved', 'fp', '{}', 'now')",
    ).run();
    expect(await row('RTD-EVT-00001', 1)).toMatchObject({ example_post: null, example_attempts: 0, example_error: null });
  });
});

describe('the layer and date block', () => {
  it('builds them as RTD Social Context (sub) does from a context answer', () => {
    expect(layerBlock('  The prompt.  ', ' Prizes: cash prizes ', 'Trixie — sets up')).toBe('The prompt.\n\nApproved facts: Prizes: cash prizes\nPeople & roles: Trixie — sets up');
    expect(layerBlock('The prompt.', '', 'Trixie — sets up')).toBe('The prompt.\n\nPeople & roles: Trixie — sets up');
    expect(layerBlock('The prompt.', '', '  ')).toBe('The prompt.');
    expect(layerBlock('  ', 'Prizes: cash prizes', '')).toBe('');
    expect(dateBlock('Friday 23 October, 6:30pm')).toBe('Date: Friday 23 October, 6:30pm');
    expect(dateBlock(null)).toBe('');
  });
});

describe('examples for n8n', () => {
  beforeEach(async () => {
    await freshDb();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await setUp();
  });
  afterEach(() => vi.useRealTimers());

  it('lists the versions that want an example, soonest date first, with the layer the live flow gives Gemini', async () => {
    const list = await due(10);
    expect(list.map(e => [e.event_id, e.version])).toEqual([
      [BINGO, 1],
      [QUIZ, 1],
      [DND, 1],
    ]);
    expect(list[1]).toEqual({
      event_id: QUIZ,
      version: 1,
      occurrence_id: QUIZ_OCC,
      layer: `${QUIZ_PROMPT}\n\n${SCHEDULE_RULE}\n\nApproved facts: Prizes: cash prizes\nPeople & roles: Trixie — sets up`,
      date_block: 'Date: Friday 23 October, 6:30pm',
      fallback_prompt: expect.stringMatching(/one friendly Facebook post for Roll The Dice Café about this event, using only the details above/),
    });
    // No time: the date alone. No facts or people: the prompt alone.
    expect(list[0]).toMatchObject({ layer: `${BINGO_PROMPT}\n\n${SCHEDULE_RULE}`, date_block: 'Date: Wednesday 21 October' });
    // The version that needs review gets one too, so the owner can see what it would write.
    expect(list[2]!.layer).toBe(`${DND_PROMPT}\n\nApproved facts: Booking: essential\nPeople & roles: MoreThanABitDicey — host`);

    // The limit: 1 to 10, default 3.
    expect(await due(1)).toHaveLength(1);
    expect(await due()).toHaveLength(3);
    expect(await due(0)).toHaveLength(1);
    expect(await due(50)).toHaveLength(3);
    expect((await due(Number.NaN)).length).toBe(3);
  });

  it('stops listing a version once it has an example, or after three failures, and lists the newer one instead', async () => {
    expect((await example(BINGO, { version: 1, job_id: 'exec-9', model: 'm', text: 'Bingo on Wednesday 21 October. Eyes down!' })).status).toBe(200);
    for (let i = 0; i < 2; i++) expect(await (await example(QUIZ, { version: 1, job_id: `exec-${i}`, error: 'quota' })).json()).toEqual({ ok: true });
    expect((await due(10)).map(e => e.event_id)).toEqual([QUIZ, DND]);
    await example(QUIZ, { version: 1, job_id: 'exec-3', error: { message: 'timeout' } });
    expect((await due(10)).map(e => e.event_id)).toEqual([DND]);
    expect(await row(QUIZ, 1)).toMatchObject({ example_attempts: 3, example_error: 'timeout', example_post: null });

    // A waiting regenerate request isn't a version yet: the one that needs review still wants its example.
    expect(await requestRegenerate(env.DB, admin, DND, NOW)).toEqual({ ok: true });
    expect((await due(10)).map(e => [e.event_id, e.version])).toEqual([[DND, 1]]);

    // A newer version (approved) wants its own example; the older one isn't listed.
    expect(await approveOverride(env.DB, admin, QUIZ, { text: QUIZ_PROMPT, reason: 'Checked prompt and example' }, NOW)).toEqual({ ok: true, version: 2 });
    expect((await due(10)).map(e => [e.event_id, e.version])).toEqual([
      [QUIZ, 2],
      [DND, 1],
    ]);

    // An event that stopped being due (no date to come) isn't listed; nor is a blocked version.
    await env.DB.prepare("UPDATE occurrences SET status = 'cancelled' WHERE event_id = ?1").bind(QUIZ).run();
    await env.DB.prepare("UPDATE social_prompts SET status = 'blocked' WHERE event_id = ?1 AND version = 1").bind(DND).run();
    expect(await due(10)).toEqual([]);
  });

  it('checks a text as a live event post, keeps it beside the prompt, and records no check', async () => {
    const res = await example(QUIZ, { version: 1, job_id: 'exec-42', model: 'gemini-x', text: `  ${GOOD}  ` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, passed: true, problems: [] });
    const stored = await row(QUIZ, 1);
    expect(stored).toMatchObject({
      status: 'approved',
      example_post: GOOD,
      example_model: 'gemini-x',
      example_job_id: 'exec-42',
      example_generated_at: NOW.toISOString(),
      example_attempts: 1,
      example_error: null,
      last_used_at: null,
    });
    expect(JSON.parse(String(stored!.example_check))).toEqual({ passed: true, problems: [] });
    // At Off too (the switch decides only what happens to live posts): never a social_checks row.
    expect(await checks()).toBe(0);

    // One that would be held: the reasons a live post would get.
    await setSocialMode(env.DB, admin, 'enforce', NOW);
    const held = await example(QUIZ, { version: 1, job_id: 'exec-43', model: 'gemini-x', text: 'Quiz Night is on Saturday 24 October at 6:30pm. Just drop in!' });
    expect(held.status).toBe(200);
    const body = await held.json<{ ok: boolean; passed: boolean; problems: string[] }>();
    expect(body.ok).toBe(true);
    expect(body.passed).toBe(false);
    expect(body.problems.length).toBeGreaterThan(0);
    expect(body.problems.join(' ')).toMatch(/24|Saturday/);
    const after = await row(QUIZ, 1);
    expect(after).toMatchObject({ status: 'approved', example_attempts: 2, example_job_id: 'exec-43' });
    expect(JSON.parse(String(after!.example_check))).toEqual({ passed: false, problems: body.problems });
    expect(await checks()).toBe(0);
  });

  it("checks the review version's example as if it were in use, without the missing-prompt reason", async () => {
    const res = await example(DND, { version: 1, job_id: 'exec-50', text: 'Dungeons & Dragons is on Friday 30 October at 6:30pm. Booking is essential. #DnD' });
    const body = await res.json<{ passed: boolean; problems: string[] }>();
    expect(body.problems.join(' ')).not.toMatch(/prompt missing|prompt version/);
    expect(body).toEqual({ ok: true, passed: true, problems: [] });
    expect(await row(DND, 1)).toMatchObject({ status: 'review_required', example_attempts: 1 });
  });

  it('refuses a stale version (409), an unknown event or version (404) and a bad body (400), storing nothing', async () => {
    // A newer version came: the answer for version 1 is stale.
    expect(await approveOverride(env.DB, admin, QUIZ, { text: QUIZ_PROMPT, reason: 'Again' }, NOW)).toEqual({ ok: true, version: 2 });
    for (const body of [
      { version: 1, job_id: 'e', text: GOOD },
      { version: 1, job_id: 'e', error: 'quota' },
    ]) {
      const res = await example(QUIZ, body);
      expect(res.status).toBe(409);
      expect((await res.json<{ error: string }>()).error).toBeTruthy();
    }
    expect(await row(QUIZ, 1)).toMatchObject({ example_post: null, example_attempts: 0, example_error: null });

    expect((await example('RTD-EVT-09999', { version: 1, text: GOOD })).status).toBe(404);
    expect((await example(QUIZ, { version: 9, text: GOOD })).status).toBe(404);

    for (const bad of [
      {},
      [],
      { text: GOOD },
      { version: 0, text: GOOD },
      { version: 1.5, text: GOOD },
      { version: '2', text: GOOD },
      { version: 2 },
      { version: 2, text: '   ' },
      { version: 2, text: 7 },
      { version: 2, text: 'x'.repeat(5001) },
      { version: 2, error: '' },
    ]) {
      const res = await example(QUIZ, bad);
      expect(res.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBeTruthy();
    }
    expect((await example(QUIZ, 'not json {')).status).toBe(400);
    expect(await row(QUIZ, 2)).toMatchObject({ example_post: null, example_attempts: 0 });
    // 5,000 characters, once trimmed, is fine.
    expect((await example(QUIZ, { version: 2, text: ` ${'a'.repeat(5000)} ` })).status).toBe(200);
    expect(await checks()).toBe(0);
  });

  it('needs the token', async () => {
    expect((await get('/internal/social-prompts/examples-due', {})).status).toBe(401);
    expect((await post(`/internal/social-prompts/${QUIZ}/example`, { version: 1, text: GOOD }, { 'Content-Type': 'application/json' })).status).toBe(401);
  });
});

type Ex = { state: string; post: string | null; passed: boolean | null; problems: string[]; model: string | null; generated_at: string | null; attempts: number; error: string | null };
type Overview = {
  mode: string;
  review: { event_id: string; name: string; status: string; version: number; questions: string[]; master_prompt: string | null; example: Ex | null }[];
  approved: { event_id: string; name: string; version: number; master_prompt: string | null; approved_by: string | null; approved_at: string | null; example: Ex }[];
  held: unknown[];
};
const DAN = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'dan@example.com' };
const MICHELLE = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'michelle@example.com' };
const staffGet = (path: string, who: Partial<Env> = DAN) => request(path, {}, who);
const addUsers = () =>
  env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(NOW.toISOString()),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(NOW.toISOString()),
  ]);

describe('admin screens', () => {
  beforeEach(async () => {
    await freshDb();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await addUsers();
    await setUp();
  });
  afterEach(() => vi.useRealTimers());

  const WAITING: Ex = { state: 'waiting', post: null, passed: null, problems: [], model: null, generated_at: null, attempts: 0, error: null };

  it('shows each prompt to review with its reasons, its text and its example, and the approved ones with theirs', async () => {
    let overview = await (await staffGet('/api/staff/social')).json<Overview>();
    expect(overview.review).toEqual([
      {
        event_id: DND,
        name: 'Dungeons & Dragons',
        status: 'review_required',
        version: 1,
        questions: expect.arrayContaining(['Is it for beginners?']),
        master_prompt: DND_PROMPT,
        example: WAITING,
        suggestions: [],
        fixing: false,
      },
    ]);
    expect(overview.approved.map(a => [a.event_id, a.name, a.version])).toEqual([
      [BINGO, 'Bingo', 1],
      [QUIZ, 'Quiz', 1],
    ]);
    expect(overview.approved[1]).toMatchObject({ master_prompt: `${QUIZ_PROMPT}\n\n${SCHEDULE_RULE}`, approved_by: 'dan@example.com', approved_at: NOW.toISOString(), example: WAITING });

    // An example that passed, one that would be held, and one n8n couldn't write.
    await example(DND, { version: 1, job_id: 'exec-1', model: 'gemini-x', text: 'Dungeons & Dragons is on Friday 30 October at 6:30pm. Booking is essential. #DnD' });
    await example(QUIZ, { version: 1, job_id: 'exec-2', model: 'gemini-x', text: 'Quiz Night is on Saturday 24 October at 6:30pm.' });
    for (let i = 0; i < 3; i++) await example(BINGO, { version: 1, job_id: `exec-${i}`, error: 'Gemini quota' });

    overview = await (await staffGet('/api/staff/social')).json<Overview>();
    expect(overview.review[0]!.example).toEqual({
      state: 'ready',
      post: 'Dungeons & Dragons is on Friday 30 October at 6:30pm. Booking is essential. #DnD',
      passed: true,
      problems: [],
      model: 'gemini-x',
      generated_at: NOW.toISOString(),
      attempts: 1,
      error: null,
    });
    const quiz = overview.approved.find(a => a.event_id === QUIZ)!;
    expect(quiz.example).toMatchObject({ state: 'ready', passed: false });
    expect(quiz.example.problems.length).toBeGreaterThan(0);
    expect(overview.approved.find(a => a.event_id === BINGO)!.example).toMatchObject({ state: 'failed', post: null, attempts: 3, error: 'Gemini quota' });

    // The event's own page shows the same example under its prompt.
    const page = await (await staffGet(`/api/staff/events/${DND}/social`)).json<{ prompt: { version: number; example: Ex | null } }>();
    expect(page.prompt).toMatchObject({ version: 1, example: overview.review[0]!.example });

    // Approved inline (the existing endpoint, with a note): the new version waits for its own example.
    const ok = await request(
      `/api/staff/events/${DND}/social/approve`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Checked prompt and example' }) },
      DAN,
    );
    expect(await ok.json()).toEqual({ version: 2 });
    overview = await (await staffGet('/api/staff/social')).json<Overview>();
    expect(overview.review).toEqual([]);
    expect(overview.approved.find(a => a.event_id === DND)).toMatchObject({ version: 2, example: WAITING });

    // Still admins only.
    expect((await staffGet('/api/staff/social', MICHELLE)).status).toBe(403);
  });

  it('gives a blocked version no example', async () => {
    await env.DB.prepare("UPDATE social_prompts SET status = 'blocked' WHERE event_id = ?1").bind(DND).run();
    const overview = await (await staffGet('/api/staff/social')).json<Overview>();
    expect(overview.review).toMatchObject([{ event_id: DND, status: 'blocked', example: null }]);
    const page = await (await staffGet(`/api/staff/events/${DND}/social`)).json<{ prompt: { example: Ex | null } }>();
    expect(page.prompt.example).toBeNull();
  });
});

describe('before migration 0025 is applied', () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(
      env.DB,
      (env.TEST_MIGRATIONS ?? []).filter(m => !m.name.startsWith('0025')),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('still shows the hub, the overview and each event, with every example on its way', async () => {
    await addUsers();
    await setUp();
    const hub = await staffGet('/api/staff/summary');
    expect(hub.status).toBe(200);
    expect((await hub.json<{ sections: Record<string, unknown> }>()).sections.social).toMatchObject({ parts: { social_prompts: 1 } });
    const res = await staffGet('/api/staff/social');
    expect(res.status).toBe(200);
    const overview = await res.json<Overview>();
    expect(overview.review.map(r => [r.event_id, r.example?.state])).toEqual([[DND, 'waiting']]);
    expect(overview.approved.map(a => a.example.state)).toEqual(['waiting', 'waiting']);
    const page = await staffGet(`/api/staff/events/${QUIZ}/social`);
    expect(page.status).toBe(200);
    expect((await page.json<{ prompt: { example: Ex } }>()).prompt.example.state).toBe('waiting');
    // The rest of the prompt flow works as before.
    expect((await get('/internal/social-prompts/due')).status).toBe(200);
    expect((await get('/internal/social-prompts/to-write')).status).toBe(200);
  });

  it('says the migration is missing on the example routes, rather than crashing', async () => {
    await setUp();
    for (const res of [await get('/internal/social-prompts/examples-due'), await example(QUIZ, { version: 1, text: GOOD })]) {
      expect(res.status).toBe(503);
      expect((await res.json<{ error: string }>()).error).toMatch(/0025/);
    }
  });
});
