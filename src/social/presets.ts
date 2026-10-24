// The preset values the event editor offers for the objective Approved Facts and for People & Roles.
// Each is worded so the social checker (validate.ts) reads it as meant: test/social-presets.test.ts
// feeds every one through parseFacts and the post checks. Pure and import-free, so the web app and
// the server can share it.

/** Booking presets. "Essential" is booked, the "drop-ins welcome" ones are both, "No need to book" is drop in. */
export const BOOKING_PRESETS = ['Essential', 'Recommended – drop-ins welcome', 'Preferred – drop-ins welcome', 'Optional', 'No need to book'] as const;
/** "Essential – book via link": saved as `Essential, book via <url>`. */
export const BOOKING_VIA = 'Essential, book via ';
export const LEVEL_PRESETS = ['Beginners welcome', 'Beginners and experienced alike', 'Experienced players', 'All levels'] as const;
export const AGE_PRESETS = ['All ages', 'Family friendly', 'Kids', 'Adults (18+)'] as const;
// "Free table time" would read as a price ("free") on a paid event, so it is "Table time".
export const FORMAT_PRESETS = ['Organised play', 'Open play', 'Table time', 'Tournament', 'Workshop', 'Drop-in session', 'Casual club'] as const;
export const PRIZE_PRESETS = ['Cash prizes', 'Vouchers', 'Trophies', 'Prizes to be won', 'No prizes'] as const;
/** Price: "Same as the event price" saves the event's App Price text; "Free" is free. */
export const PRICE_FREE = 'Free';

/** The keys with a value dropdown and their plain presets (Booking's link and Age's range come on top). */
export const FACT_PRESETS = {
  Booking: BOOKING_PRESETS,
  Level: LEVEL_PRESETS,
  Age: AGE_PRESETS,
  Format: FORMAT_PRESETS,
  Prizes: PRIZE_PRESETS,
  Price: [PRICE_FREE],
} as const satisfies Record<string, readonly string[]>;
export type PresetKey = keyof typeof FACT_PRESETS;
export const hasPresets = (key: string): key is PresetKey => key in FACT_PRESETS;

/** People & Roles presets: every one holds a role word the checks know (validate.ts ROLE_WORDS). */
export const ROLE_PRESETS = [
  'Host',
  'Dungeon Master',
  'Game Master',
  'Organiser',
  'Leads the workshop',
  'Runs the session',
  'Quizmaster',
  'Bingo caller',
  'MC',
  'Presenter',
] as const;

/** An age range as saved: "2-4 years". */
export const ageRange = (from: string, to: string): string => `${from.trim()}-${to.trim()} years`;
const AGE_RANGE = /^(\d{1,2})\s*[-–]\s*(\d{1,2})\s+years$/i;
const BOOKING_LINK = /^essential,\s*book via\s+(\S+)$/i;

/** A value compared loosely: any case, spaces collapsed, trailing full stops ignored. */
export const sameValue = (a: string, b: string): boolean => norm(a) === norm(b);
const norm = (s: string): string => s.trim().replace(/\.+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** How the editor shows a value: a preset (its exact wording), a special form, or Other with the text as it is. */
export type PresetChoice =
  | { kind: 'preset'; value: string }
  | { kind: 'link'; url: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'event_price' }
  | { kind: 'other' };

/**
 * Which choice a saved value is, read loosely (any case, trailing full stops ignored). The editor shows the
 * choice but keeps the saved text as written until the admin picks something else.
 */
export function presetChoice(key: string, value: string, eventPrice = ''): PresetChoice {
  if (!hasPresets(key)) return { kind: 'other' };
  const preset = (FACT_PRESETS[key] as readonly string[]).find(p => sameValue(p, value));
  if (preset) return { kind: 'preset', value: preset };
  if (key === 'Price' && eventPrice.trim() && sameValue(value, eventPrice)) return { kind: 'event_price' };
  if (key === 'Booking') {
    const m = BOOKING_LINK.exec(value.trim().replace(/\.+$/, ''));
    if (m) return { kind: 'link', url: m[1]! };
  }
  if (key === 'Age') {
    const m = AGE_RANGE.exec(value.trim().replace(/\.+$/, ''));
    if (m) return { kind: 'range', from: m[1]!, to: m[2]! };
  }
  return { kind: 'other' };
}

/** The role preset a role is, read loosely like the facts; undefined for any other role. */
export const rolePreset = (role: string): string | undefined => ROLE_PRESETS.find(p => sameValue(p, role));
