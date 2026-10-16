// The café's food and drinks menu (docs/RTD_FOOD_MENU.md). Browse only: the
// public reads it, nobody orders through it. Prices are in pence; an item
// without a single price shows its price note instead, never a guess.
// The menu itself is the RTD Food Menu Google Sheet (sheet.ts), copied here by
// n8n; admins switch the whole menu Off, Preview or Live. Every change is audited.

import type { AuthUser } from '../lib/auth';
import { parseMenuSheet, type MenuCategoryRow, type MenuData, type MenuItemRow, type MenuVariantRow } from './sheet';

export type MenuStatus = 'off' | 'preview' | 'live';
export const MENU_STATUSES: MenuStatus[] = ['off', 'preview', 'live'];

export interface MenuPrice {
  /** "Single", "Double"; null for an item's one price. */
  label: string | null;
  price_pence: number;
}

export interface PublicMenuItem {
  id: string;
  name: string;
  options: string | null;
  description: string | null;
  /** Empty when the menu gives no single price: see price_note. */
  prices: MenuPrice[];
  price_note: string | null;
  alcohol: boolean;
  /** Listed, but not available right now. */
  available: boolean;
  image: string | null;
  image_alt: string | null;
}

export interface PublicMenuCategory {
  id: string;
  name: string;
  description: string | null;
  alcohol: boolean;
  image: string | null;
  image_alt: string | null;
  items: PublicMenuItem[];
}

export interface PublicMenu {
  status: MenuStatus;
  /** When the server answered: an offline copy can say how old it is. */
  as_of: string;
  categories: PublicMenuCategory[];
}

type CategoryRow = MenuCategoryRow;
type ItemRow = MenuItemRow;
type VariantRow = MenuVariantRow;

/**
 * Only the app's own images or an https address reach the page; anything else
 * (javascript:, data:, http:, odd characters) is dropped and the placeholder shows.
 */
export function safeImage(url: string | null): string | null {
  if (!url) return null;
  const u = url.trim();
  if (/[\s"'<>\\]/.test(u)) return null;
  if (/^\/images\/[A-Za-z0-9/_.-]+$/.test(u) && !u.includes('..')) return u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The menu's switch. Anything unexpected in settings reads as Off. */
export async function menuStatus(db: D1Database): Promise<MenuStatus> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'food_menu_status'").first<{ value: string }>();
  return MENU_STATUSES.includes(row?.value as MenuStatus) ? (row!.value as MenuStatus) : 'off';
}

/** The menu as last copied from the sheet, stored in settings; none yet reads as empty. */
interface StoredMenu extends MenuData {
  synced_at: string;
  sheet_url: string | null;
}

/** How the last copy from the sheet went, for the organiser. */
interface SyncState {
  at: string;
  ok: boolean;
  errors: string[];
}

async function setting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

const bySort = <T extends { sort_order: number; name: string }>(a: T, b: T) => a.sort_order - b.sort_order || a.name.localeCompare(b.name);

async function readMenu(db: D1Database, withHidden: boolean) {
  const stored = await setting<StoredMenu>(db, 'food_menu');
  const shown = <T extends { visible: number }>(rows: T[] | undefined) => (rows ?? []).filter(r => withHidden || r.visible === 1);
  return {
    categories: shown(stored?.categories).sort(bySort),
    items: shown(stored?.items).sort(bySort),
    variants: stored?.variants ?? [],
    synced_at: stored?.synced_at ?? null,
    sheet_url: stored?.sheet_url ?? null,
  };
}

function pricesOf(item: ItemRow, variants: Map<string, VariantRow[]>): MenuPrice[] {
  const own = variants.get(item.item_id);
  if (own?.length) return own.map(v => ({ label: v.label, price_pence: v.price_pence }));
  return item.price_pence === null ? [] : [{ label: null, price_pence: item.price_pence }];
}

const toItem = (i: ItemRow, variants: Map<string, VariantRow[]>): PublicMenuItem => ({
  id: i.item_id,
  name: i.name,
  options: i.options,
  description: i.description,
  prices: pricesOf(i, variants),
  price_note: i.price_note,
  alcohol: i.alcohol === 1,
  available: i.available === 1,
  image: safeImage(i.image_url),
  image_alt: i.image_alt,
});

function group(rows: Awaited<ReturnType<typeof readMenu>>) {
  const variants = new Map<string, VariantRow[]>();
  for (const v of rows.variants) variants.set(v.item_id, [...(variants.get(v.item_id) ?? []), v]);
  const byCategory = new Map<string, ItemRow[]>();
  for (const i of rows.items) byCategory.set(i.category_id, [...(byCategory.get(i.category_id) ?? []), i]);
  return { variants, byCategory };
}

/**
 * What the public sees: visible categories, in order, each with its visible
 * items in order. A category with nothing visible is left out. Off: no categories.
 */
export async function publicMenu(db: D1Database, now: Date): Promise<PublicMenu> {
  const status = await menuStatus(db);
  if (status === 'off') return { status, as_of: now.toISOString(), categories: [] };
  const rows = await readMenu(db, false);
  const { variants, byCategory } = group(rows);
  const categories = rows.categories
    .map(c => ({
      id: c.category_id,
      name: c.name,
      description: c.description,
      alcohol: c.alcohol === 1,
      image: safeImage(c.image_url),
      image_alt: c.image_alt,
      items: (byCategory.get(c.category_id) ?? []).map(i => toItem(i, variants)),
    }))
    .filter(c => c.items.length > 0);
  return { status, as_of: now.toISOString(), categories };
}

// ---- For admins ----

/** Everything, hidden rows included, with each line's menu wording, for checking against the board; and how the sheet copy went. */
export async function adminMenu(db: D1Database) {
  const [status, statusRow, rows, sync] = await Promise.all([
    menuStatus(db),
    db.prepare("SELECT updated_at, updated_by FROM settings WHERE key = 'food_menu_status'").first<{ updated_at: string; updated_by: string | null }>(),
    readMenu(db, true),
    setting<SyncState>(db, 'food_menu_sync'),
  ]);
  const { variants, byCategory } = group(rows);
  const categories = rows.categories.map(c => ({
    id: c.category_id,
    name: c.name,
    visible: c.visible === 1,
    alcohol: c.alcohol === 1,
    // Shown on the public menu: the item and its category both visible.
    items: (byCategory.get(c.category_id) ?? []).map(i => ({ ...toItem(i, variants), shown: i.visible === 1 && c.visible === 1, source_text: i.source_text })),
  }));
  const items = categories.flatMap(c => c.items);
  return {
    status,
    status_changed_at: statusRow?.updated_at ?? null,
    status_changed_by: statusRow?.updated_by ?? null,
    sheet: {
      url: rows.sheet_url,
      // When the menu in the app last changed, and how the latest copy went.
      changed_at: rows.synced_at,
      checked_at: sync?.at ?? null,
      ok: sync?.ok ?? null,
      errors: sync?.errors ?? [],
    },
    counts: {
      categories: categories.length,
      items: items.length,
      hidden: items.filter(i => !i.shown).length,
      unavailable: items.filter(i => !i.available).length,
      no_price: items.filter(i => !i.prices.length).length,
    },
    categories,
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 409; error: string };

/** Admins only: Off, Preview or Live. */
export async function setMenuStatus(db: D1Database, admin: AuthUser, body: unknown, now: Date): Promise<Result<{ status: MenuStatus }>> {
  if (admin.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can switch the menu.' };
  const wanted = (body as { status?: unknown } | null)?.status;
  if (!MENU_STATUSES.includes(wanted as MenuStatus)) return { ok: false, status: 400, error: 'Send { status: "off" | "preview" | "live" }.' };
  const status = wanted as MenuStatus;
  const before = await menuStatus(db);
  if (before === status)
    return { ok: false, status: 409, error: `The menu is already ${status === 'off' ? 'off' : status === 'live' ? 'live' : 'in preview'}.` };
  const at = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('food_menu_status', ?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(status, at, admin.email),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         VALUES ('setting', 'food_menu_status', 'staff', ?1, 'menu.status_changed', ?2, ?3, 'organiser', ?4)`,
      )
      .bind(admin.email, JSON.stringify({ status: before }), JSON.stringify({ status }), at),
  ]);
  return { ok: true, value: { status } };
}

// ---- From the sheet (n8n RTD Menu Sync) ----

const SHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_#=?&/-]*)?$/;

const upsertSetting = (db: D1Database, key: string, value: string, at: string) =>
  db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, 'n8n')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key, value, at);

/** Names of lines added, removed or changed between two copies, for the audit log. */
function changedLines(before: MenuData | null, after: MenuData): { added: string[]; removed: string[]; changed: string[] } {
  const line = (m: MenuData | null) => {
    const out = new Map<string, string>();
    for (const i of m?.items ?? [])
      out.set(i.item_id, JSON.stringify([i, (m?.variants ?? []).filter(v => v.item_id === i.item_id), m?.categories.find(c => c.category_id === i.category_id)]));
    return out;
  };
  const was = line(before);
  const now = line(after);
  const name = (id: string, m: MenuData | null) => m?.items.find(i => i.item_id === id)?.name ?? id;
  return {
    added: [...now.keys()].filter(id => !was.has(id)).map(id => name(id, after)),
    removed: [...was.keys()].filter(id => !now.has(id)).map(id => name(id, before)),
    changed: [...now.keys()].filter(id => was.has(id) && was.get(id) !== now.get(id)).map(id => name(id, after)),
  };
}

/**
 * A full copy of the RTD Food Menu sheet. A good copy replaces the menu (and is
 * audited when anything changed); a bad one changes nothing and is reported,
 * to n8n and in the organiser, row by row.
 */
export async function storeMenuFromSheet(
  db: D1Database,
  body: unknown,
  now: Date,
): Promise<{ ok: true; items: number; changed: boolean } | { ok: false; errors: string[] }> {
  const at = now.toISOString();
  const parsed = parseMenuSheet(body);
  if (!parsed.ok) {
    await upsertSetting(db, 'food_menu_sync', JSON.stringify({ at, ok: false, errors: parsed.errors } satisfies SyncState), at).run();
    return { ok: false, errors: parsed.errors };
  }
  const rawUrl = (body as { sheet_url?: unknown }).sheet_url;
  const before = await setting<StoredMenu>(db, 'food_menu');
  const sheet_url = typeof rawUrl === 'string' && SHEET_URL.test(rawUrl) ? rawUrl : (before?.sheet_url ?? null);
  const diff = changedLines(before, parsed.menu);
  const sections = (m: MenuData | null) => JSON.stringify(m?.categories ?? []);
  const changed = diff.added.length + diff.removed.length + diff.changed.length > 0 || sections(before) !== sections(parsed.menu);
  const writes = [upsertSetting(db, 'food_menu_sync', JSON.stringify({ at, ok: true, errors: [] } satisfies SyncState), at)];
  if (changed || sheet_url !== (before?.sheet_url ?? null)) {
    const stored: StoredMenu = { ...parsed.menu, synced_at: changed ? at : (before?.synced_at ?? at), sheet_url };
    writes.push(upsertSetting(db, 'food_menu', JSON.stringify(stored), at));
  }
  if (changed)
    writes.push(
      db
        .prepare(
          `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
           VALUES ('setting', 'food_menu', 'n8n', 'RTD Menu Sync', 'menu.updated', ?1, ?2, 'sheet', ?3)`,
        )
        .bind(
          JSON.stringify({ items: before?.items.length ?? 0 }),
          JSON.stringify({ items: parsed.menu.items.length, added: diff.added.slice(0, 50), removed: diff.removed.slice(0, 50), changed: diff.changed.slice(0, 50) }),
          at,
        ),
    );
  await db.batch(writes);
  return { ok: true, items: parsed.menu.items.length, changed };
}
