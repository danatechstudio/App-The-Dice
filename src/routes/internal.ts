// Endpoints called only by n8n, authenticated with a bearer token held in an
// n8n credential and the INTERNAL_SYNC_TOKEN Worker secret.

import { Hono } from 'hono';
import { bearerMatches } from '../lib/auth';
import { applySync, parsePayload } from '../sync/apply';

const MAX_BODY_BYTES = 1_000_000;

export const internalRoutes = new Hono<{ Bindings: Env }>();

internalRoutes.use('*', async (c, next) => {
  if (!(await bearerMatches(c.req.header('Authorization'), c.env.INTERNAL_SYNC_TOKEN))) {
    return c.json({ error: 'Unauthorised' }, 401);
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
