// Standard durations. prefers-reduced-motion collapses all of them (see toCss).
export const durations = {
  fast: '140ms',
  normal: '220ms',
  feature: '420ms',
  dice: '1500ms',
} as const;

export const easings = {
  standard: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;
