// The café's food and drinks menu in the app (docs/RTD_FOOD_MENU.md): types,
// prices as people read them, and the icon each section's placeholders use.

import { Beer, Coffee, CupSoda, GlassWater, Martini, Sandwich, UtensilsCrossed, Wine } from 'lucide-preact';

export type MenuStatus = 'off' | 'preview' | 'live';

export interface MenuPrice {
  /** "Single", "Double"; null for an item's one price. */
  label: string | null;
  price_pence: number;
}

export interface MenuItem {
  id: string;
  name: string;
  options: string | null;
  description: string | null;
  /** Empty when the menu gives no single price: see price_note. */
  prices: MenuPrice[];
  price_note: string | null;
  alcohol: boolean;
  available: boolean;
  image: string | null;
  image_alt: string | null;
}

export interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  alcohol: boolean;
  image: string | null;
  image_alt: string | null;
  items: MenuItem[];
}

export interface Menu {
  status: MenuStatus;
  as_of: string;
  categories: MenuCategory[];
}

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 });

/** 350 → "£3.50" */
export const price = (pence: number) => GBP.format(pence / 100);

/** Each section's icon, for its placeholders; anything new gets the knife and fork. */
const ICONS = {
  'hot-food': UtensilsCrossed,
  'cold-food': Sandwich,
  'hot-drinks': Coffee,
  'cold-drinks': CupSoda,
  spirits: Martini,
  'beer-cider': Beer,
  mixers: GlassWater,
  'wine-prosecco': Wine,
} as const;

export const categoryIcon = (id: string) => ICONS[id as keyof typeof ICONS] ?? UtensilsCrossed;

/** A copy older than this was saved earlier (offline): say so, as prices may have changed. */
const SAVED_COPY_MS = 15 * 60_000;

export const isSavedCopy = (m: Pick<Menu, 'as_of'>, now = Date.now()) => now - Date.parse(m.as_of) > SAVED_COPY_MS;
