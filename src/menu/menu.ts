// The café's food and drinks menu (docs/RTD_FOOD_MENU.md). Browse only: the
// public reads it, nobody orders through it. Prices are in pence; an item
// without a single price shows its price note instead, never a guess.
// Admins switch the whole menu Off, Preview or Live; every change is audited.

import type { AuthUser } from '../lib/auth';

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

interface CategoryRow {
  category_id: string;
  name: string;
  description: string | null;
  alcohol: number;
  image_url: string | null;
  image_alt: string | null;
  sort_order: number;
  visible: number;
}

interface ItemRow {
  item_id: string;
  category_id: string;
  name: string;
  options: string | null;
  description: string | null;
  price_pence: number | null;
  price_note: string | null;
  alcohol: number;
  image_url: string | null;
  image_alt: string | null;
  sort_order: number;
  visible: number;
  available: number;
  source_text: string;
}

interface VariantRow {
  item_id: string;
  label: string;
  price_pence: number;
}

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

async function readMenu(db: D1Database, withHidden: boolean) {
  const shown = withHidden ? '' : 'WHERE visible = 1';
  const [cats, items, variants] = await db.batch([
    db.prepare(`SELECT * FROM menu_categories ${shown} ORDER BY sort_order, name`),
    db.prepare(`SELECT * FROM menu_items ${shown} ORDER BY sort_order, name`),
    db.prepare('SELECT item_id, label, price_pence FROM menu_item_variants ORDER BY sort_order, label'),
  ]);
  return {
    categories: cats!.results as unknown as CategoryRow[],
    items: items!.results as unknown as ItemRow[],
    variants: variants!.results as unknown as VariantRow[],
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

/** Everything, hidden rows included, with each line as transcribed, for checking against the board. */
export async function adminMenu(db: D1Database) {
  const [status, setting, rows] = await Promise.all([
    menuStatus(db),
    db.prepare("SELECT updated_at, updated_by FROM settings WHERE key = 'food_menu_status'").first<{ updated_at: string; updated_by: string | null }>(),
    readMenu(db, true),
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
    status_changed_at: setting?.updated_at ?? null,
    status_changed_by: setting?.updated_by ?? null,
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
