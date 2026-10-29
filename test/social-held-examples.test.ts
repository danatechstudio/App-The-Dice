// Fix for approved prompts whose example post would be held (29 Oct): the stored example is re-checked
// with the current check first (no Gemini, no social_checks row); one that still fails is cleared so
// n8n writes a new one, and the prompt builder is woken. Fix all does these with the review prompts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/lib/auth';
import { examplesDue, recheckExample } from '../src/social/examples';
import { fingerprint, sourceFields } from '../src/social/facts';
import { approveOverride } from '../src/social/prompts';
import { env, freshDb, indexRow, request, sync } from './helpers';

const NOW = new Date('2026-10-19T10:00:00Z');
const BASE = 'https://n8n.example.test/webhook';
const AUTH = { Authorization: 'Bearer test-sync-token', 'Content-Type': 'application/json' };
const DAN: Partial<Env> = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'dan@example.com', N8N_WEBHOOK_BASE: BASE };
const MICHELLE: Partial<Env> = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'michelle@example.com', N8N_WEBHOOK_BASE: BASE };
const admin: AuthUser = { user_id: 'u-dan', email: 'dan@example.com', display_name: 'Dan', role: 'admin' };

const QUIZ = 'RTD-EVT-00001'; // Friday 23 October, 18:30
const BINGO = 'RTD-EVT-00002'; // Wednesday 21 October, no time
const DND = 'RTD-EVT-00007';
const QUIZ_PROMPT = 'Write about Quiz, a family quiz night with prizes at stake, at Roll The Dice in Cleethorpes.';
const BINGO_PROMPT = 'Write about Bingo at Roll The Dice in Cleethorpes. Eyes down for a full house.';
const GOOD_QUIZ = 'Quiz Night is on Friday 23 October at 6:30pm. Teams welcome. #QuizNight';
const BAD_QUIZ = 'Quiz Night is on Saturday 24 October at 6:30pm. Teams welcome.';
const GOOD_BINGO = 'Bingo on Wednesday 21 October. Eyes down!';
// What an older check said about a post that passes now.
const STALE = JSON.stringify({ passed: false, problems: ['Humber: not in People & Roles'] });

const rows = () => [
  indexRow(1, {
    'Event Name': 'Quiz',
    'Base Details': 'A family quiz night with prizes at stake!',
    'Approved Facts': 'Prizes: cash prizes',
    'People & Roles': 'Trixie — sets up',
  }),
  indexRow(2, { 'Event Name': 'Bingo', 'Base Details': 'Eyes down for a full house.', 'Event Date': '21/10/2026', 'Event Time': '', 'End Time': '' }),
  indexRow(7, {
    'Event Name': 'Dungeons & Dragons',
    'Base Details': 'MoreThanABitDicey hosts her infamous DnD sessions!',
    'App Category': 'Gaming',
    'Event Date': '30/10/2026',
    'Approved Facts': 'Booking: essential',
    'People & Roles': 'MoreThanABitDicey — host',
  }),
];

const post = (path: string, body: unknown = {}, who: Partial<Env> = DAN) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, who);
const example = (id: string, body: unknown) => request(`/internal/social-prompts/${id}/example`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
const row = (id: string, version = 1) =>
  env.DB.prepare('SELECT * FROM social_prompts WHERE event_id = ?1 AND version = ?2').bind(id, version).first<Record<string, unknown>>();
const verdict = async (id: string, version = 1) => JSON.parse(String((await row(id, version))!.example_check)) as { passed: boolean; problems: string[] };
const checks = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM social_checks').first<{ n: number }>())!.n;
const stale = (id: string) => env.DB.prepare('UPDATE social_prompts SET example_check = ?2 WHERE event_id = ?1').bind(id, STALE).run();

let calls: { url: string; body: Record<string, unknown> }[];
let runs = 0;

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(NOW.toISOString()),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(NOW.toISOString()),
  ]);
  expect((await sync({ run_id: `held-${++runs}`, sources: { event_index: rows() } })).status).toBe(200);
  expect(await approveOverride(env.DB, admin, QUIZ, { text: QUIZ_PROMPT, reason: 'First prompt' }, NOW)).toEqual({ ok: true, version: 1 });
  expect(await approveOverride(env.DB, admin, BINGO, { text: BINGO_PROMPT, reason: 'First prompt' }, NOW)).toEqual({ ok: true, version: 1 });
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('{}', { status: 200 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('recheckExample', () => {
  it('runs the current check on the stored example and keeps the new verdict, recording no check', async () => {
    expect((await example(QUIZ, { version: 1, model: 'm', text: GOOD_QUIZ })).status).toBe(200);
    await stale(QUIZ);
    expect(await recheckExample(env.DB, QUIZ, 1, NOW)).toEqual({ ok: true, passed: true, problems: [] });
    expect(await verdict(QUIZ)).toEqual({ passed: true, problems: [] });
    // Nothing else about the example changes.
    expect(await row(QUIZ)).toMatchObject({ example_post: GOOD_QUIZ, example_model: 'm', example_attempts: 1 });
    expect(await checks()).toBe(0);
  });

  it('keeps a failing verdict with the reasons a live post would get', async () => {
    await example(QUIZ, { version: 1, text: BAD_QUIZ });
    const res = await recheckExample(env.DB, QUIZ, 1, NOW);
    expect(res).toMatchObject({ ok: true, passed: false });
    expect((res as { problems: string[] }).problems.join(' ')).toMatch(/24|Saturday/);
    expect((await verdict(QUIZ)).passed).toBe(false);
  });

  it('refuses a version with no example (404) or one that is no longer the newest (409)', async () => {
    expect(await recheckExample(env.DB, QUIZ, 1, NOW)).toMatchObject({ ok: false, status: 404 });
    await example(QUIZ, { version: 1, text: GOOD_QUIZ });
    expect(await approveOverride(env.DB, admin, QUIZ, { text: QUIZ_PROMPT, reason: 'Again' }, NOW)).toEqual({ ok: true, version: 2 });
    expect(await recheckExample(env.DB, QUIZ, 1, NOW)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('Fix on an approved prompt whose example would be held', () => {
  it('re-checks first: an example that passes now is done, and the builder is not woken', async () => {
    await example(QUIZ, { version: 1, text: GOOD_QUIZ });
    await stale(QUIZ);
    const res = await post(`/api/staff/events/${QUIZ}/social/fix`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, example: 'passes' });
    expect(await verdict(QUIZ)).toEqual({ passed: true, problems: [] });
    expect(calls).toEqual([]);
    // The prompt itself is left alone: no new version.
    expect(await row(QUIZ, 2)).toBeNull();
  });

  it('clears an example that still fails, so a new one is written, and wakes the builder', async () => {
    await example(QUIZ, { version: 1, text: BAD_QUIZ });
    expect(await examplesDue(env.DB, NOW, 10)).not.toContainEqual(expect.objectContaining({ event_id: QUIZ }));
    const res = await post(`/api/staff/events/${QUIZ}/social/fix`);
    expect(await res.json()).toEqual({ ok: true, example: 'rewriting' });
    expect(await row(QUIZ)).toMatchObject({ status: 'approved', example_post: null, example_check: null, example_attempts: 0, example_error: null });
    expect((await examplesDue(env.DB, NOW, 10)).map(e => [e.event_id, e.version])).toContainEqual([QUIZ, 1]);
    expect(calls).toEqual([{ url: `${BASE}/rtd-prompt-builder-run`, body: { reason: 'regenerate', event_id: QUIZ } }]);
    expect(await row(QUIZ, 2)).toBeNull();
  });

  it('is for admins only, and leaves an approved prompt whose example passes to the prompt Fix', async () => {
    await example(QUIZ, { version: 1, text: BAD_QUIZ });
    expect((await post(`/api/staff/events/${QUIZ}/social/fix`, {}, MICHELLE)).status).toBe(403);
    expect(await row(QUIZ)).toMatchObject({ example_post: BAD_QUIZ });
    expect(calls).toEqual([]);

    await example(BINGO, { version: 1, text: GOOD_BINGO });
    expect(await (await post(`/api/staff/events/${BINGO}/social/fix`)).json()).toEqual({ ok: true });
    expect(await row(BINGO, 2)).toMatchObject({ status: 'pending', override_reason: 'fix' });
  });
});

describe('Fix all', () => {
  it('fixes the review prompts and every held example, and wakes the builder once', async () => {
    // Dungeons & Dragons: a prompt waiting for review.
    const ev = await env.DB.prepare('SELECT * FROM events WHERE event_id = ?1').bind(DND).first<Record<string, unknown>>();
    const proposed = await request(`/internal/social-prompts/${DND}`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        fingerprint: await fingerprint(sourceFields(ev!)),
        output: { status: 'review_required', master_prompt: 'Write about Dungeons & Dragons.', claims: [], ambiguities: [], questions: ['Is it for beginners?'] },
      }),
    });
    expect(await proposed.json()).toMatchObject({ status: 'review_required' });
    // Quiz: an example that still fails. Bingo: one an older check held.
    await example(QUIZ, { version: 1, text: BAD_QUIZ });
    await example(BINGO, { version: 1, text: GOOD_BINGO });
    await stale(BINGO);

    const overview = await (await request('/api/staff/social', {}, DAN)).json<{ approved: { event_id: string; example: { passed: boolean } }[] }>();
    expect(overview.approved.filter(a => a.example.passed === false).map(a => a.event_id).sort()).toEqual([QUIZ, BINGO].sort());

    expect((await post('/api/staff/social/fix-all', {}, MICHELLE)).status).toBe(403);
    const res = await post('/api/staff/social/fix-all');
    expect(await res.json()).toEqual({ count: 3, prompts: 1, examples: 2, rechecked: 1, rewriting: 1 });
    expect(calls).toEqual([{ url: `${BASE}/rtd-prompt-builder-run`, body: { reason: 'regenerate' } }]);
    expect(await verdict(BINGO)).toEqual({ passed: true, problems: [] });
    expect(await row(QUIZ)).toMatchObject({ example_post: null, example_attempts: 0 });
    expect(await row(DND, 2)).toMatchObject({ status: 'pending', override_reason: 'fix' });

    // Only a re-check to do: nothing to wake.
    await stale(BINGO);
    await env.DB.prepare("DELETE FROM social_prompts WHERE event_id = ?1").bind(DND).run();
    calls = [];
    expect(await (await post('/api/staff/social/fix-all')).json()).toEqual({ count: 1, prompts: 0, examples: 1, rechecked: 1, rewriting: 0 });
    expect(calls).toEqual([]);
  });
});

describe("the organiser's count", () => {
  it('counts the approved prompts whose example would be held', async () => {
    const parts = async () => (await (await request('/api/staff/summary', {}, DAN)).json<{ sections: { social: { parts: Record<string, number> } } }>()).sections.social.parts;
    expect((await parts()).examples_held).toBe(0);
    await example(QUIZ, { version: 1, text: BAD_QUIZ });
    await example(BINGO, { version: 1, text: GOOD_BINGO });
    expect((await parts()).examples_held).toBe(1);
    // A private event's prompt doesn't count.
    await env.DB.prepare("UPDATE events SET visibility = 'private' WHERE event_id = ?1").bind(QUIZ).run();
    expect((await parts()).examples_held).toBe(0);
  });
});
