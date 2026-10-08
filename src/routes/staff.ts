// Staff Control API (Phase 1: identity, sync health and audit history).

import { Hono } from 'hono';
import { upcomingBookedDates } from '../bookings/bookings';
import { cafeEventPlaces, setEventPlaces } from '../bookings/places';
import { decideSession, listHosts, listSessions, type SessionStatus } from '../host/sessions';
import { afterResponse } from '../lib/background';
import { requireRole, sameOriginJson, type AuthUser } from '../lib/auth';
import { drain, overview, parseReminder, sendReminder } from '../notify/alerts';
import { deviceLabel, myDevices, notifyUser, parseSubscription, removeSubscription, saveSubscription, vapidKeys } from '../notify/push';
import { londonDate } from '../lib/time';
import { applicationsForStaff, createMarket, decideApplication as decideVendor, markWithdrawn, marketsForStaff, parseMarketInput, readPhoto, updateMarket } from '../markets/markets';
import { decideApplication, listApplications, listApprovers, removeAccess, setApprover, type ApplicationStatus } from '../team/applications';

export const staffRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// no-store first so refusals (401/403) are never cached either.
staffRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
staffRoutes.use('*', sameOriginJson);
staffRoutes.use('*', requireRole('staff'));

staffRoutes.get('/me', c => c.json({ user: c.get('user') }));

staffRoutes.get('/sync-runs', async c => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT run_id, status, reason, rows_received, events_seen, events_changed, occurrences_created,
              occurrences_updated, warnings, received_at
       FROM sync_runs ORDER BY received_at DESC LIMIT 50`,
    )
    .all<Record<string, unknown>>();
  return c.json({
    sync_runs: results.map(r => ({ ...r, warnings: r.warnings ? JSON.parse(String(r.warnings)) : [] })),
  });
});

/** Audit history, newest first. ?entity_id= narrows to one event; ?before= pages by audit_id. */
staffRoutes.get('/audit', async c => {
  const entityId = c.req.query('entity_id') ?? null;
  const before = Number(c.req.query('before') ?? 0) || null;
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 200);
  const { results } = await c.env.DB
    .prepare(
      `SELECT audit_id, entity_type, entity_id, occurrence_id, actor_type, actor_id, action, previous_value,
              new_value, source, created_at
       FROM audit_log
       WHERE (?1 IS NULL OR entity_id = ?1) AND (?2 IS NULL OR audit_id < ?2)
       ORDER BY audit_id DESC LIMIT ?3`,
    )
    .bind(entityId, before, limit)
    .all();
  return c.json({ audit: results });
});

// --- Host sessions and hosts (the staff section of /organise) ---

const SESSION_STATUSES = ['submitted', 'approved', 'declined', 'withdrawn', 'published'];

/** Host sessions by status (default: waiting for a decision). */
staffRoutes.get('/host-sessions', async c => {
  const status = c.req.query('status') ?? 'submitted';
  if (!SESSION_STATUSES.includes(status)) return c.json({ error: `status must be one of ${SESSION_STATUSES.join(', ')}` }, 400);
  return c.json({ sessions: await listSessions(c.env.DB, { status: status as SessionStatus }) });
});

/** Approve or decline. Body: { decision: 'approve' | 'decline', note? } */
staffRoutes.post('/host-sessions/:id/decision', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: unknown };
  if (body.decision !== 'approve' && body.decision !== 'decline') return c.json({ error: "decision must be 'approve' or 'decline'" }, 400);
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  const result = await decideSession(c.env.DB, c.get('user'), c.req.param('id'), body.decision, note, new Date().toISOString());
  return result.ok ? c.json({ session: result.session }) : c.json({ error: result.error }, result.status);
});

/** The next three weeks: every hosted date, and every café event date people have booked, with contacts. */
staffRoutes.get('/booked-dates', async c => c.json({ dates: await upcomingBookedDates(c.env.DB, londonDate(new Date())) }));

/** Every café event people can book, with its places (docs/RTD_BOOKINGS.md#places). */
staffRoutes.get('/event-places', async c => c.json({ events: await cafeEventPlaces(c.env.DB, londonDate(new Date())) }));

/** Places on every date of a café event. Body: { places: number | null }; null goes back to the sheet's App Capacity. */
staffRoutes.post('/events/:id/places', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { places?: unknown };
  const now = new Date();
  const result = await setEventPlaces(c.env.DB, c.get('user'), c.req.param('id'), body.places, { now: now.toISOString(), today: londonDate(now) });
  return result.ok ? c.json({ capacity: result.capacity }) : c.json({ error: result.error, errors: result.errors }, result.status);
});

/** Hosts. Everyone joins through a join request; there's no adding people directly. */
staffRoutes.get('/hosts', async c => c.json({ hosts: await listHosts(c.env.DB) }));

// --- Onboarding: join requests, approvers, removing access (docs/RTD_ONBOARDING.md) ---

/** Join requests, for approvers and admins. */
staffRoutes.get('/applications', async c => {
  const status = c.req.query('status') ?? 'pending';
  if (!['pending', 'approved', 'declined', 'withdrawn'].includes(status)) return c.json({ error: 'Unknown status' }, 400);
  return c.json({ applications: await listApplications(c.env.DB, status as ApplicationStatus) });
});

/** Approve or decline a join request. Body: { decision: 'approve' | 'decline', note? } */
staffRoutes.post('/applications/:id/decision', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: unknown };
  if (body.decision !== 'approve' && body.decision !== 'decline') return c.json({ error: "decision must be 'approve' or 'decline'" }, 400);
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  const result = await decideApplication(c.env.DB, c.get('user'), c.req.param('id'), body.decision, note, new Date().toISOString());
  return result.ok ? c.json({ application: result.application }) : c.json({ error: result.error }, result.status);
});

/** Approvers and admins: admins only. */
staffRoutes.get('/approvers', async c => {
  if (c.get('user').role !== 'admin') return c.json({ error: 'Admins only' }, 403);
  return c.json({ approvers: await listApprovers(c.env.DB) });
});

/** Admins: make a host an approver, or back. Body: { approver: true | false } */
staffRoutes.post('/users/:id/approver', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { approver?: unknown };
  if (typeof body.approver !== 'boolean') return c.json({ error: 'approver must be true or false' }, 400);
  const result = await setApprover(c.env.DB, c.get('user'), c.req.param('id'), body.approver, new Date().toISOString());
  return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status);
});

/** Remove someone's access: approvers remove hosts, admins also remove approvers. */
staffRoutes.post('/users/:id/remove', async c => {
  const result = await removeAccess(c.env.DB, c.get('user'), c.req.param('id'), new Date().toISOString());
  return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status);
});

// --- Push notifications on this device (approvers and admins; docs/RTD_PUSH.md) ---

/** The app's public key, for the browser's pushManager.subscribe(). */
staffRoutes.get('/push/key', async c => c.json({ public_key: (await vapidKeys(c.env.DB)).publicKey }));

/** This person's devices with notifications on. */
staffRoutes.get('/push/devices', async c => c.json({ devices: await myDevices(c.env.DB, c.get('user').user_id) }));

/** Turn notifications on for this device. Body: the browser's PushSubscription as JSON. */
staffRoutes.post('/push/subscribe', async c => {
  const sub = parseSubscription(await c.req.json().catch(() => null));
  if (!sub) return c.json({ error: "That browser's notification details weren't valid." }, 400);
  await saveSubscription(c.env.DB, c.get('user').user_id, sub, deviceLabel(c.req.header('User-Agent')), new Date().toISOString());
  return c.json({ ok: true });
});

/** Turn them off for one device. Body: { endpoint } */
staffRoutes.post('/push/unsubscribe', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
  return c.json({ ok: true, removed: await removeSubscription(c.env.DB, c.get('user').user_id, body.endpoint) });
});

/** Send a test to this person's own devices. */
staffRoutes.post('/push/test', async c => {
  const result = await notifyUser(
    c.env.DB,
    c.get('user').user_id,
    { title: 'Notifications are on', body: "You'll get one like this whenever a session or a join request needs approving.", url: '/organise', tag: 'test' },
    { subject: new URL(c.req.url).origin, now: new Date() },
  );
  return c.json(result);
});

// --- Markets (docs/RTD_MARKETS.md): admins set them up; approvers decide on vendors ---

const adminsOnly = (user: AuthUser) => user.role === 'admin';

/** Markets from a month ago on, with how many applications are waiting and approved. */
staffRoutes.get('/markets', async c => c.json({ markets: await marketsForStaff(c.env.DB, londonDate(new Date())) }));

/** Admins: a new market. It reaches the Logic Engine (and the diary) within 15 minutes. */
staffRoutes.post('/markets', async c => {
  if (!adminsOnly(c.get('user'))) return c.json({ error: 'Only admins can set up markets.' }, 403);
  const parsed = parseMarketInput(await c.req.json().catch(() => null), londonDate(new Date()), { creating: true });
  if (!parsed.ok) return c.json({ error: 'Please check the form', errors: parsed.errors }, 400);
  return c.json({ market: await createMarket(c.env.DB, c.get('user'), parsed.value, new Date().toISOString()) }, 201);
});

/** Admins: change a market. Body: the same fields as creating one. */
staffRoutes.post('/markets/:id', async c => {
  if (!adminsOnly(c.get('user'))) return c.json({ error: 'Only admins can change markets.' }, 403);
  const parsed = parseMarketInput(await c.req.json().catch(() => null), londonDate(new Date()), { creating: false });
  if (!parsed.ok) return c.json({ error: 'Please check the form', errors: parsed.errors }, 400);
  const result = await updateMarket(c.env.DB, c.get('user'), c.req.param('id'), parsed.value, new Date().toISOString());
  return result.ok ? c.json({ market: result.market }) : c.json({ error: result.error, errors: result.errors }, result.status);
});

/** Vendor applications for markets from a fortnight ago on, with their photos' IDs. */
staffRoutes.get('/market-applications', async c => c.json({ applications: await applicationsForStaff(c.env.DB, londonDate(new Date())) }));

/** Approve (emails the payment details) or decline. Body: { decision: 'approve' | 'decline', note? } */
staffRoutes.post('/market-applications/:id/decision', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string; note?: unknown };
  if (body.decision !== 'approve' && body.decision !== 'decline') return c.json({ error: "decision must be 'approve' or 'decline'" }, 400);
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  const result = await decideVendor(c.env.DB, c.get('user'), c.req.param('id'), body.decision, note, new Date().toISOString());
  return result.ok ? c.json({ status: result.status }) : c.json({ error: result.error }, result.status);
});

/** A vendor dropped out: their pitch is free again. No email. */
staffRoutes.post('/market-applications/:id/withdraw', async c => {
  const result = await markWithdrawn(c.env.DB, c.get('user'), c.req.param('id'), new Date().toISOString());
  return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, result.status);
});

/** A vendor's photo: approvers and admins only, never cached or shared. */
staffRoutes.get('/market-photos/:photoId', async c => {
  const photo = await readPhoto(c.env.DB, c.env.IMAGES, c.req.param('photoId'));
  if (!photo) return c.json({ error: 'Not found' }, 404);
  return new Response(photo.body, {
    headers: {
      'Content-Type': photo.type,
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
});

// --- Event reminders to everyone with alerts on (admins only; docs/RTD_ALERTS.md) ---

/** Devices with alerts on, the latest reminders, and the public events of the next fortnight. */
staffRoutes.get('/reminders', async c => {
  if (!adminsOnly(c.get('user'))) return c.json({ error: 'Only admins can send reminders.' }, 403);
  return c.json(await overview(c.env.DB, new Date()));
});

/**
 * Send one. Body: { occurrence_id, title, body, social, confirm }. A reminder
 * about the same event in the last 24 hours comes back as 409 { warning } until
 * it's sent again with confirm: true.
 */
staffRoutes.post('/reminders', async c => {
  const parsed = parseReminder(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: 'Please check the reminder.', errors: parsed.errors }, 400);
  const now = new Date();
  const origin = new URL(c.req.url).origin;
  const result = await sendReminder(c.env.DB, c.get('user'), parsed.value, { now, origin });
  if (!result.ok) return 'warning' in result ? c.json({ warning: result.warning }, 409) : c.json({ error: result.error }, result.status);
  // The first devices now; the every-minute Cron Trigger sends the rest.
  await afterResponse(c, () => drain(c.env.DB, { subject: origin, now }));
  return c.json({ send: result.send }, 201);
});
