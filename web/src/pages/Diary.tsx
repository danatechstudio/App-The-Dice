import { useState } from 'preact/hooks';
import { EventTicket } from '../components/EventCard';
import { DiceLoader, EmptyState, ErrorState } from '../components/States';
import type { Category } from '../lib/api';
import { CATEGORY } from '../lib/categories';
import { addDays, longDate } from '../lib/dates';
import { groupByDate, notOver, useUpcoming } from '../lib/events';
import { read, write } from '../lib/storage';
import { useTitle } from '../lib/title';

// Rolling windows, so "this week" is never just one day on a Sunday.
const RANGES = [
  { id: 'today', label: 'Today', days: 0 },
  { id: 'week', label: 'This week', days: 6 },
  { id: 'month', label: 'This month', days: 30 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

export function Diary() {
  useTitle("What's on");
  // Private sessions are listed too (as "Private session"), so the café shows as busy as it is.
  const { withPrivate: occurrences, error, loading, reload, today } = useUpcoming();
  const [range, setRange] = useState<RangeId>(() => read<RangeId>('rtd.diary.range', 'week'));
  const [category, setCategory] = useState<Category | null>(null);

  const days = RANGES.find(r => r.id === range)!.days;
  const end = addDays(today, days);
  const inRange = (occurrences ?? []).filter(o => notOver(o, today) && o.date <= end);
  const categories = [...new Set(inRange.map(o => o.category))].sort();
  const shown = category ? inRange.filter(o => o.category === category) : inRange;

  const pick = (id: RangeId) => {
    setRange(id);
    setCategory(null);
    write('rtd.diary.range', id);
  };

  return (
    <div class="container">
      <header class="page-head">
        <p class="label">The diary</p>
        <h1>What's on</h1>
      </header>
      <div class="diary-layout">
        <div class="diary-controls">
          <div class="segmented" role="group" aria-label="When">
            {RANGES.map(r => (
              <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => pick(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          {categories.length > 1 && (
            <div class="filters-scroll" role="group" aria-label="Type of event">
              <button type="button" class="filter" aria-pressed={!category} onClick={() => setCategory(null)}>
                Everything
              </button>
              {categories.map(c => {
                const Icon = CATEGORY[c].icon;
                return (
                  <button key={c} type="button" class="filter" aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
                    <Icon size={16} aria-hidden="true" />
                    {CATEGORY[c].label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <section aria-live="polite" aria-busy={loading}>
          {loading && !occurrences && <DiceLoader />}
          {error && !occurrences && <ErrorState error={error} onRetry={reload} />}
          {occurrences && shown.length === 0 && (
            <EmptyState
              title="Nothing on the table yet."
              text={range === 'month' ? 'Check back soon for more events.' : 'Nothing booked in for then. Try a longer view.'}
            >
              {range !== 'month' && (
                <button type="button" class="btn btn--secondary" onClick={() => pick('month')}>
                  See this month
                </button>
              )}
            </EmptyState>
          )}
          {groupByDate(shown).map(([date, list]) => (
            <div class="diary-day" key={date}>
              <h2 class="date-divider">{date === today ? `Today · ${longDate(date)}` : longDate(date)}</h2>
              <div class="list" role="list">
                {list.map(o => (
                  <div role="listitem" key={o.occurrence_id}>
                    <EventTicket o={o} today={today} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
