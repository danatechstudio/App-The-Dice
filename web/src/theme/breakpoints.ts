// Mobile-first. CSS media queries use these literal values (custom properties
// can't be used inside @media), so change them here and in styles/ together.
export const breakpoints = {
  small: 375, // most phones; 320 is the floor everything must fit
  large: 430, // big phones
  tablet: 768,
  desktop: 1024, // top navigation replaces the bottom bar
  wide: 1280,
} as const;
