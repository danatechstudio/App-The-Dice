// Counting page views and taps (/api/stats, docs/RTD_STATS.md). Anyone, no
// account; same-origin JSON only. Nothing about the person is kept.

import { Hono } from 'hono';
import { sameOriginJson } from '../lib/auth';
import { recordHits } from '../stats/stats';

export const statsRoutes = new Hono<{ Bindings: Env }>();

statsRoutes.use('*', sameOriginJson);

/** Body: { hits: [{ m: metric, e?: Event ID, s?: reminder }] }, up to 10. Always 204: a page never waits on it. */
statsRoutes.post('/', async c => {
  await recordHits(c.env.DB, await c.req.json().catch(() => null), {
    now: new Date(),
    ua: c.req.header('User-Agent'),
    // The café team and hosts (signed in to the organiser) aren't counted.
    signedIn: /(?:^|;\s*)CF_Authorization=/.test(c.req.header('Cookie') ?? ''),
    ip: c.req.header('CF-Connecting-IP') ?? null,
  });
  return c.body(null, 204, { 'Cache-Control': 'no-store' });
});
