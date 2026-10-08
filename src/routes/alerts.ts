// Event alerts (/api/alerts, docs/RTD_ALERTS.md): anyone turns them on or off
// for their own device, with no account. Same-origin JSON only. A device is
// known by its push address, which only that browser holds.

import { Hono } from 'hono';
import { sameOriginJson } from '../lib/auth';
import { isOn, renew, turnOff, turnOn } from '../notify/alerts';
import { vapidKeys } from '../notify/push';

export const alertRoutes = new Hono<{ Bindings: Env }>();

alertRoutes.use('*', sameOriginJson);
alertRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);

/** The app's public key, for the browser's pushManager.subscribe(). */
alertRoutes.get('/key', async c => c.json({ public_key: (await vapidKeys(c.env.DB)).publicKey }));

/** Turn alerts on for this device. Body: the browser's PushSubscription as JSON. */
alertRoutes.post('/subscribe', async c => {
  const result = await turnOn(c.env.DB, await body(c), {
    ua: c.req.header('User-Agent'),
    ip: c.req.header('CF-Connecting-IP') ?? null,
    now: new Date(),
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ on: true });
});

/** Turn them off. Body: { endpoint } */
alertRoutes.post('/unsubscribe', async c => {
  await turnOff(c.env.DB, await body(c));
  return c.json({ on: false });
});

/** Are they on for this device? Body: { endpoint } (a POST, so the address never lands in a log). */
alertRoutes.post('/status', async c => c.json({ on: await isOn(c.env.DB, await body(c)) }));

/** The service worker's: the browser replaced the subscription. Body: { old_endpoint, subscription } */
alertRoutes.post('/renew', async c => c.json({ renewed: await renew(c.env.DB, await body(c), { ua: c.req.header('User-Agent'), now: new Date() }) }));
