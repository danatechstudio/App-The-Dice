// What the public may see: dates still to come or still running. The same rule as
// the server (src/lib/queries.ts, docs/RTD_EVENT_CONTROL_AUDIT.md G-1), applied again
// here because a list can come from the service worker's offline copy or the
// in-memory cache. Only needs a date's status and end, so it has no other imports.

import { todayLondon } from './dates';

type Dated = { date: string; ends_at: string | null };

/** Over: past its end (UTC), or past London midnight for an all-day date. */
export function hasEnded(o: Dated, now = new Date()): boolean {
  return o.ends_at ? Date.parse(o.ends_at) <= now.getTime() : o.date < todayLondon(now);
}

/** Still to come or still running. */
export const isUpcoming = (o: Dated & { status: string }, now = new Date()) => o.status === 'scheduled' && !hasEnded(o, now);
