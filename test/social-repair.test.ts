// Prompts that repair themselves, and Fix / Fix all (the owner's option A, 28 Oct 2026): a generated
// prompt the checks fail goes back to Gemini with its own text and the problems found, up to three
// attempts for the same facts; an admin's Fix starts a fresh cycle. Facts never change by themselves:
// a review card only suggests a change, which an admin applies through the sheet-edit path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/lib/auth';
import { fingerprint, sourceFields } from '../src/social/facts';
import { REPAIR_INSTRUCTION } from '../src/social/instruction';
import { duePrompts, requestFix } from '../src/social/prompts';
import { env, freshDb, indexRow, request, sync } from './helpers';

const NOW = new Date('2026-10-19T10:00:00Z');
const BASE = 'https://n8n.example.test/webhook';
const AUTH = { Authorization: 'Bearer test-sync-token', 'Content-Type': 'application/json' };
const DAN: Partial<Env> = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'dan@example.com', N8N_WEBHOOK_BASE: BASE };
const MICHELLE: Partial<Env> = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'michelle@example.com', N8N_WEBHOOK_BASE: BASE };
const admin: AuthUser = { user_id: 'u-dan', email: 'dan@example.com', display_name: 'Dan', role: 'admin' };
const DND = 'RTD-EVT-00007';
const QUIZ = 'RTD-EVT-00004';
const FACTS = 'Booking: essential';

const dndRow = (over: Record<string, unknown> = {}) =>
  indexRow(7, {
    'Event Name': 'Dungeons & Dragons',
    'Base Details': 'MoreThanABitDicey hosts her infamous DnD sessions!',
    'App Category': 'Gaming',
    'Approved Facts': FACTS,
    'People & Roles': 'MoreThanABitDicey — host',
    ...over,
  });
const quizRow = (over: Record<string, unknown> = {}) =>
  indexRow(4, { 'Event Name': 'Pub Quiz', 'Base Details': 'Teams of six answer six rounds.', 'Approved Facts': FACTS, 'App Category': 'Quiz', ...over });

const goodPrompt =
  'Write about Dungeons & Dragons, a hosted game at Roll The Dice in Cleethorpes. MoreThanABitDicey hosts her infamous DnD sessions. ' +
  'Booking is essential. Never describe it as open play or a drop-in, and never add other people, prizes or levels.';
// The checks fail it: Trixie is in none of the event's fields.
const badPrompt = `${goodPrompt} Mention that Trixie brings the snacks.`;
const claims = [
  { claim: 'Dungeons & Dragons', source_field: 'name' },
  { claim: 'MoreThanABitDicey hosts her infamous DnD sessions', source_field: 'base_details' },
  { claim: 'MoreThanABitDicey is the host', source_field: 'people_roles' },
  { claim: 'Booking is essential', source_field: 'approved_facts.Booking' },
];
const output = (prompt = goodPrompt, over: Record<string, unknown> = {}) => ({ status: 'ok', master_prompt: prompt, claims, ambiguities: [], questions: [], ...over });
const TRIXIE = 'The prompt names "Trixie", which isn\'t in People & Roles or the event\'s own fields';

let runs = 0;
const syncRows = async (rows: Record<string, unknown>[]) => {
  expect((await sync({ run_id: `run-${++runs}`, sources: { event_index: rows } })).status).toBe(200);
};
const currentFp = async (id = DND) => fingerprint(sourceFields((await env.DB.prepare('SELECT * FROM events WHERE event_id = ?1').bind(id).first<Record<string, unknown>>())!));
const propose = async (body: Record<string, unknown>, id = DND) =>
  (await request(`/internal/social-prompts/${id}`, { method: 'POST', headers: AUTH, body: JSON.stringify({ fingerprint: await currentFp(id), ...body }) })).json<{
    status: string;
    version: number;
  }>();
const due = () => duePrompts(env.DB, new Date(), 50);
const dueOf = async (id = DND) => (await due()).find(d => d.event_id === id);
const sent = (d: { request: { user: string } }) => JSON.parse(d.request.user.slice(d.request.user.indexOf('{'))) as Record<string, unknown>;
const rows = async (id = DND) =>
  (
    await env.DB.prepare('SELECT version, status, override_reason, instruction_version FROM social_prompts WHERE event_id = ?1 ORDER BY version')
      .bind(id)
      .all<{ version: number; status: string; override_reason: string | null; instruction_version: number }>()
  ).results;
const post = (path: string, body: unknown = {}, who: Partial<Env> = DAN) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, who);

let calls: { url: string; body: Record<string, unknown> }[];

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(NOW.toISOString()),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(NOW.toISOString()),
  ]);
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

describe('self-repair', () => {
  it('sends a failed prompt back with its problems, and a pass ends it', async () => {
    await syncRows([dndRow()]);
    const first = (await dueOf())!;
    expect(sent(first)).not.toHaveProperty('previous_attempt');
    expect(first.request.system).toContain(REPAIR_INSTRUCTION);
    expect(first.instruction_version).toBe(4);

    expect(await propose({ output: output(badPrompt) })).toMatchObject({ status: 'review_required', version: 1 });
    const again = (await dueOf())!;
    expect(sent(again).previous_attempt).toEqual({ prompt: badPrompt, problems: [TRIXIE] });
    expect(again.request.user).toContain('previous_attempt is your last draft');
    // The fields go as before, beside it.
    expect(sent(again).base_details).toBe('MoreThanABitDicey hosts her infamous DnD sessions!');

    expect(await propose({ output: output() })).toMatchObject({ status: 'approved', version: 2 });
    expect(await dueOf()).toBeUndefined();
    expect((await rows()).map(r => r.status)).toEqual(['review_required', 'approved']);
  });

  it('stops after the third failed attempt for the same facts', async () => {
    await syncRows([dndRow()]);
    for (const version of [1, 2, 3]) {
      expect(await dueOf(), `due before attempt ${version}`).toBeDefined();
      expect(await propose({ output: output(badPrompt) })).toMatchObject({ status: 'review_required', version });
    }
    expect(await dueOf()).toBeUndefined();
    // Posted again anyway: the stored answer, nothing new.
    expect(await propose({ output: output() })).toMatchObject({ status: 'review_required', version: 3 });
    expect((await rows()).map(r => r.status)).toEqual(['review_required', 'review_required', 'review_required']);

    // New facts: a fresh count.
    await syncRows([dndRow({ 'Approved Facts': `${FACTS}\nLevel: all levels` })]);
    expect(sent((await dueOf())!)).not.toHaveProperty('previous_attempt');
  });

  it("doesn't repair a prompt where Gemini only asked a question", async () => {
    await syncRows([dndRow()]);
    expect(await propose({ output: output(goodPrompt, { status: 'review_required', questions: ['Is it for beginners?'] }) })).toMatchObject({
      status: 'review_required',
    });
    expect(await dueOf()).toBeUndefined();
  });

  it('leaves approved prompts, and prompts made before repairs existed, as they are', async () => {
    await syncRows([dndRow(), quizRow()]);
    expect(await propose({ output: output() })).toMatchObject({ status: 'approved', version: 1 });
    // A version made under instruction version 2 that the checks failed: it waits for an admin (Fix), as before.
    const quizPrompt = 'Write about Pub Quiz at Roll The Dice. Teams of six answer six rounds. Booking is essential, and Trixie reads the questions.';
    expect(
      await propose({ output: output(quizPrompt, { claims: [{ claim: 'Pub Quiz', source_field: 'name' }] }) }, QUIZ),
    ).toMatchObject({ status: 'review_required', version: 1 });
    await env.DB.prepare('UPDATE social_prompts SET instruction_version = 2 WHERE event_id = ?1').bind(QUIZ).run();
    expect(await due()).toEqual([]);
    expect((await rows()).map(r => [r.version, r.status])).toEqual([[1, 'approved']]);
  });
});

describe('Fix and Fix all', () => {
  const failThrice = async (id = DND) => {
    for (let i = 0; i < 3; i++) await propose({ output: output(badPrompt) }, id);
    expect(await dueOf(id)).toBeUndefined();
  };

  it('starts a fresh repair cycle from the latest version, admins only, and wakes the builder', async () => {
    await syncRows([dndRow()]);
    await failThrice();

    const refused = await post(`/api/staff/events/${DND}/social/fix`, {}, MICHELLE);
    expect(refused.status).toBe(403);
    expect(calls).toEqual([]);
    expect((await post('/api/staff/events/RTD-EVT-09999/social/fix')).status).toBe(404);

    const res = await post(`/api/staff/events/${DND}/social/fix`);
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: `${BASE}/rtd-prompt-builder-run`, body: { reason: 'regenerate', event_id: DND } }]);
    expect((await rows()).at(-1)).toMatchObject({ version: 4, status: 'pending', override_reason: 'fix' });
    expect(sent((await dueOf())!).previous_attempt).toEqual({ prompt: badPrompt, problems: [TRIXIE] });
    expect(
      (await env.DB.prepare("SELECT actor_id FROM audit_log WHERE action = 'social_prompt.fix_requested'").all()).results,
    ).toEqual([{ actor_id: 'dan@example.com' }]);

    // Three more attempts in this cycle: the Fix itself and two repairs.
    for (const version of [4, 5, 6]) {
      expect(await dueOf()).toBeDefined();
      expect(await propose({ output: output(badPrompt) })).toMatchObject({ status: 'review_required', version });
    }
    expect(await dueOf()).toBeUndefined();
    expect((await rows())[3]).toMatchObject({ status: 'review_required', override_reason: 'fix' });

    // Pressing Fix while one waits changes nothing but the wait.
    expect(await requestFix(env.DB, admin, DND, new Date())).toEqual({ ok: true });
    expect(await requestFix(env.DB, admin, DND, new Date())).toEqual({ ok: true });
    expect((await rows()).filter(r => r.status === 'pending')).toHaveLength(1);
  });

  it('fixes every prompt in the review list at once, and wakes the builder once', async () => {
    await syncRows([dndRow(), quizRow(), indexRow(2, { 'Event Name': 'Bingo' })]);
    await failThrice();
    const quizPrompt = 'Write about Pub Quiz at Roll The Dice. Teams of six answer six rounds. Booking is essential, and Trixie reads the questions.';
    for (let i = 0; i < 3; i++) await propose({ output: output(quizPrompt, { claims: [{ claim: 'Pub Quiz', source_field: 'name' }] }) }, QUIZ);
    expect(await due()).toHaveLength(1); // Bingo, which has no prompt yet: not in the list

    expect((await post('/api/staff/social/fix-all', {}, MICHELLE)).status).toBe(403);
    const res = await post('/api/staff/social/fix-all');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2, prompts: 2, examples: 0, rechecked: 0, rewriting: 0 });
    expect(calls).toEqual([{ url: `${BASE}/rtd-prompt-builder-run`, body: { reason: 'regenerate' } }]);
    expect((await rows(DND)).at(-1)).toMatchObject({ status: 'pending', override_reason: 'fix' });
    expect((await rows(QUIZ)).at(-1)).toMatchObject({ status: 'pending', override_reason: 'fix' });
    expect((await due()).map(d => d.event_id).sort()).toEqual(['RTD-EVT-00002', QUIZ, DND]);
    expect(sent((await dueOf(QUIZ))!).previous_attempt).toMatchObject({ prompt: quizPrompt });

    // Nothing to fix: nothing to wake.
    await env.DB.prepare("UPDATE social_prompts SET status = 'approved' WHERE status <> 'pending'").run();
    await env.DB.prepare("DELETE FROM social_prompts WHERE status = 'pending'").run();
    calls = [];
    expect(await (await post('/api/staff/social/fix-all')).json()).toMatchObject({ count: 0 });
    expect(calls).toEqual([]);
  });
});

describe('fact suggestions', () => {
  const STRAHD = 'RTD-EVT-00012';
  const strahdRow = (over: Record<string, unknown> = {}) =>
    indexRow(12, {
      'Event Name': 'Curse of Strahd',
      'Base Details': 'Olivia is one mean Dungeon Master, leading her band of adventurers through the mists of Barovia.',
      'App Category': 'Gaming',
      'Approved Facts': FACTS,
      'People & Roles': 'Trixie - host',
      ...over,
    });
  const strahdPrompt = 'Write about Curse of Strahd at Roll The Dice. Olivia is the Dungeon Master. Booking is essential.';

  it('shows a one-tap suggestion on the card, and Apply queues the sheet edit', async () => {
    await syncRows([strahdRow()]);
    expect((await post('/api/staff/sheet-sync/mode', { mode: 'live' })).status).toBe(200);
    expect(
      await propose({ output: output(strahdPrompt, { claims: [{ claim: 'Curse of Strahd', source_field: 'name' }] }) }, STRAHD),
    ).toMatchObject({ status: 'review_required' });

    const overview = await (await request('/api/staff/social', {}, DAN)).json<{ review: { event_id: string; suggestions: Record<string, unknown>[] }[] }>();
    const card = overview.review.find(r => r.event_id === STRAHD)!;
    expect(card.suggestions).toEqual([
      expect.objectContaining({ kind: 'people_add', name: 'Olivia', from: 'Trixie - host', to: 'Trixie - host\nOlivia - Dungeon Master' }),
    ]);
    // Nothing changed by itself.
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sheet_edits').first('n')).toBe(0);

    // Apply: the card sends the suggested value through the sheet-edit path.
    const apply = await post(`/api/staff/events/${STRAHD}/sheet-edit`, { values: { 'People & Roles': card.suggestions[0]!.to } });
    expect(apply.status).toBe(200);
    const edit = await env.DB.prepare('SELECT fields, status, requested_by FROM sheet_edits WHERE event_id = ?1').bind(STRAHD).first<{ fields: string; status: string; requested_by: string }>();
    expect(JSON.parse(edit!.fields)).toEqual({ 'People & Roles': { from: 'Trixie - host', to: 'Trixie - host\nOlivia - Dungeon Master' } });
    expect(edit).toMatchObject({ status: 'queued', requested_by: 'dan@example.com' });
    // While the change is on its way, the prompt isn't remade from the old facts.
    expect(await dueOf(STRAHD)).toBeUndefined();
  });
});
