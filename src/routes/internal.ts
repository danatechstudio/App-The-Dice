// Endpoints called only by n8n, authenticated with a bearer token held in an
// n8n credential and the INTERNAL_SYNC_TOKEN Worker secret.

import { Hono } from 'hono';
import { attentionSheetFixes } from '../attention/attention';
import { markSheetFixed, queueDueEmails, sheetFixes } from '../bookings/bookings';
import {
  decidedSessionsForHosts,
  dueFollowups,
  markCafeNotified,
  markFollowupSent,
  markHostNotified,
  markPublished,
  newSubmissions,
  sessionsToPublish,
} from '../host/sessions';
import { MAX_IMAGE_BYTES, imagePlan, parseImageSync, storeImage, syncImages } from '../images/store';
import { checkBearer } from '../lib/auth';
import { londonDate } from '../lib/time';
import { MARKET_ID, markMarketPublished, markSheetSynced, marketsToPublish, sheetRows } from '../markets/markets';
import { storeMenuFromSheet } from '../menu/menu';
import { markSocial, socialQueue } from '../notify/alerts';
import { changesToApply, markChangeApplied } from '../host/changes';
import { markFailed, markSent, unsent } from '../notify/outbox';
import { decidedApplicationsForApplicants, markApplicationNotified, newApplicationsForApprovers } from '../team/applications';
import { applySync, parsePayload } from '../sync/apply';
import { duePrompts, markPromptWritten, promptsToWrite, proposePrompt } from '../social/prompts';
import { checkEdit, claimEdits, markEditFailed, markEditWritten, parseWriterBody } from '../sync/edits';

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

/** One-off host sessions whose day has passed: n8n emails each host, then marks it sent. */
internalRoutes.get('/host-sessions/followups', async c => {
  const organiserUrl = `${new URL(c.req.url).origin}/organise`;
  const due = await dueFollowups(c.env.DB, londonDate(new Date()));
  return c.json({ followups: due.map(f => ({ ...f, organiser_url: organiserUrl })) });
});

internalRoutes.post('/host-sessions/:id/followup-sent', async c => {
  const result = await markFollowupSent(c.env.DB, c.req.param('id'), new Date().toISOString());
  if (result === 'not_found') return c.json({ error: 'No one-off session with that ID' }, 404);
  if (result === 'already_sent') return c.json({ error: 'Already marked as sent' }, 409);
  return c.json({ ok: true });
});

/** Approved host sessions to add to Logic Engine Event Index, each with its sheet row. */
// Markets come through the same feed (App Host Session = RTD-MKT-…), so the same n8n branch adds them.
internalRoutes.get('/host-sessions/to-publish', async c => {
  const today = londonDate(new Date());
  return c.json({ sessions: [...(await sessionsToPublish(c.env.DB, today)), ...(await marketsToPublish(c.env.DB, today))] });
});

internalRoutes.post('/host-sessions/:id/published', async c => {
  if (MARKET_ID.test(c.req.param('id'))) {
    const done = await markMarketPublished(c.env.DB, c.req.param('id'), new Date().toISOString());
    return done === 'not_found' ? c.json({ error: 'No market with that ID' }, 404) : c.json({ ok: true, already: done === 'already' });
  }
  const result = await markPublished(c.env.DB, c.req.param('id'), new Date().toISOString());
  if (result === 'not_found') return c.json({ error: 'No session with that ID' }, 404);
  if (result === 'not_approved') return c.json({ error: 'That session is no longer approved' }, 409);
  return c.json({ ok: true, already: result === 'already' });
});

/** New submissions the café hasn't been told about: n8n emails them, then marks each one. */
internalRoutes.get('/host-sessions/new-submissions', async c => {
  const organiserUrl = `${new URL(c.req.url).origin}/organise`;
  return c.json({ organiser_url: organiserUrl, submissions: await newSubmissions(c.env.DB) });
});

internalRoutes.post('/host-sessions/:id/cafe-notified', async c => {
  const result = await markCafeNotified(c.env.DB, c.req.param('id'), new Date().toISOString());
  if (result === 'not_found') return c.json({ error: 'No session with that ID' }, 404);
  return c.json({ ok: true, already: result === 'already' });
});

// --- Onboarding and decision emails (n8n RTD Team Notices) ---

/** New join requests for their approver: café team → the admins; host → the café address. */
internalRoutes.get('/applications/new', async c => {
  const organiserUrl = `${new URL(c.req.url).origin}/organise`;
  return c.json({ organiser_url: organiserUrl, applications: await newApplicationsForApprovers(c.env.DB) });
});

/** Decided join requests whose applicant hasn't been told. */
internalRoutes.get('/applications/decided', async c => {
  const organiserUrl = `${new URL(c.req.url).origin}/organise`;
  return c.json({ organiser_url: organiserUrl, applications: await decidedApplicationsForApplicants(c.env.DB, londonDate(new Date())) });
});

for (const who of ['approver', 'applicant'] as const) {
  internalRoutes.post(`/applications/:id/${who}-notified`, async c => {
    const result = await markApplicationNotified(c.env.DB, c.req.param('id'), who, new Date().toISOString());
    if (result === 'not_found') return c.json({ error: 'No request with that ID' }, 404);
    return c.json({ ok: true, already: result === 'already' });
  });
}

/** Host sessions the café has decided on, for an email to the host. */
internalRoutes.get('/host-sessions/decided', async c => {
  const organiserUrl = `${new URL(c.req.url).origin}/organise`;
  return c.json({ organiser_url: organiserUrl, sessions: await decidedSessionsForHosts(c.env.DB, londonDate(new Date())) });
});

internalRoutes.post('/host-sessions/:id/host-notified', async c => {
  const result = await markHostNotified(c.env.DB, c.req.param('id'), new Date().toISOString());
  if (result === 'not_found') return c.json({ error: 'No session with that ID' }, 404);
  return c.json({ ok: true, already: result === 'already' });
});

// --- Booking emails and cancelled dates (n8n RTD Outbox, RTD Host Sessions To Diary) ---

/**
 * Emails waiting to go. Collecting also queues any that have fallen due (the
 * two-day numbers emails, warnings about booked dates gone from the sheet), so
 * n8n only needs this call. to / reply_to: null = the café's general address;
 * "@bookings" = the bookings inbox (rtd_config RTD_BOOKINGS_EMAIL).
 */
internalRoutes.post('/outbox/collect', async c => {
  const now = new Date().toISOString();
  const queued = await queueDueEmails(c.env.DB, { now, origin: new URL(c.req.url).origin });
  return c.json({ queued_numbers: queued.numbers, queued_alerts: queued.alerts, messages: await unsent(c.env.DB, now) });
});

internalRoutes.post('/outbox/:id/sent', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: 'No email with that ID' }, 404);
  const result = await markSent(c.env.DB, id, new Date().toISOString());
  if (result === 'not_found') return c.json({ error: 'No email with that ID' }, 404);
  return c.json({ ok: true, already: result === 'already' });
});

/**
 * Gmail refused one. Body: { error? } (what Gmail said). It's tried again later, then
 * given up on where admins can see it (src/notify/outbox.ts), so one bad address never
 * holds up the rest. `dead`: that was the last try.
 */
internalRoutes.post('/outbox/:id/failed', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: 'No email with that ID' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { error?: unknown };
  const result = await markFailed(c.env.DB, id, body.error, new Date().toISOString());
  if (result === 'not_found') return c.json({ error: 'No email with that ID' }, 404);
  return c.json({ ok: true, already: result === 'already', dead: result === 'dead' });
});

/**
 * Approved host changes for Event Index (n8n RTD Host Sessions To Diary, branch D): each
 * with only the cells that change, matched on Event ID (src/host/changes.ts).
 */
internalRoutes.get('/host-changes', async c => c.json({ changes: await changesToApply(c.env.DB) }));

internalRoutes.post('/host-changes/:id/applied', async c => {
  const result = await markChangeApplied(c.env.DB, c.req.param('id'), new Date().toISOString());
  if (result === 'not_found') return c.json({ error: 'No change request with that number' }, 404);
  return c.json({ ok: true, already: result === 'already' });
});

/**
 * Event Index changes, matched on Event ID: new dates and archives decided under Needs
 * attention (src/attention/attention.ts), then cancelled dates (Status, or a weekly row's
 * next Event Date). At most one change per event per run, so each one's key sticks.
 */
internalRoutes.get('/sheet-fixes', async c => {
  const today = londonDate(new Date());
  const decided = await attentionSheetFixes(c.env.DB, today);
  const taken = new Set(decided.map(f => f.event_id));
  const cancelled = (await sheetFixes(c.env.DB, today)).filter(f => !taken.has(f.event_id));
  return c.json({ fixes: [...decided, ...cancelled] });
});

internalRoutes.post('/sheet-fixes/:eventId/done', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
  if (typeof body.key !== 'string' || !body.key) return c.json({ error: 'key is required' }, 400);
  const done = await markSheetFixed(c.env.DB, c.req.param('eventId'), body.key, new Date().toISOString());
  return done ? c.json({ ok: true }) : c.json({ error: 'No event with that ID' }, 404);
});

// --- Changes made in the organiser (n8n RTD Sheet Writer, src/sync/edits.ts) ---

async function writerBody(c: { req: { text(): Promise<string> } }) {
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return 'Body too large';
  try {
    return parseWriterBody(JSON.parse(text));
  } catch {
    return 'Body must be JSON';
  }
}

/** Edits due: { mode, edits: [{ edit_id, claim, event_id, target, tab }] }. target picks the spreadsheet. */
internalRoutes.post('/sheet-edits/claim', async c => c.json(await claimEdits(c.env.DB, new Date())));

/** Body: { claim, rows } (the rows read from the tab). Answers { action: 'write', tab, cells } or { action: 'skip', status }. */
internalRoutes.post('/sheet-edits/:id/check', async c => {
  const body = await writerBody(c);
  if (typeof body === 'string') return c.json({ error: body }, 400);
  const res = await checkEdit(c.env.DB, c.req.param('id'), body.claim, body.rows, new Date(), new URL(c.req.url).origin);
  return res ? c.json(res) : c.json({ error: 'No change with that number' }, 404);
});

/** Body: { claim, rows } (the row read back after writing). */
internalRoutes.post('/sheet-edits/:id/written', async c => {
  const body = await writerBody(c);
  if (typeof body === 'string') return c.json({ error: body }, 400);
  const res = await markEditWritten(c.env.DB, c.req.param('id'), body.claim, body.rows, new Date(), new URL(c.req.url).origin);
  if (res === 'not_found') return c.json({ error: 'No change with that number' }, 404);
  return c.json({ ok: res !== 'mismatch', result: res });
});

/** Body: { claim, error } (what Google or n8n said). */
internalRoutes.post('/sheet-edits/:id/failed', async c => {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { claim?: unknown; error?: unknown };
  if (typeof body.claim !== 'string' || !body.claim) return c.json({ error: 'claim is required' }, 400);
  const res = await markEditFailed(c.env.DB, c.req.param('id'), body.claim, body.error, new Date(), new URL(c.req.url).origin);
  if (res === 'not_found') return c.json({ error: 'No change with that number' }, 404);
  return c.json({ ok: true, result: res });
});

/**
 * Retired (matched rows on App Host Session). Always empty, so an n8n workflow
 * still calling it changes nothing in the sheet; use /internal/sheet-fixes.
 */
internalRoutes.get('/host-sessions/sheet-fixes', c => c.json({ fixes: [] }));

// --- The market spreadsheet (n8n RTD Market Vendors To Sheet, docs/RTD_MARKETS.md) ---

/** Applications whose spreadsheet row is out of date, each with the whole row, matched on Application ID. */
internalRoutes.get('/market-applications/sheet', async c => c.json({ rows: await sheetRows(c.env.DB, new URL(c.req.url).origin) }));

/** n8n wrote the row. Body: { hash } from the feed. */
internalRoutes.post('/market-applications/:id/sheet-synced', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { hash?: unknown };
  return (await markSheetSynced(c.env.DB, c.req.param('id'), body.hash)) ? c.json({ ok: true }) : c.json({ error: 'No application with that ID, or a bad hash' }, 404);
});

// --- Facebook posts for admins' reminders (n8n RTD Event Reminders To Facebook, docs/RTD_ALERTS.md) ---

/** Reminders whose Facebook post hasn't gone yet: text and photo address. */
internalRoutes.get('/social-posts', async c => c.json({ posts: await socialQueue(c.env.DB) }));

/** Buffer took it. Body: { post_id } */
internalRoutes.post('/social-posts/:id/done', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { post_id?: unknown };
  const postId = typeof body.post_id === 'string' ? body.post_id.slice(0, 100) : null;
  const done = await markSocial(c.env.DB, Number(c.req.param('id')), { ok: true, post_id: postId }, new Date());
  return done ? c.json({ ok: true }) : c.json({ error: 'No post waiting with that ID' }, 404);
});

/** Buffer refused it. Body: { error } (shown to admins in the organiser). */
internalRoutes.post('/social-posts/:id/failed', async c => {
  const body = (await c.req.json().catch(() => ({}))) as { error?: unknown };
  const error = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : 'Buffer refused the post';
  const done = await markSocial(c.env.DB, Number(c.req.param('id')), { ok: false, error }, new Date());
  return done ? c.json({ ok: true }) : c.json({ error: 'No post waiting with that ID' }, 404);
});

// --- Event social prompts (n8n RTD Social Prompt Builder, src/social/prompts.ts) ---

/** Events that need a prompt: { events: [{ event_id, fingerprint, request: { system, user }, instruction_version }] }. ?limit= 1–20, default 5. */
internalRoutes.get('/social-prompts/due', async c => {
  const asked = Number(c.req.query('limit') ?? 5);
  const limit = Number.isInteger(asked) ? Math.min(Math.max(asked, 1), 20) : 5;
  return c.json({ events: await duePrompts(c.env.DB, new Date(), limit) });
});

/** Versions whose cells aren't in the sheet yet: { prompts: [{ event_id, version, cells }] }. */
internalRoutes.get('/social-prompts/to-write', async c => c.json({ prompts: await promptsToWrite(c.env.DB) }));

/**
 * Gemini's answer. Body: { fingerprint, job_id?, model?, output }, or { fingerprint, job_id?, error }
 * when the generation failed. Answers { ok, status, version, cells } (cells to write, matched on
 * Event ID), or { ok, status: 'failed', failures } below three failures. 409: stale, drop it.
 */
internalRoutes.post('/social-prompts/:eventId', async c => {
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: 'Body too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const res = await proposePrompt(c.env.DB, c.req.param('eventId'), body, new Date());
  if (!res.ok) return c.json(res.errors ? { error: res.error, errors: res.errors } : { error: res.error }, res.status);
  return c.json(res);
});

/** n8n wrote a version's cells. Body: { version }. */
internalRoutes.post('/social-prompts/:eventId/written', async c => {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { version?: unknown };
  if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) return c.json({ error: 'version is required' }, 400);
  const res = await markPromptWritten(c.env.DB, c.req.param('eventId'), body.version, new Date());
  return res === 'ok' ? c.json({ ok: true }) : c.json({ error: 'No version with that number for that event' }, 404);
});

// --- The food and drinks menu (n8n RTD Menu Sync, docs/RTD_FOOD_MENU.md) ---

/**
 * A full copy of the RTD Food Menu sheet. Body: { sections: [...], items: [...],
 * sheet_url? }, each tab's rows as the Google Sheets node returns them. A bad
 * row refuses the whole copy (422, every problem listed) and the app keeps the
 * menu it had.
 */
internalRoutes.post('/menu', async c => {
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: 'Body too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: 'Body must be JSON' }, 400);
  }
  const res = await storeMenuFromSheet(c.env.DB, body, new Date());
  return res.ok ? c.json(res) : c.json({ error: `The menu sheet has problems, so the app kept its menu: ${res.errors.join(' ')}`, errors: res.errors }, 422);
});
