// Roll Me a Game: which games are in the running for a set of filters, the
// random pick, and similar games (docs/GAME_LIBRARY.md). Pure functions over
// the live library, so the count on screen and the roll always agree.

import { AUDIENCES, categoryName, playersText, type PublicGame } from './model';

export interface Filters {
  /** How many are playing. */
  players: number | null;
  /** The youngest player's age. A game with no minimum age on record never counts as suitable. */
  youngest: number | null;
  /** Any of these audiences. */
  audiences: string[];
  /** Any of these categories. */
  categories: string[];
  /** The longest the game may take, in minutes, judged on its longest estimate. A game with no play time on record doesn't match. */
  max_minutes: number | null;
}

export const NO_FILTERS: Filters = { players: null, youngest: null, audiences: [], categories: [], max_minutes: null };

const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};
const list = (v: unknown, max = 12): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return [...new Set(raw.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean))].slice(0, max);
};

/** From a query string or a JSON body. Anything unreadable counts as not set. */
export function parseFilters(src: Record<string, unknown>): Filters {
  return {
    players: int(src.players, 1, 100),
    youngest: int(src.youngest, 0, 99),
    audiences: list(src.audiences).filter(a => (AUDIENCES as readonly string[]).includes(a)),
    categories: list(src.categories).map(categoryName),
    max_minutes: int(src.max_minutes, 1, 720),
  };
}

export function matches(g: PublicGame, f: Filters): boolean {
  if (f.players !== null && (g.min_players === null || g.max_players === null || f.players < g.min_players || f.players > g.max_players)) return false;
  if (f.youngest !== null && (g.min_age === null || g.min_age > f.youngest)) return false;
  if (f.max_minutes !== null && (g.play_time_max === null || g.play_time_max > f.max_minutes)) return false;
  if (f.categories.length && !f.categories.includes(g.category)) return false;
  if (f.audiences.length && !g.audiences.some(a => f.audiences.includes(a))) return false;
  return true;
}

export const pool = <T extends PublicGame>(games: T[], f: Filters): T[] => games.filter(g => matches(g, f));

/** When nothing matches: how many games each filter would let in if it were removed. */
export function relax(games: PublicGame[], f: Filters): Partial<Record<keyof Filters, number>> {
  const out: Partial<Record<keyof Filters, number>> = {};
  if (f.players !== null) out.players = pool(games, { ...f, players: null }).length;
  if (f.youngest !== null) out.youngest = pool(games, { ...f, youngest: null }).length;
  if (f.audiences.length) out.audiences = pool(games, { ...f, audiences: [] }).length;
  if (f.categories.length) out.categories = pool(games, { ...f, categories: [] }).length;
  if (f.max_minutes !== null) out.max_minutes = pool(games, { ...f, max_minutes: null }).length;
  return out;
}

/** An unbiased random index (rejection sampling, so no number is more likely than another). */
export function randomIndex(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

/**
 * One game from the pool, avoiding the ones already rolled this visit while
 * any others remain. If every game has been rolled, only the last one is avoided.
 */
export function pick<T extends PublicGame>(candidates: T[], recent: string[]): T | null {
  if (!candidates.length) return null;
  const fresh = candidates.filter(g => !recent.includes(g.id));
  const last = recent.at(-1);
  const from = fresh.length ? fresh : candidates.length > 1 ? candidates.filter(g => g.id !== last) : candidates;
  return from[randomIndex(from.length)]!;
}

// ---- Similar games ----

const mid = (g: PublicGame) => (g.play_time_min !== null && g.play_time_max !== null ? (g.play_time_min + g.play_time_max) / 2 : g.play_time_max ?? g.play_time_min);

/** A deterministic score: category, audiences, a shared player count, play time and age. */
export function similarity(a: PublicGame, b: PublicGame): number {
  let s = 0;
  if (a.category === b.category) s += 3;
  s += Math.min(3, a.audiences.filter(x => b.audiences.includes(x)).length);
  if (a.min_players !== null && a.max_players !== null && b.min_players !== null && b.max_players !== null) {
    if (a.min_players <= b.max_players && b.min_players <= a.max_players) s += 2;
    if (a.min_players === b.min_players && a.max_players === b.max_players) s += 1;
  }
  const [ma, mb] = [mid(a), mid(b)];
  if (ma != null && mb != null) s += Math.abs(ma - mb) <= 15 ? 2 : Math.abs(ma - mb) <= 30 ? 1 : 0;
  if (a.min_age !== null && b.min_age !== null && Math.abs(a.min_age - b.min_age) <= 2) s += 1;
  return s;
}

/** Plain words for why it's similar: "Another 2–4 player strategy game". */
export function likeLabel(of: PublicGame, g: PublicGame): string {
  const range = playersText(g.min_players, g.max_players);
  const players = range && !range.startsWith('up to') ? range.replace(/ players?$/, ' player') : null;
  const category = g.category.toLowerCase();
  if (g.category === of.category) return players ? `Another ${players} ${category} game` : `Another ${category} game`;
  const shared = of.audiences.find(a => g.audiences.includes(a));
  return shared ? `Also good for ${shared === 'Children' ? 'children' : shared.toLowerCase()}` : range ? `Also for ${range}` : `A ${category} game`;
}

/** Up to `n` games most like this one, distinct titles, never the game itself. */
export function similar<T extends PublicGame>(of: PublicGame, games: T[], n = 4): { game: T; label: string }[] {
  const seen = new Set([of.title.toLowerCase()]);
  return games
    // Something real in common (the category or an audience), and a score of 4 or more.
    .filter(g => g.id !== of.id && (g.category === of.category || g.audiences.some(a => of.audiences.includes(a))))
    .map(g => ({ g, s: similarity(of, g) }))
    .filter(x => x.s >= 4)
    .sort((x, y) => y.s - x.s || x.g.title.localeCompare(y.g.title))
    .filter(x => !seen.has(x.g.title.toLowerCase()) && seen.add(x.g.title.toLowerCase()))
    .slice(0, n)
    .map(x => ({ game: x.g, label: likeLabel(of, x.g) }));
}

/**
 * Other games that still fit the filters someone rolled with (their hard
 * limits), excluding this game and the similar ones already shown.
 */
export function alternatives<T extends PublicGame>(of: PublicGame, games: T[], f: Filters, shown: string[], n = 4): T[] {
  return pool(games, f)
    .filter(g => g.id !== of.id && !shown.includes(g.id))
    .sort((a, b) => similarity(of, b) - similarity(of, a) || a.title.localeCompare(b.title))
    .slice(0, n);
}

export const hasFilters = (f: Filters) =>
  f.players !== null || f.youngest !== null || f.max_minutes !== null || f.audiences.length > 0 || f.categories.length > 0;
