import { ArrowRight, CalendarDays, ChevronRight, Clock, Lock } from 'lucide-preact';
import type { Occurrence } from '../lib/api';
import { CATEGORY } from '../lib/categories';
import { formatTime, timeRange, todayLondon, whenLabel } from '../lib/dates';
import { ChipRow, occurrenceChips } from './Chips';
import { EventArt } from './EventArt';
import { ShareMenu } from './ShareMenu';
import { eventShare } from '../lib/shareLinks';

/** Only a date that's going ahead has something to share (a private game too: it's looking for players). */
const shareable = (o: Occurrence) => o.status !== 'cancelled';
const isPrivate = (o: Occurrence) => o.visibility === 'private';
const JOIN = 'Interested in joining? Get in touch!';

export const eventHref = (o: Occurrence) => `/event/${o.occurrence_id}`;

export function EventCard({ o, feature, today = todayLondon() }: { o: Occurrence; feature?: boolean; today?: string }) {
  return (
    <div class="share-host">
      <a class={`card event-card${feature ? ' card--feature feature-event' : ''}`} href={eventHref(o)}>
        <EventArt image={o.image} category={o.category} seed={o.event_id} eager={feature}>
          <ChipRow chips={occurrenceChips(o, today)} />
        </EventArt>
        <div class="event-card__body">
          <h3 class="event-card__title">{o.name}</h3>
          <p class="when">
            <CalendarDays size={18} aria-hidden="true" />
            {whenLabel(o, today)}
          </p>
          {isPrivate(o) && (
            <p class="private-tag">
              <Lock size={15} aria-hidden="true" /> Private game
            </p>
          )}
          {o.description && <p class="event-card__desc">{o.description}</p>}
          <span class="event-card__cta" aria-hidden="true">
            {isPrivate(o) ? JOIN : 'View'} <ArrowRight size={16} />
          </span>
        </div>
      </a>
      {shareable(o) && <ShareMenu data={eventShare(o, location.origin)} eventId={o.event_id} compact />}
    </div>
  );
}

/** Diary row, styled as a ticket with a tear-off time stub. */
export function EventTicket({ o, today = todayLondon() }: { o: Occurrence; today?: string }) {
  const time = formatTime(o.start_time);
  const [clock, ampm] = time ? time.split(' ') : [null, null];
  const Icon = CATEGORY[o.category]?.icon ?? CATEGORY.Other.icon;
  const range = timeRange(o.start_time, o.end_time);
  const stub = (
    <div class={`ticket__stub${time ? '' : ' ticket__stub--tbc'}`} aria-hidden="true">
      <span class="ticket__time">{clock ?? 'TBC'}</span>
      {ampm && <span class="ticket__ampm">{ampm}</span>}
    </div>
  );
  return (
    <div class="share-host">
      <a class={`ticket${o.status === 'cancelled' ? ' ticket--cancelled' : ''}${isPrivate(o) ? ' ticket--private' : ''}`} href={eventHref(o)}>
        {stub}
        <div class="ticket__body">
          <div class="cluster" style={{ '--gap': '6px' }}>
            <ChipRow chips={occurrenceChips(o, today)} />
          </div>
          <h3 class="ticket__title">{o.name}</h3>
          <p class="ticket__meta">
            {isPrivate(o) ? (
              <span>
                <Lock size={15} aria-hidden="true" />
                Private game
              </span>
            ) : (
              <span>
                <Icon size={15} aria-hidden="true" />
                {CATEGORY[o.category]?.label ?? 'At the café'}
              </span>
            )}
            <span>
              <Clock size={15} aria-hidden="true" />
              {range ?? 'Time to be confirmed'}
            </span>
          </p>
          {o.description && <p class="ticket__desc">{o.description}</p>}
          {isPrivate(o) && o.status !== 'cancelled' && <p class="ticket__join">{JOIN}</p>}
        </div>
        <ChevronRight class="ticket__chev" size={22} aria-hidden="true" />
      </a>
      {shareable(o) && <ShareMenu data={eventShare(o, location.origin)} eventId={o.event_id} compact />}
    </div>
  );
}
