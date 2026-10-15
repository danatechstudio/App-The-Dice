// Making sure people run the newest app (docs/RTD_APP_ARCHITECTURE.md#updates).
// Every build has an ID, baked into the code and written to /version.json.
// The app checks that file when it opens, when it comes back on screen, and
// when someone moves between pages (at most every few minutes). If a newer
// build is live, an update screen blocks the app until they tap Update now.
// Checks happen at those moments, not while someone is typing on a page.

import { useEffect, useState } from 'preact/hooks';

export const BUILD_ID = __BUILD_ID__;

const RESUME_GAP_MS = 60_000;
const NAVIGATE_GAP_MS = 5 * 60_000;

let available = false;
let lastCheck = 0;
const listeners = new Set<() => void>();

/** Asks the server which build is live. Quiet on any failure (offline, say): the app carries on. */
export async function checkForUpdate(minGapMs = 0): Promise<boolean> {
  if (import.meta.env.DEV || available) return available;
  const now = Date.now();
  if (now - lastCheck < minGapMs) return false;
  lastCheck = now;
  try {
    const res = await fetch(`/version.json?t=${now}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const { build } = (await res.json()) as { build?: unknown };
    if (typeof build === 'string' && build && build !== BUILD_ID) {
      available = true;
      listeners.forEach(l => l());
    }
  } catch {
    /* offline or blocked: try again next time */
  }
  return available;
}

/** Reloads into the new build, after asking the service worker to fetch its own newest copy. */
export async function applyUpdate(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    /* the reload still fetches the new pages */
  }
  location.reload();
}

/** Starts the checks; call once when the app starts. */
export function watchForUpdates(): void {
  void checkForUpdate();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate(RESUME_GAP_MS);
  });
}

/** True once a newer build is live. Re-checks (at most every 5 minutes) when the page changes. */
export function useUpdateAvailable(path: string): boolean {
  const [, tick] = useState(0);
  useEffect(() => {
    const update = () => tick(n => n + 1);
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);
  useEffect(() => void checkForUpdate(NAVIGATE_GAP_MS), [path]);
  return available;
}
