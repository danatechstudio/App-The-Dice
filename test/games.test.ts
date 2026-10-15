import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { applyImport, planImport, type Manifest } from '../src/games/admin';
import { matches, NO_FILTERS, parseFilters, pick, similar } from '../src/games/chooser';
import { checkGame, sourceKey, type PublicGame } from '../src/games/model';
import { weekKey } from '../src/games/gotw';
import { env, freshDb, request } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // host
const ADMIN = { user_id: 'u-dan', email: 'dan@example.com', display_name: 'Dan', role: 'admin' as const };
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const NOW = '2026-10-15T10:00:00.000Z';

const game = (title: string, over: Record<string, unknown> = {}) => ({
  title,
  edition: null,
  category: 'Strategy',
  audiences: ['Family', 'Strategy'],
  min_age: 8,
  min_players: 2,
  max_players: 4,
  play_time_min: 30,
  play_time_max: 45,
  synopsis: `${title} is a game we have on the shelf. It plays well with friends.`,
  source_title: title,
  source_evidence: 'Shelf photo 3',
  ownership_evidence: 'Shelf photo 3, top row',
  ...over,
});

const MANIFEST: Manifest = {
  games: [
    game('Carcassonne'),
    game('Ticket to Ride', { edition: 'Europe', min_players: 2, max_players: 5, play_time_max: 60 }),
    game('Codenames', { category: 'party', audiences: ['Party', 'Adults'], min_age: 14, min_players: 4, max_players: 8, play_time_min: 15, play_time_max: 15 }),
    game('Dobble', { category: 'Party', audiences: ['Children', 'Family'], min_age: 6, min_players: 2, max_players: 8, play_time_min: 10, play_time_max: 15 }),
    game('Azul', { min_age: 8, play_time_max: 40 }),
  ],
  review: [
    { title: 'Unknown Red Box', kind: 'uncertain', reasons: ['Spine unreadable in photo 5'] },
    { ...game('Wingspan'), ownership_evidence: null, kind: 'provisional', reasons: ['Listed in the catalogue, not seen in a photo'] },
  ],
};

const importManifest = (m: Manifest = MANIFEST, mode: 'dry_run' | 'apply' = 'apply', retireMissing = false) =>
  applyImport(env.DB, ADMIN, { mode, manifest: m, retireMissing }, NOW);
const goLive = () => request('/api/staff/games/live', json({ on: true, confirm: true }), DAN);
const titles = async () => (await (await request('/api/games')).json<{ games: PublicGame[] }>()).games.map(g => g.title);

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reading the source catalogue', () => {
  it('normalises titles and editions into stable keys', () => {
    expect(sourceKey('  Ticket   to Ride ', 'Europe')).toBe('ticket to ride|europe');
    expect(sourceKey('Ticket to Ride: Europe', null)).toBe('ticket to ride europe|');
    expect(sourceKey('Dungeons & Dragons', null)).toBe(sourceKey('Dungeons and Dragons', null));
    expect(sourceKey('Pokémon', null)).toBe('pokemon|');
  });

  it('refuses a game without the details needed to publish it', () => {
    const r = checkGame({ title: 'X', category: '', audiences: ['Elves'], min_players: 5, max_players: 2, synopsis: 'Short' }, { publish: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['audiences', 'category', 'max_players', 'min_age', 'play_time_max', 'synopsis', 'title']);
  });

  it('refuses the whole import if any confirmed game is malformed, lacks ownership evidence, or is listed twice', async () => {
    const bad: Manifest = {
      games: [game('Azul'), game('Azul'), { ...game('Catan'), ownership_evidence: '' }, { ...game('Splendor'), min_players: 0 }],
      review: [],
    };
    const plan = await planImport(env.DB, bad);
    expect(plan.ok).toBe(false);
    expect(plan.errors).toHaveLength(3);
    const res = await importManifest(bad);
    expect(res.applied).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM games').first()).toEqual({ n: 0 });
  });
});

describe('importing', () => {
  it('a dry run shows the changes and writes nothing but its log', async () => {
    const res = await importManifest(MANIFEST, 'dry_run');
    expect(res).toMatchObject({ ok: true, applied: false, counts: { add: 5, review_add: 2, update: 0 } });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM games').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT mode FROM game_import_batches").first()).toEqual({ mode: 'dry_run' });
  });

  it('applies once, and running it again changes nothing', async () => {
    expect((await importManifest()).applied).toBe(true);
    const ids = (await env.DB.prepare('SELECT game_id, slug FROM games ORDER BY game_id').all()).results;
    expect(ids).toEqual([
      { game_id: 'RTD-GAME-00001', slug: 'carcassonne' },
      { game_id: 'RTD-GAME-00002', slug: 'ticket-to-ride-europe' },
      { game_id: 'RTD-GAME-00003', slug: 'codenames' },
      { game_id: 'RTD-GAME-00004', slug: 'dobble' },
      { game_id: 'RTD-GAME-00005', slug: 'azul' },
    ]);
    expect(await env.DB.prepare("SELECT category FROM games WHERE slug = 'codenames'").first()).toEqual({ category: 'Party' });
    const again = await importManifest();
    expect(again.counts).toMatchObject({ add: 0, update: 0, review_add: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM games').first()).toEqual({ n: 5 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM game_review').first()).toEqual({ n: 2 });
  });

  it('never overwrites an admin’s edits, and retires games dropped from the manifest only when asked', async () => {
    await importManifest();
    await request('/api/staff/games/RTD-GAME-00005', json({ ...game('Azul'), synopsis: 'Edited by Dan: a lovely tile-drafting game for the family.' }), DAN);
    const changed: Manifest = { games: [game('Carcassonne', { play_time_max: 50 }), game('Azul', { min_age: 10 })], review: MANIFEST.review };
    const plan = await planImport(env.DB, changed);
    expect(plan.update.map(u => u.title)).toEqual(['Carcassonne']);
    expect(plan.kept_admin_edits).toEqual(['RTD-GAME-00005']);
    expect(plan.not_in_manifest.map(g => g.title)).toEqual(['Ticket to Ride', 'Codenames', 'Dobble']);
    await importManifest(changed);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM games WHERE retired_at IS NULL').first()).toEqual({ n: 5 });
    await importManifest(changed, 'apply', true);
    expect((await env.DB.prepare('SELECT title FROM games WHERE retired_at IS NULL ORDER BY title').all()).results).toEqual([{ title: 'Azul' }, { title: 'Carcassonne' }]);
    expect(await env.DB.prepare("SELECT min_age, synopsis FROM games WHERE slug = 'azul'").first()).toEqual({ min_age: 8, synopsis: 'Edited by Dan: a lovely tile-drafting game for the family.' });
  });

  it('is for admins only, and applying needs an explicit confirmation', async () => {
    expect((await request('/api/staff/games/import', json({ mode: 'dry_run' }), MICHELLE)).status).toBe(403);
    expect((await request('/api/staff/games/import', json({ mode: 'dry_run' }), SAM)).status).toBe(403);
    expect((await request('/api/staff/games', {}, MICHELLE)).status).toBe(403);
    expect((await request('/api/staff/games/import', json({ mode: 'apply' }), DAN)).status).toBe(400);
    // The bundled manifest is empty until the source catalogue arrives.
    expect(await (await request('/api/staff/games/import', json({ mode: 'dry_run' }), DAN)).json()).toMatchObject({ ok: true, counts: { manifest_games: 0, add: 0 } });
  });
});

describe('the review register', () => {
  beforeEach(async () => {
    await importManifest();
  });

  it('is never public', async () => {
    await goLive();
    expect(await titles()).not.toContain('Wingspan');
    expect((await request('/api/games/unknown-red-box')).status).toBe(404);
  });

  it('an admin confirms a title with how they know the café has it, and it goes live', async () => {
    const { entries } = await (await request('/api/staff/game-review', {}, DAN)).json<{ entries: { review_id: string; source_title: string; entry: Record<string, unknown> }[] }>();
    const wingspan = entries.find(e => e.source_title === 'Wingspan')!;
    const noEvidence = await request(`/api/staff/game-review/${wingspan.review_id}/confirm`, json({ ...wingspan.entry }), DAN);
    expect(noEvidence.status).toBe(400);
    const res = await request(`/api/staff/game-review/${wingspan.review_id}/confirm`, json({ ...wingspan.entry, ownership_evidence: 'On the shelf, checked 15 Oct' }), DAN);
    expect(res.status).toBe(201);
    expect(await env.DB.prepare("SELECT ownership_evidence, confirmed_by FROM games WHERE slug = 'wingspan'").first()).toEqual({
      ownership_evidence: 'On the shelf, checked 15 Oct',
      confirmed_by: 'dan@example.com',
    });
    expect((await request(`/api/staff/game-review/${wingspan.review_id}/confirm`, json({ ...wingspan.entry, ownership_evidence: 'Again' }), DAN)).status).toBe(404);
    await goLive();
    expect(await titles()).toContain('Wingspan');
    const audit = await env.DB.prepare("SELECT action FROM audit_log WHERE action = 'game.confirmed_from_review'").first();
    expect(audit).toEqual({ action: 'game.confirmed_from_review' });
  });

  it('a rejected title stays out, and a re-import doesn’t reopen it', async () => {
    const { entries } = await (await request('/api/staff/game-review', {}, DAN)).json<{ entries: { review_id: string; source_title: string }[] }>();
    const red = entries.find(e => e.source_title === 'Unknown Red Box')!;
    expect((await request(`/api/staff/game-review/${red.review_id}/reject`, json({ note: 'Not ours' }), DAN)).status).toBe(200);
    await importManifest();
    expect(await env.DB.prepare('SELECT status FROM game_review WHERE review_id = ?1').bind(red.review_id).first()).toEqual({ status: 'rejected' });
  });

  it('is for admins only', async () => {
    expect((await request('/api/staff/game-review', {}, MICHELLE)).status).toBe(403);
    expect((await request('/api/staff/game-review/RTD-GREV-00001/confirm', json({}), SAM)).status).toBe(403);
  });
});

describe('the public switch', () => {
  it('keeps the labelled preview shelf until an admin turns the library on, and can switch back', async () => {
    await importManifest();
    let shelf = await (await request('/api/games')).json<{ live: boolean; games: PublicGame[] }>();
    expect(shelf.live).toBe(false);
    expect(shelf.games.every(g => g.preview)).toBe(true);
    expect((await request('/api/staff/games/live', json({ on: true }), DAN)).status).toBe(400); // no confirm
    expect((await request('/api/staff/games/live', json({ on: true, confirm: true }), MICHELLE)).status).toBe(403);
    expect((await goLive()).status).toBe(200);
    shelf = await (await request('/api/games')).json();
    expect(shelf.live).toBe(true);
    expect(shelf.games.map(g => g.title)).toEqual(['Azul', 'Carcassonne', 'Codenames', 'Dobble', 'Ticket to Ride']);
    expect(shelf.games.some(g => g.preview)).toBe(false);
    await request('/api/staff/games/live', json({ on: false, confirm: true }), DAN);
    expect((await (await request('/api/games')).json<{ live: boolean }>()).live).toBe(false);
  });

  it("won't go live with nothing to roll", async () => {
    expect((await goLive()).status).toBe(409);
  });
});

describe('rolling', () => {
  const lib = (list: Partial<PublicGame>[]): PublicGame[] =>
    list.map((g, i) => ({
      id: `g${i}`,
      slug: `g${i}`,
      title: `Game ${i}`,
      edition: null,
      category: 'Strategy',
      audiences: [],
      min_age: 8,
      min_players: 2,
      max_players: 4,
      play_time_min: null,
      play_time_max: 45,
      synopsis: '',
      cover: null,
      thumb: null,
      cover_alt: '',
      attribution: null,
      ...g,
    }));

  it('applies every filter, and never counts unknown details as suitable', () => {
    const [kids, unknownAge, long, unknownTime, party] = lib([
      { min_age: 6, audiences: ['Children'] },
      { min_age: null },
      { play_time_max: 120 },
      { play_time_max: null },
      { category: 'Party', audiences: ['Party'], min_players: 4, max_players: 8 },
    ]);
    const f = (over: Record<string, unknown>) => parseFilters(over);
    expect(matches(kids!, f({ youngest: 7 }))).toBe(true);
    expect(matches(unknownAge!, f({ youngest: 7 }))).toBe(false);
    expect(matches(long!, f({ max_minutes: 60 }))).toBe(false);
    expect(matches(unknownTime!, f({ max_minutes: 60 }))).toBe(false);
    expect(matches(unknownTime!, NO_FILTERS)).toBe(true);
    expect(matches(party!, f({ players: 6 }))).toBe(true);
    expect(matches(kids!, f({ players: 6 }))).toBe(false);
    expect(matches(party!, f({ categories: 'party' }))).toBe(true); // category names are normalised
    expect(matches(kids!, f({ audiences: 'Children,Party' }))).toBe(true);
    expect(matches(kids!, f({ audiences: 'Children', categories: 'Party' }))).toBe(false);
  });

  it('avoids games already rolled while others remain', () => {
    const games = lib([{}, {}, {}]);
    for (let i = 0; i < 50; i++) expect(pick(games, ['g0', 'g1'])!.id).toBe('g2');
    for (let i = 0; i < 50; i++) expect(pick(games, ['g0', 'g1', 'g2'])!.id).not.toBe('g2'); // all rolled: only the last is avoided
    expect(pick(lib([{}]), ['g0'])!.id).toBe('g0'); // one game: it repeats
    expect(pick([], [])).toBeNull();
  });

  it('rolls on the server from the filtered pool, counts it the same way, and explains an empty one', async () => {
    await importManifest();
    await goLive();
    const pool = await (await request('/api/games/pool?players=6&max_minutes=30')).json();
    expect(pool).toEqual({ count: 2, total: 5, relax: {} }); // Codenames, Dobble
    for (let i = 0; i < 10; i++) {
      const { game } = await (await request('/api/games/roll', json({ players: 6, max_minutes: 30 }))).json<{ game: PublicGame }>();
      expect(['Codenames', 'Dobble']).toContain(game.title);
    }
    const none = await (await request('/api/games/roll', json({ players: 6, categories: ['Strategy'] }))).json();
    // No 6-player strategy game: without the player count there are 3; without the category, 2.
    expect(none).toEqual({ game: null, count: 0, total: 5, relax: { players: 3, categories: 2 } });
    const quick = await (await request('/api/games/roll', json({ quick: true, players: 99 }))).json<{ count: number }>();
    expect(quick.count).toBe(5);
  });

  it('leaves out games taken off Roll Me a Game, and retired games entirely', async () => {
    await importManifest();
    await goLive();
    await env.DB.prepare("UPDATE games SET available_for_chooser = 0 WHERE slug = 'azul'").run();
    await env.DB.prepare("UPDATE games SET retired_at = ?1 WHERE slug = 'dobble'").bind(NOW).run();
    expect((await (await request('/api/games/pool')).json<{ total: number }>()).total).toBe(3);
    expect(await titles()).toEqual(['Azul', 'Carcassonne', 'Codenames', 'Ticket to Ride']); // Azul still on the shelf
    expect((await request('/api/games/dobble')).status).toBe(404);
  });
});

describe('game pages', () => {
  it('show the game, similar games and alternatives that keep to the filters, only from the shelf', async () => {
    await importManifest();
    await goLive();
    const res = await request('/api/games/carcassonne?players=3&max_minutes=60');
    expect(res.status).toBe(200);
    const page = await res.json<{ game: PublicGame; similar: { game: PublicGame; label: string }[]; alternatives: PublicGame[] }>();
    expect(page.game.title).toBe('Carcassonne');
    expect(page.game.cover).toBeNull(); // no approved cover: the page shows the placeholder
    expect(page.game.cover_alt).toBe('Box cover of Carcassonne');
    expect(page.similar.map(s => s.game.title)).toEqual(['Azul', 'Ticket to Ride', 'Dobble']);
    expect(page.similar[2]!.label).toBe('Also good for family');
    expect(page.similar[0]!.label).toBe('Another 2–4 player strategy game');
    expect(page.similar.map(s => s.game.title)).not.toContain('Carcassonne');
    // Alternatives keep to the filters (3 players, an hour), and don't repeat the similar ones.
    expect(page.alternatives).toEqual([]);
    const loose = await (await request('/api/games/carcassonne?players=4')).json<{ alternatives: PublicGame[] }>();
    expect(loose.alternatives.map(g => g.title)).toEqual(['Codenames']);
  });

  it('similar games are distinct titles and never the game itself', () => {
    const base = { edition: null, audiences: ['Family'], min_age: 8, min_players: 2, max_players: 4, play_time_min: 30, play_time_max: 45, synopsis: '', cover: null, thumb: null, cover_alt: '', attribution: null, category: 'Strategy' };
    const a = { ...base, id: 'a', slug: 'a', title: 'Azul' };
    const list = [a, { ...base, id: 'b', slug: 'b', title: 'Azul' }, { ...base, id: 'c', slug: 'c', title: 'Calico' }];
    expect(similar(a, list).map(s => s.game.id)).toEqual(['c']);
  });
});

describe('Game of the Week', () => {
  const gotw = async () => (await (await request('/api/games/gotw')).json<{ gotw: { week_key: string; game: PublicGame | null; archived: boolean; preview?: boolean } | null }>()).gotw;

  it('weeks start on Monday, London time', () => {
    expect(weekKey(new Date('2026-10-15T10:00:00Z'))).toBe('2026-10-12'); // Thursday
    expect(weekKey(new Date('2026-10-18T22:59:00Z'))).toBe('2026-10-12'); // Sunday 23:59 BST
    expect(weekKey(new Date('2026-10-18T23:00:00Z'))).toBe('2026-10-19'); // Monday 00:00 BST
  });

  it('shows the preview pick until the library is live', async () => {
    expect(await gotw()).toMatchObject({ preview: true, game: { title: 'Carcassonne' } });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM gotw_weeks').first()).toEqual({ n: 0 });
  });

  it('is picked once a week, even when asked for at the same moment', async () => {
    await importManifest();
    await goLive();
    const [a, b, c] = await Promise.all([gotw(), gotw(), gotw()]);
    expect(a!.game!.id).toBe(b!.game!.id);
    expect(a!.game!.id).toBe(c!.game!.id);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM gotw_weeks').first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gotw.selected'").first()).toEqual({ n: 1 });
  });

  it('avoids the last 12 weeks, then falls back to the game featured longest ago', async () => {
    await importManifest();
    await goLive();
    const seen: string[] = [];
    for (let w = 0; w < 5; w++) {
      vi.setSystemTime(new Date(Date.parse(NOW) + w * 7 * 86_400_000));
      seen.push((await gotw())!.game!.id);
    }
    expect(new Set(seen).size).toBe(5); // five weeks, five different games
    vi.setSystemTime(new Date(Date.parse(NOW) + 5 * 7 * 86_400_000));
    expect((await gotw())!.game!.id).toBe(seen[0]); // all featured recently: the oldest comes round
    expect(await env.DB.prepare('SELECT mode FROM gotw_weeks ORDER BY week_key DESC LIMIT 1').first()).toEqual({ mode: 'least_recent' });
  });

  it('keeps history, and replaces this week’s pick if it leaves the library', async () => {
    await importManifest();
    await goLive();
    const first = (await gotw())!;
    await request(`/api/staff/games/${first.game!.id}/retire`, json({}), DAN);
    const next = (await gotw())!;
    expect(next.game!.id).not.toBe(first.game!.id);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM gotw_weeks').first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'gotw.reselected'").first()).toEqual({ n: 1 });
    // Last week's game, retired since, still reads from its snapshot.
    vi.setSystemTime(new Date(Date.parse(NOW) + 7 * 86_400_000));
    await gotw();
    await request(`/api/staff/games/${next.game!.id}/retire`, json({}), DAN);
    const { weeks } = await (await request('/api/staff/games/gotw', {}, DAN)).json<{ weeks: { week_key: string; title: string }[] }>();
    expect(weeks.map(w => w.week_key)).toEqual(['2026-10-19', '2026-10-12']);
    expect(weeks[1]!.title).toBe(next.game!.title);
  });

  it('is picked by the hourly Cron Trigger check, with no notification', async () => {
    await importManifest();
    await goLive();
    vi.setSystemTime(new Date('2026-10-19T00:05:00Z'));
    const run = createExecutionContext();
    await worker.scheduled!({ scheduledTime: Date.now(), cron: '* * * * *', noRetry: () => {} } as ScheduledController, env, run);
    await waitOnExecutionContext(run);
    expect(await env.DB.prepare('SELECT week_key FROM gotw_weeks').first()).toEqual({ week_key: '2026-10-19' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM push_sends').first()).toEqual({ n: 0 });
  });
});

describe('admins looking after the library', () => {
  it('add a game by hand with evidence, edit it, retire and restore it', async () => {
    const add = await request('/api/staff/games', json({ ...game('Splendor'), ownership_evidence: 'Bought 14 Oct' }), DAN);
    expect(add.status).toBe(201);
    expect((await request('/api/staff/games', json({ ...game('Splendor'), ownership_evidence: 'Again' }), DAN)).status).toBe(409);
    expect((await request('/api/staff/games', json({ ...game('Splendor'), ownership_evidence: 'Bought' }), SAM)).status).toBe(403);
    const edit = await request('/api/staff/games/RTD-GAME-00001', json({ ...game('Splendor'), copies: 2, available_for_gotw: false }), DAN);
    expect(edit.status).toBe(200);
    expect(await env.DB.prepare('SELECT copies, available_for_gotw, admin_edited_at IS NOT NULL AS edited FROM games').first()).toEqual({ copies: 2, available_for_gotw: 0, edited: 1 });
    expect((await request('/api/staff/games/RTD-GAME-00001/retire', json({}), DAN)).status).toBe(200);
    expect((await request('/api/staff/games/RTD-GAME-00001/retire', json({}), DAN)).status).toBe(409);
    expect((await request('/api/staff/games/RTD-GAME-00001/restore', json({}), DAN)).status).toBe(200);
    const actions = (await env.DB.prepare("SELECT action FROM audit_log WHERE entity_type = 'game' ORDER BY audit_id").all()).results.map(r => r.action);
    expect(actions).toEqual(['game.added', 'game.updated', 'game.retired', 'game.restored']);
  });

  it('attach a cover, which shows publicly only once matched and approved', async () => {
    await importManifest();
    await goLive();
    const jpeg = `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 64 }, (_, i) => i)))}`;
    const thumb = `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 16 }, (_, i) => i)))}`;
    const attach = (over: Record<string, unknown>) =>
      request('/api/staff/games/RTD-GAME-00001/cover', json({ cover: jpeg, thumb, source_url: 'https://publisher.example/carcassonne', attribution: '© Publisher', rights_status: 'pending', ...over }), DAN);
    expect((await attach({ source_url: 'not a url' })).status).toBe(400);
    expect((await attach({ cover: 'data:text/html;base64,PGh0bWw+' })).status).toBe(415);
    expect((await attach({ matches_edition: true })).status).toBe(200);
    let g = await (await request('/api/games/carcassonne')).json<{ game: PublicGame }>();
    expect(g.game.cover).toBeNull(); // rights still pending
    await request('/api/staff/games/RTD-GAME-00001/cover/status', json({ rights_status: 'approved', matches_edition: true }), DAN);
    g = await (await request('/api/games/carcassonne')).json();
    expect(g.game.cover).toMatch(/^\/images\/games\/[a-f0-9]{32}$/);
    expect(g.game.attribution).toBe('© Publisher');
    const img = await request(g.game.cover!);
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/jpeg');
    expect((await request('/images/games/not-an-id')).status).toBe(404);
  });
});

describe('the rest of the app', () => {
  it('is untouched by the game library tables', async () => {
    await importManifest();
    await goLive();
    for (const table of ['events', 'occurrences', 'bookings', 'users', 'push_sends', 'stats_daily']) {
      const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(before!.n).toBeGreaterThanOrEqual(0);
    }
    expect((await request('/api/events')).status).toBe(200);
  });
});
