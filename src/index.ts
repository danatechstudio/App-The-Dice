import { Hono } from 'hono';
import { internalRoutes } from './routes/internal';
import { pageRoutes } from './routes/pages';
import { publicRoutes } from './routes/public';
import { staffRoutes } from './routes/staff';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
});

app.get('/api/health', async c => {
  const last = await c.env.DB
    .prepare("SELECT received_at FROM sync_runs WHERE status = 'ok' ORDER BY received_at DESC LIMIT 1")
    .first<{ received_at: string }>();
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, last_sync: last?.received_at ?? null });
});

app.route('/api', publicRoutes);
app.route('/api/staff', staffRoutes);
app.route('/internal', internalRoutes);
// App pages the Worker answers first (wrangler.jsonc run_worker_first): link previews.
app.route('/', pageRoutes);

app.notFound(c => {
  const path = new URL(c.req.url).pathname;
  // Anything else that reaches the Worker and isn't API gets the app shell.
  if (!path.startsWith('/api/') && !path.startsWith('/internal/') && c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ error: 'Not found' }, 404);
});
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong' }, 500);
});

export default app;
