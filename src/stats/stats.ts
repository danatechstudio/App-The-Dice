// Stats for admins (docs/RTD_STATS.md). The app counts page views and taps as
// daily totals: no network address, device ID or cookie, so a count says how
// many times, never who. Bookings, requests and reminders are counted from their
// own tables instead, so they're exact and include everything before stats began.

import { shortDate, weekdayOf } from '../lib/format';
import { EVENT_ID } from '../lib/queries';
import { addDays, londonDate, londonToUtc } from '../lib/time';

/** Counts about the whole app, sent by the page. */
export const APP_METRICS = [
  'app_open', // the app opened in a browser
  'home_screen_open', // the app opened from the Home Screen (installed)
  'install', // the browser said the app was installed (Android, Chrome and Edge; not iPhone)
  'diary_view',
  'book_page_view',
  'roll_use', // Roll Me a Game: a roll
  'roll_pick', // Roll Me a Game: "This One!"
  'gotw_view', // the Games page, led by Game of the Week
  'host_page_view',
  'host_apply_tap',
  'markets_view',
] as const;

/** Counts about one event, sent by the page. */
export const EVENT_METRICS = ['event_view', 'book_tap', 'calendar_tap', 'share_tap', 'reminder_open'] as const;

/** Counted by the server itself (src/notify/alerts.ts), never accepted from a page. */
export const SERVER_METRICS = ['alerts_on', 'alerts_off'] as const;

type AppMetric = (typeof APP_METRICS)[number];
type EventMetric = (typeof EVENT_METRICS)[number];
export type Metric = AppMetric | EventMetric | (typeof SERVER_METRICS)[number];

const isApp = (m: string): m is AppMetric => (APP_METRICS as readonly string[]).includes(m);
const isEvent = (m: string): m is EventMetric => (EVENT_METRICS as readonly string[]).includes(m);

/** Most counts one request can carry (the page sends them in small batches). */
export const MAX_HITS = 10;
/** Most counts one network address can add in a minute (kept in memory only). */
const PER_MINUTE = 60;

/** One count about the whole app, for a batch. */
export function countApp(db: D1Database, now: Date, metric: Metric, n = 1): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO stats_daily (day, metric, event_id, count) VALUES (?1, ?2, '', ?3)
       ON CONFLICT (day, metric, event_id) DO UPDATE SET count = count + excluded.count`,
    )
    .bind(londonDate(now), metric, n);
}

/** One count about an event, only if the event exists. */
function countEvent(db: D1Database, now: Date, metric: EventMetric, eventId: string, n: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO stats_daily (day, metric, event_id, count) SELECT ?1, ?2, event_id, ?4 FROM events WHERE event_id = ?3
       ON CONFLICT (day, metric, event_id) DO UPDATE SET count = count + excluded.count`,
    )
    .bind(londonDate(now), metric, eventId, n);
}

// ---- What the page sends ----

/** Search engines, link previews and other robots: not people, so not counted. */
const ROBOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python|headless|lighthouse/i;

let minute = 0;
let perAddress = new Map<string, number>();
function overLimit(ip: string | null, hits: number, now: Date): boolean {
  if (!ip) return false;
  const m = Math.floor(now.getTime() / 60_000);
  if (m !== minute) {
    minute = m;
    perAddress = new Map();
  }
  const used = (perAddress.get(ip) ?? 0) + hits;
  perAddress.set(ip, used);
  return used > PER_MINUTE;
}

interface Hit {
  metric: AppMetric | EventMetric;
  eventId: string;
  sendId: number | null;
}

function parseHits(body: unknown): Hit[] {
  const list = (body as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(list)) return [];
  const hits: Hit[] = [];
  for (const raw of list.slice(0, MAX_HITS)) {
    const h = (raw ?? {}) as { m?: unknown; e?: unknown; s?: unknown };
    const m = typeof h.m === 'string' ? h.m : '';
    if (isApp(m)) hits.push({ metric: m, eventId: '', sendId: null });
    else if (isEvent(m) && typeof h.e === 'string' && EVENT_ID.test(h.e)) {
      const s = m === 'reminder_open' && Number.isInteger(h.s) && (h.s as number) > 0 ? (h.s as number) : null;
      hits.push({ metric: m, eventId: h.e, sendId: s });
    }
  }
  return hits;
}

/**
 * Counts what a page sent: { hits: [{ m: metric, e?: Event ID, s?: reminder }] }.
 * Robots, people signed in to the organiser (the café team and hosts) and more
 * than 60 counts a minute from one address aren't counted. Returns how many were.
 */
export async function recordHits(
  db: D1Database,
  body: unknown,
  ctx: { now: Date; ua?: string; signedIn: boolean; ip: string | null },
): Promise<number> {
  if (ctx.signedIn || !ctx.ua || ROBOT.test(ctx.ua)) return 0;
  const hits = parseHits(body);
  if (!hits.length || overLimit(ctx.ip, hits.length, ctx.now)) return 0;
  // The same count twice in one batch is one statement.
  const grouped = new Map<string, { hit: Hit; n: number }>();
  for (const hit of hits) {
    const key = `${hit.metric}|${hit.eventId}`;
    const g = grouped.get(key);
    if (g) g.n++;
    else grouped.set(key, { hit, n: 1 });
  }
  const statements = [...grouped.values()].map(({ hit, n }) =>
    hit.eventId ? countEvent(db, ctx.now, hit.metric as EventMetric, hit.eventId, n) : countApp(db, ctx.now, hit.metric, n),
  );
  // Which reminder was tapped, for "opened" under Latest reminders.
  for (const hit of hits) {
    if (hit.sendId) statements.push(db.prepare('UPDATE push_sends SET opened = opened + 1 WHERE send_id = ?1 AND event_id = ?2').bind(hit.sendId, hit.eventId));
  }
  await db.batch(statements);
  return hits.length;
}

// ---- For admins ----

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

export interface EventStats {
  event_id: string;
  name: string;
  event_view: number;
  book_tap: number;
  bookings: number;
  places: number;
  calendar_tap: number;
  share_tap: number;
  reminder_open: number;
}

type Totals = Record<string, number>;

const sumBy = (rows: { metric: string; n: number }[]): Totals => Object.fromEntries(rows.map(r => [r.metric, r.n]));

/**
 * The last `days` days (London dates, today included), with the same number of
 * days before for comparison: totals, a day-by-day series, and every event.
 */
export async function statsOverview(db: D1Database, now: Date, days: Period) {
  const to = londonDate(now);
  const from = addDays(to, -(days - 1));
  const prevFrom = addDays(from, -days);
  const prevTo = addDays(from, -1);
  // Bookings and requests carry UTC instants: London midnight to midnight.
  const at = (day: string) => londonToUtc(day, '00:00');
  const [start, end, prevStart] = [at(from), at(addDays(to, 1)), at(prevFrom)];

  const [appNow, appBefore, eventNow, eventBefore, daily, bookings, bookingsBefore, requests, alertsOn, reminders, since] = await db.batch([
    db.prepare("SELECT metric, SUM(count) AS n FROM stats_daily WHERE event_id = '' AND day BETWEEN ?1 AND ?2 GROUP BY metric").bind(from, to),
    db.prepare("SELECT metric, SUM(count) AS n FROM stats_daily WHERE event_id = '' AND day BETWEEN ?1 AND ?2 GROUP BY metric").bind(prevFrom, prevTo),
    db
      .prepare(
        `SELECT s.event_id, s.metric, SUM(s.count) AS n, MAX(e.display_name) AS name
         FROM stats_daily s LEFT JOIN events e ON e.event_id = s.event_id
         WHERE s.event_id <> '' AND s.day BETWEEN ?1 AND ?2 GROUP BY s.event_id, s.metric`,
      )
      .bind(from, to),
    db.prepare("SELECT metric, SUM(count) AS n FROM stats_daily WHERE event_id <> '' AND day BETWEEN ?1 AND ?2 GROUP BY metric").bind(prevFrom, prevTo),
    db
      .prepare(
        `SELECT day, metric, SUM(count) AS n FROM stats_daily
         WHERE day BETWEEN ?1 AND ?2 AND metric IN ('event_view', 'app_open', 'home_screen_open') GROUP BY day, metric`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT o.event_id, MAX(e.display_name) AS name, COUNT(*) AS bookings, SUM(b.party_size) AS places
         FROM bookings b JOIN occurrences o ON o.occurrence_id = b.occurrence_id LEFT JOIN events e ON e.event_id = o.event_id
         WHERE b.created_at >= ?1 AND b.created_at < ?2 GROUP BY o.event_id`,
      )
      .bind(start, end),
    db.prepare('SELECT COUNT(*) AS bookings, COALESCE(SUM(party_size), 0) AS places FROM bookings WHERE created_at >= ?1 AND created_at < ?2').bind(prevStart, start),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM applications WHERE created_at >= ?1 AND created_at < ?2) AS join_requests,
         (SELECT COUNT(*) FROM applications WHERE created_at >= ?3 AND created_at < ?1) AS join_requests_before,
         (SELECT COUNT(*) FROM market_applications WHERE created_at >= ?1 AND created_at < ?2) AS vendor_applications,
         (SELECT COUNT(*) FROM market_applications WHERE created_at >= ?3 AND created_at < ?1) AS vendor_applications_before`,
    ).bind(start, end, prevStart),
    db.prepare('SELECT COUNT(*) AS n FROM alert_subscriptions'),
    db
      .prepare(
        `SELECT COUNT(*) AS sent, COALESCE(SUM(delivered), 0) AS delivered, COALESCE(SUM(opened), 0) AS opened
         FROM push_sends WHERE created_at >= ?1 AND created_at < ?2`,
      )
      .bind(start, end),
    db.prepare('SELECT MIN(day) AS day FROM stats_daily'),
  ]);

  // Every event with a count or a booking in the period.
  const events = new Map<string, EventStats>();
  const row = (id: string, name: string | null) => {
    let e = events.get(id);
    if (!e) {
      e = { event_id: id, name: name ?? id, event_view: 0, book_tap: 0, bookings: 0, places: 0, calendar_tap: 0, share_tap: 0, reminder_open: 0 };
      events.set(id, e);
    }
    return e;
  };
  for (const r of eventNow!.results as { event_id: string; metric: string; n: number; name: string | null }[]) {
    const e = row(r.event_id, r.name);
    if (r.metric in e) (e as unknown as Record<string, number>)[r.metric] = r.n;
  }
  for (const r of bookings!.results as { event_id: string; name: string | null; bookings: number; places: number }[]) {
    const e = row(r.event_id, r.name);
    e.bookings = r.bookings;
    e.places = r.places;
  }
  const list = [...events.values()].sort((a, b) => b.event_view - a.event_view || b.bookings - a.bookings || a.name.localeCompare(b.name));
  await nameApart(db, list);

  // Day by day, with the empty days filled in.
  const byDay = new Map<string, { day: string; event_view: number; app_open: number; home_screen_open: number }>();
  for (let d = from; d <= to; d = addDays(d, 1)) byDay.set(d, { day: d, event_view: 0, app_open: 0, home_screen_open: 0 });
  for (const r of daily!.results as { day: string; metric: 'event_view' | 'app_open' | 'home_screen_open'; n: number }[]) {
    const d = byDay.get(r.day);
    if (d) d[r.metric] = r.n;
  }

  const sum = (key: keyof EventStats) => list.reduce((n, e) => n + (e[key] as number), 0);
  const req = requests!.results[0] as Record<string, number>;
  const before = bookingsBefore!.results[0] as { bookings: number; places: number };
  const sent = reminders!.results[0] as { sent: number; delivered: number; opened: number };
  return {
    days,
    from,
    to,
    counting_since: (since!.results[0] as { day: string | null }).day,
    totals: {
      ...sumBy(appNow!.results as { metric: string; n: number }[]),
      event_view: sum('event_view'),
      book_tap: sum('book_tap'),
      calendar_tap: sum('calendar_tap'),
      share_tap: sum('share_tap'),
      reminder_open: sum('reminder_open'),
      bookings: sum('bookings'),
      places: sum('places'),
      join_requests: req.join_requests!,
      vendor_applications: req.vendor_applications!,
      reminders_sent: sent.sent,
      reminders_delivered: sent.delivered,
    } as Totals,
    previous: {
      ...sumBy(appBefore!.results as { metric: string; n: number }[]),
      ...sumBy(eventBefore!.results as { metric: string; n: number }[]),
      bookings: before.bookings,
      places: before.places,
      join_requests: req.join_requests_before!,
      vendor_applications: req.vendor_applications_before!,
    } as Totals,
    alerts_on_now: (alertsOn!.results[0] as { n: number }).n,
    daily: [...byDay.values()],
    events: list,
  };
}

/**
 * Two events with the same name (a club on Mondays and on Thursdays) get their
 * day added, "(Mondays)", or for one-offs and monthly ones, their latest date.
 */
async function nameApart(db: D1Database, list: EventStats[]): Promise<void> {
  const seen = new Map<string, number>();
  for (const e of list) seen.set(e.name, (seen.get(e.name) ?? 0) + 1);
  const clashing = list.filter(e => seen.get(e.name)! > 1);
  if (!clashing.length) return;
  const { results } = await db
    .prepare(
      `SELECT e.event_id, e.frequency, (SELECT MAX(o.event_date) FROM occurrences o WHERE o.event_id = e.event_id) AS last_date
       FROM events e WHERE e.event_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(clashing.map(e => e.event_id)))
    .all<{ event_id: string; frequency: string; last_date: string | null }>();
  const info = new Map(results.map(r => [r.event_id, r]));
  for (const e of clashing) {
    const r = info.get(e.event_id);
    if (!r?.last_date) continue;
    const repeating = r.frequency === 'weekly' || r.frequency === 'fortnightly';
    e.name = `${e.name} (${repeating ? `${weekdayOf(r.last_date)}s` : shortDate(r.last_date)})`;
  }
}

export type StatsOverview = Awaited<ReturnType<typeof statsOverview>>;
