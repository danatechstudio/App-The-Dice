// Public market API (/api/markets, docs/RTD_MARKETS.md): markets vendors can
// apply to, and applying. No account. Applications must be same-origin JSON;
// photos come in the same request, already resized by the page.

import { Hono } from 'hono';
import { afterResponse } from '../lib/background';
import { sameOriginJson } from '../lib/auth';
import { londonDate } from '../lib/time';
import { createApplication, getMarket, MAX_PHOTO_BYTES, MAX_PHOTOS, publicMarket, publicMarkets } from '../markets/markets';
import { marketApplicationToApprove, notifyApprovers } from '../notify/push';

export const marketRoutes = new Hono<{ Bindings: Env }>();

marketRoutes.use('*', sameOriginJson);

/** Three photos as base64, plus the rest of the form. */
const MAX_BODY = Math.ceil((MAX_PHOTOS * MAX_PHOTO_BYTES * 4) / 3) + 64 * 1024;

/** Markets still to come: dates, pitch fee, pitches left. Never who has applied. */
marketRoutes.get('/', async c => c.json({ markets: await publicMarkets(c.env.DB, londonDate(new Date())) }, 200, { 'Cache-Control': 'public, max-age=60' }));

marketRoutes.get('/:id', async c => {
  const market = await publicMarket(c.env.DB, c.req.param('id'), londonDate(new Date()));
  if (!market) return c.json({ error: 'No market with that ID.' }, 404, { 'Cache-Control': 'no-store' });
  return c.json({ market }, 200, { 'Cache-Control': 'public, max-age=60' });
});

/** Apply for a pitch. Body: the form, and photos: [{ data: base64 }] (up to 3). */
marketRoutes.post('/:id/apply', async c => {
  c.header('Cache-Control', 'no-store');
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_BODY) return c.json({ error: 'The photos are too big. Try fewer, or smaller ones.' }, 413);
  const now = new Date();
  const result = await createApplication(c.env.DB, c.env.IMAGES, c.req.param('id'), await c.req.json().catch(() => null), {
    now: now.toISOString(),
    ip: c.req.header('CF-Connecting-IP') ?? null,
    origin: new URL(c.req.url).origin,
  });
  if (!result.ok) return c.json({ error: result.error, errors: result.errors }, result.status);
  // A push to approvers' devices, as well as the email.
  const market = (await getMarket(c.env.DB, result.application.market_id))!;
  const message = marketApplicationToApprove({ ...result.application, market_name: market.name, event_date: market.event_date });
  await afterResponse(c, () => notifyApprovers(c.env.DB, message, { subject: new URL(c.req.url).origin, now }));
  return c.json({ application: result.application }, 201);
});
