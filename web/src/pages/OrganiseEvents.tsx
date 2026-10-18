// Admins: every event in one list (docs/superpowers/specs/2026-10-18-admin-event-editor-design.md),
// café events from both tabs, hosts' sessions and markets, whether public, private or hidden,
// running or stopped. Each opens the editor (OrganiseEventEdit).

import { ChevronRight } from 'lucide-preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { DiceLoader } from '../components/States';
import { shortDate } from '../lib/dates';
import { hostApi, type AdminEventRow, type EventKind, type EventVisibility } from '../lib/hostApi';

export const KIND_LABEL: Record<EventKind, string> = {
  event_index: 'Café · Event Index',
  standard_diary: 'Café · Standard Diary',
  host_session: 'Host session',
  market: 'Market',
};
export const VISIBILITY_LABEL: Record<EventVisibility, string> = { public: 'Public', app_bookable: 'App Bookable', private: 'Private', hidden: 'Hidden' };

const FILTERS = {
  all: { label: 'All', test: () => true },
  cafe: { label: 'Café', test: (e: AdminEventRow) => e.kind === 'event_index' || e.kind === 'standard_diary' },
  hosts: { label: 'Host sessions', test: (e: AdminEventRow) => e.kind === 'host_session' },
  markets: { label: 'Markets', test: (e: AdminEventRow) => e.kind === 'market' },
  stopped: { label: 'Stopped', test: (e: AdminEventRow) => !e.active },
  unlisted: { label: 'Hidden or private', test: (e: AdminEventRow) => e.visibility === 'hidden' || e.visibility === 'private' },
} as const;
type Filter = keyof typeof FILTERS;

export function AllEventsPanel() {
  const [events, setEvents] = useState<AdminEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  useEffect(() => {
    void hostApi<{ events: AdminEventRow[] }>('/api/staff/events').then(res => (res.ok ? setEvents(res.data.events) : setError(res.error)));
  }, []);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (events ?? []).filter(
      e => FILTERS[filter].test(e) && (!needle || e.name.toLowerCase().includes(needle) || e.event_id.toLowerCase().includes(needle)),
    );
  }, [events, q, filter]);

  return (
    <section class="section" aria-labelledby="all-events">
      <div class="section-head">
        <h2 id="all-events">All events</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Every event, whatever its kind or who can see it. Open one to change its details, who can see it, places and booking, or to cancel it. Details go to the
        Logic Engine first; places and booking change straight away.
      </p>
      <div class="all-events__tools">
        <input
          class="input"
          type="search"
          placeholder="Search by name or RTD-EVT number"
          aria-label="Search events"
          value={q}
          onInput={e => setQ(e.currentTarget.value)}
        />
        <div class="filter-chips" role="group" aria-label="Show">
          {(Object.keys(FILTERS) as Filter[]).map(f => (
            <button key={f} type="button" class="btn btn--sm btn--secondary" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {FILTERS[f].label}
            </button>
          ))}
        </div>
      </div>
      {error && <p class="field__error">{error}</p>}
      {events === null && !error && <DiceLoader label="Loading events..." />}
      {events && !shown.length && <p class="meta">No events match.</p>}
      <ul class="all-events__list">
        {shown.map(e => (
          <li key={e.event_id}>
            <a class="all-events__row" href={`/organise/events/${e.event_id}`}>
              <span class="all-events__main">
                <strong>{e.name}</strong>
                <span class="meta">
                  {[KIND_LABEL[e.kind], e.next_date ? `next ${shortDate(e.next_date)}` : 'no dates to come', e.bookings ? `${e.bookings} booked` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span class="all-events__tags">
                  <span class={`tag tag--${e.visibility}`}>{VISIBILITY_LABEL[e.visibility]}</span>
                  {!e.active && <span class="tag tag--stopped">Stopped</span>}
                  {e.pending && <span class="tag tag--pending">{e.pending.kind === 'host_change' ? 'Host change waiting' : 'Change on its way'}</span>}
                </span>
              </span>
              <ChevronRight size={18} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
