import { beforeEach, describe, expect, it } from 'vitest';
import { safeImage, type PublicMenu } from '../src/menu/menu';
import { env, freshDb, request } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // host
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const menu = async () => (await request('/api/menu')).json<PublicMenu>();
const items = (m: PublicMenu) => m.categories.flatMap(c => c.items);
const byName = (m: PublicMenu, name: string) => items(m).find(i => i.name === name)!;

/**
 * Every price in the brief (RTD_FOOD_MENU_OFFERS-1.md), written out again here
 * rather than read from the migration, so a typo in either shows up.
 */
const BRIEF_PRICES: [string, number][] = [
  ['Bacon bun', 350],
  ['Sausage / vegetarian sausage bun', 350],
  ['All day breakfast', 650],
  ['Toast', 125],
  ['Toasted teacake', 300],
  ['Fries', 250],
  ['Cheesy fries', 275],
  ['Pizza', 600],
  ['Beef / vegetarian burger', 700],
  ['Nachos & 3 dips', 425],
  ['Jacket potato', 575],
  ['Sandwiches', 375],
  ['Tea', 220],
  ['Decaf tea', 220],
  ['Speciality teas', 240],
  ['Hot chocolate', 275],
  ['Flavoured hot chocolate', 300],
  ['Black / white Americano', 270],
  ['Decaf coffee', 270],
  ['Latte / cappuccino', 300],
  ['Flat white / mocha', 300],
  ['Iced latte', 300],
  ['Ice cream milkshake', 275],
  ['Orange / apple carton', 150],
  ['Fruit Shoot', 150],
  ['J2O', 250],
  ['Bottled water', 150],
  ['Coke float', 175],
  ['Clap Clap Fish Pale Ale', 420],
  ['Hard Graft Pale Ale', 420],
  ['Overtime Craft Lager', 420],
  ['Mango Cider', 450],
  ['Kopparberg Strawberry & Lime', 440],
  ['Kopparberg Mixed Fruit', 440],
  ['Kopparberg 0%', 300],
  ['Budweiser', 300],
  ['Stella', 300],
  ['Boddingtons', 300],
  ['Corona 0%', 300],
  ['Guinness', 350],
  ['Tonic water', 180],
  ['Monster Original', 250],
  ['Red wine', 450],
  ['Rosé wine', 450],
  ['White wine', 450],
  ['Prosecco', 500],
];
const SPIRITS = ['Gin', 'Vodka', 'Sourz', 'Disaronno', "Jack Daniel's", 'Captain Morgan Spiced Rum', 'Bacardi White Rum', 'Archers Peach Schnapps'];
const NO_PRICE = ['Cupcakes, doughnuts and gluten-free cakes', 'Crisps & chocolate', 'Homemade cakes'];

beforeEach(async () => {
  await freshDb();
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
  ]);
});

describe('the public menu', () => {
  it('lists every category in order, starting in Preview', async () => {
    const res = await request('/api/menu');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const m = await res.json<PublicMenu>();
    expect(m.status).toBe('preview');
    expect(m.categories.map(c => c.name)).toEqual([
      'Hot food',
      'Cold food',
      'Hot drinks',
      'Cold drinks',
      'Spirits',
      'Beer & cider',
      'Mixers',
      'Wine & prosecco',
    ]);
    expect(items(m)).toHaveLength(59);
    expect(new Date(m.as_of).getTime()).toBeGreaterThan(0);
  });

  it('has every price in the brief, exactly', async () => {
    const m = await menu();
    for (const [name, pence] of BRIEF_PRICES) {
      const item = byName(m, name);
      expect(item, name).toBeTruthy();
      expect(item.prices, name).toEqual([{ label: null, price_pence: pence }]);
    }
    // Soft drinks appear twice: priced under Cold drinks, pointed to under Mixers.
    const soft = items(m).filter(i => i.name === 'Soft drinks');
    expect(soft.map(i => i.prices)).toEqual([[{ label: null, price_pence: 200 }], []]);
    expect(soft[1]!.price_note).toBe('As priced under Cold drinks');
  });

  it('prices every spirit by the single and the double', async () => {
    const m = await menu();
    const spirits = m.categories.find(c => c.id === 'spirits')!;
    expect(spirits.items.map(i => i.name)).toEqual(SPIRITS);
    for (const s of spirits.items) {
      expect(s.prices).toEqual([
        { label: 'Single', price_pence: 400 },
        { label: 'Double', price_pence: 600 },
      ]);
    }
  });

  it('never invents a price: "individually priced" lines have none', async () => {
    const m = await menu();
    for (const name of NO_PRICE) {
      expect(byName(m, name).prices).toEqual([]);
      expect(byName(m, name).price_note).toBe('Individually priced');
    }
    // Every line has a price, or says why it hasn't.
    for (const i of items(m)) expect(i.prices.length > 0 || !!i.price_note, i.name).toBe(true);
  });

  it('marks alcohol, but not the 0% drinks', async () => {
    const m = await menu();
    expect(m.categories.filter(c => c.alcohol).map(c => c.id)).toEqual(['spirits', 'beer-cider', 'wine']);
    const alcoholic = items(m)
      .filter(i => i.alcohol)
      .map(i => i.name);
    expect(alcoholic).toContain('Gin');
    expect(alcoholic).toContain('Prosecco');
    expect(alcoholic).toContain('Guinness');
    expect(alcoholic).not.toContain('Kopparberg 0%');
    expect(alcoholic).not.toContain('Corona 0%');
    expect(alcoholic).not.toContain('Tonic water');
    expect(alcoholic).toHaveLength(8 + 10 + 4);
  });

  it('keeps choices and descriptions apart from the name', async () => {
    const m = await menu();
    expect(byName(m, 'Pizza').options).toBe('Cheese or pepperoni');
    expect(byName(m, 'Beef / vegetarian burger').description).toBe('Served with fries or side salad.');
    expect(byName(m, 'Jacket potato')).toMatchObject({ options: 'Choice of cheese, beans or tuna mayo', description: 'Served with side salad.' });
  });

  it('has no photos yet, and nothing to order', async () => {
    const m = await menu();
    for (const c of m.categories) expect(c.image).toBeNull();
    for (const i of items(m)) {
      expect(i.image).toBeNull();
      expect(Object.keys(i).sort()).toEqual(['alcohol', 'available', 'description', 'id', 'image', 'image_alt', 'name', 'options', 'price_note', 'prices']);
    }
    expect((await request('/api/menu', json({ item: 'RTD-MENU-00001' }))).status).toBe(404);
  });

  it('leaves out hidden items and hidden categories, and marks unavailable ones', async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE menu_items SET visible = 0 WHERE name = 'Toast'"),
      env.DB.prepare("UPDATE menu_items SET available = 0 WHERE name = 'Iced latte'"),
      env.DB.prepare("UPDATE menu_categories SET visible = 0 WHERE category_id = 'wine'"),
      env.DB.prepare("UPDATE menu_items SET visible = 0 WHERE category_id = 'mixers'"),
    ]);
    const m = await menu();
    expect(items(m).map(i => i.name)).not.toContain('Toast');
    expect(byName(m, 'Iced latte').available).toBe(false);
    expect(byName(m, 'Tea').available).toBe(true);
    // A hidden category, and one with nothing visible, are left out altogether.
    expect(m.categories.map(c => c.id)).not.toContain('wine');
    expect(m.categories.map(c => c.id)).not.toContain('mixers');
    expect(items(m)).toHaveLength(59 - 1 - 4 - 3);
  });

  it('follows the sort order set for categories and items', async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE menu_categories SET sort_order = 5 WHERE category_id = 'hot-drinks'"),
      env.DB.prepare("UPDATE menu_items SET sort_order = 1 WHERE name = 'Iced latte'"),
    ]);
    const m = await menu();
    expect(m.categories[0]!.id).toBe('hot-drinks');
    expect(m.categories[0]!.items[0]!.name).toBe('Iced latte');
  });

  it('shows nothing when the menu is off, and reads anything unknown as off', async () => {
    await env.DB.prepare("UPDATE settings SET value = 'off' WHERE key = 'food_menu_status'").run();
    expect(await menu()).toMatchObject({ status: 'off', categories: [] });
    await env.DB.prepare("UPDATE settings SET value = 'sideways' WHERE key = 'food_menu_status'").run();
    expect(await menu()).toMatchObject({ status: 'off', categories: [] });
    await env.DB.prepare("UPDATE settings SET value = 'live' WHERE key = 'food_menu_status'").run();
    expect((await menu()).status).toBe('live');
  });

  it('only passes on safe image addresses', async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE menu_items SET image_url = '/images/abc123', image_alt = 'A bacon bun' WHERE name = 'Bacon bun'"),
      env.DB.prepare("UPDATE menu_items SET image_url = 'javascript:alert(1)' WHERE name = 'Toast'"),
      env.DB.prepare("UPDATE menu_categories SET image_url = 'https://example.com/hot.jpg' WHERE category_id = 'hot-food'"),
    ]);
    const m = await menu();
    expect(byName(m, 'Bacon bun')).toMatchObject({ image: '/images/abc123', image_alt: 'A bacon bun' });
    expect(byName(m, 'Toast').image).toBeNull();
    expect(m.categories[0]!.image).toBe('https://example.com/hot.jpg');
  });

  it('checks image addresses', () => {
    expect(safeImage('/images/games/abc_1.webp')).toBe('/images/games/abc_1.webp');
    expect(safeImage('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
    for (const bad of [
      'http://example.com/a.jpg',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      '/images/../api/staff',
      '/brand/x.png',
      'https://user:pw@example.com/a.jpg',
      '/images/a"onerror="x',
      '',
      null,
    ]) {
      expect(safeImage(bad), String(bad)).toBeNull();
    }
  });
});

describe('the menu for admins', () => {
  it('only admins see it or switch it, checked on the server', async () => {
    expect((await request('/api/staff/menu')).status).toBe(401);
    expect((await request('/api/staff/menu', {}, SAM)).status).toBe(403);
    expect((await request('/api/staff/menu', {}, MICHELLE)).status).toBe(403);
    expect((await request('/api/staff/menu/status', json({ status: 'live' }), MICHELLE)).status).toBe(403);
    expect((await request('/api/staff/menu/status', json({ status: 'off' }), SAM)).status).toBe(403);
    expect((await menu()).status).toBe('preview');

    const res = await request('/api/staff/menu', {}, DAN);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const admin = await res.json<{ status: string; counts: Record<string, number>; categories: { items: { source_text: string }[] }[] }>();
    expect(admin.status).toBe('preview');
    expect(admin.counts).toEqual({ categories: 8, items: 59, hidden: 0, unavailable: 0, no_price: 4 });
    expect(admin.categories[0]!.items[0]!.source_text).toBe('Bacon bun — £3.50');
  });

  it('counts hidden lines, including those in a hidden category', async () => {
    await env.DB.batch([
      env.DB.prepare("UPDATE menu_items SET visible = 0 WHERE name = 'Toast'"),
      env.DB.prepare("UPDATE menu_categories SET visible = 0 WHERE category_id = 'wine'"),
    ]);
    const admin = await (await request('/api/staff/menu', {}, DAN)).json<{ counts: Record<string, number> }>();
    expect(admin.counts.hidden).toBe(1 + 4);
  });

  it('switches Off, Preview and Live, and audits each change', async () => {
    let res = await request('/api/staff/menu/status', json({ status: 'live' }), DAN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'live' });
    expect((await menu()).status).toBe('live');

    res = await request('/api/staff/menu/status', json({ status: 'off' }), DAN);
    expect(res.status).toBe(200);
    expect(await menu()).toMatchObject({ status: 'off', categories: [] });

    expect((await request('/api/staff/menu/status', json({ status: 'off' }), DAN)).status).toBe(409);
    expect((await request('/api/staff/menu/status', json({ status: 'everyone' }), DAN)).status).toBe(400);
    expect((await request('/api/staff/menu/status', json({}), DAN)).status).toBe(400);

    const setting = await env.DB.prepare("SELECT value, updated_by FROM settings WHERE key = 'food_menu_status'").first();
    expect(setting).toEqual({ value: 'off', updated_by: 'dan@example.com' });
    const { results } = await env.DB.prepare(
      "SELECT actor_id, action, previous_value, new_value FROM audit_log WHERE entity_id = 'food_menu_status' ORDER BY audit_id",
    ).all();
    expect(results).toEqual([
      { actor_id: 'dan@example.com', action: 'menu.status_changed', previous_value: '{"status":"preview"}', new_value: '{"status":"live"}' },
      { actor_id: 'dan@example.com', action: 'menu.status_changed', previous_value: '{"status":"live"}', new_value: '{"status":"off"}' },
    ]);
  });

  it('refuses a switch from another site', async () => {
    const res = await request(
      '/api/staff/menu/status',
      { ...json({ status: 'live' }), headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } },
      DAN,
    );
    expect(res.status).toBe(403);
    expect((await menu()).status).toBe('preview');
  });
});

describe('stats', () => {
  it('counts Food & Drinks page views', async () => {
    const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const res = await request('/api/stats', { ...json({ hits: [{ m: 'menu_view' }] }), headers: { 'Content-Type': 'application/json', 'User-Agent': phone } });
    expect(res.status).toBeLessThan(300);
    const row = await env.DB.prepare("SELECT count FROM stats_daily WHERE metric = 'menu_view'").first<{ count: number }>();
    expect(row?.count).toBe(1);
  });
});
