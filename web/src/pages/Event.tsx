import { CalendarDays, CalendarPlus, ChevronDown, ChevronLeft, Clock, Info, MapPin, PoundSterling, Share2, TriangleAlert, UsersRound } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AlertsInline } from '../components/Alerts';
import { BookingPanel } from '../components/BookingPanel';
import { MarketVendorPanel } from './Markets';
import { Chip, ChipRow, occurrenceChips } from '../components/Chips';
import { eventHref } from '../components/EventCard';
import { EventArt } from '../components/EventArt';
import { Gallery } from '../components/Gallery';
import { DiceLoader, EmptyState, ErrorState } from '../components/States';
import { useApi, type EventSummary, type Occurrence } from '../lib/api';
import { CATEGORY } from '../lib/categories';
import { longDate, shortDate, timeRange, todayLondon } from '../lib/dates';
import { back } from '../lib/router';
import { share } from '../lib/share';
import { count } from '../lib/stats';
import { useTitle } from '../lib/title';

type Series = { event: EventSummary; occurrences: Occurrence[] };

/** /event/:occurrenceId — one date of an event (the link people share). */
export function EventPage({ occurrenceId }: { occurrenceId: string }) {
  const res = useApi<{ occurrence: Occurrence }>(`/api/occurrences/${encodeURIComponent(occurrenceId)}`);
  const o = res.data?.occurrence;
  const series = useApi<Series>(o ? `/api/events/${o.event_id}` : null);
  useTitle(o?.name);
  if (res.loading && !o) return <DiceLoader label="Finding that event..." />;
  if (res.error?.status === 404) return <MissingEvent />;
  if (!o) return <ErrorState error={res.error} onRetry={res.reload} />;
  return (
    <EventDetail
      o={o}
      others={(series.data?.occurrences ?? []).filter(x => x.occurrence_id !== o.occurrence_id)}
      images={o.images ?? series.data?.event.images ?? []}
    />
  );
}

/** /events/:eventId — an evergreen link to an event: shows its next date. */
export function SeriesPage({ eventId }: { eventId: string }) {
  const res = useApi<Series>(`/api/events/${encodeURIComponent(eventId)}`);
  useTitle(res.data?.event.name);
  if (res.loading && !res.data) return <DiceLoader label="Finding that event..." />;
  if (res.error?.status === 404) return <MissingEvent />;
  if (!res.data) return <ErrorState error={res.error} onRetry={res.reload} />;
  const [next, ...others] = res.data.occurrences;
  if (!next) {
    return (
      <div class="container">
        <EmptyState title={res.data.event.name} text="No dates in the diary for this one yet. Check back soon.">
          <a class="btn btn--primary" href="/diary">See what's on</a>
        </EmptyState>
      </div>
    );
  }
  return <EventDetail o={next} others={others} images={res.data.event.images ?? []} />;
}

function MissingEvent() {
  return (
    <div class="container">
      <EmptyState title="That event has rolled under the table." text="It may have finished, or the link is out of date.">
        <a class="btn btn--primary" href="/diary">See what's on</a>
      </EmptyState>
    </div>
  );
}

function EventDetail({ o, others, images }: { o: Occurrence; others: Occurrence[]; images: string[] }) {
  const today = todayLondon();
  const cancelled = o.status === 'cancelled';
  const moved = o.status === 'rescheduled';
  const finished = o.status === 'completed' || o.date < today;
  const range = timeRange(o.start_time, o.end_time);
  const Icon = CATEGORY[o.category]?.icon ?? CATEGORY.Other.icon;
  const url = `${location.origin}${eventHref(o)}`;
  useEffect(() => count('event_view', o.event_id), [o.occurrence_id]);

  return (
    <div class="container">
      <a class="back-link" href="/diary" onClick={e => (e.preventDefault(), back('/diary'))}>
        <ChevronLeft size={20} aria-hidden="true" /> Back
      </a>
      <div class="event-page">
        <article>
          <div class="event-page__art">
            <EventArt image={o.image} category={o.category} seed={o.event_id} eager>
              <ChipRow chips={occurrenceChips(o, today)} />
            </EventArt>
          </div>
          <header class="event-page__head">
            <div class="cluster">
              <Chip kind="category">
                <Icon aria-hidden="true" />
                {CATEGORY[o.category]?.label}
              </Chip>
            </div>
            <h1 class={cancelled ? 'event-page__title--cancelled' : undefined}>{o.name}</h1>
          </header>
          <div class="stack" style={{ '--gap': '16px', marginTop: '16px' }}>
            {cancelled && (
              <div class="notice notice--danger" role="alert">
                <TriangleAlert size={22} aria-hidden="true" />
                <div>
                  <strong>This event has been cancelled.</strong>
                  <p>Sorry about that. {others.length ? 'Other dates are below.' : 'Keep an eye on the diary for new dates.'}</p>
                </div>
              </div>
            )}
            {moved && (
              <div class="notice notice--warning" role="alert">
                <Info size={22} aria-hidden="true" />
                <div>
                  <strong>This date has moved.</strong>
                  <p>{others[0] ? `The next date is ${longDate(others[0].date)}.` : 'The new date will appear in the diary soon.'}</p>
                </div>
              </div>
            )}
            {!cancelled && !moved && finished && (
              <div class="notice notice--info">
                <Info size={22} aria-hidden="true" />
                <div>
                  <strong>This one has finished.</strong>
                  {others[0] && <p>The next date is {longDate(others[0].date)}.</p>}
                </div>
              </div>
            )}
            {o.description && <p class="event-page__desc reading">{o.description}</p>}
          </div>
          <Gallery images={images} name={o.name} />
        </article>

        <aside class="event-page__side">
          <div class="card card--pad event-page__panel">
            <div class="facts">
              <div class="fact">
                <span class="fact__icon"><CalendarDays size={20} aria-hidden="true" /></span>
                <span><strong>{longDate(o.date)}</strong></span>
              </div>
              <div class="fact">
                <span class="fact__icon"><Clock size={20} aria-hidden="true" /></span>
                <span><strong>{range ?? 'Time to be confirmed'}</strong></span>
              </div>
              {o.price_display && (
                <div class="fact">
                  <span class="fact__icon"><PoundSterling size={20} aria-hidden="true" /></span>
                  <span>
                    <strong>{/^free$/i.test(o.price_display.trim()) ? 'Free' : `${o.price_display} per player`}</strong>
                    {!/^free$/i.test(o.price_display.trim()) && 'Paid at the café'}
                  </span>
                </div>
              )}
              {o.capacity && (
                <div class="fact">
                  <span class="fact__icon"><UsersRound size={20} aria-hidden="true" /></span>
                  <span><strong>Up to {o.capacity} players</strong></span>
                </div>
              )}
              <div class="fact">
                <span class="fact__icon"><MapPin size={20} aria-hidden="true" /></span>
                <span><strong>Roll The Dice</strong>Board Game Café</span>
              </div>
            </div>
            {!cancelled && !finished && !moved && (o.market_id ? <MarketVendorPanel marketId={o.market_id} /> : <BookingPanel key={o.occurrence_id} o={o} />)}
            <div class="event-page__actions">
              {!cancelled && !finished && !moved ? <CalendarMenu o={o} /> : <span />}
              <button type="button" class="btn btn--secondary" onClick={() => (count('share_tap', o.event_id), share({ title: o.name, text: `${o.name} at Roll The Dice, ${shortDate(o.date)}`, url }))}>
                <Share2 size={18} aria-hidden="true" /> Share
              </button>
            </div>
            <AlertsInline />
            {others.length > 0 && (
              <div class="stack" style={{ '--gap': '8px' }}>
                <h2 class="label">Other dates</h2>
                <div class="other-dates">
                  {others.slice(0, 8).map(x => (
                    <a key={x.occurrence_id} href={eventHref(x)}>
                      {shortDate(x.date)}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function CalendarMenu({ o }: { o: Occurrence }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const base = `/api/occurrences/${o.occurrence_id}`;
  return (
    <div class="menu" ref={box}>
      <button type="button" class="btn btn--primary" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        <CalendarPlus size={18} aria-hidden="true" /> Add to calendar <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div class="menu__list">
          <a href={`${base}/calendar.ics`} download onClick={() => (count('calendar_tap', o.event_id), setOpen(false))}>
            Apple, Outlook & others (.ics)
          </a>
          <a href={`${base}/google-calendar`} target="_blank" rel="noopener" onClick={() => (count('calendar_tap', o.event_id), setOpen(false))}>
            Google Calendar
          </a>
        </div>
      )}
    </div>
  );
}
