// The public food and drinks menu (/api/menu, docs/RTD_FOOD_MENU.md). Read only:
// there is nothing to order. Cached briefly, like the games shelf.

import { Hono } from 'hono';
import { publicMenu } from '../menu/menu';

export const menuRoutes = new Hono<{ Bindings: Env }>();

menuRoutes.get('/', async c => c.json(await publicMenu(c.env.DB, new Date()), 200, { 'Cache-Control': 'public, max-age=60' }));
