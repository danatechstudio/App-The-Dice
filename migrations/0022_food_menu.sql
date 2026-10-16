-- The café's food and drinks menu (docs/RTD_FOOD_MENU.md). Browse only: no
-- basket, orders or payments. Additive: no existing table changes.
--
-- Prices are in pence. An item with no single price keeps price_pence NULL and
-- says why in price_note ("Individually priced"); serve sizes with their own
-- prices (spirits: Single, Double) are rows in menu_item_variants. A price is
-- never guessed. The data below is transcribed from photographs of the café's
-- menu: each line keeps its original wording in source_text, and the menu
-- starts in Preview until the café has checked it (docs/RTD_FOOD_MENU_AUDIT.md §6).

CREATE TABLE menu_categories (
  category_id TEXT PRIMARY KEY,               -- slug, also the page anchor: /menu#hot-food
  name        TEXT NOT NULL,
  description TEXT,                           -- shown under the heading
  alcohol     INTEGER NOT NULL DEFAULT 0,     -- 1: has alcoholic drinks (the over-18s note)
  image_url   TEXT,                           -- reserved for a photo: /images/… or https://…
  image_alt   TEXT,
  sort_order  INTEGER NOT NULL,
  visible     INTEGER NOT NULL DEFAULT 1,     -- 0: the whole category is left off the menu
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE menu_items (
  item_id     TEXT PRIMARY KEY,               -- RTD-MENU-00001 upwards; never reused
  category_id TEXT NOT NULL REFERENCES menu_categories (category_id),
  name        TEXT NOT NULL,
  options     TEXT,                           -- the choices: "Cheese or pepperoni"
  description TEXT,                           -- "Served with fries or side salad"
  price_pence INTEGER CHECK (price_pence IS NULL OR price_pence BETWEEN 0 AND 100000),
  price_note  TEXT,                           -- instead of a price: "Individually priced"
  alcohol     INTEGER NOT NULL DEFAULT 0,     -- 1: alcoholic (marked 18+); 0% drinks are 0
  image_url   TEXT,                           -- reserved for a photo: /images/… or https://…
  image_alt   TEXT,
  sort_order  INTEGER NOT NULL,
  visible     INTEGER NOT NULL DEFAULT 1,     -- 0: left off the menu
  available   INTEGER NOT NULL DEFAULT 1,     -- 0: listed, marked "Not available right now"
  source_text TEXT NOT NULL,                  -- the line as transcribed from the menu
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX menu_items_by_category ON menu_items (category_id, sort_order);

-- Serve sizes with their own price. When an item has these, they are its prices.
CREATE TABLE menu_item_variants (
  variant_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES menu_items (item_id),
  label       TEXT NOT NULL,                  -- Single, Double
  price_pence INTEGER NOT NULL CHECK (price_pence BETWEEN 0 AND 100000),
  sort_order  INTEGER NOT NULL,
  UNIQUE (item_id, label)
);

-- Off: the page says the menu isn't in the app. Preview: shown, marked as being
-- checked. Live: shown. Admins change it in the organiser (audited).
INSERT OR IGNORE INTO settings (key, value, updated_at, updated_by) VALUES ('food_menu_status', 'preview', '2026-10-16T00:00:00Z', 'migration 0022');

INSERT INTO menu_categories (category_id, name, description, alcohol, sort_order, created_at, updated_at) VALUES
  ('hot-food',    'Hot food',        NULL,                    0, 10, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('cold-food',   'Cold food',       NULL,                    0, 20, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('hot-drinks',  'Hot drinks',      NULL,                    0, 30, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('cold-drinks', 'Cold drinks',     NULL,                    0, 40, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('spirits',     'Spirits',         NULL,                    1, 50, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('beer-cider',  'Beer & cider',    'Draught and bottled.',  1, 60, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('mixers',      'Mixers',          NULL,                    0, 70, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('wine',        'Wine & prosecco', NULL,                    1, 80, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z');

INSERT INTO menu_items (item_id, category_id, name, options, description, price_pence, price_note, alcohol, sort_order, source_text, created_at, updated_at) VALUES
  -- Hot food
  ('RTD-MENU-00001', 'hot-food', 'Bacon bun', NULL, NULL, 350, NULL, 0, 10, 'Bacon bun — £3.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00002', 'hot-food', 'Sausage / vegetarian sausage bun', NULL, NULL, 350, NULL, 0, 20, 'Sausage / vegetarian sausage bun — £3.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00003', 'hot-food', 'All day breakfast', NULL, NULL, 650, NULL, 0, 30, 'All day breakfast — £6.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00004', 'hot-food', 'Toast', NULL, NULL, 125, NULL, 0, 40, 'Toast — £1.25', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00005', 'hot-food', 'Toasted teacake', NULL, NULL, 300, NULL, 0, 50, 'Toasted teacake — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00006', 'hot-food', 'Fries', NULL, NULL, 250, NULL, 0, 60, 'Fries — £2.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00007', 'hot-food', 'Cheesy fries', NULL, NULL, 275, NULL, 0, 70, 'Cheesy fries — £2.75', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00008', 'hot-food', 'Pizza', 'Cheese or pepperoni', NULL, 600, NULL, 0, 80, 'Pizza, cheese or pepperoni — £6.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00009', 'hot-food', 'Beef / vegetarian burger', NULL, 'Served with fries or side salad.', 700, NULL, 0, 90, 'Beef / vegetarian burger, served with fries or side salad — £7.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00010', 'hot-food', 'Nachos & 3 dips', NULL, 'Sour cream & chive, salsa and guacamole.', 425, NULL, 0, 100, 'Nachos & 3 dips (sour cream & chive, salsa & guacamole) — £4.25', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00011', 'hot-food', 'Jacket potato', 'Choice of cheese, beans or tuna mayo', 'Served with side salad.', 575, NULL, 0, 110, 'Jacket potato, choice of cheese, beans, tuna mayo; served with side salad — £5.75', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  -- Cold food
  ('RTD-MENU-00012', 'cold-food', 'Sandwiches', 'Cheese and tomato, cheese and ham, tuna mayo or ham salad', NULL, 375, NULL, 0, 10, 'Sandwiches, cheese and tomato / cheese and ham / tuna mayo / ham salad — £3.75', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00013', 'cold-food', 'Cupcakes, doughnuts and gluten-free cakes', NULL, NULL, NULL, 'Individually priced', 0, 20, 'Cupcakes, doughnuts, gluten-free cakes — individually priced', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00014', 'cold-food', 'Crisps & chocolate', NULL, NULL, NULL, 'Individually priced', 0, 30, 'Crisps & chocolate — individually priced', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00015', 'cold-food', 'Homemade cakes', NULL, NULL, NULL, 'Individually priced', 0, 40, 'Homemade cakes — individually priced', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  -- Hot drinks
  ('RTD-MENU-00016', 'hot-drinks', 'Tea', NULL, NULL, 220, NULL, 0, 10, 'Tea — £2.20', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00017', 'hot-drinks', 'Decaf tea', NULL, NULL, 220, NULL, 0, 20, 'Decaf tea — £2.20', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00018', 'hot-drinks', 'Speciality teas', NULL, NULL, 240, NULL, 0, 30, 'Speciality teas — £2.40', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00019', 'hot-drinks', 'Hot chocolate', NULL, NULL, 275, NULL, 0, 40, 'Hot chocolate — £2.75', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00020', 'hot-drinks', 'Flavoured hot chocolate', NULL, NULL, 300, NULL, 0, 50, 'Flavoured hot chocolate — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00021', 'hot-drinks', 'Black / white Americano', NULL, NULL, 270, NULL, 0, 60, 'Black / white Americano — £2.70', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00022', 'hot-drinks', 'Decaf coffee', NULL, NULL, 270, NULL, 0, 70, 'Decaf coffee — £2.70', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00023', 'hot-drinks', 'Latte / cappuccino', NULL, NULL, 300, NULL, 0, 80, 'Latte / cappuccino — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00024', 'hot-drinks', 'Flat white / mocha', NULL, NULL, 300, NULL, 0, 90, 'Flat white / mocha — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00025', 'hot-drinks', 'Iced latte', NULL, NULL, 300, NULL, 0, 100, 'Iced latte — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  -- Cold drinks
  ('RTD-MENU-00026', 'cold-drinks', 'Soft drinks', 'Coke, Dr Pepper, 7Up Zero, Diet Coke or Tango', NULL, 200, NULL, 0, 10, 'Soft drinks (Coke, Dr Pepper, 7Up Zero, Diet Coke, Tango) — £2.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00027', 'cold-drinks', 'Ice cream milkshake', 'Chocolate, strawberry or banana', NULL, 275, NULL, 0, 20, 'Ice cream milkshake, chocolate/strawberry/banana — £2.75', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00028', 'cold-drinks', 'Orange / apple carton', NULL, NULL, 150, NULL, 0, 30, 'Orange / apple carton — £1.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00029', 'cold-drinks', 'Fruit Shoot', 'Orange or blackcurrant', NULL, 150, NULL, 0, 40, 'Fruit Shoot, orange / blackcurrant — £1.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00030', 'cold-drinks', 'J2O', 'Orange & passionfruit or apple & raspberry', NULL, 250, NULL, 0, 50, 'J2O, orange & passionfruit / apple & raspberry — £2.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00031', 'cold-drinks', 'Bottled water', NULL, NULL, 150, NULL, 0, 60, 'Bottled water — £1.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00032', 'cold-drinks', 'Coke float', NULL, NULL, 175, NULL, 0, 70, 'Coke float — £1.75', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  -- Spirits: priced by serve (menu_item_variants)
  ('RTD-MENU-00033', 'spirits', 'Gin', 'London Dry, Pink or Raspberry', NULL, NULL, NULL, 1, 10, 'Gin: London Dry, Pink, Raspberry (single £4 / double £6)', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00034', 'spirits', 'Vodka', 'Smirnoff or Absolut', NULL, NULL, NULL, 1, 20, 'Vodka: Smirnoff, Absolut (single £4 / double £6)', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00035', 'spirits', 'Sourz', 'Apple or Cherry', NULL, NULL, NULL, 1, 30, 'Sourz: Apple, Cherry (single £4 / double £6)', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00036', 'spirits', 'Disaronno', NULL, NULL, NULL, NULL, 1, 40, 'Disaronno (single £4 / double £6)', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00037', 'spirits', 'Jack Daniel''s', NULL, NULL, NULL, NULL, 1, 50, 'Jack Daniels (single £4 / double £6)', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00038', 'spirits', 'Captain Morgan Spiced Rum', NULL, NULL, NULL, NULL, 1, 60, 'Captain Morgan Spiced Rum (single £4 / double £6)', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00039', 'spirits', 'Bacardi White Rum', NULL, NULL, NULL, NULL, 1, 70, 'Bacardi White Rum (single £4 / double £6)', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00040', 'spirits', 'Archers Peach Schnapps', NULL, NULL, NULL, NULL, 1, 80, 'Archers Peach Schnapps (single £4 / double £6)', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  -- Beer & cider
  ('RTD-MENU-00041', 'beer-cider', 'Clap Clap Fish Pale Ale', NULL, NULL, 420, NULL, 1, 10, 'Clap Clap Fish Pale Ale — £4.20', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00042', 'beer-cider', 'Hard Graft Pale Ale', NULL, NULL, 420, NULL, 1, 20, 'Hard Graft Pale Ale — £4.20', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00043', 'beer-cider', 'Overtime Craft Lager', NULL, NULL, 420, NULL, 1, 30, 'Overtime Craft Lager — £4.20', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00044', 'beer-cider', 'Mango Cider', NULL, NULL, 450, NULL, 1, 40, 'Mango Cider — £4.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00045', 'beer-cider', 'Kopparberg Strawberry & Lime', NULL, NULL, 440, NULL, 1, 50, 'Kopparberg Strawberry & Lime — £4.40', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00046', 'beer-cider', 'Kopparberg Mixed Fruit', NULL, NULL, 440, NULL, 1, 60, 'Kopparberg Mixed Fruit — £4.40', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00047', 'beer-cider', 'Kopparberg 0%', NULL, NULL, 300, NULL, 0, 70, 'Kopparberg 0% — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00048', 'beer-cider', 'Budweiser', NULL, NULL, 300, NULL, 1, 80, 'Budweiser — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00049', 'beer-cider', 'Stella', NULL, NULL, 300, NULL, 1, 90, 'Stella — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00050', 'beer-cider', 'Boddingtons', NULL, NULL, 300, NULL, 1, 100, 'Boddingtons — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00051', 'beer-cider', 'Corona 0%', NULL, NULL, 300, NULL, 0, 110, 'Corona 0% — £3.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00052', 'beer-cider', 'Guinness', 'Regular or 0%', NULL, 350, NULL, 1, 120, 'Guinness / 0% — £3.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  -- Mixers
  ('RTD-MENU-00053', 'mixers', 'Soft drinks', NULL, NULL, NULL, 'As priced under Cold drinks', 0, 10, 'Soft drinks as priced on menu', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00054', 'mixers', 'Tonic water', NULL, NULL, 180, NULL, 0, 20, 'Tonic water — £1.80', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00055', 'mixers', 'Monster Original', NULL, NULL, 250, NULL, 0, 30, 'Monster Original — £2.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  -- Wine & prosecco
  ('RTD-MENU-00056', 'wine', 'Red wine', NULL, NULL, 450, NULL, 1, 10, 'Red — £4.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00057', 'wine', 'Rosé wine', NULL, NULL, 450, NULL, 1, 20, 'Rosé — £4.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00058', 'wine', 'White wine', NULL, NULL, 450, NULL, 1, 30, 'White — £4.50', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z'),
  ('RTD-MENU-00059', 'wine', 'Prosecco', NULL, NULL, 500, NULL, 1, 40, 'Prosecco — £5.00', '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z');

-- Every spirit: single £4, double £6 (the menu gives these for the whole section).
INSERT INTO menu_item_variants (item_id, label, price_pence, sort_order)
  SELECT item_id, 'Single', 400, 10 FROM menu_items WHERE category_id = 'spirits'
  UNION ALL
  SELECT item_id, 'Double', 600, 20 FROM menu_items WHERE category_id = 'spirits';
