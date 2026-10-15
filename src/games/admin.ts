// Looking after the game library: admins only (docs/GAME_LIBRARY_AUDIT.md).
// - The importer reads the manifest built from the source catalogue
//   (data/game-library-*.json): confirmed games into `games`, everything else
//   into the review register. A dry run shows the changes; applying them needs
//   a second, explicit confirmation, and is one transaction.
// - A title in the review register only becomes a live game when an admin
//   confirms the café owns it, with a note of how they know.
// - Every change is written to the audit log.

import masterFile from '../../data/game-library-master.json';
import reviewFile from '../../data/game-library-review.json';
import { sniffImageType } from '../images/store';
import type { AuthUser } from '../lib/auth';
import { LIVE_SQL } from './catalogue';
import { checkGame, IMAGE_RIGHTS, parseList, slugify, sourceKey, tidy, type GameInput, type GameRow } from './model';

// ---- The manifest ----

export interface ManifestGame {
  title: string;
  edition?: string | null;
  category: string;
  audiences?: string[];
  min_age?: number | null;
  min_players?: number | null;
  max_players?: number | null;
  play_time_min?: number | null;
  play_time_max?: number | null;
  synopsis: string;
  source_title?: string;
  source_evidence?: string | null;
  /** How the café's ownership is known (a photo, a staff check). Required for the live library. */
  ownership_evidence?: string | null;
  /** The source's search link: a lead for finding a cover, never an image address. */
  image_lookup?: string | null;
}

export interface ManifestReview extends Partial<ManifestGame> {
  title: string;
  kind: 'provisional' | 'uncertain';
  reasons: string[];
}

export interface Manifest {
  games: ManifestGame[];
  review: ManifestReview[];
}

/** The manifest committed with the app (data/). */
export const BUNDLED: Manifest = {
  games: (masterFile as { games: ManifestGame[] }).games,
  review: (reviewFile as { entries: ManifestReview[] }).entries,
};

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');

const audit = (db: D1Database, admin: string, entity: string, action: string, before: unknown, after: unknown, now: string) =>
  db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
       VALUES ('game', ?1, 'staff', ?2, ?3, ?4, ?5, 'organiser', ?6)`,
    )
    .bind(entity, admin, action, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), now);

const nextId = async (db: D1Database, table: 'games' | 'game_review', prefix: string) => {
  const col = table === 'games' ? 'game_id' : 'review_id';
  const row = await db.prepare(`SELECT MAX(CAST(substr(${col}, ${prefix.length + 1}) AS INTEGER)) AS n FROM ${table}`).first<{ n: number | null }>();
  const start = (row?.n ?? 0) + 1;
  return (i: number) => `${prefix}${String(start + i).padStart(5, '0')}`;
};

/** The columns a game's details fill. */
const DETAIL_COLUMNS = ['title', 'edition', 'category', 'audiences', 'min_age', 'min_players', 'max_players', 'play_time_min', 'play_time_max', 'synopsis'] as const;
const detailValues = (v: GameInput) => [v.title, v.edition, v.category, JSON.stringify(v.audiences), v.min_age, v.min_players, v.max_players, v.play_time_min, v.play_time_max, v.synopsis];

/** Slug for a new game: the title (and edition), with -2, -3… if taken. */
async function freeSlug(db: D1Database, title: string, edition: string | null, taken = new Set<string>()): Promise<string> {
  const base = slugify(title, edition);
  const { results } = await db.prepare("SELECT slug FROM games WHERE slug = ?1 OR slug LIKE ?1 || '-%'").bind(base).all<{ slug: string }>();
  const used = new Set([...results.map(r => r.slug), ...taken]);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

export interface ImportPlan {
  ok: boolean;
  source_sha256: string;
  errors: string[];
  counts: Record<string, number>;
  add: { title: string; edition: string | null }[];
  update: { game_id: string; title: string; changed: string[] }[];
  kept_admin_edits: string[];
  not_in_manifest: { game_id: string; title: string }[];
  review_add: string[];
  review_update: string[];
  review_kept: string[];
}

type Prepared = { key: string; input: GameInput; source: ManifestGame };

/** What an import would change. Writes nothing. */
export async function planImport(db: D1Database, manifest: Manifest = BUNDLED): Promise<ImportPlan & { prepared: Prepared[] }> {
  const errors: string[] = [];
  const prepared: Prepared[] = [];
  const keys = new Set<string>();
  manifest.games.forEach((g, i) => {
    const checked = checkGame({ ...g, available_for_chooser: true, available_for_gotw: true }, { publish: true });
    const label = `Game ${i + 1} (${tidy(g.title) || 'no title'})`;
    if (!checked.ok) return errors.push(`${label}: ${Object.values(checked.errors).join(' ')}`);
    if (tidy(g.ownership_evidence).length < 5) return errors.push(`${label}: no evidence that the café owns it.`);
    const key = sourceKey(checked.value.title, checked.value.edition);
    if (keys.has(key)) return errors.push(`${label}: listed twice.`);
    keys.add(key);
    prepared.push({ key, input: checked.value, source: g });
  });
  const reviewKeys = new Set<string>();
  manifest.review.forEach((r, i) => {
    const key = sourceKey(tidy(r.title), tidy(r.edition) || null);
    if (!tidy(r.title)) errors.push(`Review entry ${i + 1}: no title.`);
    else if (keys.has(key) || reviewKeys.has(key)) errors.push(`Review entry ${i + 1} (${r.title}): listed twice, or also listed as confirmed.`);
    else if (!['provisional', 'uncertain'].includes(r.kind)) errors.push(`Review entry ${i + 1} (${r.title}): kind must be provisional or uncertain.`);
    reviewKeys.add(key);
  });

  const [existing, reviews] = await db.batch([db.prepare('SELECT * FROM games'), db.prepare('SELECT review_id, source_key, status, entry, reasons, kind FROM game_review')]);
  const byKey = new Map((existing!.results as GameRow[]).filter(g => g.source_key).map(g => [g.source_key!, g]));
  const reviewByKey = new Map((reviews!.results as { review_id: string; source_key: string; status: string; entry: string; reasons: string; kind: string }[]).map(r => [r.source_key, r]));

  const plan: ImportPlan & { prepared: Prepared[] } = {
    ok: false,
    source_sha256: await sha256(JSON.stringify(manifest)),
    errors,
    counts: {},
    add: [],
    update: [],
    kept_admin_edits: [],
    not_in_manifest: [],
    review_add: [],
    review_update: [],
    review_kept: [],
    prepared,
  };
  for (const p of prepared) {
    const g = byKey.get(p.key);
    if (!g) {
      plan.add.push({ title: p.input.title, edition: p.input.edition });
      continue;
    }
    if (g.admin_edited_at) {
      plan.kept_admin_edits.push(g.game_id);
      continue;
    }
    const now = detailValues(p.input);
    const was = DETAIL_COLUMNS.map(c => (c === 'audiences' ? JSON.stringify(parseList(g.audiences)) : g[c]));
    const changed = DETAIL_COLUMNS.filter((_, i) => now[i] !== was[i]);
    if (changed.length) plan.update.push({ game_id: g.game_id, title: g.title, changed: [...changed] });
  }
  // Only games an import brought in: games an admin added or confirmed are their decisions, never retired by an import.
  for (const g of existing!.results as GameRow[]) {
    if (g.import_batch_id && g.source_key && !keys.has(g.source_key) && !reviewKeys.has(g.source_key) && !g.retired_at) {
      plan.not_in_manifest.push({ game_id: g.game_id, title: g.title });
    }
  }
  for (const r of manifest.review) {
    const key = sourceKey(tidy(r.title), tidy(r.edition) || null);
    const was = reviewByKey.get(key);
    if (byKey.has(key)) plan.review_kept.push(tidy(r.title));
    else if (!was) plan.review_add.push(tidy(r.title));
    else if (was.status !== 'open') plan.review_kept.push(tidy(r.title));
    else if (was.entry !== JSON.stringify(r) || was.reasons !== JSON.stringify(r.reasons ?? [])) plan.review_update.push(tidy(r.title));
  }
  plan.counts = {
    manifest_games: manifest.games.length,
    manifest_review: manifest.review.length,
    add: plan.add.length,
    update: plan.update.length,
    kept_admin_edits: plan.kept_admin_edits.length,
    not_in_manifest: plan.not_in_manifest.length,
    review_add: plan.review_add.length,
    review_update: plan.review_update.length,
    review_kept: plan.review_kept.length,
    errors: errors.length,
  };
  plan.ok = errors.length === 0;
  return plan;
}

/**
 * Applies the manifest in one transaction: new confirmed games added, imported
 * details updated (never over an admin's edits), review entries added or
 * refreshed (never once decided). With `retireMissing`, imported games no
 * longer in the manifest are retired (kept, hidden). Safe to run again.
 */
export async function applyImport(
  db: D1Database,
  admin: AuthUser,
  opts: { mode: 'dry_run' | 'apply'; retireMissing?: boolean; manifest?: Manifest },
  now: string,
) {
  const plan = await planImport(db, opts.manifest ?? BUNDLED);
  const { prepared, ...report } = plan;
  const batchId = `IMP-${now.replace(/\D/g, '').slice(0, 14)}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(16)}`;
  const logBatch = db
    .prepare('INSERT INTO game_import_batches (batch_id, mode, source_sha256, counts, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(batchId, opts.mode, plan.source_sha256, JSON.stringify(plan.counts), admin.email, now);
  if (opts.mode === 'dry_run' || !plan.ok) {
    await logBatch.run();
    return { ...report, batch_id: batchId, applied: false };
  }

  const gameId = await nextId(db, 'games', 'RTD-GAME-');
  const reviewId = await nextId(db, 'game_review', 'RTD-GREV-');
  const existing = new Map(((await db.prepare('SELECT game_id, source_key, admin_edited_at FROM games').all<GameRow>()).results).map(g => [g.source_key, g]));
  const statements: D1PreparedStatement[] = [logBatch];
  const taken = new Set<string>();
  let added = 0;
  for (const p of prepared) {
    const g = existing.get(p.key);
    if (g?.admin_edited_at) continue;
    if (g) {
      statements.push(
        db
          .prepare(
            `UPDATE games SET title = ?2, edition = ?3, category = ?4, audiences = ?5, min_age = ?6, min_players = ?7, max_players = ?8,
               play_time_min = ?9, play_time_max = ?10, synopsis = ?11, source_title = ?12, source_evidence = ?13, import_batch_id = ?14, updated_at = ?15
             WHERE game_id = ?1`,
          )
          .bind(g.game_id, ...detailValues(p.input), tidy(p.source.source_title) || p.input.title, tidy(p.source.source_evidence) || null, batchId, now),
      );
      continue;
    }
    const slug = await freeSlug(db, p.input.title, p.input.edition, taken);
    taken.add(slug);
    statements.push(
      db
        .prepare(
          `INSERT INTO games (game_id, slug, title, edition, category, audiences, min_age, min_players, max_players, play_time_min, play_time_max, synopsis,
             verification_status, available_for_chooser, available_for_gotw, source_key, source_title, source_evidence, ownership_evidence,
             confirmed_by, confirmed_at, import_batch_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'confirmed', 1, 1, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?18, ?18)`,
        )
        .bind(
          gameId(added++),
          slug,
          ...detailValues(p.input),
          p.key,
          tidy(p.source.source_title) || p.input.title,
          tidy(p.source.source_evidence) || null,
          tidy(p.source.ownership_evidence),
          `import by ${admin.email}`,
          now,
          batchId,
        ),
      // A title that was waiting for review and is now confirmed in the manifest.
      db
        .prepare("UPDATE game_review SET status = 'confirmed', game_id = ?2, decision_note = 'Confirmed in the manifest', decided_by = ?3, decided_at = ?4, updated_at = ?4 WHERE source_key = ?1 AND status = 'open'")
        .bind(p.key, gameId(added - 1), admin.email, now),
    );
  }
  let r = 0;
  const reviewKeys = new Set<string>();
  for (const entry of (opts.manifest ?? BUNDLED).review) {
    const key = sourceKey(tidy(entry.title), tidy(entry.edition) || null);
    reviewKeys.add(key);
    if (existing.has(key)) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO game_review (review_id, source_key, source_title, kind, entry, reasons, status, import_batch_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?8)
           ON CONFLICT (source_key) DO UPDATE SET entry = excluded.entry, reasons = excluded.reasons, kind = excluded.kind,
             import_batch_id = excluded.import_batch_id, updated_at = excluded.updated_at
           WHERE game_review.status = 'open'`,
        )
        .bind(reviewId(r++), key, tidy(entry.source_title) || tidy(entry.title), entry.kind, JSON.stringify(entry), JSON.stringify(entry.reasons ?? []), batchId, now),
    );
  }
  if (opts.retireMissing) {
    for (const g of plan.not_in_manifest) {
      statements.push(db.prepare('UPDATE games SET retired_at = ?2, updated_at = ?2 WHERE game_id = ?1 AND retired_at IS NULL').bind(g.game_id, now));
    }
  }
  statements.push(audit(db, admin.email, batchId, 'games.import_applied', null, { ...plan.counts, retired: opts.retireMissing ? plan.not_in_manifest.length : 0 }, now));
  await db.batch(statements);
  return { ...report, batch_id: batchId, applied: true, retired: opts.retireMissing ? plan.not_in_manifest.length : 0 };
}

// ---- The library, for admins ----

export async function adminLibrary(db: D1Database) {
  const [games, reviewCounts, live, batches] = await db.batch([
    db.prepare('SELECT * FROM games ORDER BY retired_at IS NOT NULL, title, edition'),
    db.prepare('SELECT status, COUNT(*) AS n FROM game_review GROUP BY status'),
    db.prepare("SELECT value FROM settings WHERE key = 'game_library_live'"),
    db.prepare('SELECT batch_id, mode, counts, created_by, created_at FROM game_import_batches ORDER BY created_at DESC LIMIT 5'),
  ]);
  return {
    live: (live!.results[0] as { value: string } | undefined)?.value === 'on',
    games: (games!.results as GameRow[]).map(g => ({ ...g, audiences: parseList(g.audiences) })),
    review: Object.fromEntries((reviewCounts!.results as { status: string; n: number }[]).map(r => [r.status, r.n])),
    imports: batches!.results,
    manifest: { games: BUNDLED.games.length, review: BUNDLED.review.length, status: (masterFile as { status?: string }).status ?? null },
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 413 | 415; error: string; errors?: Record<string, string> };

const evidenceOf = (body: unknown) => tidy((body as { ownership_evidence?: unknown } | null)?.ownership_evidence, 300);

/** A game added by hand: an admin vouches it's on the shelf. */
export async function createGame(db: D1Database, admin: AuthUser, body: unknown, now: string): Promise<Result<GameRow>> {
  const checked = checkGame(body, { publish: true });
  if (!checked.ok) return { ok: false, status: 400, error: 'Please check the game’s details.', errors: checked.errors };
  const evidence = evidenceOf(body);
  if (evidence.length < 5) return { ok: false, status: 400, error: 'Say how you know the café has it.', errors: { ownership_evidence: 'Say how you know the café has it, e.g. “On the shelf, checked today”.' } };
  const v = checked.value;
  const key = sourceKey(v.title, v.edition);
  const same = await db.prepare('SELECT retired_at FROM games WHERE source_key = ?1').bind(key).first<{ retired_at: string | null }>();
  if (same) {
    return { ok: false, status: 409, error: same.retired_at ? 'That game is in the library but retired: restore it instead.' : 'That game (and edition) is already in the library.' };
  }
  const id = (await nextId(db, 'games', 'RTD-GAME-'))(0);
  const slug = await freeSlug(db, v.title, v.edition);
  await db.batch([
    db
      .prepare(
        `INSERT INTO games (game_id, slug, title, edition, category, audiences, min_age, min_players, max_players, play_time_min, play_time_max, synopsis,
           verification_status, available_for_chooser, available_for_gotw, copies, source_key, source_title, ownership_evidence, confirmed_by, confirmed_at,
           admin_edited_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'confirmed', ?13, ?14, ?15, ?19, ?3, ?16, ?17, ?18, ?18, ?18, ?18)`,
      )
      // The same key as an import would give it, so a later import matches it instead of adding it twice.
      .bind(id, slug, ...detailValues(v), v.available_for_chooser ? 1 : 0, v.available_for_gotw ? 1 : 0, v.copies, evidence, admin.email, now, key),
    audit(db, admin.email, id, 'game.added', null, { ...v, ownership_evidence: evidence }, now),
  ]);
  return { ok: true, value: (await db.prepare('SELECT * FROM games WHERE game_id = ?1').bind(id).first<GameRow>())! };
}

export async function updateGame(db: D1Database, admin: AuthUser, id: string, body: unknown, now: string): Promise<Result<GameRow>> {
  const before = await db.prepare('SELECT * FROM games WHERE game_id = ?1').bind(id).first<GameRow>();
  if (!before) return { ok: false, status: 404, error: 'No game with that ID.' };
  const checked = checkGame(body, { publish: true });
  if (!checked.ok) return { ok: false, status: 400, error: 'Please check the game’s details.', errors: checked.errors };
  const v = checked.value;
  await db.batch([
    db
      .prepare(
        `UPDATE games SET title = ?2, edition = ?3, category = ?4, audiences = ?5, min_age = ?6, min_players = ?7, max_players = ?8, play_time_min = ?9,
           play_time_max = ?10, synopsis = ?11, available_for_chooser = ?12, available_for_gotw = ?13, copies = ?14, admin_edited_at = ?15, updated_at = ?15
         WHERE game_id = ?1`,
      )
      .bind(id, ...detailValues(v), v.available_for_chooser ? 1 : 0, v.available_for_gotw ? 1 : 0, v.copies, now),
    audit(
      db,
      admin.email,
      id,
      'game.updated',
      Object.fromEntries([...DETAIL_COLUMNS, 'available_for_chooser', 'available_for_gotw', 'copies'].map(k => [k, before[k as keyof GameRow]])),
      v,
      now,
    ),
  ]);
  return { ok: true, value: (await db.prepare('SELECT * FROM games WHERE game_id = ?1').bind(id).first<GameRow>())! };
}

/** Retire (hide everywhere, keep the record and its history) or bring back. */
export async function setRetired(db: D1Database, admin: AuthUser, id: string, retire: boolean, now: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE games SET retired_at = ?2, updated_at = ?3 WHERE game_id = ?1 AND (retired_at IS NULL) = ?4`)
    .bind(id, retire ? now : null, now, retire ? 1 : 0)
    .run();
  if (res.meta.changes) await audit(db, admin.email, id, retire ? 'game.retired' : 'game.restored', null, null, now).run();
  return res.meta.changes > 0;
}

// ---- The review register ----

export async function reviewList(db: D1Database, status: 'open' | 'confirmed' | 'rejected') {
  const { results } = await db
    .prepare('SELECT review_id, source_title, kind, entry, reasons, status, decision_note, decided_by, decided_at, game_id FROM game_review WHERE status = ?1 ORDER BY source_title')
    .bind(status)
    .all<Record<string, string | null>>();
  return results.map(r => ({ ...r, entry: JSON.parse(r.entry ?? '{}'), reasons: parseList(r.reasons) }));
}

/** An admin confirms the café owns a title: it becomes a live game with their evidence note. */
export async function confirmReview(db: D1Database, admin: AuthUser, reviewId: string, body: unknown, now: string): Promise<Result<GameRow>> {
  const entry = await db.prepare("SELECT * FROM game_review WHERE review_id = ?1 AND status = 'open'").bind(reviewId).first<{ source_key: string; source_title: string; entry: string }>();
  if (!entry) return { ok: false, status: 404, error: 'No open review entry with that ID.' };
  const checked = checkGame(body, { publish: true });
  if (!checked.ok) return { ok: false, status: 400, error: 'Fill in the details before confirming.', errors: checked.errors };
  const evidence = evidenceOf(body);
  if (evidence.length < 5) return { ok: false, status: 400, error: 'Say how you know the café has it.', errors: { ownership_evidence: 'Say how you know the café has it, e.g. “On the shelf, checked today”.' } };
  const v = checked.value;
  if (await db.prepare(`SELECT 1 FROM games WHERE source_key = ?1 OR (source_key IS NULL AND title = ?2 AND edition IS ?3 AND ${LIVE_SQL})`).bind(entry.source_key, v.title, v.edition).first()) {
    return { ok: false, status: 409, error: 'That game is already in the library.' };
  }
  const id = (await nextId(db, 'games', 'RTD-GAME-'))(0);
  const slug = await freeSlug(db, v.title, v.edition);
  const source = JSON.parse(entry.entry) as ManifestReview;
  const res = await db.batch([
    db
      .prepare(
        `INSERT INTO games (game_id, slug, title, edition, category, audiences, min_age, min_players, max_players, play_time_min, play_time_max, synopsis,
           verification_status, available_for_chooser, available_for_gotw, copies, source_key, source_title, source_evidence, ownership_evidence,
           confirmed_by, confirmed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'confirmed', ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?21, ?21)`,
      )
      .bind(id, slug, ...detailValues(v), v.available_for_chooser ? 1 : 0, v.available_for_gotw ? 1 : 0, v.copies, entry.source_key, entry.source_title,
        tidy(source.source_evidence) || null, evidence, admin.email, now),
    db
      .prepare("UPDATE game_review SET status = 'confirmed', game_id = ?2, decision_note = ?3, decided_by = ?4, decided_at = ?5, updated_at = ?5 WHERE review_id = ?1 AND status = 'open'")
      .bind(reviewId, id, evidence, admin.email, now),
    audit(db, admin.email, id, 'game.confirmed_from_review', { review_id: reviewId }, { ...v, ownership_evidence: evidence }, now),
  ]);
  if (!res[1]!.meta.changes) return { ok: false, status: 409, error: 'Someone else decided on it first.' };
  return { ok: true, value: (await db.prepare('SELECT * FROM games WHERE game_id = ?1').bind(id).first<GameRow>())! };
}

/** Most titles one bulk confirmation takes (the Review list's "Confirm ticked"). */
export const MAX_BULK_CONFIRM = 200;

/**
 * An admin confirms several titles at once, with one note of how they know the
 * café has them (a stocktake, say). Each goes live with the catalogue's details
 * as they are; a title whose details aren't complete enough to publish is left
 * open, to confirm one at a time with the details filled in. One transaction.
 */
export async function confirmReviews(
  db: D1Database,
  admin: AuthUser,
  body: unknown,
  now: string,
): Promise<Result<{ confirmed: { review_id: string; game_id: string; title: string }[]; needs_details: { review_id: string; title: string; errors: string[] }[] }>> {
  const b = (body && typeof body === 'object' ? body : {}) as { review_ids?: unknown };
  const ids = Array.isArray(b.review_ids) ? [...new Set(b.review_ids.filter((x): x is string => typeof x === 'string'))] : [];
  if (!ids.length || ids.length > MAX_BULK_CONFIRM) return { ok: false, status: 400, error: `Tick between 1 and ${MAX_BULK_CONFIRM} titles.` };
  const evidence = evidenceOf(body);
  if (evidence.length < 5) return { ok: false, status: 400, error: 'Say how you know the café has them.', errors: { ownership_evidence: 'Say how you know the café has them, e.g. “Stocktake, 16 Oct”.' } };

  const [open, existing] = await db.batch([
    db.prepare("SELECT review_id, source_key, source_title, entry FROM game_review WHERE status = 'open' AND review_id IN (SELECT value FROM json_each(?1)) ORDER BY review_id").bind(JSON.stringify(ids)),
    db.prepare('SELECT slug, source_key FROM games'),
  ]);
  const entries = open!.results as { review_id: string; source_key: string; source_title: string; entry: string }[];
  if (entries.length !== ids.length) return { ok: false, status: 409, error: 'Some of those titles have already been decided. Reload the list and try again.' };
  const inLibrary = new Set((existing!.results as { source_key: string | null }[]).map(g => g.source_key));
  const slugs = new Set((existing!.results as { slug: string }[]).map(g => g.slug));
  const gameId = await nextId(db, 'games', 'RTD-GAME-');

  const confirmed: { review_id: string; game_id: string; title: string }[] = [];
  const needs: { review_id: string; title: string; errors: string[] }[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const e of entries) {
    const source = JSON.parse(e.entry) as ManifestReview;
    const checked = checkGame({ ...source, available_for_chooser: true, available_for_gotw: true }, { publish: true });
    if (!checked.ok) {
      needs.push({ review_id: e.review_id, title: e.source_title, errors: Object.values(checked.errors) });
      continue;
    }
    if (inLibrary.has(e.source_key)) {
      needs.push({ review_id: e.review_id, title: e.source_title, errors: ['Already in the library.'] });
      continue;
    }
    const v = checked.value;
    const base = slugify(v.title, v.edition);
    let slug = base;
    for (let i = 2; slugs.has(slug); i++) slug = `${base}-${i}`;
    slugs.add(slug);
    const id = gameId(confirmed.length);
    confirmed.push({ review_id: e.review_id, game_id: id, title: v.title });
    statements.push(
      db
        .prepare(
          `INSERT INTO games (game_id, slug, title, edition, category, audiences, min_age, min_players, max_players, play_time_min, play_time_max, synopsis,
             verification_status, available_for_chooser, available_for_gotw, source_key, source_title, source_evidence, ownership_evidence,
             confirmed_by, confirmed_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'confirmed', 1, 1, ?13, ?14, ?15, ?16, ?17, ?18, ?18, ?18)`,
        )
        .bind(id, slug, ...detailValues(v), e.source_key, e.source_title, tidy(source.source_evidence) || null, evidence, admin.email, now),
      db
        .prepare("UPDATE game_review SET status = 'confirmed', game_id = ?2, decision_note = ?3, decided_by = ?4, decided_at = ?5, updated_at = ?5 WHERE review_id = ?1")
        .bind(e.review_id, id, evidence, admin.email, now),
      audit(db, admin.email, id, 'game.confirmed_from_review', { review_id: e.review_id, bulk: true }, { ...v, ownership_evidence: evidence }, now),
    );
  }
  if (statements.length) await db.batch(statements);
  return { ok: true, value: { confirmed, needs_details: needs } };
}

export async function rejectReview(db: D1Database, admin: AuthUser, reviewId: string, note: unknown, now: string): Promise<boolean> {
  const why = tidy(note, 300) || null;
  const res = await db
    .prepare("UPDATE game_review SET status = 'rejected', decision_note = ?2, decided_by = ?3, decided_at = ?4, updated_at = ?4 WHERE review_id = ?1 AND status = 'open'")
    .bind(reviewId, why, admin.email, now)
    .run();
  if (res.meta.changes) await audit(db, admin.email, reviewId, 'game.review_rejected', null, { note: why }, now).run();
  return res.meta.changes > 0;
}

// ---- Covers ----

const MAX_COVER_BYTES = 1_500_000;
const MAX_THUMB_BYTES = 300_000;

function decodeImage(v: unknown, max: number): { type: string; bytes: Uint8Array } | string {
  if (typeof v !== 'string') return 'No image was sent.';
  const b64 = v.replace(/^data:[^,]*,/, '');
  if (b64.length > Math.ceil((max * 4) / 3) + 4) return 'That image is too big.';
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch {
    return 'That image could not be read.';
  }
  const type = sniffImageType(bytes);
  return type && ['image/jpeg', 'image/png', 'image/webp'].includes(type) ? { type, bytes } : 'Covers must be JPEG, PNG or WebP images.';
}

const imageId = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * Attach a cover (and its thumbnail, both resized in the browser). It shows
 * publicly only once it's marked as matching the café's edition and its reuse
 * rights are approved; the source page and attribution are recorded either way.
 */
export async function attachCover(db: D1Database, kv: KVNamespace, admin: AuthUser, id: string, body: unknown, now: string): Promise<Result<GameRow>> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const game = await db.prepare('SELECT game_id FROM games WHERE game_id = ?1').bind(id).first();
  if (!game) return { ok: false, status: 404, error: 'No game with that ID.' };
  const cover = decodeImage(b.cover, MAX_COVER_BYTES);
  const thumb = decodeImage(b.thumb, MAX_THUMB_BYTES);
  if (typeof cover === 'string') return { ok: false, status: 415, error: cover };
  if (typeof thumb === 'string') return { ok: false, status: 415, error: thumb };
  const source = tidy(b.source_url, 500);
  let sourceUrl: string | null = null;
  try {
    sourceUrl = source ? new URL(source).href : null;
  } catch {
    return { ok: false, status: 400, error: 'The source page must be a web address.', errors: { source_url: 'Paste the address of the page the cover came from.' } };
  }
  if (!sourceUrl || !/^https?:/.test(sourceUrl)) return { ok: false, status: 400, error: 'Say where the cover came from.', errors: { source_url: 'Paste the address of the page the cover came from.' } };
  const rights = (IMAGE_RIGHTS as readonly string[]).includes(String(b.rights_status)) ? String(b.rights_status) : 'unknown';
  const status = b.matches_edition === true ? 'verified' : 'pending';
  const [coverId, thumbId] = await Promise.all([imageId(cover.bytes), imageId(thumb.bytes)]);
  await Promise.all([
    kv.put(`game:${coverId}`, cover.bytes, { metadata: { type: cover.type } }),
    kv.put(`game:${thumbId}`, thumb.bytes, { metadata: { type: thumb.type } }),
  ]);
  const attribution = tidy(b.attribution, 200) || null;
  await db.batch([
    db
      .prepare(
        `UPDATE games SET cover_image_id = ?2, thumb_image_id = ?3, image_source_url = ?4, image_attribution = ?5, image_rights_status = ?6,
           image_status = ?7, image_checked_at = ?8, updated_at = ?8 WHERE game_id = ?1`,
      )
      .bind(id, coverId, thumbId, sourceUrl, attribution, rights, status, now),
    audit(db, admin.email, id, 'game.cover_attached', null, { source_url: sourceUrl, attribution, rights_status: rights, image_status: status }, now),
  ]);
  return { ok: true, value: (await db.prepare('SELECT * FROM games WHERE game_id = ?1').bind(id).first<GameRow>())! };
}

/** Change a cover's rights or match status without uploading it again (e.g. permission arrives). */
export async function setCoverStatus(db: D1Database, admin: AuthUser, id: string, body: unknown, now: string): Promise<boolean> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const rights = (IMAGE_RIGHTS as readonly string[]).includes(String(b.rights_status)) ? String(b.rights_status) : null;
  if (!rights) return false;
  const status = b.matches_edition === true ? 'verified' : 'pending';
  const res = await db
    .prepare('UPDATE games SET image_rights_status = ?2, image_status = ?3, image_checked_at = ?4, updated_at = ?4 WHERE game_id = ?1 AND cover_image_id IS NOT NULL')
    .bind(id, rights, status, now)
    .run();
  if (res.meta.changes) await audit(db, admin.email, id, 'game.cover_status', null, { rights_status: rights, image_status: status }, now).run();
  return res.meta.changes > 0;
}

export async function removeCover(db: D1Database, admin: AuthUser, id: string, now: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE games SET cover_image_id = NULL, thumb_image_id = NULL, image_source_url = NULL, image_attribution = NULL, image_rights_status = 'unknown',
         image_status = 'placeholder', image_checked_at = ?2, updated_at = ?2 WHERE game_id = ?1 AND cover_image_id IS NOT NULL`,
    )
    .bind(id, now)
    .run();
  if (res.meta.changes) await audit(db, admin.email, id, 'game.cover_removed', null, null, now).run();
  return res.meta.changes > 0;
}

export async function readCover(kv: KVNamespace, imageId: string): Promise<{ body: ReadableStream; type: string } | null> {
  if (!/^[a-f0-9]{32}$/.test(imageId)) return null;
  const found = await kv.getWithMetadata<{ type?: string }>(`game:${imageId}`, 'stream');
  return found.value ? { body: found.value, type: found.metadata?.type ?? 'image/jpeg' } : null;
}

// ---- Going live ----

/** Swap the public app between the preview shelf and the café's library. */
export async function setLive(db: D1Database, admin: AuthUser, on: boolean, now: string): Promise<Result<{ live: boolean }>> {
  if (on) {
    const ready = await db.prepare(`SELECT COUNT(*) AS n FROM games WHERE ${LIVE_SQL} AND available_for_chooser = 1`).first<{ n: number }>();
    if (!ready?.n) return { ok: false, status: 409, error: 'There are no confirmed games for Roll Me a Game yet. Confirm some first.' };
  }
  await db.batch([
    db
      .prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('game_library_live', ?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
      .bind(on ? 'on' : 'off', now, admin.email),
    audit(db, admin.email, 'game_library_live', on ? 'games.library_live' : 'games.library_preview', null, { live: on }, now),
  ]);
  return { ok: true, value: { live: on } };
}
