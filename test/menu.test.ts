import { beforeEach, describe, expect, it } from 'vitest';
import { safeImage, type PublicMenu } from '../src/menu/menu';
import { menuSheet } from './fixtures/menuSheet';
import { env, freshDb, request } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // host
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const menu = async () => (await request('/api/menu')).json<PublicMenu>();

/** n8n RTD Menu Sync posting a copy of the sheet. */
const sheetSync = (body: unknown, token = 'test-sync-token') =>
  request('/internal/menu', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

/** The sheet as first filled in, with one change made to some rows. */
function editedSheet(edit: (items: Record<string, unknown>[], sections: Record<string, unknown>[]) => void) {
  const sheet = menuSheet();
  edit(sheet.items, sheet.sections);
  return sheet;
}
const row = (items: Record<string, unknown>[], name: string) => items.find(r => r.Item === name)!;
const items = (m: PublicMenu) => m.categories.flatMap(c => c.items);
const byName = (m: PublicMenu, name: string) => items(m).find(i => i.name === name)!;

/**
 * Every price in the brief (RTD_FOOD_MENU_OFFERS-1.md), written out again here
 * rather than read from the sheet's starting rows, so a typo in either shows up.
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
    env.DB.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('food_menu_status', 'preview', ?1, 'test')").bind(now),
  ]);
  expect((await sheetSync(menuSheet())).status).toBe(200);
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
    expect(spirits.items.map(i => i.name)).toHaveLength(8);
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
    expect(m.categories.filter(c => c.alcohol).map(c => c.id)).toEqual(['spirits', 'beer-cider', 'wine-prosecco']);
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
    expect((await request('/api/menu', json({ item: 'hot-food--bacon-bun' }))).status).toBe(404);
  });

  it('leaves out hidden items and hidden categories, and marks unavailable ones', async () => {
    const sheet = editedSheet((items, sections) => {
      row(items, 'Toast').Show = 'N';
      row(items, 'Iced latte').Available = 'no';
      sections.find(r => r.Section === 'Wine & prosecco')!.Show = 'N';
      for (const r of items.filter(r => r.Section === 'Mixers')) r.Show = false;
    });
    expect((await sheetSync(sheet)).status).toBe(200);
    const m = await menu();
    expect(items(m).map(i => i.name)).not.toContain('Toast');
    expect(byName(m, 'Iced latte').available).toBe(false);
    expect(byName(m, 'Tea').available).toBe(true);
    // A hidden category, and one with nothing visible, are left out altogether.
    expect(m.categories.map(c => c.id)).not.toContain('wine-prosecco');
    expect(m.categories.map(c => c.id)).not.toContain('mixers');
    expect(items(m)).toHaveLength(59 - 1 - 4 - 3);
  });

  it('follows the order of the rows in the sheet', async () => {
    const sheet = editedSheet((items, sections) => {
      sections.unshift(sections.splice(sections.findIndex(r => r.Section === 'Hot drinks'), 1)[0]!);
      items.unshift(items.splice(items.findIndex(r => r.Item === 'Iced latte'), 1)[0]!);
    });
    expect((await sheetSync(sheet)).status).toBe(200);
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
    const sheet = editedSheet(items => {
      Object.assign(row(items, 'Bacon bun'), { Photo: '/images/abc123', 'Photo description': 'A bacon bun' });
      row(items, 'Toast').Photo = 'javascript:alert(1)';
      row(items, 'Fries').Photo = 'https://example.com/fries.jpg';
    });
    expect((await sheetSync(sheet)).status).toBe(200);
    const m = await menu();
    expect(byName(m, 'Bacon bun')).toMatchObject({ image: '/images/abc123', image_alt: 'A bacon bun' });
    expect(byName(m, 'Toast').image).toBeNull();
    expect(byName(m, 'Fries').image).toBe('https://example.com/fries.jpg');
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
    const sheet = editedSheet((items, sections) => {
      row(items, 'Toast').Show = 'N';
      sections.find(r => r.Section === 'Wine & prosecco')!.Show = 'N';
    });
    expect((await sheetSync(sheet)).status).toBe(200);
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

describe('copying the menu from the sheet', () => {
  type Admin = { counts: Record<string, number>; sheet: { url: string | null; changed_at: string | null; checked_at: string | null; ok: boolean | null; errors: string[] } };
  const admin = async () => (await request('/api/staff/menu', {}, DAN)).json<Admin>();
  const audits = async () =>
    (await env.DB.prepare("SELECT actor_type, actor_id, action, new_value FROM audit_log WHERE entity_id = 'food_menu' ORDER BY audit_id").all()).results;

  it('only takes copies from n8n', async () => {
    expect((await sheetSync(menuSheet(), 'wrong-token')).status).toBe(401);
    expect((await request('/internal/menu', json(menuSheet()))).status).toBe(401);
    expect((await request('/internal/menu', json(menuSheet()), DAN)).status).toBe(401);
  });

  it('changes the menu when the sheet changes, and audits what changed', async () => {
    const sheet = editedSheet(items => {
      row(items, 'Tea').Price = '£2.30';
      items.push({ Section: 'Hot food', Item: 'Halloween pizza', Price: 7, 'Menu wording': 'Halloween pizza — £7.00' });
    });
    const res = await sheetSync(sheet);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, items: 60, changed: true });
    const m = await menu();
    expect(byName(m, 'Tea').prices).toEqual([{ label: null, price_pence: 230 }]);
    expect(byName(m, 'Halloween pizza').prices).toEqual([{ label: null, price_pence: 700 }]);
    const rows = await audits();
    expect(rows).toHaveLength(2); // the first copy, then this one
    expect(rows[1]).toMatchObject({ actor_type: 'n8n', actor_id: 'RTD Menu Sync', action: 'menu.updated' });
    expect(JSON.parse(rows[1]!.new_value as string)).toEqual({ items: 60, added: ['Halloween pizza'], removed: [], changed: ['Tea'] });
  });

  it('leaves the audit log alone when nothing changed', async () => {
    const res = await sheetSync(menuSheet());
    expect(await res.json()).toEqual({ ok: true, items: 59, changed: false });
    expect(await audits()).toHaveLength(1);
    expect((await admin()).sheet).toMatchObject({ ok: true, errors: [] });
  });

  it('refuses a copy with a bad row, keeps the menu it had, and says which rows', async () => {
    const sheet = editedSheet(items => {
      row(items, 'Toast').Price = '1,25';
      row(items, 'Fries').Price = '';
      row(items, 'Gin').Price = '5.00';
      row(items, 'Tea').Section = 'Brews';
      row(items, 'Stella').Alcohol = 'maybe';
    });
    const res = await sheetSync(sheet);
    expect(res.status).toBe(422);
    const body = await res.json<{ error: string; errors: string[] }>();
    expect(body.errors).toEqual([
      'Menu row 5 (Toast): Price "1,25" isn\'t a price. Write it like 3.50.',
      'Menu row 7 (Fries): there\'s no price. Give one, or say why in the Price note (for example "Individually priced").',
      'Menu row 17 (Tea): the Section "Brews" isn\'t on the Sections tab.',
      'Menu row 34 (Gin): give a Price, or Single and Double prices, not both.',
      'Menu row 50 (Stella): Alcohol must be Y or N.',
    ]);
    expect(body.error).toContain('the app kept its menu');
    // The menu is untouched.
    const m = await menu();
    expect(byName(m, 'Toast').prices).toEqual([{ label: null, price_pence: 125 }]);
    expect(items(m)).toHaveLength(59);
    // Admins see the problems in the organiser.
    expect((await admin()).sheet).toMatchObject({ ok: false, errors: body.errors });
    // Fixed: back to ok.
    expect((await sheetSync(menuSheet())).status).toBe(200);
    expect((await admin()).sheet).toMatchObject({ ok: true, errors: [] });
  });

  it('never empties the menu, and checks the sections', async () => {
    expect((await sheetSync({ sections: menuSheet().sections, items: [] })).status).toBe(422);
    expect((await sheetSync({})).status).toBe(422);
    expect((await sheetSync('not a menu')).status).toBe(422);
    const twice = editedSheet((_, sections) => sections.push({ Section: 'hot food', Show: 'Y', row_number: 99 }));
    expect((await sheetSync(twice)).status).toBe(422);
    expect(items(await menu())).toHaveLength(59);
  });

  it('skips empty rows, and reads prices, ticks and Y / N the way people type them', async () => {
    const sheet = editedSheet(items => {
      items.splice(3, 0, { Section: '', Item: '', Price: '', row_number: 0 });
      Object.assign(row(items, 'Toast'), { Price: 1.2, Show: true, Available: 'FALSE' });
      Object.assign(row(items, 'Fries'), { Price: '£ 2.6' });
      Object.assign(row(items, 'Gin'), { Single: 4.5, Double: '' });
    });
    expect((await sheetSync(sheet)).status).toBe(200);
    const m = await menu();
    expect(byName(m, 'Toast')).toMatchObject({ prices: [{ label: null, price_pence: 120 }], available: false });
    expect(byName(m, 'Fries').prices).toEqual([{ label: null, price_pence: 260 }]);
    expect(byName(m, 'Gin').prices).toEqual([{ label: 'Single', price_pence: 450 }]);
  });

  it('keeps the sheet link for the organiser, but only a Google Sheets one', async () => {
    const url = 'https://docs.google.com/spreadsheets/d/abc_DEF-123/edit';
    expect((await sheetSync({ ...menuSheet(), sheet_url: url })).status).toBe(200);
    expect((await admin()).sheet.url).toBe(url);
    expect((await sheetSync({ ...menuSheet(), sheet_url: 'javascript:alert(1)' })).status).toBe(200);
    expect((await admin()).sheet.url).toBe(url);
  });

  it('shows nothing until the first copy arrives, and is Off until an admin switches it', async () => {
    await freshDb();
    expect(await menu()).toMatchObject({ status: 'off', categories: [] });
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('food_menu_status', 'preview', 'x', 'test')").run();
    expect(await menu()).toMatchObject({ status: 'preview', categories: [] });
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
