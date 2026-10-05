// Central theme. Every colour, size, radius, shadow and duration the app uses
// is defined in this folder and emitted once as CSS custom properties
// (virtual:rtd-theme.css, built by web/vite.config.ts). Components only use
// the variables, never raw values.

import { breakpoints } from './breakpoints';
import { colours } from './colours';
import { durations, easings } from './motion';
import { radii } from './radii';
import { shadows } from './shadows';
import { layout, spacing } from './spacing';
import { fonts, leading, sizes, tracking, weights } from './typography';

export { brand, colours } from './colours';
export { breakpoints };

export const theme = { colours, fonts, sizes, weights, leading, tracking, spacing, layout, radii, shadows, durations, easings, breakpoints };

// One design system, three intensities (brief §43): the public app is the
// most decorative, the host portal calmer, staff control plainest.
export const surfaces = {
  customer: { 'decor-opacity': '0.045', 'heading-font': 'var(--rtd-font-display)', 'card-shadow': 'var(--rtd-shadow-card)', 'page-bg': 'var(--rtd-background)' },
  host: { 'decor-opacity': '0.03', 'heading-font': 'var(--rtd-font-display)', 'card-shadow': 'var(--rtd-shadow-sm)', 'page-bg': 'var(--rtd-background)' },
  staff: { 'decor-opacity': '0', 'heading-font': 'var(--rtd-font-interface)', 'card-shadow': 'var(--rtd-shadow-sm)', 'page-bg': '#F4F2EE' },
} as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);

function group(prefix: string, values: Record<string | number, string | number>): string[] {
  return Object.entries(values).map(([k, v]) => `--rtd-${prefix}${kebab(String(k))}: ${v};`);
}

export function themeCss(): string {
  const root = [
    ...group('', colours),
    ...group('font-', fonts),
    ...group('size-', sizes),
    ...group('weight-', weights),
    ...group('leading-', leading),
    ...group('tracking-', tracking),
    ...group('space-', spacing),
    ...group('', layout),
    ...group('radius-', radii),
    ...group('shadow-', shadows),
    ...group('duration-', durations),
    ...group('ease-', easings),
  ];
  const surface = (name: keyof typeof surfaces) => group('', surfaces[name]).join('\n  ');
  const still = Object.keys(durations).map(k => `--rtd-duration-${k}: 1ms;`).join(' ');
  return `/* Generated from web/src/theme. Edit those files, not this output. */
:root {
  color-scheme: light;
  ${root.join('\n  ')}
  ${surface('customer')}
}
[data-surface="host"] {
  ${surface('host')}
}
[data-surface="staff"] {
  ${surface('staff')}
}
@media (prefers-reduced-motion: reduce) {
  :root { ${still} }
}
:root[data-motion="reduce"] { ${still} }
`;
}
