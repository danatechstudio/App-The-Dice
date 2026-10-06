// Onboarding API (/api/join) for people who are signed in through Cloudflare
// Access but don't have access yet: ask to host games or join the café team,
// see where the request is, or withdraw it (docs/RTD_ONBOARDING.md).

import { Hono } from 'hono';
import { requireSignedIn, sameOriginJson } from '../lib/auth';
import { latestApplication, submitApplication, withdrawApplication } from '../team/applications';

export const joinRoutes = new Hono<{ Bindings: Env; Variables: { email: string } }>();

joinRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
joinRoutes.use('*', sameOriginJson);
joinRoutes.use('*', requireSignedIn);

joinRoutes.get('/me', async c => {
  const email = c.get('email');
  const user = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?1 AND active = 1').bind(email).first();
  return c.json({ email, has_access: !!user, application: await latestApplication(c.env.DB, email) });
});

joinRoutes.post('/apply', async c => {
  const result = await submitApplication(c.env.DB, c.get('email'), await c.req.json().catch(() => null), new Date().toISOString());
  if (!result.ok) return c.json({ error: result.error, errors: result.errors }, result.status);
  return c.json({ application: result.application }, 201);
});

joinRoutes.post('/withdraw', async c => {
  const done = await withdrawApplication(c.env.DB, c.get('email'), new Date().toISOString());
  return done ? c.json({ ok: true }) : c.json({ error: 'There is no request waiting to withdraw.' }, 409);
});
