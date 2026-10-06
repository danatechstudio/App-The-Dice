// Work that shouldn't hold up a response (sending push notifications): it runs
// after the response through waitUntil, or straight away where there's no
// execution context (tests). It never throws: a failure is only logged.

import type { Context } from 'hono';

export function afterResponse(c: Context, task: () => Promise<unknown>): Promise<void> {
  const run = task().then(
    () => undefined,
    err => console.error('Background task failed:', err),
  );
  try {
    c.executionCtx.waitUntil(run);
    return Promise.resolve();
  } catch {
    return run;
  }
}
