// Restrained, navy-tinted elevation (never neon glows).
const ink = '11 42 71'; // primaryDark as RGB

export const shadows = {
  sm: `0 1px 2px rgb(${ink} / 0.08), 0 1px 1px rgb(${ink} / 0.04)`,
  card: `0 1px 3px rgb(${ink} / 0.08), 0 8px 20px -10px rgb(${ink} / 0.18)`,
  feature: `0 2px 6px rgb(${ink} / 0.10), 0 20px 40px -16px rgb(${ink} / 0.35)`,
  float: `0 6px 16px rgb(${ink} / 0.32), 0 2px 4px rgb(${ink} / 0.20)`,
  inset: `inset 0 2px 10px rgb(0 0 0 / 0.35)`,
  // The logo's die-cut outline, for stickers drawn on navy.
  sticker: `0 0 0 3px #FFFFFF`,
} as const;
