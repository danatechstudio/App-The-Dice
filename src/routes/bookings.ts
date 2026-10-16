// Public booking API (/api/bookings), for open host sessions. No account: the
// customer's secret link (in their confirmation email) shows or cancels a
// booking. Never cached; changes must be same-origin JSON.

import { Hono } from 'hono';
import { availability, cancelByCustomer, createBooking, viewBooking } from '../bookings/bookings';
import { addDevice, deviceOn, removeDevice, renewDevice } from '../bookings/devices';
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

/**
 * The booking behind a Manage / Cancel link. Body: { token, endpoint? } (POST keeps the
 * secret out of URLs and logs). endpoint: this browser's push address, to say whether
 * this device is set to be told if the date changes.
 */
bookingRoutes.post('/:id/view', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: unknown; endpoint?: unknown };
  const booking = await viewBooking(c.env.DB, c.req.param('id'), body.token, new Date().toISOString());
  if (!booking) return c.json({ error: 'Booking not found. Check the link in your confirmation email.' }, 404);
  return c.json({ booking: { ...booking, this_device: await deviceOn(c.env.DB, booking.booking_id, body.endpoint) } });
});

/** Tell this device if the date is cancelled or moved. Body: { token, subscription } (src/bookings/devices.ts). */
bookingRoutes.post('/:id/device', async c => {
  const result = await addDevice(c.env.DB, c.req.param('id'), await c.req.json().catch(() => null), {
    now: new Date().toISOString(),
    ua: c.req.header('User-Agent'),
  });
  return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status);
});

/** Stop telling this device. Body: { token, endpoint }. */
bookingRoutes.post('/:id/device/remove', async c => {
  const result = await removeDevice(c.env.DB, c.req.param('id'), await c.req.json().catch(() => null));
  return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status);
});

/** The service worker: the browser renewed its push subscription. Body: { old_endpoint, subscription }. */
bookingRoutes.post('/devices/renew', async c => c.json({ ok: await renewDevice(c.env.DB, await c.req.json().catch(() => null)) }));

bookingRoutes.post('/:id/cancel', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
  const result = await cancelByCustomer(c.env.DB, c.req.param('id'), body.token, { now: new Date().toISOString(), origin: origin(c.req.url) });
  return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status);
});
