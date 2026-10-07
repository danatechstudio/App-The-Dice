// Host organiser API (/api/host). Signed in through Cloudflare Access; the
// users table decides who is a host. Staff and admins can host too.

import { Hono } from 'hono';
import { cancelDate, datesForSessions } from '../bookings/bookings';
import { setDatePlaces, setSessionPlaces } from '../bookings/places';
import { createSession, deleteSession, listSessions, parseSessionInput, resubmitSession, withdrawSession } from '../host/sessions';
import { requireRole, sameOriginJson, type AuthUser } from '../lib/auth';
import { afterResponse } from '../lib/background';
import { notifyApprovers, sessionToApprove } from '../notify/push';
import { londonDate } from '../lib/time';

export const hostRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

hostRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
hostRoutes.use('*', sameOriginJson);
hostRoutes.use('*', requireRole('host', 'staff'));

hostRoutes.get('/me', c => {
  const user = c.get('user');
  return c.json({ user, can_review: user.role === 'staff' || user.role === 'admin', is_admin: user.role === 'admin' });
});

/** My sessions; live ones carry their upcoming dates, with who's booked (names and party sizes). */
hostRoutes.get('/sessions', async c => {
  const sessions = await listSessions(c.env.DB, { hostUserId: c.get('user').user_id });
  const live = sessions.filter(s => s.status === 'published').map(s => s.session_id);
  const dates = await datesForSessions(c.env.DB, live, londonDate(new Date()));
  return c.json({ sessions: sessions.map(s => ({ ...s, dates: dates.filter(d => d.host_session_id === s.session_id) })) });
});

hostRoutes.post('/sessions', async c => {
  const parsed = parseSessionInput(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: 'Please check the form', errors: parsed.errors }, 400);
  const user = c.get('user');
  const session = await createSession(c.env.DB, user, parsed.value, new Date().toISOString());
  // A push to the approvers' devices (not the person who sent it), as well as the email n8n sends.
  const ctx = { subject: new URL(c.req.url).origin, now: new Date(), exceptUserId: user.user_id };
  await afterResponse(c, () => notifyApprovers(c.env.DB, sessionToApprove(session as unknown as Parameters<typeof sessionToApprove>[0]), ctx));
  return c.json({ session }, 201);
});

/** Edit a declined or withdrawn session and send it to the café again. Body: the same fields as creating one. */
hostRoutes.post('/sessions/:id/resubmit', async c => {
  const parsed = parseSessionInput(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: 'Please check the form', errors: parsed.errors }, 400);
  const user = c.get('user');
  const result = await resubmitSession(c.env.DB, user, c.req.param('id'), parsed.value, new Date().toISOString());
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const ctx = { subject: new URL(c.req.url).origin, now: new Date(), exceptUserId: user.user_id };
  await afterResponse(c, () => notifyApprovers(c.env.DB, sessionToApprove(result.session as unknown as Parameters<typeof sessionToApprove>[0]), ctx));
  return c.json({ session: result.session });
});

/** Remove a declined or withdrawn session from the host's list (kept for the record). */
hostRoutes.post('/sessions/:id/delete', async c => {
  const result = await deleteSession(c.env.DB, c.get('user'), c.req.param('id'), new Date().toISOString());
  return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status);
});

hostRoutes.post('/sessions/:id/withdraw', async c => {
  const result = await withdrawSession(c.env.DB, c.get('user'), c.req.param('id'), new Date().toISOString());
  return result.ok ? c.json({ session: result.session }) : c.json({ error: result.error }, result.status);
});

/**
 * Cancel one date: the host of the session, or an approver. Everyone booked is
 * emailed, and the café (or the host) is told. Body: { message? } for the people booked.
 */
hostRoutes.post('/occurrences/:id/cancel', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { message?: unknown };
  const result = await cancelDate(c.env.DB, c.get('user'), c.req.param('id'), body.message, {
    now: new Date().toISOString(),
    origin: new URL(c.req.url).origin,
  });
  return result.ok ? c.json({ ok: true, cancelled_bookings: result.cancelled_bookings }) : c.json({ error: result.error }, result.status);
});

/** Places on every date of the host's own live session. Body: { places }. */
hostRoutes.post('/sessions/:id/places', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { places?: unknown };
  const now = new Date();
  const result = await setSessionPlaces(c.env.DB, c.get('user'), c.req.param('id'), body.places, { now: now.toISOString(), today: londonDate(now) });
  return result.ok ? c.json({ places: result.places }) : c.json({ error: result.error, errors: result.errors }, result.status);
});

/**
 * Places on one date: the host of the session, or an approver for any date.
 * Body: { places: number | null }; null makes it the same as the other dates.
 */
hostRoutes.post('/occurrences/:id/places', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { places?: unknown };
  const result = await setDatePlaces(c.env.DB, c.get('user'), c.req.param('id'), body.places, { now: new Date().toISOString() });
  return result.ok ? c.json({ capacity: result.capacity }) : c.json({ error: result.error, errors: result.errors }, result.status);
});
