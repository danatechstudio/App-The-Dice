// Colour tokens. Source of truth: docs/brand/RTDLogo.jpg, a two-colour logo
// (white on navy #123F68). Everything else is derived from that navy, or from
// the orange already used on RTD posters and emails, and checked for contrast
// in test/theme.test.ts. Keys become CSS variables: primaryLight → --rtd-primary-light.

export const brand = {
  navy: '#123F68', // measured from the reference image
  white: '#FFFFFF',
  posterOrange: '#D9822B', // existing RTD poster/email accent
} as const;

export const colours = {
  primary: brand.navy,
  primaryLight: '#E1EAF3', // navy tint: selected states, highlights
  primaryDark: '#0B2A47', // pressed, deep panels, dice tray

  secondary: '#2F6EA5', // lighter brand blue: links, focus, decoration
  secondaryLight: '#DDEBF7',
  secondaryDark: '#1F5280',

  accent: '#F0A043', // poster orange, lifted to read on navy. Use sparingly.
  accentHover: '#E48A24',
  accentStrong: '#A4520C', // orange that passes as text on light surfaces

  background: '#F7F3EC', // warm café paper, never sterile white
  backgroundAlt: '#EFE8DC',
  surface: '#FFFDF9', // card stock
  surfaceElevated: '#FFFFFF',

  text: '#14273B', // navy ink
  textMuted: '#56636F',
  textInverse: '#FFFFFF',

  border: '#E2DACC', // decorative edges only
  borderStrong: '#7A848E', // form controls: 3:1 against background

  success: '#1C7A4A',
  successLight: '#E3F2E9',
  warning: '#9A4F06',
  warningLight: '#FDF0DC',
  danger: '#B3261E',
  dangerLight: '#FBE4E2',
  info: '#2F6EA5',
  infoLight: '#DDEBF7',

  event: brand.navy,
  booking: '#1C7A4A',
  game: '#A4520C',
  host: '#4E4A8E',

  focus: '#2F6EA5', // focus ring on light surfaces
  focusInverse: '#F0A043', // focus ring on navy
} as const;

export type ColourToken = keyof typeof colours;
