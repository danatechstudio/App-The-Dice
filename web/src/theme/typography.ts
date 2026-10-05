// Two tiers. Display (Arvo) is the closest open font to the logo's lettering:
// a round, geometric slab. Interface (Figtree) is a friendly, very readable sans
// for everything people read or operate. Arvo ships one bold weight (700),
// which covers the brief's 700–800 hero band.

export const fonts = {
  display: "'Arvo', 'Roboto Slab', Rockwell, Georgia, serif",
  interface: "'Figtree Variable', 'Figtree', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
} as const;

// Fluid sizes: 320px phone → desktop.
export const sizes = {
  hero: 'clamp(2.125rem, 1.6rem + 2.6vw, 3.5rem)',
  h1: 'clamp(1.75rem, 1.45rem + 1.5vw, 2.5rem)',
  h2: 'clamp(1.375rem, 1.25rem + 0.6vw, 1.75rem)',
  h3: '1.1875rem',
  body: '1rem',
  small: '0.9375rem',
  meta: '0.875rem',
  label: '0.8125rem',
} as const;

export const weights = {
  hero: 700,
  h1: 700,
  h2: 700,
  h3: 600,
  body: 400,
  bodyStrong: 500,
  label: 600,
  meta: 400,
  button: 700,
} as const;

export const leading = {
  tight: 1.1,
  snug: 1.3,
  body: 1.55,
} as const;

export const tracking = {
  label: '0.08em',
  display: '-0.01em',
} as const;
