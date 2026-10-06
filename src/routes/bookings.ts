// Public booking API (/api/bookings), for open host sessions. No account: the
// customer's secret link (in their confirmation email) shows or cancels a
// booking. Never cached; changes must be same-origin JSON.

import { Hono } from 'hono';
import { availability, cancelByCustomer, createBooking, viewBooking } from '../bookings/bookings';
import { sameOriginJson } from '../lib/auth';

export const bookingRoutes = new Hono<{ Bindings: Env }>();

bookingRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
bookingRoutes.use('*', sameOriginJson);

const origin = (url: string) => new URL(url).origin;

/** Can this date be booked, and how many places are left? */
bookingRoutes.get('/availability/:occurrenceId', async c =>
  c.json(await availability(c.env.DB, c.req.param('occurrenceId'), new Date().toISOString())),
);

/** Book. Body: { occurrence_id, lead_name, email, mobile?, party_size, notes? } */
bookingRoutes.post('/', async c => {
  const result = await createBooking(c.env.DB, await c.req.json().catch(() => null), {
    now: new Date().toISOString(),
    ip: c.req.header('CF-Connecting-IP') ?? null,
    origin: origin(c.req.url),
  });
  if (!result.ok) return c.json({ error: result.error, errors: result.errors, availability: result.availability }, result.status);
  return c.json({ booking: result.booking, manage_path: result.manage_path, availability: result.availability }, 201);
});

/** The booking behind a Manage / Cancel link. Body: { token } (POST keeps the secret out of URLs and logs). */
bookingRoutes.post('/:id/view', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
  const booking = await viewBooking(c.env.DB, c.req.param('id'), body.token, new Date().toISOString());
  return booking ? c.json({ booking }) : c.json({ error: 'Booking not found. Check the link in your confirmation email.' }, 404);
});

bookingRoutes.post('/:id/cancel', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
  const result = await cancelByCustomer(c.env.DB, c.req.param('id'), body.token, { now: new Date().toISOString(), origin: origin(c.req.url) });
  return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status);
});
