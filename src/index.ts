import { Hono } from 'hono';
import { readImage } from './images/store';
import { applyRetention } from './lib/privacy';
import { bookingRoutes } from './routes/bookings';
import { hostRoutes } from './routes/host';
import { internalRoutes } from './routes/internal';
import { joinRoutes } from './routes/join';
import { pageRoutes } from './routes/pages';
import { publicRoutes } from './routes/public';
import { staffRoutes } from './routes/staff';

export const app = new Hono<{ Bindings: Env }>();

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

// Event photos. Content-addressed, so they can be cached for a year.
app.get('/images/:imageId', async c => {
  const image = await readImage(c.env.DB, c.env.IMAGES, c.req.param('imageId'));
  if (!image) return c.json({ error: 'Not found' }, 404);
  return new Response(image.body, {
    headers: {
      'Content-Type': image.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${c.req.param('imageId')}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// The organiser's "Sign in" button. Cloudflare Access guards /api/staff, so a
// visitor only reaches this after signing in; Access's cookie covers the whole
// site, so we just send them back. It checks no role: hosts come this way too.
app.get('/api/staff/sign-in', c => {
  c.header('Cache-Control', 'no-store');
  return c.redirect('/organise?signed-in=1', 302);
});

app.route('/api/bookings', bookingRoutes);
app.route('/api', publicRoutes);
app.route('/api/staff', staffRoutes);
app.route('/api/host', hostRoutes);
app.route('/api/join', joinRoutes);
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

export default {
  fetch: app.fetch,
  /** Daily (wrangler.jsonc triggers): erase people's details once they're no longer needed (docs/RTD_PRIVACY.md). */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      applyRetention(env.DB, new Date(controller.scheduledTime)).then(erased => console.log('retention', JSON.stringify(erased))),
    );
  },
} satisfies ExportedHandler<Env>;
