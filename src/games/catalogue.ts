// The game library the public app reads (docs/GAME_LIBRARY_AUDIT.md): the
// café's confirmed games once `game_library_live` is on, the preview shelf
// until then. Never the review register.

import { AUDIENCES, toPublic, type GameRow, type PublicGame } from './model';
import { PREVIEW_GAMES } from './preview';

export interface LibraryGame extends PublicGame {
  /** In the running for Roll Me a Game. */
  chooser: boolean;
  /** Can be Game of the Week. */
  gotw: boolean;
}

/** The switch that moves the public app from the preview shelf to the café's library. */
export async function isLive(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'game_library_live'").first<{ value: string }>();
  return row?.value === 'on';
}

/** Confirmed, not retired: the café's shelf. */
export const LIVE_SQL = "verification_status = 'confirmed' AND retired_at IS NULL";

export async function confirmedGames(db: D1Database): Promise<LibraryGame[]> {
  const { results } = await db.prepare(`SELECT * FROM games WHERE ${LIVE_SQL} ORDER BY title, edition`).all<GameRow>();
  return results.map(r => ({ ...toPublic(r), chooser: r.available_for_chooser === 1, gotw: r.available_for_gotw === 1 }));
}

/** What the public sees: the confirmed library, or the labelled preview shelf. */
export async function library(db: D1Database): Promise<{ live: boolean; games: LibraryGame[] }> {
  if (!(await isLive(db))) return { live: false, games: PREVIEW_GAMES.map(g => ({ ...g, chooser: true, gotw: true })) };
  return { live: true, games: await confirmedGames(db) };
}

/** The categories and audiences that games on the shelf actually have, for the filters. */
export function facets(games: PublicGame[]) {
  const categories = [...new Set(games.map(g => g.category))].sort((a, b) => a.localeCompare(b));
  const present = new Set(games.flatMap(g => g.audiences));
  return { categories, audiences: AUDIENCES.filter(a => present.has(a)) };
}

/** Strip the internal flags before a game goes to the browser. */
export const publicOnly = ({ chooser: _c, gotw: _g, ...g }: LibraryGame): PublicGame => g;
