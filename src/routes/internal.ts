// Endpoints called only by n8n, authenticated with a bearer token held in an
// n8n credential and the INTERNAL_SYNC_TOKEN Worker secret.

import { Hono } from 'hono';
import { MAX_IMAGE_BYTES, imagePlan, parseImageSync, storeImage, syncImages } from '../images/store';
import { checkBearer } from '../lib/auth';
import { applySync, parsePayload } from '../sync/apply';

const MAX_BODY_BYTES = 1_000_000;

export const internalRoutes = new Hono<{ Bindings: Env }>();

// Refusals say what is wrong (never the token itself), so n8n's error shows the fix.
const REFUSALS = {
  not_configured: [503, 'The app has no INTERNAL_SYNC_TOKEN secret set (Cloudflare: Worker rtd-app → Settings → Variables and Secrets, type Secret)'],
  missing: [401, 'Missing Authorization header'],
  malformed: [401, "Authorization header must be 'Bearer <token>'"],
  mismatch: [401, 'Token does not match INTERNAL_SYNC_TOKEN'],
} as const;

internalRoutes.use('*', async (c, next) => {
  const result = await checkBearer(c.req.header('Authorization'), c.env.INTERNAL_SYNC_TOKEN);
  if (result !== 'ok') {
    const [status, error] = REFUSALS[result];
    return c.json({ error }, status);
  }
  await next();
});

/** Full snapshot of the Logic Engine tabs. Idempotent per run_id. */
internalRoutes.post('/sync/logic-engine', async c => {
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > MAX_BODY_BYTES) return c.json({ error: 'Body too large' }, 413);
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: 'Body too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const payload = parsePayload(body);
  if (typeof payload === 'string') return c.json({ error: payload }, 400);
  const result = await applySync(c.env.DB, payload);
  // 409 lets n8n's error branch see a rejected snapshot without treating it as a crash.
  return c.json(result, result.status === 'rejected' ? 409 : 200);
});

// --- Event photos (n8n "RTD Event Images"; see src/images/store.ts) ---

/** Events that want photos, with their Drive folder. */
internalRoutes.get('/images/plan', async c => c.json(await imagePlan(c.env.DB)));

/** The photos each event should have now; answers with the ones still to upload. */
internalRoutes.post('/images/sync', async c => {
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: 'Body too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const payload = parseImageSync(body);
  if (typeof payload === 'string') return c.json({ error: payload }, 400);
  const result = await syncImages(c.env.DB, c.env.IMAGES, payload, new Date().toISOString());
  return c.json(result, result.status === 'rejected' ? 409 : 200);
});

/** One photo's bytes (already resized by Google), for a file the sync asked for. */
internalRoutes.put('/images/:eventId/:sourceId', async c => {
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) return c.json({ error: `Image larger than ${MAX_IMAGE_BYTES} bytes` }, 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const result = await storeImage(c.env.DB, c.env.IMAGES, {
    eventId: c.req.param('eventId'),
    sourceId: c.req.param('sourceId'),
    bytes,
    runId: c.req.header('X-Run-Id')?.slice(0, 100) ?? null,
    now: new Date().toISOString(),
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ image_id: result.image_id, url: result.url });
});
