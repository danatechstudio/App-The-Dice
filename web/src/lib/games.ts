// The game library in the app (docs/GAME_LIBRARY_AUDIT.md): types, labels,
// the filters Roll Me a Game remembers, and the games already rolled this visit.

import { read, write } from './storage';

export interface Game {
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
  cover: string | null;
  thumb: string | null;
  cover_alt: string;
  attribution: string | null;
  preview?: boolean;
}

export interface Shelf {
  live: boolean;
  games: Game[];
  categories: string[];
  audiences: string[];
}

export interface Gotw {
  week_key: string;
  game: Game | null;
  snapshot: { title: string; edition: string | null; cover: string | null };
  archived: boolean;
  preview?: boolean;
}

export interface Filters {
  players: number | null;
  youngest: number | null;
  audiences: string[];
  categories: string[];
  max_minutes: number | null;
}

export const NO_FILTERS: Filters = { players: null, youngest: null, audiences: [], categories: [], max_minutes: null };

const FILTERS_KEY = 'rtd.roll.filters';
const RECENT_KEY = 'rtd.roll.recent';

export const savedFilters = (): Filters => ({ ...NO_FILTERS, ...read<Partial<Filters>>(FILTERS_KEY, {}) });
export const saveFilters = (f: Filters) => write(FILTERS_KEY, f);

/** Games rolled this visit, so the next roll avoids them while others remain. */
export const recentRolls = (): string[] => read<string[]>(RECENT_KEY, [], 'session');
export const rememberRoll = (id: string) => write(RECENT_KEY, [...recentRolls().filter(x => x !== id), id].slice(-50), 'session');

export const activeFilters = (f: Filters) =>
  (f.players !== null ? 1 : 0) + (f.youngest !== null ? 1 : 0) + (f.max_minutes !== null ? 1 : 0) + (f.audiences.length ? 1 : 0) + (f.categories.length ? 1 : 0);

/** Filters as a query string, for counting and for a game page's alternatives. */
export function filterQuery(f: Filters): string {
  const q = new URLSearchParams();
  if (f.players !== null) q.set('players', String(f.players));
  if (f.youngest !== null) q.set('youngest', String(f.youngest));
  if (f.max_minutes !== null) q.set('max_minutes', String(f.max_minutes));
  if (f.audiences.length) q.set('audiences', f.audiences.join(','));
  if (f.categories.length) q.set('categories', f.categories.join(','));
  return q.toString();
}

export const gameName = (g: Pick<Game, 'title' | 'edition'>) => (g.edition ? `${g.title}: ${g.edition}` : g.title);

export function playersLabel(g: Pick<Game, 'min_players' | 'max_players'>): string | null {
  const { min_players: a, max_players: b } = g;
  if (a === null && b === null) return null;
  if (a !== null && b !== null) return a === b ? `${a} player${a === 1 ? '' : 's'}` : `${a}–${b} players`;
  return a !== null ? `${a}+ players` : `Up to ${b} players`;
}

export function timeLabel(g: Pick<Game, 'play_time_min' | 'play_time_max'>): string | null {
  const { play_time_min: a, play_time_max: b } = g;
  const fmt = (n: number) => (n < 60 ? `${n} min` : n % 60 ? `${Math.floor(n / 60)} hr ${n % 60} min` : `${n / 60} hr`);
  if (a !== null && b !== null && a !== b) return b <= 60 ? `${a}–${b} min` : `${fmt(a)} to ${fmt(b)}`;
  const n = b ?? a;
  return n === null ? null : `About ${fmt(n)}`;
}

export const ageLabel = (g: Pick<Game, 'min_age'>) => (g.min_age === null ? null : `Ages ${g.min_age}+`);

/** Labels for the filters that can be loosened. */
export const FILTER_NAMES: Record<keyof Filters, string> = {
  players: 'the number of players',
  youngest: 'the youngest age',
  audiences: 'who it’s for',
  categories: 'the category',
  max_minutes: 'the time limit',
};

export const TIME_LIMITS = [15, 30, 45, 60, 90, 120] as const;
export const AGES = [3, 5, 6, 8, 10, 12, 14, 16, 18] as const;
