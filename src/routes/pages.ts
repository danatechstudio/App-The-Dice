// App pages that need the Worker: the shell HTML with link-preview tags, so
// an event shared on Facebook or WhatsApp shows its own title, date and
// picture (spec §40). Everything else is served straight from static assets.

import { Hono, type Context } from 'hono';
import { withImages } from '../images/store';
import { findOccurrence, nextOccurrence, type PublicOccurrence } from '../lib/queries';
import { londonDate } from '../lib/time';

export const pageRoutes = new Hono<{ Bindings: Env }>();

// Mirrors web/public/_headers, which only applies to assets served directly.
const CSP =
  "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; " +
  "connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const SITE = 'Roll The Dice · Board Game Café';
const SITE_DESCRIPTION = "What's on at Roll The Dice Board Game Café: events, game nights and something to play.";

interface Meta {
  title: string;
  description: string;
  image: string;
  url: string;
}

const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

function clock(hhmm: string | null): string | null {
  if (!hhmm) return null;
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function eventMeta(o: PublicOccurrence, origin: string): Meta {
  const when = [DAY.format(new Date(`${o.date}T12:00:00Z`)), clock(o.start_time)].filter(Boolean).join(', ');
  const status = o.status === 'cancelled' ? 'Cancelled: ' : '';
  // Our own photos are relative (/images/…); previews need absolute URLs.
  const image = o.image && /^(https:\/\/|\/images\/)/.test(o.image) ? new URL(o.image, origin).href : `${origin}/brand/og-default.png`;
  return {
    title: `${status}${o.name} · ${when}`,
    description: o.description ? `${o.description} At Roll The Dice.` : `${when} at Roll The Dice Board Game Café.`,
    image,
    url: `${origin}/event/${o.occurrence_id}`,
  };
}

async function shell(c: Context<{ Bindings: Env }>, meta: Meta | null, status: 200 | 404 = 200): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const page = await c.env.ASSETS.fetch(new URL('/', c.req.url));
  const m: Meta = meta ?? { title: SITE, description: SITE_DESCRIPTION, image: `${origin}/brand/og-default.png`, url: origin + new URL(c.req.url).pathname };
  const set = (value: string) => ({
    element: (el: Element) => {
      el.setAttribute('content', value);
    },
  });
  const rewritten = new HTMLRewriter()
    .on('title', {
      element: el => {
        el.setInnerContent(meta ? `${m.title} · Roll The Dice` : SITE);
      },
    })
    .on('meta[name="description"]', set(m.description))
    .on('meta[property="og:title"]', set(m.title))
    .on('meta[property="og:description"]', set(m.description))
    .on('meta[property="og:image"]', set(m.image))
    .on('head', {
      element: el => {
        el.append(`<meta property="og:url" content="${m.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" />`, { html: true });
      },
    })
    .transform(page);
  return new Response(rewritten.body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Content-Security-Policy': CSP,
    },
  });
}

pageRoutes.get('/', c => shell(c, null));

pageRoutes.get('/event/:occurrenceId', async c => {
  const found = await findOccurrence(c.env.DB, c.req.param('occurrenceId'));
  const [o] = found ? await withImages(c.env.DB, [found]) : [];
  return shell(c, o ? eventMeta(o, new URL(c.req.url).origin) : null, o ? 200 : 404);
});

pageRoutes.get('/events/:eventId', async c => {
  const next = await nextOccurrence(c.env.DB, c.req.param('eventId'), londonDate(new Date()));
  const [o] = next ? await withImages(c.env.DB, [next]) : [];
  return shell(c, o ? { ...eventMeta(o, new URL(c.req.url).origin), url: new URL(c.req.url).href } : null, o ? 200 : 404);
});
