// Staff Control API (Phase 1: identity, sync health and audit history).

import { Hono } from 'hono';
import { requireRole, type AuthUser } from '../lib/auth';

export const staffRoutes = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// no-store first so refusals (401/403) are never cached either.
staffRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});
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
