// The food and drinks menu as the café keeps it: the RTD Food Menu Google
// Sheet (docs/RTD_FOOD_MENU.md). n8n RTD Menu Sync reads its two tabs and posts
// the rows here; this turns them into the menu the app stores, or says exactly
// which rows are wrong. One bad row refuses the whole copy, so the menu in the
// app is always one the sheet held in full; a price is never guessed.

export interface MenuCategoryRow {
  category_id: string;
  name: string;
  description: string | null;
  alcohol: number;
  image_url: string | null;
  image_alt: string | null;
  sort_order: number;
  visible: number;
}

export interface MenuItemRow {
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

export interface MenuVariantRow {
  item_id: string;
  label: string;
  price_pence: number;
}

export interface MenuData {
  categories: MenuCategoryRow[];
  items: MenuItemRow[];
  variants: MenuVariantRow[];
}

const MAX_SECTIONS = 50;
const MAX_ITEMS = 500;
const MAX_ERRORS = 20;
const MAX_PENCE = 100_000;

type Row = Record<string, unknown>;

/** "Beer & cider" → "beer-cider": the section's page anchor. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const text = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** Y / N, yes / no, TRUE / FALSE (a ticked box), or empty for the default. */
function flag(v: unknown, fallback: boolean): boolean | undefined {
  if (v === true || v === false) return v;
  const s = text(v, 10)?.toLowerCase();
  if (!s) return fallback;
  if (['y', 'yes', 'true', '1'].includes(s)) return true;
  if (['n', 'no', 'false', '0'].includes(s)) return false;
  return undefined;
}

/** 3.5, "3.50" or "£3.50" → 350. Empty → null. Anything else → undefined. */
function pence(v: unknown): number | null | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v * 100 <= MAX_PENCE ? Math.round(v * 100) : undefined;
  const s = text(v, 20)?.replace(/^£\s*/, '');
  if (!s) return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return undefined;
  const p = Math.round(Number(s) * 100);
  return p <= MAX_PENCE ? p : undefined;
}

const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r)) : []);
const blank = (r: Row) => Object.entries(r).every(([k, v]) => k === 'row_number' || text(v, 1) === null);
const rowNo = (r: Row, i: number) => (typeof r.row_number === 'number' ? r.row_number : i + 2);

export type SheetResult = { ok: true; menu: MenuData } | { ok: false; errors: string[] };

/**
 * Body: { sections: [{ Section, Description, Show }], items: [{ Section, Item,
 * Options, Description, Price, Single, Double, 'Price note', Alcohol, Show,
 * Available, Photo, 'Photo description', 'Menu wording' }] }, as n8n's Google
 * Sheets node returns each tab (row_number included).
 */
export function parseMenuSheet(body: unknown): SheetResult {
  const b = (body ?? {}) as { sections?: unknown; items?: unknown };
  const sectionRows = rowsOf(b.sections);
  const itemRows = rowsOf(b.items);
  const errors: string[] = [];
  const fail = (msg: string) => errors.length < MAX_ERRORS && errors.push(msg);

  const categories: MenuCategoryRow[] = [];
  const byName = new Map<string, MenuCategoryRow>();
  sectionRows.forEach((r, i) => {
    if (blank(r)) return;
    const at = `Sections row ${rowNo(r, i)}`;
    const name = text(r.Section, 60);
    const show = flag(r.Show, true);
    if (!name) return void fail(`${at}: the Section is empty.`);
    const id = slug(name);
    if (!id) return void fail(`${at}: "${name}" needs at least one letter or number.`);
    if (byName.has(name.toLowerCase()) || categories.some(c => c.category_id === id)) return void fail(`${at}: "${name}" is listed twice.`);
    if (show === undefined) return void fail(`${at} (${name}): Show must be Y or N.`);
    const c: MenuCategoryRow = {
      category_id: id,
      name,
      description: text(r.Description, 300),
      alcohol: 0,
      image_url: null,
      image_alt: null,
      sort_order: categories.length + 1,
      visible: show ? 1 : 0,
    };
    categories.push(c);
    byName.set(name.toLowerCase(), c);
  });
  if (categories.length > MAX_SECTIONS) fail(`There are ${categories.length} sections; the most the app takes is ${MAX_SECTIONS}.`);

  const items: MenuItemRow[] = [];
  const variants: MenuVariantRow[] = [];
  const ids = new Set<string>();
  itemRows.forEach((r, i) => {
    if (blank(r)) return;
    const name = text(r.Item, 120);
    const at = `Menu row ${rowNo(r, i)}${name ? ` (${name})` : ''}`;
    if (!name) return void fail(`${at}: the Item is empty.`);
    const sectionName = text(r.Section, 60);
    const c = sectionName ? byName.get(sectionName.toLowerCase()) : undefined;
    if (!sectionName) return void fail(`${at}: the Section is empty.`);
    if (!c) return void fail(`${at}: the Section "${sectionName}" isn't on the Sections tab.`);

    const price = pence(r.Price);
    const single = pence(r.Single);
    const double = pence(r.Double);
    const note = text(r['Price note'], 120);
    for (const [col, v, raw] of [
      ['Price', price, r.Price],
      ['Single', single, r.Single],
      ['Double', double, r.Double],
    ] as const)
      if (v === undefined) return void fail(`${at}: ${col} "${String(raw)}" isn't a price. Write it like 3.50.`);
    if (price !== null && (single !== null || double !== null)) return void fail(`${at}: give a Price, or Single and Double prices, not both.`);
    if (price === null && single === null && double === null && !note)
      return void fail(`${at}: there's no price. Give one, or say why in the Price note (for example "Individually priced").`);

    const alcohol = flag(r.Alcohol, false);
    const show = flag(r.Show, true);
    const available = flag(r.Available, true);
    for (const [col, v] of [
      ['Alcohol', alcohol],
      ['Show', show],
      ['Available', available],
    ] as const)
      if (v === undefined) return void fail(`${at}: ${col} must be Y or N.`);

    let id = `${c.category_id}--${slug(name) || 'item'}`;
    for (let n = 2; ids.has(id); n++) id = `${c.category_id}--${slug(name) || 'item'}-${n}`;
    ids.add(id);
    items.push({
      item_id: id,
      category_id: c.category_id,
      name,
      options: text(r.Options, 300),
      description: text(r.Description, 300),
      price_pence: price ?? null,
      price_note: note,
      alcohol: alcohol ? 1 : 0,
      image_url: text(r.Photo, 500),
      image_alt: text(r['Photo description'], 200),
      sort_order: items.length + 1,
      visible: show ? 1 : 0,
      available: available ? 1 : 0,
      source_text: text(r['Menu wording'], 300) ?? '',
    });
    if (single !== null) variants.push({ item_id: id, label: 'Single', price_pence: single! });
    if (double !== null) variants.push({ item_id: id, label: 'Double', price_pence: double! });
    if (alcohol) c.alcohol = 1;
  });
  if (items.length > MAX_ITEMS) fail(`There are ${items.length} menu rows; the most the app takes is ${MAX_ITEMS}.`);
  if (!errors.length && !items.length) fail('The Menu tab has no items. The app keeps the menu it has.');

  return errors.length ? { ok: false, errors } : { ok: true, menu: { categories, items, variants } };
}
