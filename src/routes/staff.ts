// Staff Control API (Phase 1: identity, sync health and audit history).

import { Hono, type Context } from 'hono';
import { attentionOverview, resolveItem, setAttention } from '../attention/attention';
import { emailOverview, sendTest, setEmailSettings } from '../attention/reminders';
import { upcomingBookedDates } from '../bookings/bookings';
import { cafeEventPlaces, setBookingMode, setEventPlaces } from '../bookings/places';
import { adminOnly, eventForm, listAllEvents, saveEvent, stopEvent } from '../events/admin';
import { editDate, listDates } from '../events/dates';
import { requestEdit, resolveEdit, setSheetMode, sheetEvents, sheetSyncOverview, type SheetEdit } from '../sync/edits';
import { decideChange, listChanges } from '../host/changes';
import { deliveryOverview } from '../notify/delivery';
import { retryNow } from '../notify/outbox';
import { decideSession, listHosts, listSessions, type SessionStatus } from '../host/sessions';
import { afterResponse } from '../lib/background';
import { triggerN8n, waiter } from '../n8n/trigger';
import { requireRole, sameOriginJson, type AuthUser } from '../lib/auth';
import { staffSummary } from '../staff/summary';
import { approve as approvePrompt, eventSocial, regenerate as regeneratePrompt, setMode as setSocialMode, socialOverview } from '../social/admin';
import { drain, overview, parseReminder, sendReminder } from '../notify/alerts';
import { PERIODS, statsOverview, type Period } from '../stats/stats';
import { adminLibrary, applyImport, attachCover, confirmReview, confirmReviews, createGame, rejectReview, removeCover, reviewList, setCoverStatus, setLive, setRetired, updateGame } from '../games/admin';
import { gotwHistory } from '../games/gotw';
import { deviceLabel, myDevices, notifyUser, parseSubscription, removeSubscription, saveSubscription, vapidKeys } from '../notify/push';
import { londonDate } from '../lib/time';
import { adminMenu, setMenuStatus } from '../menu/menu';
import { applicationsForStaff, createMarket, decideApplication as decideVendor, markWithdrawn, marketsForStaff, parseMarketInput, readPhoto, updateMarket } from '../markets/markets';
import { decideApplication, listApplications, listApprovers, removeAccess, setApprover, type ApplicationStatus } from '../team/applications';

export const staffRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

/** A change waiting for the sheet: ask RTD Sheet Writer to run now (the 5-minute schedule stays). */
function wakeSheetWriter(c: Context<{ Bindings: Env; Variables: { user: AuthUser } }>, edit: SheetEdit | null | undefined) {
  if (edit?.status !== 'queued') return Promise.resolve();
  return triggerN8n(c.env, waiter(c), 'sheet-writer', { reason: 'edit_queued', event_id: edit.event_id });
}

// no-store first so refusals (401/403) are never cached either.
staffRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
staffRoutes.use('*', sameOriginJson);
staffRoutes.use('*', requireRole('staff'));

staffRoutes.get('/me', c => c.json({ user: c.get('user') }));

/** What's waiting in each organiser section, for the hub's cards (src/staff/summary.ts). Read only. */
staffRoutes.get('/summary', async c => c.json(await staffSummary(c.env.DB, c.get('user'), new Date()), 200, { 'Cache-Control': 'no-store' }));

// --- Needs attention (src/attention/attention.ts): approvers and admins ---

/** Open items, what was sorted in the last 30 days, dates with no end time, and the emails. Brings the list up to date first. */
staffRoutes.get('/attention', async c => {
  const now = new Date();
  const base = await attentionOverview(c.env.DB, now);
  if (!base.enabled) return c.json(base);
  return c.json({ ...base, emails: await emailOverview(c.env.DB, base.open.map(i => i.item_id), now) });
});

/** Body: { action: 'renew' | 'archive' | 'complete' | 'dismiss', date? (renew), note? } */
staffRoutes.post('/attention/:id/resolve', async c => {
  const res = await resolveItem(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), new Date(), new URL(c.req.url).origin);
  return res.ok ? c.json({ item: res.item }) : c.json({ error: res.error, errors: res.errors }, res.status);
});

/** How emails and booking pushes have gone: the last 7 days, and each failing or given up on (src/notify/delivery.ts). */
staffRoutes.get('/delivery', async c => c.json(await deliveryOverview(c.env.DB, new Date())));

/** Try a failing or given-up email again now. */
staffRoutes.post('/outbox/:id/retry', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1 || !(await retryNow(c.env.DB, id, new Date().toISOString()))) {
    return c.json({ error: "That email can't be tried again: it has gone, or it hasn't failed." }, 409);
  }
  return c.json({ ok: true });
});

/** Admins: who gets the emails, and on or off. Body: { to?: 'a@x, b@y', on?: boolean } */
staffRoutes.post('/attention/emails', async c => {
  const res = await setEmailSettings(c.env.DB, c.get('user'), await c.req.json().catch(() => null), new Date());
  return res.ok ? c.json({ on: res.on, to: res.to }) : c.json({ error: res.error, errors: res.errors }, res.status);
});

/** Admins: a test email to every address. */
staffRoutes.post('/attention/emails/test', async c => {
  const res = await sendTest(c.env.DB, c.get('user'), new Date(), new URL(c.req.url).origin);
  return res.ok ? c.json({ to: res.to }) : c.json({ error: res.error }, res.status);
});

/** Admins: switch Needs attention on or off. Body: { on: boolean } */
staffRoutes.post('/attention/switch', async c => {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { on?: unknown };
  if (typeof body.on !== 'boolean') return c.json({ error: 'Send { on: true|false }.' }, 400);
  const res = await setAttention(c.env.DB, c.get('user'), body.on, new Date());
  return res.ok ? c.json({ enabled: res.enabled }) : c.json({ error: res.error }, res.status);
});

// --- Changing events in the Logic Engine from the app (src/sync/edits.ts): admins ---

/** Where edits go (off, staging, shadow, live), the latest changes and the last sync. */
staffRoutes.get('/sheet-sync', async c => {
  const res = await sheetSyncOverview(c.env.DB, c.get('user'));
  return res.ok ? c.json(res) : c.json({ error: res.error }, res.status);
});

/** Body: { mode: 'off' | 'staging' | 'shadow' | 'live' } */
staffRoutes.post('/sheet-sync/mode', async c => {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { mode?: unknown };
  const res = await setSheetMode(c.env.DB, c.get('user'), body.mode, new Date());
  return res.ok ? c.json({ mode: res.mode }) : c.json({ error: res.error }, res.status);
});

/** The café's events with their Logic Engine columns, as the last sync read them. */
staffRoutes.get('/sheet-events', async c => {
  const res = await sheetEvents(c.env.DB, c.get('user'), new Date());
  return res.ok ? c.json({ events: res.events }) : c.json({ error: res.error }, res.status);
});

/** Body: { values: {column: value}, note?, confirm? }. Queued for RTD Sheet Writer; 409 { warning } asks first. */
staffRoutes.post('/events/:id/sheet-edit', async c => {
  const res = await requestEdit(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), new Date());
  if (res.ok) {
    await wakeSheetWriter(c, res.edit);
    return c.json({ edit: res.edit });
  }
  if ('warning' in res) return c.json({ warning: res.warning }, 409);
  return c.json({ error: res.error, errors: res.errors }, res.status);
});

/** Body: { action: 'withdraw' | 'keep_sheet' | 'write_mine' | 'retry' } */
staffRoutes.post('/sheet-edits/:id/resolve', async c => {
  const res = await resolveEdit(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), new Date());
  if (!res.ok) return c.json({ error: res.error }, res.status);
  await wakeSheetWriter(c, res.edit);
  return c.json({ edit: res.edit });
});

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

/** Dates in the next four weeks, with what's set for each one in the app (src/events/dates.ts). */
staffRoutes.get('/dates', async c => c.json({ dates: await listDates(c.env.DB, new Date()) }));

/**
 * Change one date in the app: { hidden?, description?, price?, confirm? }. 409 { warning } when
 * hiding a date people have booked, until confirm: true.
 */
staffRoutes.post('/dates/:id', async c => {
  const result = await editDate(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), new Date());
  if (result.ok) return c.json({ date: result.date });
  return 'warning' in result ? c.json({ warning: result.warning }, 409) : c.json({ error: result.error, errors: result.errors }, result.status);
});

/** Hosts' change requests: waiting (default), or decided in the last fortnight (src/host/changes.ts). */
staffRoutes.get('/change-requests', async c => {
  const status = c.req.query('status') === 'decided' ? 'decided' : 'pending';
  return c.json({ requests: await listChanges(c.env.DB, status, londonDate(new Date())) });
});

/** Approve, or decline with a reason. Body: { decision: 'approve' | 'decline', note? (required to decline) } */
staffRoutes.post('/change-requests/:id/decision', async c => {
  const result = await decideChange(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), {
    now: new Date().toISOString(),
    origin: new URL(c.req.url).origin,
  });
  return result.ok ? c.json({ request: result.request }) : c.json({ error: result.error, errors: result.errors }, result.status);
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

/** Admins: every event, whatever its kind, visibility or status (the admin event editor). */
staffRoutes.get('/events', async c => {
  const denied = adminOnly(c.get('user'));
  if (denied) return c.json({ error: denied.error }, 403);
  return c.json({ events: await listAllEvents(c.env.DB, new Date()) });
});

/** Admins: one event as the editor shows it. */
staffRoutes.get('/events/:id', async c => {
  const denied = adminOnly(c.get('user'));
  if (denied) return c.json({ error: denied.error }, 403);
  const event = await eventForm(c.env.DB, c.req.param('id'), new Date());
  return event ? c.json({ event }) : c.json({ error: 'No event with that ID.' }, 404);
});

/**
 * Admins: save the editor. Body: only what changed (src/events/admin.ts SaveBody). 409 { warning }
 * asks to send again with confirm: true.
 */
staffRoutes.post('/events/:id', async c => {
  const res = await saveEvent(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), { now: new Date(), origin: new URL(c.req.url).origin });
  if (res.ok) {
    await wakeSheetWriter(c, res.sheet_edit);
    return c.json(res);
  }
  return 'warning' in res ? c.json({ warning: res.warning }, 409) : c.json({ error: res.error, errors: res.errors }, res.status);
});

/** Admins: stop running an event. Body: { message?, confirm? }. 409 { warning } with the dates and people booked. */
staffRoutes.post('/events/:id/stop', async c => {
  const res = await stopEvent(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), { now: new Date(), origin: new URL(c.req.url).origin });
  if (res.ok) {
    await wakeSheetWriter(c, res.sheet_edit);
    return c.json(res);
  }
  return 'warning' in res ? c.json({ warning: res.warning }, 409) : c.json({ error: res.error, errors: res.errors }, res.status);
});

/** Places on every date of a café event. Body: { places: number | null }; null goes back to the sheet's App Capacity. */
staffRoutes.post('/events/:id/places', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { places?: unknown };
  const now = new Date();
  const result = await setEventPlaces(c.env.DB, c.get('user'), c.req.param('id'), body.places, { now: now.toISOString(), today: londonDate(now) });
  return result.ok ? c.json({ capacity: result.capacity }) : c.json({ error: result.error, errors: result.errors }, result.status);
});

/**
 * Whether people need to book a café event. Body: { mode: 'none' | 'optional' | 'required' | 'default', confirm? }.
 * 409 { warning } when switching to Not required with people booked: send again with confirm: true.
 */
staffRoutes.post('/events/:id/booking-mode', async c => {
  const now = new Date();
  const result = await setBookingMode(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), { now: now.toISOString(), today: londonDate(now) });
  if (result.ok) return c.json({ booking_mode: result.booking_mode, booking_mode_set: result.booking_mode_set });
  return 'warning' in result ? c.json({ warning: result.warning }, 409) : c.json({ error: result.error, errors: result.errors }, result.status);
});

// --- Social prompts (docs/superpowers/specs/2026-10-18-social-master-prompt-design.md §5): admins only ---

/** Far more than a prompt (3,000 characters) and a reason need. */
const MAX_SOCIAL_BODY = 64_000;

/** The switch, the prompts waiting for a person and the approved ones (each with its example post), and the posts the check held (or would have). */
staffRoutes.get('/social', async c => {
  const res = await socialOverview(c.env.DB, c.get('user'));
  return res.ok ? c.json({ mode: res.mode, review: res.review, approved: res.approved, held: res.held }) : c.json({ error: res.error }, res.status);
});

/** Body: { mode: 'off' | 'shadow' | 'enforce' } */
staffRoutes.post('/social/mode', async c => {
  const res = await setSocialMode(c.env.DB, c.get('user'), await c.req.json().catch(() => null), new Date());
  return res.ok ? c.json({ mode: res.mode }) : c.json({ error: res.error }, res.status);
});

/** One event: its facts as the last sync read them, its prompt and versions, and its last 10 checks. */
staffRoutes.get('/events/:id/social', async c => {
  const res = await eventSocial(c.env.DB, c.get('user'), c.req.param('id'));
  if (!res.ok) return c.json({ error: res.error }, res.status);
  const { ok: _ok, ...page } = res;
  return c.json(page);
});

/** Make the event due again on the builder's next run. */
staffRoutes.post('/events/:id/social/regenerate', async c => {
  const res = await regeneratePrompt(c.env.DB, c.get('user'), c.req.param('id'), new Date());
  if (!res.ok) return c.json({ error: res.error }, res.status);
  // RTD Social Prompt Builder runs now rather than at its next timed run.
  await triggerN8n(c.env, waiter(c), 'prompt-builder', { reason: 'regenerate', event_id: c.req.param('id') });
  return c.json({ ok: true });
});

/** Approve with a note. Body: { text?, reason }. 400 { error, errors } when the text fails the checks a generated prompt gets. */
staffRoutes.post('/events/:id/social/approve', async c => {
  if (c.get('user').role !== 'admin') return c.json({ error: 'Only admins can manage social prompts.' }, 403);
  const text = await c.req.text();
  if (text.length > MAX_SOCIAL_BODY) return c.json({ error: 'That is too long to be a prompt.' }, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: 'Send JSON' }, 400);
  }
  const res = await approvePrompt(c.env.DB, c.get('user'), c.req.param('id'), body, new Date());
  return res.ok ? c.json({ version: res.version }) : c.json({ error: res.error, errors: res.errors }, res.status);
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

// --- Stats: page views, taps and bookings (admins only; docs/RTD_STATS.md) ---

/** ?days=7|30|90 (default 30): totals against the days before, day by day, and every event. */
staffRoutes.get('/stats', async c => {
  if (!adminsOnly(c.get('user'))) return c.json({ error: 'Only admins can see stats.' }, 403);
  const days = Number(c.req.query('days') ?? 30);
  if (!(PERIODS as readonly number[]).includes(days)) return c.json({ error: 'days must be 7, 30 or 90' }, 400);
  return c.json(await statsOverview(c.env.DB, new Date(), days as Period));
});

// --- The game library (admins only; docs/GAME_LIBRARY_AUDIT.md) ---

const MAX_COVER_BODY = 2_600_000;
staffRoutes.use('/games/*', async (c, next) => (adminsOnly(c.get('user')) ? next() : c.json({ error: 'Only admins can change the game library.' }, 403)));
staffRoutes.use('/games', async (c, next) => (adminsOnly(c.get('user')) ? next() : c.json({ error: 'Only admins can change the game library.' }, 403)));
staffRoutes.use('/game-review/*', async (c, next) => (adminsOnly(c.get('user')) ? next() : c.json({ error: 'Only admins can review games.' }, 403)));
staffRoutes.use('/game-review', async (c, next) => (adminsOnly(c.get('user')) ? next() : c.json({ error: 'Only admins can review games.' }, 403)));

/** Every game (retired too), the review counts, the switch, the bundled manifest and recent imports. */
staffRoutes.get('/games', async c => c.json(await adminLibrary(c.env.DB)));

/** Add a game by hand. Body: its details and `ownership_evidence`. */
staffRoutes.post('/games', async c => {
  const res = await createGame(c.env.DB, c.get('user'), await c.req.json().catch(() => null), new Date().toISOString());
  return res.ok ? c.json({ game: res.value }, 201) : c.json({ error: res.error, errors: res.errors }, res.status);
});

/** Import the bundled manifest. Body: { mode: 'dry_run' | 'apply', retire_missing?, confirm: 'apply' (to apply) } */
staffRoutes.post('/games/import', async c => {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { mode?: unknown; retire_missing?: unknown; confirm?: unknown };
  const mode = body.mode === 'apply' ? 'apply' : 'dry_run';
  if (mode === 'apply' && body.confirm !== 'apply') return c.json({ error: 'Applying an import needs confirm: "apply".' }, 400);
  const result = await applyImport(c.env.DB, c.get('user'), { mode, retireMissing: body.retire_missing === true }, new Date().toISOString());
  return c.json(result, mode === 'apply' && !result.applied ? 409 : 200);
});

/** The public switch. Body: { on: boolean, confirm: true } */
staffRoutes.post('/games/live', async c => {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { on?: unknown; confirm?: unknown };
  if (typeof body.on !== 'boolean' || body.confirm !== true) return c.json({ error: 'Send { on: true|false, confirm: true }.' }, 400);
  const res = await setLive(c.env.DB, c.get('user'), body.on, new Date().toISOString());
  return res.ok ? c.json(res.value) : c.json({ error: res.error }, res.status);
});

/** Game of the Week, past weeks. */
staffRoutes.get('/games/gotw', async c => c.json({ weeks: await gotwHistory(c.env.DB) }));

staffRoutes.post('/games/:id', async c => {
  const res = await updateGame(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), new Date().toISOString());
  return res.ok ? c.json({ game: res.value }) : c.json({ error: res.error, errors: res.errors }, res.status);
});

for (const [path, retire] of [['retire', true], ['restore', false]] as const) {
  staffRoutes.post(`/games/:id/${path}`, async c =>
    (await setRetired(c.env.DB, c.get('user'), c.req.param('id'), retire, new Date().toISOString())) ? c.json({ ok: true }) : c.json({ error: 'Nothing to change.' }, 409),
  );
}

/** Attach a cover. Body: { cover, thumb (base64), source_url, attribution, rights_status, matches_edition } */
staffRoutes.post('/games/:id/cover', async c => {
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_COVER_BODY) return c.json({ error: 'That image is too big.' }, 413);
  const res = await attachCover(c.env.DB, c.env.IMAGES, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), new Date().toISOString());
  return res.ok ? c.json({ game: res.value }) : c.json({ error: res.error, errors: res.errors }, res.status);
});

staffRoutes.post('/games/:id/cover/status', async c =>
  (await setCoverStatus(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), new Date().toISOString()))
    ? c.json({ ok: true })
    : c.json({ error: 'No cover to update, or an unknown rights status.' }, 400),
);

staffRoutes.post('/games/:id/cover/remove', async c =>
  (await removeCover(c.env.DB, c.get('user'), c.req.param('id'), new Date().toISOString())) ? c.json({ ok: true }) : c.json({ error: 'No cover to remove.' }, 409),
);

/** The review register. ?status=open|confirmed|rejected */
staffRoutes.get('/game-review', async c => {
  const s = c.req.query('status');
  const status = s === 'confirmed' || s === 'rejected' ? s : 'open';
  return c.json({ entries: await reviewList(c.env.DB, status) });
});

/** Confirm several at once with the catalogue's details. Body: { review_ids: string[], ownership_evidence } */
staffRoutes.post('/game-review/confirm', async c => {
  const res = await confirmReviews(c.env.DB, c.get('user'), await c.req.json().catch(() => null), new Date().toISOString());
  return res.ok ? c.json(res.value) : c.json({ error: res.error, errors: res.errors }, res.status);
});

/** Confirm the café owns it. Body: the game's details (checked and completed) and `ownership_evidence`. */
staffRoutes.post('/game-review/:id/confirm', async c => {
  const res = await confirmReview(c.env.DB, c.get('user'), c.req.param('id'), await c.req.json().catch(() => null), new Date().toISOString());
  return res.ok ? c.json({ game: res.value }, 201) : c.json({ error: res.error, errors: res.errors }, res.status);
});

staffRoutes.post('/game-review/:id/reject', async c => {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { note?: unknown };
  return (await rejectReview(c.env.DB, c.get('user'), c.req.param('id'), body.note, new Date().toISOString())) ? c.json({ ok: true }) : c.json({ error: 'No open entry with that ID.' }, 404);
});

// --- The food and drinks menu (admins only; docs/RTD_FOOD_MENU.md) ---

staffRoutes.use('/menu/*', async (c, next) => (adminsOnly(c.get('user')) ? next() : c.json({ error: 'Only admins can manage the menu.' }, 403)));
staffRoutes.use('/menu', async (c, next) => (adminsOnly(c.get('user')) ? next() : c.json({ error: 'Only admins can manage the menu.' }, 403)));

/** The whole menu, hidden lines included, each with the line as transcribed, and Off / Preview / Live. */
staffRoutes.get('/menu', async c => c.json(await adminMenu(c.env.DB)));

/** Body: { status: 'off' | 'preview' | 'live' } */
staffRoutes.post('/menu/status', async c => {
  const res = await setMenuStatus(c.env.DB, c.get('user'), await c.req.json().catch(() => null), new Date());
  return res.ok ? c.json(res.value) : c.json({ error: res.error }, res.status);
});
