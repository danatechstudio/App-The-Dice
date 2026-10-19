// Event-specific social master prompts, Stage 1 (docs/superpowers/specs/2026-10-18-social-master-prompt-design.md).
// Task 1: the owner columns the sync reads, the facts they hold, and the fingerprint of what Gemini may see.
// Task 4: the prompt store, the builder's internal endpoints and the switch.
// Task 5: what n8n is given before a post (the event layer) and the check every post goes through.
// Task 6: the admin screens' endpoints: the switch, what needs review, held posts, and each event's prompt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../src/lib/auth';
import { fingerprint, parseFacts, parsePeople, sourceFields, type SourceFields } from '../src/social/facts';
import { runCheck, socialContext, type EventLayer } from '../src/social/check';
import { INSTRUCTION, SCHEDULE_RULE } from '../src/social/instruction';
import {
  approveOverride,
  currentPrompt,
  duePrompts,
  insertPrompt,
  markPromptWritten,
  promptsToWrite,
  requestRegenerate,
  setSocialMode,
  socialMode,
} from '../src/social/prompts';
import { env, freshDb, indexRow, request, sync } from './helpers';

describe('owner columns', () => {
  beforeEach(freshDb);

  it('syncs Approved Facts, People & Roles and Banned Phrases without changing any event', async () => {
    expect((await sync({ run_id: 'r1', sources: { event_index: [indexRow(1)] } })).status).toBe(200);
    const blank = await env.DB.prepare('SELECT social_values, source_hash FROM events WHERE event_id = ?1')
      .bind('RTD-EVT-00001')
      .first<{ social_values: string; source_hash: string }>();
    expect(JSON.parse(blank!.social_values)).toEqual({ approved_facts: '', people_roles: '', banned_phrases: '' });

    const row = indexRow(1, {
      'Approved Facts': 'Booking: essential\nLevel: all levels',
      'People & Roles': 'Trixie — sets up',
      'Banned Phrases': 'open table',
    });
    const again = await (await sync({ run_id: 'r2', sources: { event_index: [row] } })).json<{ events_changed: number }>();
    expect(again.events_changed).toBe(0);

    const stored = await env.DB.prepare('SELECT social_values, source_hash FROM events WHERE event_id = ?1')
      .bind('RTD-EVT-00001')
      .first<{ social_values: string; source_hash: string }>();
    expect(stored!.source_hash).toBe(blank!.source_hash);
    expect(JSON.parse(stored!.social_values)).toEqual({
      approved_facts: 'Booking: essential\nLevel: all levels',
      people_roles: 'Trixie — sets up',
      banned_phrases: 'open table',
    });
  });

  it('reads the two owner columns on Standard Diary, which has no Banned Phrases', async () => {
    const row = {
      Group: 'Arkham',
      Notes: 'Co-op horror.',
      Frequency: 'Weekly',
      'Event ID': 'RTD-EVT-00005',
      'App Visibility': 'Public',
      'App Category': 'Club',
      Date: '12/10/2026',
      'Approved Facts': ' Level: all levels ',
      'People & Roles': 'Liv - DM',
      'Banned Phrases': 'ignored',
    };
    expect((await sync({ run_id: 'r1', sources: { standard_diary: [row] } })).status).toBe(200);
    const stored = await env.DB.prepare('SELECT social_values FROM events WHERE event_id = ?1').bind('RTD-EVT-00005').first<{ social_values: string }>();
    expect(JSON.parse(stored!.social_values)).toEqual({ approved_facts: 'Level: all levels', people_roles: 'Liv - DM', banned_phrases: '' });
  });

  it("reads facts by key, and reports lines it can't read", () => {
    const { facts, errors } = parseFacts('Booking: essential\nlevel: All levels\nPrizes: cash\nnonsense');
    expect(facts.Booking).toEqual(['essential']);
    expect(facts.Level).toEqual(['All levels']);
    expect(facts.Prizes).toEqual(['cash']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('nonsense');
  });

  it('keeps a repeated key, a colon inside a value, and reports an unknown key or an empty value', () => {
    const { facts, errors } = parseFacts('Bring: dice\n\nBring: snacks\nFormat: rounds: 3\nColour: red\nAge:  ');
    expect(facts.Bring).toEqual(['dice', 'snacks']);
    expect(facts.Format).toEqual(['rounds: 3']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Colour');
    expect(errors[1]).toContain('Age');
    expect(parseFacts('')).toEqual({ facts: {}, errors: [] });
  });

  it('reads people with any dash', () => {
    const { people, errors } = parsePeople('Trixie — sets up\nLiv - DM\nAlfie – DM');
    expect(errors).toEqual([]);
    expect(people).toEqual([
      { name: 'Trixie', role: 'sets up' },
      { name: 'Liv', role: 'DM' },
      { name: 'Alfie', role: 'DM' },
    ]);
  });

  it('keeps a hyphenated name whole, and reports a line with no role', () => {
    const { people, errors } = parsePeople('Mary-Jane — runs the table\nLiv - DM — lead\nTrixie\n');
    expect(people).toEqual([
      { name: 'Mary-Jane', role: 'runs the table' },
      { name: 'Liv', role: 'DM — lead' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Trixie');
  });

  describe('fingerprint', () => {
    const fields = (over: Partial<SourceFields> = {}): SourceFields => ({
      event_id: 'RTD-EVT-00001',
      name: 'Quiz',
      source: 'event_index',
      frequency: 'weekly',
      base_details: 'Teams of six.',
      approved_facts: 'Booking: essential',
      people_roles: 'Trixie — sets up',
      category: 'Quiz',
      visibility: 'public',
      price: '£2',
      capacity: '',
      ...over,
    });

    it('fingerprints facts but never dates', async () => {
      expect(await fingerprint(fields({ event_id: 'RTD-EVT-00002' }))).toBe(await fingerprint(fields()));
      expect(await fingerprint(fields({ approved_facts: 'Booking: walk in' }))).not.toBe(await fingerprint(fields()));
      expect(await fingerprint(fields())).toMatch(/^[0-9a-f]{64}$/);

      const row = {
        event_id: 'RTD-EVT-00001',
        display_name: 'Quiz',
        source: 'event_index',
        frequency: 'weekly',
        description: 'Teams of six.',
        category: 'Quiz',
        visibility: 'public',
        price_display: '£2',
        default_capacity: 8,
        event_date: '2026-10-15',
        start_time: '19:30',
        next_date: '2026-10-22',
        social_values: JSON.stringify({ approved_facts: 'Booking: essential', people_roles: 'Trixie — sets up', banned_phrases: 'open table' }),
      };
      const keys = Object.keys(sourceFields(row));
      expect(keys.filter(k => /date|time|when|day/i.test(k))).toEqual([]);
      expect(keys.sort()).toEqual(Object.keys(fields()).sort());
      expect(sourceFields(row)).toEqual(fields({ capacity: '8' }));
    });

    it('hashes only the ten whitelisted fields, whatever else the object holds', async () => {
      const extra = { ...fields(), event_date: '2026-10-23', start_time: '19:30', email: 'dan@example.com' } as unknown as SourceFields;
      expect(await fingerprint(extra)).toBe(await fingerprint(fields()));
    });

    it('does not depend on the order the fields were built in', async () => {
      const shuffled = Object.fromEntries(Object.entries(fields()).reverse()) as unknown as SourceFields;
      expect(await fingerprint(shuffled)).toBe(await fingerprint(fields()));
    });

    it('reads blanks from an events row that has no social values yet', () => {
      const bare = sourceFields({
        event_id: 'RTD-EVT-00009',
        display_name: 'Arkham',
        source: 'standard_diary',
        frequency: 'weekly',
        description: null,
        category: null,
        visibility: 'hidden',
        price_display: null,
        default_capacity: null,
        social_values: null,
      });
      expect(bare).toEqual({
        event_id: 'RTD-EVT-00009',
        name: 'Arkham',
        source: 'standard_diary',
        frequency: 'weekly',
        base_details: '',
        approved_facts: '',
        people_roles: '',
        category: '',
        visibility: 'hidden',
        price: '',
        capacity: '',
      });
    });
  });
});

describe('prompt store', () => {
  const NOW = new Date('2026-10-19T10:00:00Z');
  // The routes read the clock, so it is fixed at NOW: the dates in these tests never go stale.
  beforeEach(async () => {
    await freshDb();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  const AUTH = { Authorization: 'Bearer test-sync-token' };
  const admin: AuthUser = { user_id: 'u-dan', email: 'dan@example.com', display_name: 'Dan', role: 'admin' };
  const staff: AuthUser = { user_id: 'u-sam', email: 'sam@example.com', display_name: 'Sam', role: 'staff' };
  const DND = 'RTD-EVT-00007';
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

  const goodPrompt =
    'Write about Dungeons & Dragons, a hosted game at Roll The Dice in Cleethorpes. MoreThanABitDicey hosts her infamous DnD sessions. ' +
    'Booking is essential. Never describe it as open play or a drop-in, and never add other people, prizes or levels.';
  const output = (over: Record<string, unknown> = {}) => ({
    status: 'ok',
    master_prompt: goodPrompt,
    claims: [
      { claim: 'Dungeons & Dragons', source_field: 'name' },
      { claim: 'MoreThanABitDicey hosts her infamous DnD sessions', source_field: 'base_details' },
      { claim: 'MoreThanABitDicey is the host', source_field: 'people_roles' },
      { claim: 'Booking is essential', source_field: 'approved_facts.Booking' },
    ],
    ambiguities: [],
    questions: [],
    ...over,
  });
  const reviewOutput = () => output({ status: 'review_required', questions: ['Is it for beginners?'] });

  let runs = 0;
  const syncRows = async (rows: Record<string, unknown>[]) => {
    expect((await sync({ run_id: `run-${++runs}`, sources: { event_index: rows } })).status).toBe(200);
  };
  const due = (now = NOW, limit = 50) => duePrompts(env.DB, now, limit);
  const dueIds = async (now = NOW) => (await due(now)).map(d => d.event_id);
  const currentFp = async (id = DND) => {
    const row = await env.DB.prepare('SELECT * FROM events WHERE event_id = ?1').bind(id).first<Record<string, unknown>>();
    return fingerprint(sourceFields(row!));
  };
  const propose = (id: string, body: unknown) =>
    request(`/internal/social-prompts/${id}`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const written = (id: string, body: unknown) =>
    request(`/internal/social-prompts/${id}/written`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rows = async (id = DND) =>
    (
      await env.DB.prepare('SELECT * FROM social_prompts WHERE event_id = ?1 ORDER BY version')
        .bind(id)
        .all<{ prompt_id: string; version: number; status: string; master_prompt: string | null; approved_by: string | null; override_reason: string | null; override_text: string | null }>()
    ).results;
  const audits = async (action: string) =>
    (await env.DB.prepare('SELECT * FROM audit_log WHERE action = ?1 ORDER BY audit_id').bind(action).all<Record<string, string>>()).results;

  it('lists an event as due until it has a prompt for its facts, and never a past, private or hidden one', async () => {
    const others = [
      indexRow(2, { 'App Visibility': 'Private' }),
      indexRow(3, { 'App Visibility': 'Hidden' }),
      indexRow(4, { 'Event Date': '01/10/2026' }),
      indexRow(5),
      indexRow(8, { Status: 'Inactive' }),
      indexRow(9),
      indexRow(10),
      indexRow(11),
    ];
    await syncRows([dndRow(), ...others]);
    // Its only date cancelled; its only date hidden.
    await env.DB.prepare("UPDATE occurrences SET status = 'cancelled' WHERE event_id = 'RTD-EVT-00009'").run();
    await env.DB.prepare("UPDATE occurrences SET visibility = 'hidden' WHERE event_id = 'RTD-EVT-00010'").run();
    // A host's change request waiting for a decision.
    const iso = NOW.toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam', 'host', 1, ?1, ?1)").bind(iso),
      env.DB.prepare(
        "INSERT INTO host_sessions (session_id, host_user_id, name, event_date, start_time, max_players, status, created_at, updated_at) VALUES ('RTD-HS-00001', 'u-sam', 'D&D', '2026-10-23', '18:00', 6, 'published', ?1, ?1)",
      ).bind(iso),
      env.DB.prepare(
        "INSERT INTO event_change_requests (request_id, session_id, event_id, requested_by, published, proposed, status, created_at, updated_at) VALUES ('RTD-CR-00001', 'RTD-HS-00001', 'RTD-EVT-00011', 'sam@example.com', '{}', '{}', 'pending', ?1, ?1)",
      ).bind(iso),
    ]);
    // A change on its way to the Logic Engine: the facts may be about to change, so not yet.
    await env.DB.prepare(
      `INSERT INTO sheet_edits (edit_id, event_id, source, target, fields, requested_by, status, created_at, updated_at)
       VALUES ('RTD-SE-00001', 'RTD-EVT-00005', 'event_index', 'live', '{}', 'dan@example.com', 'queued', ?1, ?1)`,
    )
      .bind(NOW.toISOString())
      .run();

    const list = await due();
    expect(list.map(d => d.event_id)).toEqual([DND]);
    expect(list[0]!.fingerprint).toBe(await currentFp());
    expect(list[0]!.instruction_version).toBe(1);
    expect(list[0]!.request.system).toContain(INSTRUCTION);
    expect(list[0]!.request.user).toContain('MoreThanABitDicey');
    // Gemini never sees the date or the time.
    expect(list[0]!.request.user).not.toMatch(/2026|18:30|23\/10/);
    // Once the last date has gone, it isn't due.
    expect(await dueIds(new Date('2026-10-24T10:00:00Z'))).toEqual([]);

    // The edit lands: both are due, and the limit is kept.
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run();
    expect((await dueIds()).sort()).toEqual(['RTD-EVT-00005', DND]);
    expect(await due(NOW, 1)).toHaveLength(1);

    // The same answer over HTTP.
    const res = await request('/internal/social-prompts/due?limit=1', { headers: AUTH });
    expect(res.status).toBe(200);
    expect((await res.json<{ events: unknown[] }>()).events).toHaveLength(1);

    // A prompt for these facts: not due. New facts: due again.
    expect((await propose(DND, { fingerprint: await currentFp(), job_id: 'exec-1', model: 'm', output: output() })).status).toBe(200);
    expect(await dueIds()).toEqual(['RTD-EVT-00005']);
    await syncRows([dndRow({ 'Approved Facts': `${FACTS}\nLevel: all levels` }), ...others]);
    expect((await dueIds()).sort()).toEqual(['RTD-EVT-00005', DND]);
  });

  it('refuses an answer (409) for an event that stopped being due meanwhile, and stores nothing', async () => {
    await syncRows([dndRow()]);
    const fp = await currentFp();
    expect(await dueIds()).toEqual([DND]);
    // A change on its way to the Logic Engine.
    await env.DB.prepare(
      `INSERT INTO sheet_edits (edit_id, event_id, source, target, fields, requested_by, status, created_at, updated_at)
       VALUES ('RTD-SE-00001', ?1, 'event_index', 'live', '{}', 'dan@example.com', 'queued', ?2, ?2)`,
    )
      .bind(DND, NOW.toISOString())
      .run();
    expect((await propose(DND, { fingerprint: fp, output: output() })).status).toBe(409);
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run();
    // Stopped running (the facts, and so the fingerprint, are the same).
    await syncRows([dndRow({ Status: 'Inactive' })]);
    expect(await currentFp()).toBe(fp);
    const res = await propose(DND, { fingerprint: fp, output: output() });
    expect(res.status).toBe(409);
    expect((await propose(DND, { fingerprint: fp, error: 'quota' })).status).toBe(409);
    expect(await rows()).toEqual([]);
    expect(await audits('social_prompt.failed')).toEqual([]);
    expect(await audits('social_prompt.generated')).toEqual([]);
  });

  it('stores one version when the same answer is posted twice at once', async () => {
    await syncRows([dndRow()]);
    const fp = await currentFp();
    const both = await Promise.all([propose(DND, { fingerprint: fp, output: output() }), propose(DND, { fingerprint: fp, output: output() })]);
    for (const res of both) expect(await res.json()).toMatchObject({ ok: true, status: 'approved', version: 1 });
    expect((await rows()).map(r => [r.version, r.status])).toEqual([[1, 'approved']]);
    // Only what was stored is audited.
    expect(await audits('social_prompt.generated')).toHaveLength(1);
    // Posted again later: the stored answer, nothing new.
    expect(await (await propose(DND, { fingerprint: fp, output: reviewOutput() })).json()).toMatchObject({ status: 'approved', version: 1 });
    expect(await rows()).toHaveLength(1);
    expect(await audits('social_prompt.generated')).toHaveLength(1);
  });

  it('makes a fresh version when the facts come back to a set whose regenerate request was overtaken', async () => {
    await syncRows([dndRow()]);
    const a = await currentFp();
    await propose(DND, { fingerprint: a, output: output() });
    expect(await requestRegenerate(env.DB, admin, DND, new Date())).toEqual({ ok: true });
    await syncRows([dndRow({ 'Approved Facts': `${FACTS}\nLevel: all levels` })]);
    expect(await (await propose(DND, { fingerprint: await currentFp(), output: output() })).json()).toMatchObject({ status: 'approved', version: 3 });

    await syncRows([dndRow()]);
    expect(await dueIds()).toEqual([DND]);
    expect(await (await propose(DND, { fingerprint: a, output: output() })).json()).toEqual({
      ok: true,
      status: 'approved',
      version: 4,
      cells: { 'Social Prompt': `${goodPrompt}\n\n${SCHEDULE_RULE}`, 'Social Prompt Status': 'approved · v4' },
    });
    expect((await rows()).map(r => [r.version, r.status])).toEqual([
      [1, 'superseded'],
      [2, 'superseded'],
      [3, 'superseded'],
      [4, 'approved'],
    ]);
    expect(await currentPrompt(env.DB, DND)).toMatchObject({ version: 4, fingerprint: a, current: true });
    expect(await dueIds()).toEqual([]);
  });

  it('approves a valid proposal, supersedes the old version, and returns the cells', async () => {
    await syncRows([dndRow()]);
    const res = await propose(DND, { fingerprint: await currentFp(), job_id: 'exec-1', model: 'm', output: output() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      status: 'approved',
      version: 1,
      cells: { 'Social Prompt': `${goodPrompt}\n\n${SCHEDULE_RULE}`, 'Social Prompt Status': 'approved · v1' },
    });

    await syncRows([dndRow({ 'Approved Facts': `${FACTS}\nLevel: all levels` })]);
    const again = await (await propose(DND, { fingerprint: await currentFp(), job_id: 'exec-2', output: JSON.stringify(output()) })).json();
    expect(again).toMatchObject({ ok: true, status: 'approved', version: 2, cells: { 'Social Prompt Status': 'approved · v2' } });
    expect((await rows()).map(r => [r.prompt_id, r.version, r.status, r.approved_by])).toEqual([
      ['RTD-SP-00001', 1, 'superseded', 'system'],
      ['RTD-SP-00002', 2, 'approved', 'system'],
    ]);
    expect(await audits('social_prompt.generated')).toHaveLength(2);

    // Posting the same facts again changes nothing: the stored answer comes back.
    const dup = await (await propose(DND, { fingerprint: await currentFp(), output: reviewOutput() })).json();
    expect(dup).toMatchObject({ ok: true, status: 'approved', version: 2 });
    expect(await rows()).toHaveLength(2);
  });

  it('checks a proposal against the names of the other events', async () => {
    await syncRows([dndRow(), indexRow(2, { 'Event Name': 'Quiz Night' })]);
    const prompt = `${goodPrompt} Never mention Quiz Night.`;
    const body = await (await propose(DND, { fingerprint: await currentFp(), output: output({ master_prompt: prompt }) })).json<{ status: string; cells: Record<string, string> }>();
    expect(body.status).toBe('review_required');
    expect(body.cells['Social Prompt Status']).toMatch(/^review · v1: .*Quiz Night/);
    expect(body.cells['Social Prompt']).toBe('');
  });

  it('refuses a stale proposal (409) when the facts changed meanwhile', async () => {
    await syncRows([dndRow()]);
    const old = await currentFp();
    await syncRows([dndRow({ 'Approved Facts': 'Booking: walk in' })]);
    const res = await propose(DND, { fingerprint: old, job_id: 'exec-1', output: output() });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toMatch(/stale/i);
    expect((await propose(DND, { fingerprint: old, error: 'quota' })).status).toBe(409);
    expect(await rows()).toEqual([]);
    expect(await audits('social_prompt.failed')).toEqual([]);
    expect(await dueIds()).toEqual([DND]);

    // Bad requests say what is wrong.
    expect((await propose(DND, { output: output() })).status).toBe(400);
    expect((await propose(DND, { fingerprint: await currentFp() })).status).toBe(400);
    expect((await propose('RTD-EVT-09999', { fingerprint: old, output: output() })).status).toBe(404);
  });

  it('blocks after three failed generations, then stops listing it as due', async () => {
    await syncRows([dndRow()]);
    const fp = await currentFp();
    expect(await (await propose(DND, { fingerprint: fp, output: 'not json {' })).json()).toEqual({ ok: true, status: 'failed', failures: 1, version: null, cells: null });
    expect(await dueIds()).toEqual([DND]);
    expect(await (await propose(DND, { fingerprint: fp, error: 'Gemini: quota exceeded' })).json()).toMatchObject({ status: 'failed', failures: 2 });
    expect(await dueIds()).toEqual([DND]);
    expect(await rows()).toEqual([]);

    const third = await (await propose(DND, { fingerprint: fp, output: { status: 'ok' } })).json();
    expect(third).toEqual({ ok: true, status: 'blocked', version: 1, cells: { 'Social Prompt': '', 'Social Prompt Status': 'blocked · v1: generation failed' } });
    expect(await dueIds()).toEqual([]);
    expect((await rows()).map(r => r.status)).toEqual(['blocked']);
    expect(await audits('social_prompt.failed')).toHaveLength(3);
    expect((await audits('social_prompt.failed')).map(r => JSON.parse(r.new_value!).reason)).toEqual([
      'The output is not JSON',
      'Gemini: quota exceeded',
      expect.any(String),
    ]);

    // Regenerate: only an admin, and the event is due again with a fresh count.
    expect(await requestRegenerate(env.DB, staff, DND, NOW)).toEqual({ ok: false, status: 403, error: 'Only admins can manage social prompts.' });
    expect(await requestRegenerate(env.DB, admin, 'RTD-EVT-09999', NOW)).toMatchObject({ ok: false, status: 404 });
    // A minute later: the route stamps failures with the time it gets them, so the earlier ones are before the request.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect(await requestRegenerate(env.DB, admin, DND, new Date())).toEqual({ ok: true });
    expect(await requestRegenerate(env.DB, admin, DND, new Date())).toEqual({ ok: true });
    expect(await audits('social_prompt.regenerate_requested')).toHaveLength(2);
    expect(await dueIds()).toEqual([DND]);
    // n8n may pass its error object as it is.
    expect(await (await propose(DND, { fingerprint: fp, error: { message: 'quota' } })).json()).toMatchObject({ status: 'failed', failures: 1 });
    expect(await (await propose(DND, { fingerprint: fp, error: { code: 429 } })).json()).toMatchObject({ status: 'failed', failures: 2 });
    expect((await audits('social_prompt.failed')).slice(3).map(r => JSON.parse(r.new_value!).reason)).toEqual(['quota', '{"code":429}']);
    expect(await (await propose(DND, { fingerprint: fp, output: output() })).json()).toMatchObject({ status: 'approved', version: 2 });
    expect((await rows()).map(r => [r.version, r.status, r.override_reason])).toEqual([
      [1, 'blocked', null],
      [2, 'approved', 'regenerate'],
    ]);
    expect(await dueIds()).toEqual([]);
  });

  it('keeps an old approved version usable only while its facts still match', async () => {
    await syncRows([dndRow()]);
    const fp = await currentFp();
    expect(await currentPrompt(env.DB, DND)).toBeNull();
    await propose(DND, { fingerprint: fp, output: output() });
    expect(await currentPrompt(env.DB, DND)).toEqual({ version: 1, master_prompt: `${goodPrompt}\n\n${SCHEDULE_RULE}`, fingerprint: fp, current: true });

    await syncRows([dndRow({ 'Approved Facts': `${FACTS}\nLevel: all levels` })]);
    expect(await currentPrompt(env.DB, DND)).toMatchObject({ version: 1, current: false });

    // A version that needs review doesn't replace it, and the sheet shows no usable prompt.
    const review = await (await propose(DND, { fingerprint: await currentFp(), output: reviewOutput() })).json();
    expect(review).toEqual({
      ok: true,
      status: 'review_required',
      version: 2,
      cells: { 'Social Prompt': '', 'Social Prompt Status': 'review · v2: Is it for beginners?' },
    });
    expect(await currentPrompt(env.DB, DND)).toMatchObject({ version: 1, current: false });

    // The facts go back: version 1 is usable again.
    await syncRows([dndRow()]);
    expect(await currentPrompt(env.DB, DND)).toMatchObject({ version: 1, current: true });

    // A regenerate leaves the approved version in use until a new one is approved.
    expect(await requestRegenerate(env.DB, admin, DND, NOW)).toEqual({ ok: true });
    expect(await currentPrompt(env.DB, DND)).toMatchObject({ version: 1, current: true });
    const regen = await (await propose(DND, { fingerprint: fp, output: reviewOutput() })).json();
    expect(regen).toMatchObject({ status: 'review_required', version: 3, cells: { 'Social Prompt': `${goodPrompt}\n\n${SCHEDULE_RULE}` } });
    expect(await currentPrompt(env.DB, DND)).toMatchObject({ version: 1, current: true });
  });

  it('keeps the old version and its fingerprint as they were when a regenerate makes a new one', async () => {
    await syncRows([dndRow()]);
    const fp = await currentFp();
    await propose(DND, { fingerprint: fp, output: output() });
    expect(await requestRegenerate(env.DB, admin, DND, NOW)).toEqual({ ok: true });
    expect(await (await propose(DND, { fingerprint: fp, output: output() })).json()).toMatchObject({ status: 'approved', version: 2 });
    const stored = await env.DB.prepare('SELECT version, status, source_fingerprint FROM social_prompts WHERE event_id = ?1 ORDER BY version')
      .bind(DND)
      .all<{ version: number; status: string; source_fingerprint: string }>();
    expect(stored.results).toEqual([
      { version: 1, status: 'superseded', source_fingerprint: fp },
      { version: 2, status: 'approved', source_fingerprint: fp },
    ]);
    expect(await currentPrompt(env.DB, DND)).toMatchObject({ version: 2, fingerprint: fp, current: true });
    expect(await dueIds()).toEqual([]);
  });

  it('writes each approved or overridden version once', async () => {
    await syncRows([dndRow()]);
    await propose(DND, { fingerprint: await currentFp(), output: output() });
    expect(await promptsToWrite(env.DB)).toEqual([
      { event_id: DND, version: 1, cells: { 'Social Prompt': `${goodPrompt}\n\n${SCHEDULE_RULE}`, 'Social Prompt Status': 'approved · v1' } },
    ]);
    expect((await written(DND, {})).status).toBe(400);
    expect((await written(DND, { version: 9 })).status).toBe(404);
    const ok = await written(DND, { version: 1 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(await promptsToWrite(env.DB)).toEqual([]);
    expect(await (await request('/internal/social-prompts/to-write', { headers: AUTH })).json()).toEqual({ prompts: [] });

    const text = 'Write about Dungeons & Dragons. Booking is essential.';
    expect(await approveOverride(env.DB, admin, DND, { text, reason: 'Shorter' }, NOW)).toEqual({ ok: true, version: 2 });
    const toWrite = await (await request('/internal/social-prompts/to-write', { headers: AUTH })).json();
    expect(toWrite).toEqual({
      prompts: [{ event_id: DND, version: 2, cells: { 'Social Prompt': `${text}\n\n${SCHEDULE_RULE}`, 'Social Prompt Status': 'approved · v2' } }],
    });
    expect(await markPromptWritten(env.DB, DND, 2, NOW)).toBe('ok');
    expect(await markPromptWritten(env.DB, DND, 2, NOW)).toBe('ok');
    expect(await markPromptWritten(env.DB, 'RTD-EVT-09999', 1, NOW)).toBe('not_found');
    expect(await promptsToWrite(env.DB)).toEqual([]);
  });

  it('appends the schedule rule exactly once to a prompt an admin approves', async () => {
    await syncRows([dndRow()]);
    await propose(DND, { fingerprint: await currentFp(), output: reviewOutput() });

    expect(await approveOverride(env.DB, staff, DND, { reason: 'ok' }, NOW)).toEqual({ ok: false, status: 403, error: 'Only admins can manage social prompts.' });
    expect(await approveOverride(env.DB, admin, DND, { reason: ' ' }, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await approveOverride(env.DB, admin, 'RTD-EVT-09999', { reason: 'ok' }, NOW)).toMatchObject({ ok: false, status: 404 });
    const dated = await approveOverride(env.DB, admin, DND, { text: `${goodPrompt} It is on 23 October at 7pm.`, reason: 'ok' }, NOW);
    expect(dated).toMatchObject({ ok: false, status: 400 });
    expect((dated as { errors: string[] }).errors.join(' ')).toMatch(/date/);

    // Approving the version that needed review, as Gemini wrote it.
    expect(await approveOverride(env.DB, admin, DND, { reason: 'Yes, beginners are welcome' }, NOW)).toEqual({ ok: true, version: 2 });
    let stored = await rows();
    expect(stored.map(r => [r.version, r.status])).toEqual([
      [1, 'review_required'],
      [2, 'approved'],
    ]);
    expect(stored[1]).toMatchObject({ master_prompt: `${goodPrompt}\n\n${SCHEDULE_RULE}`, approved_by: 'dan@example.com', override_reason: 'Yes, beginners are welcome' });
    expect(await currentPrompt(env.DB, DND)).toMatchObject({ version: 2, current: true });

    // Pasted text that already ends with the rule keeps one copy of it.
    expect(await approveOverride(env.DB, admin, DND, { text: `${goodPrompt}\n\n${SCHEDULE_RULE}\n`, reason: 'Tidied' }, NOW)).toEqual({ ok: true, version: 3 });
    stored = await rows();
    expect(stored.map(r => r.status)).toEqual(['review_required', 'superseded', 'approved']);
    expect(stored[2]!.master_prompt).toBe(`${goodPrompt}\n\n${SCHEDULE_RULE}`);
    expect(stored[2]!.master_prompt!.split(SCHEDULE_RULE)).toHaveLength(2);
    expect(await audits('social_prompt.overridden')).toHaveLength(2);

    // The rule pasted in the middle is taken out there and added once at the end.
    const middle = `${goodPrompt}\n\n${SCHEDULE_RULE}\n\nKeep it short. ${SCHEDULE_RULE} Be warm.`;
    expect(await approveOverride(env.DB, admin, DND, { text: middle, reason: 'Moved the rule' }, NOW)).toEqual({ ok: true, version: 4 });
    expect((await rows())[3]!.master_prompt).toBe(`${goodPrompt}\n\nKeep it short. Be warm.\n\n${SCHEDULE_RULE}`);
  });

  it('gives two versions made in one batch different numbers', async () => {
    await syncRows([dndRow()]);
    const row = (fp: string) => ({ event_id: DND, status: 'blocked' as const, fingerprint: fp, snapshot: '{}', now: NOW.toISOString() });
    await env.DB.batch([insertPrompt(env.DB, row('a'.repeat(64))), insertPrompt(env.DB, row('b'.repeat(64)))]);
    expect((await rows()).map(r => [r.prompt_id, r.version])).toEqual([
      ['RTD-SP-00001', 1],
      ['RTD-SP-00002', 2],
    ]);
  });

  it('needs the bearer token', async () => {
    for (const [method, path] of [
      ['GET', '/internal/social-prompts/due'],
      ['POST', `/internal/social-prompts/${DND}`],
      ['GET', '/internal/social-prompts/to-write'],
      ['POST', `/internal/social-prompts/${DND}/written`],
    ] as const) {
      expect((await request(path, { method })).status, path).toBe(401);
    }
  });

  it('starts Off, and only an admin can change the switch, with an audit row', async () => {
    expect(await socialMode(env.DB)).toBe('off');
    expect(await setSocialMode(env.DB, staff, 'shadow', NOW)).toEqual({ ok: false, status: 403, error: 'Only admins can manage social prompts.' });
    expect(await setSocialMode(env.DB, admin, 'loud', NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await socialMode(env.DB)).toBe('off');
    expect(await setSocialMode(env.DB, admin, 'shadow', NOW)).toEqual({ ok: true, mode: 'shadow' });
    expect(await socialMode(env.DB)).toBe('shadow');
    const [audit] = await audits('social_prompts.changed');
    expect(audit).toMatchObject({ entity_type: 'setting', entity_id: 'social_prompts', actor_type: 'staff', actor_id: 'dan@example.com', previous_value: 'off', new_value: 'shadow' });
  });
});

describe('posting', () => {
  // Monday 19 October 2026, 11:00 in London. The Quiz is on Friday 23 October, 18:30–22:00.
  const NOW = new Date('2026-10-19T10:00:00Z');
  // The routes read the clock, so it is fixed at NOW: the dates in these tests never go stale.
  beforeEach(async () => {
    await freshDb();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  const AUTH = { Authorization: 'Bearer test-sync-token', 'Content-Type': 'application/json' };
  const admin: AuthUser = { user_id: 'u-dan', email: 'dan@example.com', display_name: 'Dan', role: 'admin' };
  const QUIZ = 'RTD-EVT-00001';
  const QUIZ_OCC = 'RTD-OCC-00001-20261023';
  const BINGO = 'RTD-EVT-00002';
  const BINGO_OCC = 'RTD-OCC-00002-20261023';
  const QUIZ_PROMPT = 'Write about Quiz, a family quiz night with prizes at stake, at Roll The Dice in Cleethorpes.';

  // As the Logic Engine held it on 18 October: no App Price, no Approved Facts.
  const quizRow = (over: Record<string, unknown> = {}) =>
    indexRow(1, { 'Event Name': 'Quiz', 'Base Details': 'A family quiz night with prizes at stake!', 'Banned Phrases': 'open table', ...over });
  const bingoRow = (over: Record<string, unknown> = {}) => indexRow(2, { 'Event Name': 'Bingo', 'Base Details': 'Eyes down for a full house.', ...over });

  // The Quiz caption that went out on 18 October (real-captions-2026-10-18.md).
  const REAL_QUIZ_CAPTION = [
    "Who's ready to turn their random trivia knowledge into real cash prizes? ",
    '',
    "We're hosting our Quiz Night on Friday, 23/10/2026 at 18:30, and we'd love for you to join us at Roll The Dice! ",
    '',
    "It's completely family-friendly and suitable for all ages, so bring your crew along for an evening of fun and friendly competition. With cash prizes up for grabs, everyone gets a chance to shine. ",
    '',
    'You can book a table with us or simply drop in on the night.',
    '',
    '#RollTheDice #QuizNight #FamilyFun #TriviaNight',
  ].join('\n');
  const GOOD = 'Quiz Night is on Friday 23 October at 6:30pm. Teams welcome. #QuizNight';

  let runs = 0;
  const syncRows = async (rows: Record<string, unknown>[]) => {
    expect((await sync({ run_id: `post-${++runs}`, sources: { event_index: rows } })).status).toBe(200);
  };
  const setUp = async (mode: 'off' | 'shadow' | 'enforce', rows = [quizRow(), bingoRow()]) => {
    await syncRows(rows);
    expect(await approveOverride(env.DB, admin, QUIZ, { text: QUIZ_PROMPT, reason: 'First prompt' }, NOW)).toEqual({ ok: true, version: 1 });
    if (mode !== 'off') expect(await setSocialMode(env.DB, admin, mode, NOW)).toEqual({ ok: true, mode });
  };
  const checkBody = (over: Record<string, unknown> = {}) => ({
    kind: 'event_post',
    platform: 'facebook',
    targets: [{ event_id: QUIZ, occurrence_id: QUIZ_OCC, prompt_version: 1 }],
    text: GOOD,
    workflow: 'RTD Master V1',
    execution_id: 'exec-42',
    ...over,
  });
  const checks = async () => (await env.DB.prepare('SELECT * FROM social_checks ORDER BY check_id').all<Record<string, string | null>>()).results;
  const post = (path: string, body: unknown, headers: Record<string, string> = AUTH) =>
    request(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const failed = (res: unknown) => res as { allow: boolean; result: string; reasons: string[]; mode: string };
  const said = (res: unknown, words: RegExp) => failed(res).reasons.some(r => words.test(r));

  it('does nothing at Off', async () => {
    await setUp('off');
    expect(await socialMode(env.DB)).toBe('off');
    expect(await socialContext(env.DB, { event_ids: [QUIZ] }, NOW)).toEqual({ mode: 'off', events: [] });
    expect(await runCheck(env.DB, checkBody({ text: REAL_QUIZ_CAPTION }), NOW)).toEqual({ allow: true, result: null, reasons: [], mode: 'off' });
    // No work at all, so not even a malformed body is looked at.
    expect(await runCheck(env.DB, 'nonsense', NOW)).toEqual({ allow: true, result: null, reasons: [], mode: 'off' });

    const ctx = await post('/internal/social/context', { event_ids: [QUIZ] });
    expect(ctx.status).toBe(200);
    expect(await ctx.json()).toEqual({ mode: 'off', events: [] });
    const chk = await post('/internal/social/check', checkBody({ text: REAL_QUIZ_CAPTION }));
    expect(chk.status).toBe(200);
    expect(await chk.json()).toEqual({ allow: true, result: null, reasons: [], mode: 'off' });
    expect(await checks()).toEqual([]);
    const used = await env.DB.prepare('SELECT last_used_at FROM social_prompts').first<{ last_used_at: string | null }>();
    expect(used!.last_used_at).toBeNull();
  });

  it("gives n8n each event's layer with today's date block", async () => {
    await setUp('shadow', [
      quizRow({ 'Approved Facts': 'Prizes: cash prizes', 'People & Roles': 'Trixie — sets up' }),
      bingoRow({ 'Event Time': '', 'End Time': '' }),
    ]);
    expect(await approveOverride(env.DB, admin, QUIZ, { text: QUIZ_PROMPT, reason: 'Facts added' }, NOW)).toEqual({ ok: true, version: 2 });

    const res = await socialContext(env.DB, { event_ids: [QUIZ, BINGO, 'RTD-EVT-09999'] }, NOW);
    expect(res).toEqual({
      mode: 'shadow',
      events: [
        {
          event_id: QUIZ,
          prompt: `${QUIZ_PROMPT}\n\n${SCHEDULE_RULE}`,
          prompt_version: 2,
          base_details: 'A family quiz night with prizes at stake!',
          approved_facts: 'Prizes: cash prizes',
          people_roles: 'Trixie — sets up',
          banned_phrases: 'open table',
          occurrence: {
            occurrence_id: QUIZ_OCC,
            date: '2026-10-23',
            label: 'Friday 23 October, 6:30pm',
            start_time: '18:30',
            end_time: '22:00',
            is_today: false,
            is_tomorrow: false,
          },
          sync_pending: false,
        },
        // No prompt yet, and no time: the label is the date alone.
        {
          event_id: BINGO,
          prompt: '',
          prompt_version: 0,
          base_details: 'Eyes down for a full house.',
          approved_facts: '',
          people_roles: '',
          banned_phrases: '',
          occurrence: { occurrence_id: BINGO_OCC, date: '2026-10-23', label: 'Friday 23 October', start_time: null, end_time: null, is_today: false, is_tomorrow: false },
          sync_pending: false,
        },
      ],
    });

    // Today and tomorrow are judged in London at the moment of asking.
    const layer = async (now: Date) => (await socialContext(env.DB, { event_ids: [QUIZ] }, now)) as { events: EventLayer[] };
    expect((await layer(new Date('2026-10-22T22:30:00Z'))).events[0]!.occurrence).toMatchObject({ is_today: false, is_tomorrow: true });
    // 00:30 on the 23rd in London is still the 22nd in UTC.
    expect((await layer(new Date('2026-10-22T23:30:00Z'))).events[0]!.occurrence).toMatchObject({ is_today: true, is_tomorrow: false });

    // Over HTTP, with the bearer token; a malformed body says what is wrong.
    const http = await post('/internal/social/context', { event_ids: [QUIZ] });
    expect(http.status).toBe(200);
    expect(await http.json()).toMatchObject({ mode: 'shadow', events: [{ event_id: QUIZ, prompt_version: 2 }] });
    for (const bad of [{}, { event_ids: 'RTD-EVT-00001' }, { event_ids: [] }, { event_ids: [7] }, { event_ids: [QUIZ], sheet_dates: 'x' }]) {
      const r = await post('/internal/social/context', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await r.json<{ error: string }>()).error).toBeTruthy();
    }
    expect((await post('/internal/social/context', 'not json {')).status).toBe(400);
  });

  it('records but always allows in Shadow', async () => {
    await setUp('shadow');
    const res = await runCheck(env.DB, checkBody({ text: REAL_QUIZ_CAPTION }), NOW);
    expect(res).toMatchObject({ allow: true, result: 'fail', mode: 'shadow' });
    expect(said(res, /cash/)).toBe(true);

    const ok = await post('/internal/social/check', checkBody());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ allow: true, result: 'pass', reasons: [], mode: 'shadow' });

    const rows = await checks();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      mode: 'shadow',
      kind: 'event_post',
      platform: 'facebook',
      text: REAL_QUIZ_CAPTION,
      result: 'fail',
      workflow: 'RTD Master V1',
      execution_id: 'exec-42',
    });
    expect(JSON.parse(rows[0]!.targets!)).toEqual([{ event_id: QUIZ, occurrence_id: QUIZ_OCC, prompt_version: 1 }]);
    expect(JSON.parse(rows[0]!.reasons!)).toEqual(failed(res).reasons);
    expect(rows[1]).toMatchObject({ result: 'pass', text: GOOD });
    expect(JSON.parse(rows[1]!.reasons!)).toEqual([]);
    expect(rows.map(r => r.check_id)).toEqual([expect.any(String), expect.any(String)]);
    expect(rows[0]!.check_id).not.toBe(rows[1]!.check_id);

    // The prompt version the post used is marked.
    const used = await env.DB.prepare('SELECT last_used_at FROM social_prompts WHERE event_id = ?1 AND version = 1').bind(QUIZ).first<{ last_used_at: string | null }>();
    expect(used!.last_used_at).toBeTruthy();

    // A malformed body is refused (400) in Shadow too, and nothing is recorded.
    expect((await post('/internal/social/check', { ...checkBody(), targets: [] })).status).toBe(400);
    expect(await checks()).toHaveLength(2);
  });

  it('holds a failing post in Enforce, and says why', async () => {
    await setUp('enforce');
    const res = await runCheck(env.DB, checkBody({ text: REAL_QUIZ_CAPTION }), NOW);
    expect(res).toMatchObject({ allow: false, result: 'fail', mode: 'enforce' });
    expect(said(res, /cash/)).toBe(true);
    expect(said(res, /drop in/)).toBe(true);

    expect(await runCheck(env.DB, checkBody(), NOW)).toEqual({ allow: true, result: 'pass', reasons: [], mode: 'enforce' });
    expect((await checks()).map(r => [r.mode, r.result])).toEqual([
      ['enforce', 'fail'],
      ['enforce', 'pass'],
    ]);

    // A body that can't be checked is never allowed: it is refused, with the reason.
    for (const bad of [
      'nonsense',
      checkBody({ kind: 'story' }),
      checkBody({ targets: [] }),
      checkBody({ targets: [{ event_id: QUIZ }] }),
      checkBody({ targets: [{ event_id: QUIZ, occurrence_id: QUIZ_OCC, prompt_version: '1' }] }),
      checkBody({ text: 42 }),
      checkBody({ image_text: 42 }),
      checkBody({ sheet_dates: [] }),
    ]) {
      const r = await runCheck(env.DB, bad, NOW);
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false, status: 400 });
      expect((r as { allow?: boolean }).allow).toBeUndefined();
    }
    const http = await post('/internal/social/check', checkBody({ targets: 'all' }));
    expect(http.status).toBe(400);
    expect((await http.json<{ error: string }>()).error).toMatch(/targets/);
    expect(await checks()).toHaveLength(2);
  });

  it('holds a post whose event was cancelled, went private, or changed facts since its prompt', async () => {
    await setUp('enforce');
    const held = async (words: RegExp, body = checkBody(), now = NOW) => {
      const res = await runCheck(env.DB, body, now);
      expect(res, JSON.stringify(res)).toMatchObject({ allow: false, result: 'fail' });
      expect(said(res, words), JSON.stringify(res)).toBe(true);
    };
    expect(await runCheck(env.DB, checkBody(), NOW)).toMatchObject({ allow: true, result: 'pass' });

    // Its date was cancelled.
    await env.DB.prepare("UPDATE occurrences SET status = 'cancelled' WHERE occurrence_id = ?1").bind(QUIZ_OCC).run();
    await held(/cancelled/);
    await env.DB.prepare("UPDATE occurrences SET status = 'scheduled' WHERE occurrence_id = ?1").bind(QUIZ_OCC).run();

    // The event went private; then just that date was hidden.
    await syncRows([quizRow({ 'App Visibility': 'Private' }), bingoRow()]);
    await held(/not public/);
    await syncRows([quizRow(), bingoRow()]);
    await env.DB.prepare("UPDATE occurrences SET visibility = 'hidden' WHERE occurrence_id = ?1").bind(QUIZ_OCC).run();
    await held(/not public/);
    await env.DB.prepare('UPDATE occurrences SET visibility = NULL WHERE occurrence_id = ?1').bind(QUIZ_OCC).run();

    // It stopped running.
    await syncRows([quizRow({ Status: 'Inactive' }), bingoRow()]);
    await held(/not running/);
    await syncRows([quizRow(), bingoRow()]);
    expect(await runCheck(env.DB, checkBody(), NOW)).toMatchObject({ allow: true, result: 'pass' });

    // A change is on its way to the Logic Engine.
    await env.DB.prepare(
      `INSERT INTO sheet_edits (edit_id, event_id, source, target, fields, requested_by, status, created_at, updated_at)
       VALUES ('RTD-SE-00001', ?1, 'event_index', 'live', '{}', 'dan@example.com', 'queued', ?2, ?2)`,
    )
      .bind(QUIZ, NOW.toISOString())
      .run();
    await held(/on its way to the Logic Engine/);
    await env.DB.prepare("UPDATE sheet_edits SET status = 'synced'").run();

    // The date has been and gone, or ended earlier today.
    await held(/already happened/, checkBody(), new Date('2026-10-24T10:00:00Z'));
    await held(/already happened/, checkBody(), new Date('2026-10-23T21:30:00Z'));

    // The occurrence isn't this event's, or doesn't exist.
    await held(/not a date of/, checkBody({ targets: [{ event_id: QUIZ, occurrence_id: BINGO_OCC, prompt_version: 1 }] }));
    await held(/not a date of/, checkBody({ targets: [{ event_id: QUIZ, occurrence_id: 'RTD-OCC-00001-20261030', prompt_version: 1 }] }));
    await held(/no event/i, checkBody({ targets: [{ event_id: 'RTD-EVT-09999', occurrence_id: QUIZ_OCC, prompt_version: 1 }] }));

    // No prompt at all; an older version than the current one.
    await held(/prompt missing/, checkBody({ targets: [{ event_id: BINGO, occurrence_id: BINGO_OCC, prompt_version: 0 }], text: 'Bingo is on Friday 23 October at 6:30pm.' }));
    expect(await approveOverride(env.DB, admin, QUIZ, { text: QUIZ_PROMPT, reason: 'Again' }, NOW)).toEqual({ ok: true, version: 2 });
    await held(/prompt version 1 isn't the current one \(2\)/);
    expect(await runCheck(env.DB, checkBody({ targets: [{ event_id: QUIZ, occurrence_id: QUIZ_OCC, prompt_version: 2 }] }), NOW)).toMatchObject({ allow: true });

    // The facts changed since its prompt was approved.
    await syncRows([quizRow({ 'Approved Facts': 'Prizes: cash prizes' }), bingoRow()]);
    await held(/prompt out of date/, checkBody({ targets: [{ event_id: QUIZ, occurrence_id: QUIZ_OCC, prompt_version: 2 }] }));
  });

  it('picks the next date still to come and public, never one the app only guessed', async () => {
    await setUp('shadow');
    // The week after: Friday 30 October, 18:30–22:00 (GMT by then).
    const NEXT = 'RTD-OCC-00001-20261030';
    await env.DB.prepare(
      `INSERT INTO occurrences (occurrence_id, event_id, event_date, start_time, end_time, starts_at, ends_at, status, created_at, updated_at)
       VALUES (?1, ?2, '2026-10-30', '18:30', '22:00', '2026-10-30T18:30:00.000Z', '2026-10-30T22:00:00.000Z', 'scheduled', ?3, ?3)`,
    )
      .bind(NEXT, QUIZ, NOW.toISOString())
      .run();
    const target = async (now = NOW) => ((await socialContext(env.DB, { event_ids: [QUIZ] }, now)) as { events: EventLayer[] }).events[0]!.occurrence;
    expect(await target()).toMatchObject({ occurrence_id: QUIZ_OCC, label: 'Friday 23 October, 6:30pm' });

    // 22:30 on the 23rd: that night's Quiz ended at 22:00, so the next one is the target.
    expect(await target(new Date('2026-10-23T21:30:00Z'))).toMatchObject({ occurrence_id: NEXT, date: '2026-10-30', is_today: false });
    // Still running at 21:30: tonight's is.
    expect(await target(new Date('2026-10-23T20:30:00Z'))).toMatchObject({ occurrence_id: QUIZ_OCC, is_today: true });

    // The 23rd hidden: the 30th is the target.
    await env.DB.prepare("UPDATE occurrences SET visibility = 'hidden' WHERE occurrence_id = ?1").bind(QUIZ_OCC).run();
    expect(await target()).toMatchObject({ occurrence_id: NEXT });
    await env.DB.prepare('UPDATE occurrences SET visibility = NULL WHERE occurrence_id = ?1').bind(QUIZ_OCC).run();

    // The 23rd only projected by the app (the Logic Engine hasn't reached it): not a target, and a post about it is held.
    await env.DB.prepare('UPDATE occurrences SET projected = 1 WHERE occurrence_id = ?1').bind(QUIZ_OCC).run();
    expect(await target()).toMatchObject({ occurrence_id: NEXT });
    const res = await runCheck(env.DB, checkBody(), NOW);
    expect(res).toMatchObject({ allow: true, result: 'fail' });
    expect(said(res, /date not in the app yet/)).toBe(true);
    // Nothing confirmed to come: no target.
    await env.DB.prepare('UPDATE occurrences SET projected = 1 WHERE occurrence_id = ?1').bind(NEXT).run();
    expect(await target()).toBeNull();
  });

  it('marks a prompt version as used only when it is the current one', async () => {
    await setUp('shadow');
    const used = async (version: number) =>
      (
        await env.DB.prepare('SELECT last_used_at FROM social_prompts WHERE event_id = ?1 AND version = ?2')
          .bind(QUIZ, version)
          .first<{ last_used_at: string | null }>()
      )!.last_used_at;
    expect(await approveOverride(env.DB, admin, QUIZ, { text: QUIZ_PROMPT, reason: 'Again' }, NOW)).toEqual({ ok: true, version: 2 });
    const v = (n: number) => checkBody({ targets: [{ event_id: QUIZ, occurrence_id: QUIZ_OCC, prompt_version: n }] });

    // An old version: allowed in Shadow, but not marked.
    expect(await runCheck(env.DB, v(1), NOW)).toMatchObject({ allow: true, result: 'fail' });
    expect(await used(1)).toBeNull();
    expect(await runCheck(env.DB, v(2), NOW)).toMatchObject({ allow: true, result: 'pass' });
    expect(await used(2)).toBe(NOW.toISOString());

    // The facts changed: version 2 is stale, and isn't marked again.
    await syncRows([quizRow({ 'Approved Facts': 'Prizes: cash prizes' }), bingoRow()]);
    const later = new Date(NOW.getTime() + 60_000);
    expect(await runCheck(env.DB, v(2), later)).toMatchObject({ allow: true, result: 'fail' });
    expect(await used(2)).toBe(NOW.toISOString());
  });

  it("holds while the sheet's date hasn't reached the app", async () => {
    await setUp('enforce');
    // The sheet has moved the Quiz to the 30th; the app's sync hasn't caught up.
    const moved = await socialContext(env.DB, { event_ids: [QUIZ], sheet_dates: { [QUIZ]: '30/10/2026' } }, NOW);
    expect((moved as { events: EventLayer[] }).events[0]).toMatchObject({ sync_pending: true, occurrence: { date: '2026-10-23' } });
    // The same date, written either way, isn't pending; neither is an event the sheet sent no date for.
    for (const date of ['23/10/2026', '2026-10-23']) {
      const same = await socialContext(env.DB, { event_ids: [QUIZ, BINGO], sheet_dates: { [QUIZ]: date } }, NOW);
      expect((same as { events: EventLayer[] }).events.map(e => e.sync_pending)).toEqual([false, false]);
    }
    // A date that can't be read can't be confirmed.
    const odd = await socialContext(env.DB, { event_ids: [QUIZ], sheet_dates: { [QUIZ]: 'Every Friday' } }, NOW);
    expect((odd as { events: EventLayer[] }).events[0]!.sync_pending).toBe(true);

    const res = await runCheck(env.DB, checkBody({ sheet_dates: { [QUIZ]: '30/10/2026' } }), NOW);
    expect(res).toMatchObject({ allow: false, result: 'fail' });
    expect(said(res, /date not in the app yet/)).toBe(true);
    expect(await runCheck(env.DB, checkBody({ sheet_dates: { [QUIZ]: '23/10/2026' } }), NOW)).toMatchObject({ allow: true, result: 'pass' });
  });

  it("checks the poster's wording too", async () => {
    await setUp('enforce');
    const res = await runCheck(env.DB, checkBody({ kind: 'poster', image_text: 'Quiz Night · Friday 23 October · 7:30pm' }), NOW);
    expect(res).toMatchObject({ allow: false, result: 'fail' });
    expect(said(res, /poster.*7:30pm/i)).toBe(true);
    expect(failed(res).reasons.every(r => /poster/i.test(r))).toBe(true);
    // The caption and the poster wording are recorded apart.
    const [row] = await checks();
    expect(row).toMatchObject({ kind: 'poster', text: GOOD, image_text: 'Quiz Night · Friday 23 October · 7:30pm' });
    expect(await checks()).toHaveLength(1);

    expect(await runCheck(env.DB, checkBody({ kind: 'poster', image_text: 'Quiz Night · Friday 23 October · 6:30pm' }), NOW)).toMatchObject({
      allow: true,
      result: 'pass',
    });
  });

  it("checks prices against the date's own price, else the event's App Price", async () => {
    await setUp('enforce', [quizRow({ 'App Price': '£2' }), bingoRow()]);
    const priced = (text: string) => runCheck(env.DB, checkBody({ text: `Quiz Night is on Friday 23 October at 6:30pm. It costs ${text}. #QuizNight` }), NOW);
    const two = await priced('£2');
    expect(two, JSON.stringify(two)).toMatchObject({ allow: true, result: 'pass' });
    expect(await priced('£3')).toMatchObject({ allow: false, result: 'fail' });

    // This date has its own price, as the public pages show it.
    await env.DB.prepare("UPDATE occurrences SET price_display = '£3' WHERE occurrence_id = ?1").bind(QUIZ_OCC).run();
    expect(await priced('£3')).toMatchObject({ allow: true, result: 'pass' });
    const old = await priced('£2');
    expect(old).toMatchObject({ allow: false, result: 'fail' });
    expect(said(old, /£2/)).toBe(true);
  });

  it('needs the bearer token', async () => {
    for (const path of ['/internal/social/context', '/internal/social/check']) {
      expect((await post(path, {}, { 'Content-Type': 'application/json' })).status, path).toBe(401);
    }
  });
});

describe('admin screens', () => {
  // Monday 19 October 2026, 11:00 in London. Dungeons & Dragons is on Friday 23 October.
  const NOW = new Date('2026-10-19T10:00:00Z');
  beforeEach(async () => {
    await freshDb();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(NOW.toISOString()),
      env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(NOW.toISOString()),
      env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(NOW.toISOString()),
    ]);
  });
  afterEach(() => vi.useRealTimers());

  const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
  const DAN = as('dan@example.com'); // admin
  const MICHELLE = as('michelle@example.com'); // approver
  const SAM = as('sam@example.com'); // host
  const AUTH = { Authorization: 'Bearer test-sync-token', 'Content-Type': 'application/json' };
  const DND = 'RTD-EVT-00007';
  const DND_OCC = 'RTD-OCC-00007-20261023';
  const FACTS = 'Booking: essential\nColour: red';
  const dndRow = (over: Record<string, unknown> = {}) =>
    indexRow(7, {
      'Event Name': 'Dungeons & Dragons',
      'Base Details': 'MoreThanABitDicey hosts her infamous DnD sessions!',
      'App Category': 'Gaming',
      'Approved Facts': FACTS,
      'People & Roles': 'MoreThanABitDicey — host',
      'Banned Phrases': 'open table\ndrop in',
      ...over,
    });
  const goodPrompt =
    'Write about Dungeons & Dragons, a hosted game at Roll The Dice in Cleethorpes. MoreThanABitDicey hosts her infamous DnD sessions. ' +
    'Booking is essential. Never describe it as open play or a drop-in, and never add other people, prizes or levels.';
  const reviewOutput = {
    status: 'review_required',
    master_prompt: goodPrompt,
    claims: [{ claim: 'Dungeons & Dragons', source_field: 'name' }],
    ambiguities: [],
    questions: ['Is it for beginners?'],
  };

  const get = (path: string, who: Partial<Env> = DAN) => request(path, {}, who);
  const send = (path: string, body: unknown, who: Partial<Env> = DAN) =>
    request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, who);
  const setUp = async () => {
    expect((await sync({ run_id: 'admin-1', sources: { event_index: [dndRow(), indexRow(2, { 'Event Name': 'Bingo' })] } })).status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM events WHERE event_id = ?1').bind(DND).first<Record<string, unknown>>();
    const res = await request(`/internal/social-prompts/${DND}`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ fingerprint: await fingerprint(sourceFields(row!)), job_id: 'exec-1', output: reviewOutput }),
    });
    expect(await res.json()).toMatchObject({ status: 'review_required', version: 1 });
  };
  const check = (text: string) => ({ kind: 'event_post', platform: 'facebook', targets: [{ event_id: DND, occurrence_id: DND_OCC, prompt_version: 1 }], text });

  type Overview = {
    mode: string;
    review: { event_id: string; name: string; status: string; version: number; questions: string[] }[];
    held: { check_id: string; event_ids: string[]; mode: string; reasons: string[]; created_at: string; text: string | null }[];
  };

  it('shows an admin the switch, items to review and held posts', async () => {
    await setUp();
    let overview = await (await get('/api/staff/social')).json<Overview>();
    expect(overview.mode).toBe('off');
    expect(overview.review).toEqual([
      { event_id: DND, name: 'Dungeons & Dragons', status: 'review_required', version: 1, questions: expect.arrayContaining(['Is it for beginners?']) },
    ]);
    expect(overview.held).toEqual([]);

    // The switch: only off, shadow or enforce, and every change is audited.
    expect((await send('/api/staff/social/mode', { mode: 'loud' })).status).toBe(400);
    const set = await send('/api/staff/social/mode', { mode: 'shadow' });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ mode: 'shadow' });
    expect(await socialMode(env.DB)).toBe('shadow');

    // A post that would have been held in Shadow, one held in Enforce, and one that passed.
    const shadowFail = await runCheck(env.DB, check('Dungeons & Dragons: just drop in on Saturday!'), NOW);
    expect(shadowFail).toMatchObject({ allow: true, result: 'fail' });
    expect((await send('/api/staff/social/mode', { mode: 'enforce' })).status).toBe(200);
    expect(await runCheck(env.DB, check('Dungeons & Dragons, with cash prizes.'), NOW)).toMatchObject({ allow: false, result: 'fail' });
    // A check from long ago whose text retention has cleared.
    await env.DB.prepare(
      "INSERT INTO social_checks (check_id, mode, kind, targets, text, result, reasons, created_at) VALUES ('RTD-SC-00099', 'shadow', 'event_post', ?1, NULL, 'fail', ?2, '2026-06-01T09:00:00Z')",
    )
      .bind(JSON.stringify([{ event_id: DND, occurrence_id: DND_OCC, prompt_version: 0 }]), JSON.stringify(['Dungeons & Dragons: prompt missing']))
      .run();
    await env.DB.prepare(
      "INSERT INTO social_checks (check_id, mode, kind, targets, text, result, reasons, created_at) VALUES ('RTD-SC-00098', 'enforce', 'event_post', ?1, 'Fine', 'pass', '[]', ?2)",
    )
      .bind(JSON.stringify([{ event_id: DND, occurrence_id: DND_OCC, prompt_version: 1 }]), NOW.toISOString())
      .run();

    overview = await (await get('/api/staff/social')).json<Overview>();
    expect(overview.mode).toBe('enforce');
    expect(overview.held.map(h => [h.mode, h.event_ids])).toEqual([
      ['enforce', [DND]],
      ['shadow', [DND]],
      ['shadow', [DND]],
    ]);
    expect(overview.held[0]!.reasons.some(r => /cash/.test(r))).toBe(true);
    expect(overview.held[0]!.text).toBe('Dungeons & Dragons, with cash prizes.');
    expect(overview.held[1]!.reasons.some(r => /drop in/.test(r))).toBe(true);
    expect(overview.held[2]).toMatchObject({ check_id: 'RTD-SC-00099', text: null, created_at: '2026-06-01T09:00:00Z' });

    // The event's own page: its facts as the café wrote them, the prompt, its history and recent checks.
    const page = await (await get(`/api/staff/events/${DND}/social`)).json<{
      facts: { key: string; value: string }[];
      people: { name: string; role: string }[];
      banned: string[];
      parse_errors: string[];
      prompt: { version: number; status: string; master_prompt: string | null; approved_by: string | null; validated_at: string | null; questions: string[]; errors: string[] } | null;
      history: { version: number; status: string }[];
      checks: { check_id: string; result: string; reasons: string[] }[];
    }>();
    expect(page.facts).toEqual([{ key: 'Booking', value: 'essential' }]);
    expect(page.people).toEqual([{ name: 'MoreThanABitDicey', role: 'host' }]);
    expect(page.banned).toEqual(['open table', 'drop in']);
    expect(page.parse_errors).toEqual([expect.stringMatching(/Colour/)]);
    expect(page.prompt).toMatchObject({ version: 1, status: 'review_required', master_prompt: goodPrompt, approved_by: null, questions: expect.arrayContaining(['Is it for beginners?']) });
    expect(page.history.map(h => [h.version, h.status])).toEqual([[1, 'review_required']]);
    expect(page.checks.map(c => c.result)).toEqual(['pass', 'fail', 'fail', 'fail']);
    expect((await get('/api/staff/events/RTD-EVT-09999/social')).status).toBe(404);

    // Regenerate: the event is due again on the builder's next run.
    expect((await send(`/api/staff/events/${DND}/social/regenerate`, {})).status).toBe(200);
    expect((await duePrompts(env.DB, NOW, 10)).map(d => d.event_id)).toContain(DND);
    expect((await send('/api/staff/events/RTD-EVT-09999/social/regenerate', {})).status).toBe(404);
  });

  it('refuses approvers and hosts', async () => {
    await setUp();
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/staff/social'],
      ['POST', '/api/staff/social/mode', { mode: 'shadow' }],
      ['GET', `/api/staff/events/${DND}/social`],
      ['POST', `/api/staff/events/${DND}/social/regenerate`, {}],
      ['POST', `/api/staff/events/${DND}/social/approve`, { text: goodPrompt, reason: 'Looks right' }],
    ];
    for (const [method, path, body] of routes) {
      const mich = method === 'GET' ? await get(path, MICHELLE) : await send(path, body, MICHELLE);
      expect(mich.status, `approver ${path}`).toBe(403);
      expect(await mich.json(), `approver ${path}`).toEqual({ error: 'Only admins can manage social prompts.' });
      const sam = method === 'GET' ? await get(path, SAM) : await send(path, body, SAM);
      expect(sam.status, `host ${path}`).toBe(403);
    }
    // Nothing changed.
    expect(await socialMode(env.DB)).toBe('off');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM social_prompts').first<{ n: number }>())!.n).toBe(1);
  });

  it('validates an admin override like a generated prompt, and records who approved it', async () => {
    await setUp();
    const approve = (body: unknown) => send(`/api/staff/events/${DND}/social/approve`, body);

    // A date, a time, a price that isn't the event's and another event's name are each refused, with the problems listed.
    const bad = await approve({ text: `${goodPrompt} Next one is Friday 23 October at 7pm, £5 a head, straight after Bingo.`, reason: 'Added the date' });
    expect(bad.status).toBe(400);
    const why = await bad.json<{ error: string; errors: string[] }>();
    expect(why.errors.length).toBeGreaterThanOrEqual(3);
    expect(why.errors.join(' ')).toMatch(/date|weekday/i);
    expect(why.errors.join(' ')).toMatch(/£5/);
    expect(why.errors.join(' ')).toMatch(/Bingo/);
    // A reason is needed, and it can't be an essay.
    expect((await approve({ text: goodPrompt })).status).toBe(400);
    expect((await approve({ text: goodPrompt, reason: '   ' })).status).toBe(400);
    expect((await approve({ text: goodPrompt, reason: 'x'.repeat(501) })).status).toBe(400);
    // A body far too big is refused before it is read.
    expect((await approve({ text: 'a'.repeat(70_000), reason: 'big' })).status).toBe(413);
    expect((await currentPrompt(env.DB, DND))).toBeNull();

    const ok = await approve({ text: goodPrompt, reason: 'Yes, beginners are welcome' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ version: 2 });

    const page = await (await get(`/api/staff/events/${DND}/social`)).json<{
      prompt: { version: number; status: string; master_prompt: string; approved_by: string; validated_at: string | null; override_reason: string | null };
      history: { version: number; status: string; approved_by: string | null; override_reason: string | null }[];
    }>();
    expect(page.prompt).toMatchObject({
      version: 2,
      status: 'approved',
      master_prompt: `${goodPrompt}\n\n${SCHEDULE_RULE}`,
      approved_by: 'dan@example.com',
      validated_at: NOW.toISOString(),
      override_reason: 'Yes, beginners are welcome',
    });
    expect(page.history.map(h => [h.version, h.status, h.approved_by])).toEqual([
      [2, 'approved', 'dan@example.com'],
      [1, 'review_required', null],
    ]);
    const audit = await env.DB.prepare("SELECT actor_id, new_value FROM audit_log WHERE action = 'social_prompt.overridden'").first<{ actor_id: string; new_value: string }>();
    expect(audit!.actor_id).toBe('dan@example.com');
    expect(JSON.parse(audit!.new_value)).toMatchObject({ version: 2, reason: 'Yes, beginners are welcome' });

    // Approved, it no longer needs review.
    expect((await (await get('/api/staff/social')).json<Overview>()).review).toEqual([]);
  });
});
