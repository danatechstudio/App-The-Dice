// Public, read-only endpoints for the diary. Only active events with Public or
// App Bookable visibility are ever returned in full. Private ones appear in the
// diary list only as "Private session" with their time; Hidden never appears.
// Only dates still to come or still running are shown: a date stops being public
// the moment it ends (docs/RTD_EVENT_CONTROL_AUDIT.md, G-1), whatever n8n has done.

import { Hono } from 'hono';
import { imagesByEvent, withImages } from '../images/store';
import { calendarFile, googleCalendarUrl } from '../lib/calendar';
import {
  EVENT_ID, LISTED, OCCURRENCE_FIELDS, VISIBLE, findOccurrence, goneReason, nextOccurrence, publicCache, redactPrivate, shape, upcoming,
  type GoneReason, type Row,
} from '../lib/queries';
import { privacyInfo } from '../lib/privacy';
import { addDays, londonDate, parseSheetDate } from '../lib/time';
import { CATEGORIES } from '../sync/normalise';

const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseSheetDate(s) === s;
const MAX_RANGE_DAYS = 120;

// Short public caching on successful reads only. Set per handler, never as
// path middleware: this router is mounted at /api, so a '*' middleware here
// would also run on /api/staff/* and could make staff data publicly cacheable.
// Lists use publicCache, so nothing is cached past the moment a date ends.
const CACHE = { 'Cache-Control': 'public, max-age=60' };

const GONE: Record<GoneReason, string> = {
  finished: 'This event has finished.',
  cancelled: 'This date was cancelled.',
  moved: 'This date has moved.',
};

export const publicRoutes = new Hono<{ Bindings: Env }>();

/** Who the privacy notice names, where to send questions, and how long booking details are kept. */
publicRoutes.get('/privacy', async c => c.json(await privacyInfo(c.env.DB), 200, { 'Cache-Control': 'public, max-age=300' }));

/** Upcoming occurrences for the diary. ?from=&to= (YYYY-MM-DD, London), ?category= */
publicRoutes.get('/events', async c => {
  const now = new Date();
  const today = londonDate(now);
  const from = c.req.query('from') ?? today;
  if (!isDate(from)) return c.json({ error: 'from must be a real date, YYYY-MM-DD' }, 400);
  const to = c.req.query('to') ?? addDays(from, 60);
  const category = c.req.query('category');
  if (!isDate(to) || to < from) return c.json({ error: 'to must be a real date, YYYY-MM-DD, not before from' }, 400);
  if (addDays(from, MAX_RANGE_DAYS) < to) return c.json({ error: `Range is limited to ${MAX_RANGE_DAYS} days` }, 400);
  if (category && !CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    return c.json({ error: `category must be one of ${CATEGORIES.join(', ')}` }, 400);
  }
  const start = from < today ? today : from; // the diary never lists the past
  const { results } = await c.env.DB
    .prepare(
      `SELECT ${OCCURRENCE_FIELDS}
       FROM occurrences o JOIN events e ON e.event_id = o.event_id
       WHERE ${LISTED} AND ${upcoming('?4', '?5')} AND o.event_date BETWEEN ?1 AND ?2
         AND (?3 IS NULL OR e.category = ?3)
       ORDER BY o.event_date, COALESCE(o.start_time, '00:00'), e.display_name`,
    )
    .bind(start, to, category ?? null, now.toISOString(), today)
    .all<Row>();
  const occurrences = (await withImages(c.env.DB, results.map(shape))).map(redactPrivate);
  return c.json({ from: start, to, occurrences }, 200, publicCache(occurrences, now));
});

/** One event and its upcoming occurrences. */
publicRoutes.get('/events/:eventId', async c => {
  const eventId = c.req.param('eventId');
  if (!EVENT_ID.test(eventId)) return c.json({ error: 'Not found' }, 404);
  const now = new Date();
  const [eventRes, occRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `SELECT event_id, display_name AS name, category, description, frequency, default_image AS image
         FROM events e WHERE event_id = ?1 AND active = 1 AND visibility IN ('public', 'app_bookable')`,
      )
      .bind(eventId),
    c.env.DB
      .prepare(
        `SELECT ${OCCURRENCE_FIELDS}
         FROM occurrences o JOIN events e ON e.event_id = o.event_id
         WHERE o.event_id = ?1 AND ${VISIBLE} AND ${upcoming('?2', '?3')}
         ORDER BY o.event_date, COALESCE(o.start_time, '00:00') LIMIT 20`,
      )
      .bind(eventId, now.toISOString(), londonDate(now)),
  ]);
  const event = eventRes?.results[0] as Row | undefined;
  if (!event) return c.json({ error: 'Not found' }, 404);
  const images = (await imagesByEvent(c.env.DB, [eventId])).get(eventId) ?? [];
  const occurrences = await withImages(c.env.DB, (occRes?.results ?? []).map(r => shape(r as Row)));
  return c.json({ event: { ...event, image: event.image ?? images[0] ?? null, images }, occurrences }, 200, publicCache(occurrences, now));
});

/**
 * One occurrence, for deep links and shared event pages. A date that has
 * finished, was cancelled or has moved is never shown: an old link gets 410
 * with only the event's name, that date, why, and its next date if it has one.
 */
publicRoutes.get('/occurrences/:occurrenceId', async c => {
  const now = new Date();
  const found = await findOccurrence(c.env.DB, c.req.param('occurrenceId'));
  if (!found) return c.json({ error: 'Not found' }, 404);
  const reason = goneReason(found, now);
  if (reason) {
    const next = await nextOccurrence(c.env.DB, found.event_id, now);
    const gone = {
      occurrence_id: found.occurrence_id,
      event_id: found.event_id,
      name: found.name,
      date: found.date,
      reason,
      next: next && { occurrence_id: next.occurrence_id, date: next.date, start_time: next.start_time },
    };
    return c.json({ error: GONE[reason], gone }, 410, next ? publicCache([next], now) : CACHE);
  }
  const [occurrence] = await withImages(c.env.DB, [found]);
  const images = (await imagesByEvent(c.env.DB, [found.event_id])).get(found.event_id) ?? [];
  return c.json({ occurrence: { ...occurrence, images } }, 200, publicCache([found], now));
});

/** Add to Calendar (spec §39): an .ics file for Apple, Outlook and most others. */
publicRoutes.get('/occurrences/:occurrenceId/calendar.ics', async c => {
  const now = new Date();
  const o = await findOccurrence(c.env.DB, c.req.param('occurrenceId'));
  if (!o || goneReason(o, now)) return c.json({ error: 'Not found' }, 404);
  const origin = new URL(c.req.url).origin;
  const slug = o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
  return c.body(calendarFile(o, { origin, location: c.env.VENUE_LOCATION, now }), 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="rtd-${slug}-${o.date}.ics"`,
    ...publicCache([o], now),
  });
});

/** Add to Calendar, Google flavour: a redirect to Google's prefilled form. */
publicRoutes.get('/occurrences/:occurrenceId/google-calendar', async c => {
  const o = await findOccurrence(c.env.DB, c.req.param('occurrenceId'));
  if (!o || goneReason(o, new Date())) return c.json({ error: 'Not found' }, 404);
  return c.redirect(googleCalendarUrl(o, { origin: new URL(c.req.url).origin, location: c.env.VENUE_LOCATION }), 302);
});
