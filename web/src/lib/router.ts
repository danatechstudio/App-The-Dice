// A tiny History API router: same-origin <a href> clicks become in-app
// navigation, so every screen is also a real, shareable URL.
import { useEffect, useState } from 'preact/hooks';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const here = location.pathname + location.search + location.hash;
  if (to === here) return;
  // inApp marks entries reached inside the app, so back() knows it's safe.
  history[opts.replace ? 'replaceState' : 'pushState']({ inApp: !opts.replace || history.state?.inApp }, '', to);
  window.scrollTo(0, 0);
  notify();
}

export function back(fallback = '/'): void {
  // A shared link opened cold has no in-app history to go back to.
  if (history.state?.inApp) history.back();
  else navigate(fallback, { replace: true });
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);
  return path;
}

/** '/event/:id' against '/event/RTD-OCC-1' → { id: 'RTD-OCC-1' }; null when it doesn't match. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const want = p[i]!;
    const got = s[i]!;
    if (want.startsWith(':')) params[want.slice(1)] = decodeURIComponent(got);
    else if (want !== got) return null;
  }
  return params;
}

export function installLinkInterception(): void {
  window.addEventListener('popstate', notify);
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    // Calendar files and other API links are real downloads, not screens;
    // /cdn-cgi/ is Cloudflare's own (Access sign-out).
    if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
}
