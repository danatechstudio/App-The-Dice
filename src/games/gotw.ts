// Game of the Week (docs/GAME_LIBRARY_AUDIT.md): picked automatically once per
// calendar week (Monday to Sunday, London), from confirmed games that can be
// featured, avoiding the last `gotw_avoid_weeks` weeks. If every game has been
// featured that recently, the one featured longest ago is picked (ties: the
// lowest game ID). One row per week, so concurrent runs can't pick twice. No
// notification is sent.

import { addDays, londonDate } from '../lib/time';
import { randomIndex } from './chooser';
import { isLive, LIVE_SQL } from './catalogue';
import { showCover, toPublic, type GameRow, type PublicGame } from './model';
import { PREVIEW_GAMES, PREVIEW_GOTW } from './preview';

const DEFAULT_AVOID_WEEKS = 12;

/** The Monday (London) that starts this week: "2026-10-12". */
export function weekKey(now: Date): string {
  const day = londonDate(now);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

interface WeekRow {
  week_key: string;
  game_id: string;
  title: string;
  edition: string | null;
  cover_image_id: string | null;
  mode: 'random' | 'least_recent';
  pool_size: number;
  selected_at: string;
}

export interface Gotw {
  week_key: string;
  /** The game as it is now; null if it has since left the library. */
  game: PublicGame | null;
  /** How the game looked when it was picked, for weeks whose game has left the library. */
  snapshot: { title: string; edition: string | null; cover: string | null };
  archived: boolean;
  preview?: boolean;
}

async function avoidWeeks(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'gotw_avoid_weeks'").first<{ value: string }>();
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= 0 && n <= 104 ? n : DEFAULT_AVOID_WEEKS;
}

const ELIGIBLE_SQL = `SELECT * FROM games WHERE ${LIVE_SQL} AND available_for_gotw = 1 AND length(synopsis) >= 20 ORDER BY game_id`;

/** Picks this week's game, or replaces a pick that can no longer be featured. Returns the week's row. */
async function choose(db: D1Database, week: string, now: Date, existing: WeekRow | null): Promise<WeekRow | null> {
  const { results: eligible } = await db.prepare(ELIGIBLE_SQL).all<GameRow>();
  if (!eligible.length) return existing;
  const { results: history } = await db
    .prepare('SELECT game_id, MAX(week_key) AS last FROM gotw_weeks WHERE week_key < ?1 GROUP BY game_id')
    .bind(week)
    .all<{ game_id: string; last: string }>();
  const last = new Map(history.map(h => [h.game_id, h.last]));
  const cutoff = addDays(week, -7 * (await avoidWeeks(db)));
  const fresh = eligible.filter(g => (last.get(g.game_id) ?? '') < cutoff);
  let chosen: GameRow;
  let mode: WeekRow['mode'];
  if (fresh.length) {
    chosen = fresh[randomIndex(fresh.length)]!;
    mode = 'random';
  } else {
    chosen = [...eligible].sort((a, b) => (last.get(a.game_id) ?? '').localeCompare(last.get(b.game_id) ?? '') || a.game_id.localeCompare(b.game_id))[0]!;
    mode = 'least_recent';
  }
  const values = [chosen.game_id, chosen.title, chosen.edition, showCover(chosen) ? chosen.cover_image_id : null, mode, eligible.length, now.toISOString()];
  const write = existing
    ? db
        .prepare(
          `UPDATE gotw_weeks SET game_id = ?2, title = ?3, edition = ?4, cover_image_id = ?5, mode = ?6, pool_size = ?7, selected_at = ?8
           WHERE week_key = ?1 AND game_id = ?9`,
        )
        .bind(week, ...values, existing.game_id)
    : db
        .prepare(
          `INSERT INTO gotw_weeks (week_key, game_id, title, edition, cover_image_id, mode, pool_size, selected_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (week_key) DO NOTHING`,
        )
        .bind(week, ...values);
  const res = await write.run();
  if (res.meta.changes) {
    await db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         VALUES ('gotw', ?1, 'system', 'gotw', ?2, ?3, ?4, 'gotw', ?5)`,
      )
      .bind(
        week,
        existing ? 'gotw.reselected' : 'gotw.selected',
        existing ? JSON.stringify({ game_id: existing.game_id }) : null,
        JSON.stringify({ game_id: chosen.game_id, mode, pool_size: eligible.length }),
        now.toISOString(),
      )
      .run();
  }
  // Whoever won a race, this is the week's pick.
  return db.prepare('SELECT * FROM gotw_weeks WHERE week_key = ?1').bind(week).first<WeekRow>();
}

/**
 * This week's game. Picked on first request of the week (and by the hourly
 * check in the Cron Trigger). A pick that has since been retired or taken out
 * of Game of the Week is replaced, once, by a new pick.
 */
export async function currentGotw(db: D1Database, now: Date): Promise<Gotw | null> {
  const week = weekKey(now);
  if (!(await isLive(db))) {
    const game = PREVIEW_GAMES.find(g => g.slug === PREVIEW_GOTW)!;
    return { week_key: week, game, snapshot: { title: game.title, edition: null, cover: null }, archived: false, preview: true };
  }
  let row = await db.prepare('SELECT * FROM gotw_weeks WHERE week_key = ?1').bind(week).first<WeekRow>();
  let game = row ? await db.prepare(`SELECT * FROM games WHERE game_id = ?1`).bind(row.game_id).first<GameRow>() : null;
  const usable = (g: GameRow | null) => !!g && g.verification_status === 'confirmed' && !g.retired_at && g.available_for_gotw === 1;
  if (!row || !usable(game)) {
    row = await choose(db, week, now, row);
    game = row ? await db.prepare(`SELECT * FROM games WHERE game_id = ?1`).bind(row.game_id).first<GameRow>() : null;
  }
  if (!row) return null;
  const live = game && game.verification_status === 'confirmed' && !game.retired_at ? toPublic(game) : null;
  return {
    week_key: row.week_key,
    game: live,
    snapshot: { title: row.title, edition: row.edition, cover: row.cover_image_id ? `/images/games/${row.cover_image_id}` : null },
    archived: !live,
  };
}

/** Past weeks, newest first, for admins. */
export async function gotwHistory(db: D1Database, limit = 26) {
  const { results } = await db.prepare('SELECT * FROM gotw_weeks ORDER BY week_key DESC LIMIT ?1').bind(limit).all<WeekRow>();
  return results;
}
