// Host organiser API (/api/host). Signed in through Cloudflare Access; the
// users table decides who is a host. Staff and admins can host too.

import { Hono } from 'hono';
import { createSession, listSessions, parseSessionInput, withdrawSession } from '../host/sessions';
import { requireRole, sameOriginJson, type AuthUser } from '../lib/auth';

export const hostRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

hostRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
hostRoutes.use('*', sameOriginJson);
hostRoutes.use('*', requireRole('host', 'staff'));

hostRoutes.get('/me', c => {
  const user = c.get('user');
  return c.json({ user, can_review: user.role === 'staff' || user.role === 'admin' });
});

hostRoutes.get('/sessions', async c => c.json({ sessions: await listSessions(c.env.DB, { hostUserId: c.get('user').user_id }) }));

hostRoutes.post('/sessions', async c => {
  const parsed = parseSessionInput(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: 'Please check the form', errors: parsed.errors }, 400);
  const session = await createSession(c.env.DB, c.get('user'), parsed.value, new Date().toISOString());
  return c.json({ session }, 201);
});

hostRoutes.post('/sessions/:id/withdraw', async c => {
  const result = await withdrawSession(c.env.DB, c.get('user'), c.req.param('id'), new Date().toISOString());
  return result.ok ? c.json({ session: result.session }) : c.json({ error: result.error }, result.status);
});
