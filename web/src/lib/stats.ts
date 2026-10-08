// Counting page views and taps for admins' Stats (docs/RTD_STATS.md). Only the
// name of what happened (and which event) is sent: nothing about the person,
// no ID and no cookie. Counts go in small batches, and never hold anything up.

import { useEffect } from 'preact/hooks';

export type AppMetric =
  | 'app_open'
  | 'home_screen_open'
  | 'install'
  | 'diary_view'
  | 'book_page_view'
  | 'roll_use'
  | 'roll_pick'
  | 'gotw_view'
  | 'host_page_view'
  | 'host_apply_tap'
  | 'markets_view';
export type EventMetric = 'event_view' | 'book_tap' | 'calendar_tap' | 'share_tap';

const MAX_BATCH = 10;
const queue: { m: string; e?: string }[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  clearTimeout(timer);
  while (queue.length) {
    const hits = queue.splice(0, MAX_BATCH);
    // keepalive: still sent when the page is closing or moving on.
    fetch('/api/stats', {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hits }),
    }).catch(() => undefined);
  }
}

addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
addEventListener('pagehide', flush);

/** Count something about the whole app. */
export function count(metric: AppMetric): void;
/** Count something about one event. */
export function count(metric: EventMetric, eventId: string): void;
export function count(metric: AppMetric | EventMetric, eventId?: string): void {
  // Automated browsers (tests, robots) aren't people.
  if (navigator.webdriver) return;
  queue.push(eventId ? { m: metric, e: eventId } : { m: metric });
  if (queue.length >= MAX_BATCH) flush();
  else {
    clearTimeout(timer);
    timer = setTimeout(flush, 3000);
  }
}

/** Count a page view once each time the page is shown. */
export function useCount(metric: AppMetric): void {
  useEffect(() => count(metric), []);
}
