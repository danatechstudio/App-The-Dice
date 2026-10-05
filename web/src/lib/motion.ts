import { read, write } from './storage';

const KEY = 'rtd.motion';

export function prefersReducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The in-app switch, on top of the device setting. */
export function applyMotionPreference(): void {
  if (read<string>(KEY, 'full') === 'reduce') document.documentElement.dataset.motion = 'reduce';
}

export function setReducedMotion(reduce: boolean): void {
  if (reduce) document.documentElement.dataset.motion = 'reduce';
  else delete document.documentElement.dataset.motion;
  write(KEY, reduce ? 'reduce' : 'full');
}

/** Duration token in ms, read from the theme (1ms when motion is reduced). */
export function duration(name: 'fast' | 'normal' | 'feature' | 'dice'): number {
  if (prefersReducedMotion()) return 0;
  // The CSS minifier may rewrite 1500ms as 1.5s, so read either unit.
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--rtd-duration-${name}`).trim();
  const n = parseFloat(v) || 0;
  return v.endsWith('ms') ? n : n * 1000;
}
