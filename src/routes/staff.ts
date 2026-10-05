// Staff Control API (Phase 1: identity, sync health and audit history).

import { Hono } from 'hono';
import { addHost, decideSession, listHosts, listSessions, type SessionStatus } from '../host/sessions';
import { requireRole, sameOriginJson, type AuthUser } from '../lib/auth';

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

staffRoutes.get('/hosts', async c => c.json({ hosts: await listHosts(c.env.DB) }));

/** Add a host by the email they'll sign in with. Body: { email, display_name } */
staffRoutes.post('/hosts', async c => {
  const result = await addHost(c.env.DB, c.get('user'), await c.req.json().catch(() => null), new Date().toISOString());
  return result.ok ? c.json({ host: result.host }, 201) : c.json({ error: 'Please check the form', errors: result.errors }, result.status);
});
