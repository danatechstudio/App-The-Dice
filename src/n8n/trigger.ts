// "Run now" calls to n8n, so a change reaches the sheet and comes back in seconds instead of
// waiting for the workflows' timers (docs/RTD_N8N_WORKFLOWS.md#instant-triggers). The schedules
// stay as the safety net: a call that's skipped, refused or lost is caught by the next timed run.
//
// Fire and forget: the call runs after the response (waitUntil), with a 5 s timeout, and a
// failure is only logged. It never changes what the caller answers.
//
// When a call is skipped (stamps in the settings table, key trigger_last_<target> / trigger_seen_<target>):
// - sheet-writer, prompt-builder: skipped when the last call was under 15 s ago AND no run has
//   started since (no /sheet-edits/claim or /social-prompts/due). That run hasn't read the queue
//   yet, so it will take this change too. Once a run has started, the next change calls again,
//   so a burst of edits still ends with a run after the last one.
// - event-sync: skipped while the last call's run may still be going: a call under 30 s ago with no
//   snapshot since. A snapshot that has arrived is a run that has finished, so the next call starts
//   at once (two runs at once could give the same new Event ID to different rows). A run that never
//   reports back blocks for 30 s at most; the 5-minute schedule picks up anything skipped.

import type { Context } from 'hono';

export type Target = 'sheet-writer' | 'event-sync' | 'prompt-builder';
export type TriggerBody = { reason: 'edit_queued' | 'edit_written' | 'prompts_due' | 'regenerate'; event_id?: string };
type Waiter = { waitUntil(p: Promise<unknown>): void } | null;

const PATHS: Record<Target, string> = {
  'sheet-writer': '/rtd-sheet-writer-run',
  'event-sync': '/rtd-event-sync-run',
  'prompt-builder': '/rtd-prompt-builder-run',
};
const DEBOUNCE_MS = 15_000;
const SYNC_RUNNING_MS = 30_000;
const TIMEOUT_MS = 5_000;

/** The request's execution context, or null where there is none (tests): the work then runs before the response. */
export function waiter(c: Context): Waiter {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

const lastKey = (t: Target) => `trigger_last_${t}`;
const seenKey = (t: Target) => `trigger_seen_${t}`;

async function stamps(db: D1Database, t: Target) {
  const { results } = await db.prepare('SELECT key, value FROM settings WHERE key IN (?1, ?2)').bind(lastKey(t), seenKey(t)).all<{ key: string; value: string }>();
  const at = (k: string) => {
    const v = results.find(r => r.key === k)?.value;
    return v ? Date.parse(v) : NaN;
  };
  return { last: at(lastKey(t)), seen: at(seenKey(t)) };
}

const stamp = (db: D1Database, key: string, iso: string) =>
  db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?2, 'n8n-trigger')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, iso)
    .run();

function skip(t: Target, now: number, s: { last: number; seen: number }): boolean {
  if (t === 'event-sync') return now - s.last < SYNC_RUNNING_MS && !(s.seen >= s.last);
  return now - s.last < DEBOUNCE_MS && !(s.seen >= s.last);
}

async function run(env: Env, t: Target, body: TriggerBody): Promise<void> {
  const base = env.N8N_WEBHOOK_BASE?.trim().replace(/\/+$/, '');
  if (!base) return; // switched off: the schedules do it
  const now = Date.now();
  if (skip(t, now, await stamps(env.DB, t))) return;
  await stamp(env.DB, lastKey(t), new Date(now).toISOString());
  let problem: string | null = null;
  try {
    const res = await fetch(base + PATHS[t], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INTERNAL_SYNC_TOKEN}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) problem = res.status === 404 ? '404 (is the workflow published?)' : `HTTP ${res.status}`;
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  if (problem) {
    console.warn(`n8n trigger ${t} failed: ${problem}`);
    // Let the next change try again rather than wait out the debounce for a call that went nowhere.
    // Not for the sync: a run may have started even so, and two at once is what the quiet time prevents.
    if (t !== 'event-sync') await env.DB.prepare('DELETE FROM settings WHERE key = ?1').bind(lastKey(t)).run();
  }
}

/** Ask n8n to run a workflow now. Never throws; resolves at once when there's an execution context. */
export function triggerN8n(env: Env, ctx: Waiter, target: Target, body: TriggerBody): Promise<void> {
  const task = run(env, target, body).catch(e => console.warn(`n8n trigger ${target} failed:`, e));
  if (ctx) {
    ctx.waitUntil(task);
    return Promise.resolve();
  }
  return task;
}

/**
 * n8n started a run (sheet-writer: claimed edits; prompt-builder: asked what's due), or a snapshot
 * arrived (event-sync). Used only to decide when to skip a call.
 */
export async function noteRun(env: Env, target: Target): Promise<void> {
  if (!env.N8N_WEBHOOK_BASE?.trim()) return;
  try {
    await stamp(env.DB, seenKey(target), new Date().toISOString());
  } catch (e) {
    console.warn(`n8n trigger ${target}: couldn't note the run:`, e);
  }
}
