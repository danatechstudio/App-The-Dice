import { describe, expect, it } from 'vitest';
import { brand, colours, themeCss } from '../web/src/theme';
import { contrast } from '../web/src/theme/contrast';

// The brief's required semantic tokens (§3).
const REQUIRED = [
  'primary', 'primary-light', 'primary-dark', 'secondary', 'secondary-light', 'secondary-dark', 'accent', 'accent-hover',
  'background', 'background-alt', 'surface', 'surface-elevated', 'text', 'text-muted', 'text-inverse', 'border',
  'success', 'warning', 'danger', 'info', 'event', 'booking', 'game', 'host',
];

describe('theme', () => {
  it('keeps the logo navy as the primary colour', () => {
    expect(colours.primary).toBe('#123F68');
    expect(brand.navy).toBe('#123F68');
  });

  it('defines every required token once, centrally', () => {
    const css = themeCss();
    for (const name of REQUIRED) expect(css).toMatch(new RegExp(`--rtd-${name}: #[0-9A-F]{6};`));
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('[data-surface="staff"]');
  });

  // WCAG AA: 4.5:1 for text, 3:1 for large text and control boundaries.
  const TEXT: [keyof typeof colours, keyof typeof colours][] = [
    ['text', 'background'], ['text', 'surface'], ['textMuted', 'background'], ['textMuted', 'surface'],
    ['primary', 'background'], ['textInverse', 'primary'], ['textInverse', 'primaryDark'], ['secondaryDark', 'background'],
    ['secondary', 'surfaceElevated'], ['accentStrong', 'background'], ['accentStrong', 'surfaceElevated'], ['primaryDark', 'accent'],
    ['primaryDark', 'accentHover'], ['textInverse', 'success'], ['textInverse', 'danger'], ['textInverse', 'warning'],
    ['success', 'successLight'], ['warning', 'warningLight'], ['danger', 'dangerLight'], ['secondaryDark', 'secondaryLight'],
    ['primary', 'primaryLight'], ['textInverse', 'host'], ['textInverse', 'game'], ['accent', 'primary'],
  ];
  it.each(TEXT)('%s on %s reads at 4.5:1 or better', (fg, bg) => {
    expect(contrast(colours[fg], colours[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it('gives controls and focus rings 3:1 against their backgrounds', () => {
    expect(contrast(colours.borderStrong, colours.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(colours.borderStrong, colours.surfaceElevated)).toBeGreaterThanOrEqual(3);
    expect(contrast(colours.focus, colours.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(colours.focusInverse, colours.primary)).toBeGreaterThanOrEqual(3);
  });
});
