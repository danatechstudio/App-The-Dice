// Stats in the organiser, for admins (docs/RTD_STATS.md): how the app is used,
// from daily totals of page views and taps (nothing about who), plus bookings,
// requests and reminders from their own records.

import { TrendingDown, TrendingUp } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { DiceLoader } from '../components/States';
import { longDate, shortDate } from '../lib/dates';
import { hostApi } from '../lib/hostApi';

type Period = 7 | 30 | 90;

interface EventStats {
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

interface Stats {
  days: Period;
  from: string;
  to: string;
  counting_since: string | null;
  totals: Record<string, number>;
  previous: Record<string, number>;
  alerts_on_now: number;
  daily: { day: string; event_view: number; app_open: number; home_screen_open: number }[];
  events: EventStats[];
}

const fmt = (n: number) => n.toLocaleString('en-GB');
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;

export function StatsAdmin() {
  const [days, setDays] = useState<Period>(30);
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (d: Period) => {
    setLoading(true);
    const res = await hostApi<Stats>(`/api/staff/stats?days=${d}`);
    setLoading(false);
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else setError(res.error);
  }, []);
  useEffect(() => void load(days), [days, load]);

  return (
    <section class="section stats" aria-labelledby="stats-admin">
      <div class="section-head">
        <h2 id="stats-admin">Stats</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        How the app is used: page views and taps, counted as daily totals with nothing about who, plus bookings and requests. Visits by the café team and hosts
        (signed in to the organiser) aren't counted.
        {data?.counting_since ? ` Counting since ${longDate(data.counting_since)}.` : ''}
      </p>
      <div class="segmented segmented--inline stats__period" role="group" aria-label="Period">
        {([7, 30, 90] as const).map(d => (
          <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
            {d} days
          </button>
        ))}
      </div>
      {error && !data && <p class="meta">{error}</p>}
      {!data && !error && <DiceLoader label="Counting..." />}
      {data && (
        <div class="stats__body" data-loading={loading || undefined} aria-busy={loading}>
          <Tiles s={data} />
          <ViewsChart s={data} />
          <TopLists events={data.events} />
          <EventTable events={data.events} />
          <AroundTheApp s={data} />
        </div>
      )}
    </section>
  );
}

// ---- Headline numbers ----

function Delta({ now, before, days }: { now: number; before: number; days: number }) {
  const diff = now - before;
  if (!before && !now) return null;
  const label = !before ? 'new' : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${fmt(Math.abs(diff))}`;
  const Icon = diff >= 0 ? TrendingUp : TrendingDown;
  return (
    <p class={`stat-tile__delta${diff > 0 ? ' is-up' : diff < 0 ? ' is-down' : ''}`}>
      {diff !== 0 && <Icon size={14} aria-hidden="true" />}
      <span>
        {label} <span class="meta">vs the {days} days before</span>
      </span>
    </p>
  );
}

function Tiles({ s }: { s: Stats }) {
  const t = (k: string) => s.totals[k] ?? 0;
  const p = (k: string) => s.previous[k] ?? 0;
  const tiles: { label: string; value: number; note?: string; key?: string }[] = [
    { label: 'Event page views', value: t('event_view'), key: 'event_view' },
    { label: 'Bookings', value: t('bookings'), note: plural(t('places'), 'place', 'places'), key: 'bookings' },
    { label: 'Opens from the Home Screen', value: t('home_screen_open'), note: 'People who installed the app', key: 'home_screen_open' },
    { label: 'Visits in a browser', value: t('app_open'), key: 'app_open' },
    { label: 'Installs', value: t('install'), note: 'Android and computers; iPhone doesn\'t say', key: 'install' },
    { label: 'Event alerts on now', value: s.alerts_on_now, note: `${fmt(t('alerts_on'))} turned on, ${fmt(t('alerts_off'))} off in this period` },
  ];
  return (
    <div class="stat-tiles">
      {tiles.map(x => (
        <div class="stat-tile card" key={x.label}>
          <p class="stat-tile__label">{x.label}</p>
          <p class="stat-tile__value">{fmt(x.value)}</p>
          {x.note && <p class="meta stat-tile__note">{x.note}</p>}
          {x.key && <Delta now={x.value} before={p(x.key)} days={s.days} />}
        </div>
      ))}
    </div>
  );
}

// ---- Event page views over time (one series: columns, a tooltip on each) ----

/** A round number at or above the largest value, for the scale. */
function niceMax(n: number): number {
  if (n <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= n) return m * step;
  return 10 * step;
}

function ViewsChart({ s }: { s: Stats }) {
  // 90 days as weeks, so each column stays readable on a phone.
  const weekly = s.days === 90;
  const points = weekly
    ? Array.from({ length: Math.ceil(s.daily.length / 7) }, (_, i) => {
        const week = s.daily.slice(i * 7, i * 7 + 7);
        // The newest week can be short: it ends today.
        const part = week.length < 7 ? ` (${week.length} days so far)` : '';
        return { label: `Week of ${shortDate(week[0]!.day)}${part}`, short: shortDate(week[0]!.day), value: week.reduce((n, d) => n + d.event_view, 0) };
      })
    : s.daily.map(d => ({ label: longDate(d.day), short: shortDate(d.day), value: d.event_view }));
  const max = niceMax(Math.max(0, ...points.map(p => p.value)));
  const [tip, setTip] = useState<number | null>(null);
  const title = `Event page views per ${weekly ? 'week' : 'day'}`;
  const ticks = [max, max / 2, 0];
  // Dates under the first, middle and last columns only.
  const marks = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];

  return (
    <figure class="card card--pad stats-chart">
      <figcaption>
        <h3>{title}</h3>
      </figcaption>
      <div class="stats-chart__plot">
        <div class="stats-chart__axis" aria-hidden="true">
          {ticks.map(v => (
            <span key={v}>{fmt(v)}</span>
          ))}
        </div>
        <div class="stats-chart__area">
          {ticks.map(v => (
            <span key={v} class="stats-chart__grid" style={{ bottom: `${(v / max) * 100}%` }} aria-hidden="true" />
          ))}
          <div class="stats-chart__cols" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }} onPointerLeave={() => setTip(null)}>
            {points.map((p, i) => (
              <button
                key={p.label}
                type="button"
                class="stats-chart__col"
                aria-label={`${p.label}: ${plural(p.value, 'view', 'views')}`}
                onPointerEnter={() => setTip(i)}
                onFocus={() => setTip(i)}
                onBlur={() => setTip(null)}
              >
                <span class="stats-chart__bar" data-active={tip === i || undefined} style={{ height: `${(p.value / max) * 100}%` }} />
              </button>
            ))}
          </div>
          {tip !== null && points[tip] && (
            <div
              class="stats-chart__tip"
              role="status"
              style={{ left: `${((tip + 0.5) / points.length) * 100}%`, transform: `translateX(${tip < points.length / 4 ? '-10%' : tip > (points.length * 3) / 4 ? '-90%' : '-50%'})` }}
            >
              <strong>{fmt(points[tip]!.value)}</strong>
              <span>{points[tip]!.label}</span>
            </div>
          )}
        </div>
      </div>
      <div class="stats-chart__x" aria-hidden="true">
        {marks.map(i => (
          <span key={i}>{points[i]!.short}</span>
        ))}
      </div>
      <details class="stats-chart__table">
        <summary>Show as a table</summary>
        <table class="table">
          <thead>
            <tr>
              <th scope="col">{weekly ? 'Week' : 'Day'}</th>
              <th scope="col" class="num">Event page views</th>
            </tr>
          </thead>
          <tbody>
            {points.map(p => (
              <tr key={p.label}>
                <td>{p.label}</td>
                <td class="num">{fmt(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

// ---- Most viewed, most booked, most tapped ----

function TopList({ title, rows, unit }: { title: string; rows: { name: string; value: number; note?: string }[]; unit: [string, string] }) {
  const top = rows.filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 5);
  const max = top[0]?.value ?? 0;
  return (
    <div class="card card--pad stats-top">
      <h3>{title}</h3>
      {!top.length ? (
        <p class="meta">Nothing yet.</p>
      ) : (
        <ol class="stats-top__list" role="list">
          {top.map(r => (
            <li key={r.name}>
              <span class="stats-top__name">{r.name}</span>
              <span class="stats-top__row">
                <span class="stats-top__bar" style={{ width: `${(r.value / max) * 100}%` }} aria-hidden="true" />
                <span class="stats-top__value">
                  {plural(r.value, unit[0], unit[1])}
                  {r.note ? <span class="meta"> · {r.note}</span> : null}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TopLists({ events }: { events: EventStats[] }) {
  return (
    <div class="stats-tops">
      <TopList title="Most viewed" unit={['view', 'views']} rows={events.map(e => ({ name: e.name, value: e.event_view }))} />
      <TopList
        title="Most booked"
        unit={['booking', 'bookings']}
        rows={events.map(e => ({ name: e.name, value: e.bookings, note: plural(e.places, 'place', 'places') }))}
      />
      <TopList
        title="Most tapped"
        unit={['tap', 'taps']}
        rows={events.map(e => ({ name: e.name, value: e.book_tap + e.calendar_tap + e.share_tap }))}
      />
    </div>
  );
}

// ---- Every event ----

const rate = (bookings: number, views: number) => (views ? `${Math.round((bookings / views) * 100)}%` : '–');

function EventTable({ events }: { events: EventStats[] }) {
  return (
    <div class="stack" style={{ '--gap': '8px' }}>
      <h3>Every event</h3>
      {!events.length ? (
        <p class="meta">No views or bookings in this period yet.</p>
      ) : (
        <div class="table-wrap">
          <table class="table table--stack stats-table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col" class="num">Views</th>
                <th scope="col" class="num">Book taps</th>
                <th scope="col" class="num">Bookings</th>
                <th scope="col" class="num">Booked per view</th>
                <th scope="col" class="num">Calendar</th>
                <th scope="col" class="num">Shares</th>
                <th scope="col" class="num">Reminder taps</th>
              </tr>
            </thead>
            <tbody>
              {events.map(e => (
                <tr key={e.event_id}>
                  <td data-label="Event">
                    <strong>{e.name}</strong>
                  </td>
                  <td data-label="Views" class="num">{fmt(e.event_view)}</td>
                  <td data-label="Book taps" class="num">{fmt(e.book_tap)}</td>
                  <td data-label="Bookings" class="num">
                    {fmt(e.bookings)} <span class="meta">({plural(e.places, 'place', 'places')})</span>
                  </td>
                  <td data-label="Booked per view" class="num">{rate(e.bookings, e.event_view)}</td>
                  <td data-label="Calendar" class="num">{fmt(e.calendar_tap)}</td>
                  <td data-label="Shares" class="num">{fmt(e.share_tap)}</td>
                  <td data-label="Reminder taps" class="num">{fmt(e.reminder_open)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="meta">
        Book taps count each press of the book button, including ones the form turned back. Bookings are the bookings made. "Booked per view" is
        bookings divided by views.
      </p>
    </div>
  );
}

// ---- Everything else ----

function AroundTheApp({ s }: { s: Stats }) {
  const t = (k: string) => s.totals[k] ?? 0;
  const rows: [string, string][] = [
    ['Diary views', fmt(t('diary_view'))],
    ['Book page views', fmt(t('book_page_view'))],
    ['Games page views (Game of the Week)', fmt(t('gotw_view'))],
    ['Roll Me a Game rolls', fmt(t('roll_use'))],
    ['"This One!" picks after a roll', fmt(t('roll_pick'))],
    ['Become a host page views', fmt(t('host_page_view'))],
    ['Apply to host taps', fmt(t('host_apply_tap'))],
    ['Requests to host or join the team', fmt(t('join_requests'))],
    ['Markets page views', fmt(t('markets_view'))],
    ['Market stall applications', fmt(t('vendor_applications'))],
    ['Event reminders sent', `${fmt(t('reminders_sent'))} (reached ${plural(t('reminders_delivered'), 'device', 'devices')}, ${fmt(t('reminder_open'))} tapped)`],
  ];
  return (
    <div class="stack" style={{ '--gap': '8px' }}>
      <h3>Around the app</h3>
      <dl class="stats-around card card--pad">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
