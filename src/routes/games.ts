// Public game library API (/api/games, docs/GAME_LIBRARY_AUDIT.md). The
// café's confirmed games once the library is live, the preview shelf until
// then; never the review register. The roll happens here, with the same rules
// that count the games in the running.

import { Hono } from 'hono';
import { sameOriginJson } from '../lib/auth';
import { alternatives, hasFilters, parseFilters, pick, pool, relax, similar } from '../games/chooser';
import { facets, library, publicOnly } from '../games/catalogue';
import { currentGotw } from '../games/gotw';

export const gameRoutes = new Hono<{ Bindings: Env }>();

gameRoutes.use('*', sameOriginJson);

const CACHE = { 'Cache-Control': 'public, max-age=60' };

/** The shelf: every game, plus the categories and audiences to filter by. */
gameRoutes.get('/', async c => {
  const { live, games } = await library(c.env.DB);
  return c.json({ live, games: games.map(publicOnly), ...facets(games.filter(g => g.chooser)) }, 200, CACHE);
});

/** How many games are in the running for these filters, and, if none, which filter to loosen. */
gameRoutes.get('/pool', async c => {
  const { games } = await library(c.env.DB);
  const chooser = games.filter(g => g.chooser);
  const f = parseFilters(c.req.query());
  const count = pool(chooser, f).length;
  return c.json({ count, total: chooser.length, relax: count ? {} : relax(chooser, f) }, 200, CACHE);
});

/** Roll. Body: the filters, and `recent`: game IDs already rolled this visit (avoided while others remain). */
gameRoutes.post('/roll', async c => {
  c.header('Cache-Control', 'no-store');
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const { games } = await library(c.env.DB);
  const chooser = games.filter(g => g.chooser);
  const f = body.quick === true ? parseFilters({}) : parseFilters(body);
  const candidates = pool(chooser, f);
  const recent = Array.isArray(body.recent) ? body.recent.filter((x): x is string => typeof x === 'string').slice(-50) : [];
  const game = pick(candidates, recent);
  return c.json({ game: game ? publicOnly(game) : null, count: candidates.length, total: chooser.length, relax: game ? {} : relax(chooser, f) });
});

/** This week's Game of the Week (picked on the first request of the week). */
gameRoutes.get('/gotw', async c => c.json({ gotw: await currentGotw(c.env.DB, new Date()) }, 200, CACHE));

/** One game, with similar games and (given the filters rolled with) alternatives that still fit them. */
gameRoutes.get('/:slug', async c => {
  const { games } = await library(c.env.DB);
  const game = games.find(g => g.slug === c.req.param('slug'));
  if (!game) return c.json({ error: 'That game isn’t on our shelf.' }, 404, { 'Cache-Control': 'no-store' });
  const f = parseFilters(c.req.query());
  const shelf = games.filter(g => g.chooser || g.id === game.id);
  const like = similar(game, shelf.filter(g => g.id !== game.id));
  const others = hasFilters(f) ? alternatives(game, shelf, f, like.map(s => s.game.id)) : [];
  return c.json(
    {
      game: publicOnly(game),
      similar: like.map(s => ({ game: publicOnly(s.game), label: s.label })),
      alternatives: others.map(publicOnly),
    },
    200,
    CACHE,
  );
});
