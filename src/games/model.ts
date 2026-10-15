// The game library's shape, vocabulary and checks (docs/GAME_LIBRARY_AUDIT.md).
// Shared by the importer, the admin screens and the public chooser, so every
// path applies the same rules.

/** Who a game suits. Kept apart from category: "Party" can be both, but they're different questions. */
export const AUDIENCES = ['Children', 'Family', 'Adults', 'Party', 'Strategy'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const IMAGE_RIGHTS = ['approved', 'pending', 'restricted', 'unknown'] as const;
export const IMAGE_STATUS = ['verified', 'placeholder', 'pending'] as const;

/** Sensible bounds: anything outside is a data error, not a game. */
export const LIMITS = { players: [1, 100], age: [0, 21], minutes: [1, 720] } as const;

export interface GameRow {
  game_id: string;
  slug: string;
  title: string;
  edition: string | null;
  category: string;
  audiences: string; // JSON
  min_age: number | null;
  min_players: number | null;
  max_players: number | null;
  play_time_min: number | null;
  play_time_max: number | null;
  synopsis: string;
  verification_status: 'confirmed' | 'needs_review' | 'rejected';
  available_for_chooser: number;
  available_for_gotw: number;
  copies: number | null;
  cover_image_id: string | null;
  thumb_image_id: string | null;
  image_source_url: string | null;
  image_attribution: string | null;
  image_rights_status: (typeof IMAGE_RIGHTS)[number];
  image_status: (typeof IMAGE_STATUS)[number];
  image_checked_at: string | null;
  source_key: string | null;
  source_title: string;
  source_evidence: string | null;
  ownership_evidence: string;
  confirmed_by: string;
  confirmed_at: string;
  import_batch_id: string | null;
  admin_edited_at: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the public app sees of a game. */
export interface PublicGame {
  id: string;
  slug: string;
  title: string;
  edition: string | null;
  category: string;
  audiences: string[];
  min_age: number | null;
  min_players: number | null;
  max_players: number | null;
  play_time_min: number | null;
  play_time_max: number | null;
  synopsis: string;
  /** Only for a cover whose match is checked and whose rights are approved; otherwise the page shows the RTD placeholder. */
  cover: string | null;
  thumb: string | null;
  cover_alt: string;
  attribution: string | null;
  /** The sample shelf shown until the library goes live. */
  preview?: boolean;
}

export const parseList = (json: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** A cover is shown only when it has been matched to the café's edition and its reuse is approved. */
export const showCover = (g: Pick<GameRow, 'cover_image_id' | 'image_status' | 'image_rights_status'>) =>
  !!g.cover_image_id && g.image_status === 'verified' && g.image_rights_status === 'approved';

export function toPublic(g: GameRow): PublicGame {
  const cover = showCover(g);
  const name = g.edition ? `${g.title} (${g.edition})` : g.title;
  return {
    id: g.game_id,
    slug: g.slug,
    title: g.title,
    edition: g.edition,
    category: g.category,
    audiences: parseList(g.audiences),
    min_age: g.min_age,
    min_players: g.min_players,
    max_players: g.max_players,
    play_time_min: g.play_time_min,
    play_time_max: g.play_time_max,
    synopsis: g.synopsis,
    cover: cover ? `/images/games/${g.cover_image_id}` : null,
    thumb: cover ? `/images/games/${g.thumb_image_id ?? g.cover_image_id}` : null,
    cover_alt: `Box cover of ${name}`,
    attribution: cover ? g.image_attribution : null,
  };
}

// ---- Normalising ----

/** Collapse whitespace and curly quotes, so the same text from two sources compares equal. */
export const tidy = (s: unknown, max = 2000): string =>
  typeof s === 'string'
    ? s
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

/** A stable, edition-aware key for matching the same game across imports: "ticket to ride|europe". */
export function sourceKey(title: string, edition: string | null): string {
  const norm = (s: string) =>
    tidy(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${norm(title)}|${edition ? norm(edition) : ''}`;
}

export function slugify(title: string, edition: string | null): string {
  return sourceKey(title, edition).replace('|', ' ').trim().replace(/\s+/g, '-').slice(0, 80) || 'game';
}

/** Title Case for categories, so "deck-building" and "Deck Building" are one category. */
export const categoryName = (s: string) =>
  tidy(s, 40)
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]/g, c => c.toUpperCase());

// ---- Checking a game's details ----

export interface GameInput {
  title: string;
  edition: string | null;
  category: string;
  audiences: Audience[];
  min_age: number | null;
  min_players: number | null;
  max_players: number | null;
  play_time_min: number | null;
  play_time_max: number | null;
  synopsis: string;
  available_for_chooser: boolean;
  available_for_gotw: boolean;
  copies: number | null;
}

type Check = { ok: true; value: GameInput } | { ok: false; errors: Record<string, string> };

const whole = (v: unknown): number | null | 'bad' => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) ? n : 'bad';
};

/**
 * Checks a game's details. `publish` is the bar for the live library: title,
 * category, a short synopsis, and sensible players, age and play time. Below
 * it, a title waits in the review register.
 */
export function checkGame(body: unknown, opts: { publish: boolean }): Check {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const title = tidy(b.title, 120);
  const edition = tidy(b.edition, 80) || null;
  const category = b.category ? categoryName(String(b.category)) : '';
  const synopsis = tidy(b.synopsis, 600);
  const audiences = Array.isArray(b.audiences) ? [...new Set(b.audiences.map(a => tidy(a, 20)))] : [];
  const bad = audiences.filter(a => !(AUDIENCES as readonly string[]).includes(a));
  const num = (k: string, [lo, hi]: readonly [number, number], label: string) => {
    const n = whole(b[k]);
    if (n === 'bad' || (n !== null && (n < lo || n > hi))) {
      errors[k] = `${label} must be a whole number from ${lo} to ${hi}.`;
      return null;
    }
    return n;
  };
  const value: GameInput = {
    title,
    edition,
    category,
    audiences: audiences.filter((a): a is Audience => !bad.includes(a)),
    min_age: num('min_age', LIMITS.age, 'Minimum age'),
    min_players: num('min_players', LIMITS.players, 'Minimum players'),
    max_players: num('max_players', LIMITS.players, 'Maximum players'),
    play_time_min: num('play_time_min', LIMITS.minutes, 'Shortest play time'),
    play_time_max: num('play_time_max', LIMITS.minutes, 'Longest play time'),
    synopsis,
    available_for_chooser: b.available_for_chooser !== false,
    available_for_gotw: b.available_for_gotw !== false,
    copies: num('copies', [1, 50], 'Copies'),
  };
  if (title.length < 2) errors.title = 'Enter the game’s title.';
  if (!category) errors.category = 'Choose a category.';
  if (bad.length) errors.audiences = `Unknown audience: ${bad.join(', ')}. Use ${AUDIENCES.join(', ')}.`;
  if (value.min_players !== null && value.max_players !== null && value.min_players > value.max_players) errors.max_players = 'Maximum players can’t be below the minimum.';
  if (value.play_time_min !== null && value.play_time_max !== null && value.play_time_min > value.play_time_max) {
    errors.play_time_max = 'The longest play time can’t be below the shortest.';
  }
  if (opts.publish) {
    if (synopsis.length < 20) errors.synopsis = 'Write a short synopsis (2 or 3 sentences).';
    if (value.min_players === null || value.max_players === null) errors.min_players ??= 'Enter the player range.';
    if (value.min_age === null) errors.min_age ??= 'Enter the minimum age.';
    if (value.play_time_max === null) errors.play_time_max ??= 'Enter the play time.';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** "2–4 players", "2+ players", or null when unknown. */
export function playersText(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min !== null && max !== null) return min === max ? `${min} player${min === 1 ? '' : 's'}` : `${min}–${max} players`;
  return min !== null ? `${min}+ players` : `up to ${max} players`;
}
