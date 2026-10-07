// Dates and bookings in the organiser (docs/RTD_BOOKINGS.md):
// - SessionDates: a host's live session, date by date, with who's booked;
// - HostedDatesPanel: approvers see the next three weeks of hosted dates and
//   booked café events;
// both let the host (or an approver) change a date's places, or cancel it,
// which emails everyone booked.

import { Ban, ChevronDown, Mail, Phone } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader } from '../components/States';
import { shortDate, timeRange } from '../lib/dates';
import { hostApi, MAX_PLACES, type HostedDate, type SessionDate } from '../lib/hostApi';
import { toast } from '../lib/toast';
import { DatePlaces } from './OrganisePlaces';

const placesText = (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`;

export function SessionDates({ dates, onChanged }: { dates: SessionDate[]; onChanged: () => void }) {
  if (!dates.length) return null;
  return (
    <div class="date-list" role="list" aria-label="Upcoming dates">
      {dates.slice(0, 6).map(d => (
        <DateRow key={d.occurrence_id} d={d} maxPlaces={MAX_PLACES.hosted} onChanged={onChanged} />
      ))}
    </div>
  );
}

function DateRow({
  d,
  title,
  contact,
  maxPlaces,
  onChanged,
}: {
  d: SessionDate;
  title?: string;
  contact?: boolean;
  maxPlaces: number;
  onChanged: () => void;
}) {
  const [action, setAction] = useState<'places' | 'cancel' | null>(null);
  const cancelling = action === 'cancel';
  const setCancelling = (on: boolean) => setAction(on ? 'cancel' : null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const cancelled = d.status === 'cancelled';
  const when = `${shortDate(d.event_date)}${d.start_time ? `, ${timeRange(d.start_time, d.end_time)}` : ''}`;
  const people = d.bookings.length;

  const cancel = async () => {
    setBusy(true);
    const res = await hostApi<{ cancelled_bookings: number }>(`/api/host/occurrences/${d.occurrence_id}/cancel`, { message });
    setBusy(false);
    if (res.ok) {
      toast(res.data.cancelled_bookings ? `Cancelled. ${res.data.cancelled_bookings} ${res.data.cancelled_bookings === 1 ? 'booking' : 'bookings'} will be emailed.` : 'Date cancelled.');
      setCancelling(false);
      onChanged();
    } else toast(res.error);
  };

  return (
    <div class={`date-row${cancelled ? ' date-row--cancelled' : ''}`} role="listitem">
      <div class="date-row__main">
        <div class="date-row__when">
          {title && <strong class="date-row__title">{title}</strong>}
          <span>{when}</span>
        </div>
        {cancelled ? (
          <Chip kind="cancelled">
            <Ban aria-hidden="true" /> Cancelled{d.cancelled_by === 'staff' ? ' by the café' : ''}
          </Chip>
        ) : (
          <span class="date-row__count">
            {d.capacity ? `${d.booked} of ${d.capacity} booked` : `${d.booked} booked`}
            {d.own_capacity !== null && <span class="meta"> (this date)</span>}
          </span>
        )}
      </div>
      {!cancelled && people > 0 && (
        <details class="date-row__people">
          <summary>
            Who's coming <ChevronDown size={16} aria-hidden="true" />
          </summary>
          <ul>
            {d.bookings.map(b => (
              <li key={b.booking_id}>
                <strong>{b.lead_name}</strong> · {placesText(b.party_size)}
                {b.notes && <span class="meta"> · "{b.notes}"</span>}
                {contact && b.email && (
                  <span class="date-row__contact">
                    <a href={`mailto:${b.email}`}><Mail size={14} aria-hidden="true" /> {b.email}</a>
                    {b.mobile && (
                      <a href={`tel:${b.mobile.replace(/\s+/g, '')}`}><Phone size={14} aria-hidden="true" /> {b.mobile}</a>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!cancelled && action === 'places' && (
        <DatePlaces
          occurrenceId={d.occurrence_id}
          current={d.capacity}
          own={d.own_capacity}
          max={maxPlaces}
          onClose={() => setAction(null)}
          onSaved={() => (setAction(null), onChanged())}
        />
      )}
      {!cancelled &&
        action !== 'places' &&
        (cancelling ? (
          <div class="stack date-row__cancel" style={{ '--gap': '8px' }}>
            <label class="label" for={`msg-${d.occurrence_id}`}>
              {people ? 'Message for the people booked (optional)' : 'Reason (optional)'}
            </label>
            <textarea id={`msg-${d.occurrence_id}`} class="input" rows={2} maxLength={500} value={message} onInput={e => setMessage(e.currentTarget.value)}
              placeholder="e.g. Not enough players this week, sorry. Hope to see you next time!" />
            <div class="cluster">
              <button type="button" class="btn btn--destructive btn--sm" disabled={busy} onClick={cancel}>
                {people ? `Cancel and email ${people === 1 ? '1 booking' : `${people} bookings`}` : `Cancel ${shortDate(d.event_date)}`}
              </button>
              <button type="button" class="btn btn--text btn--sm" onClick={() => setCancelling(false)}>
                Keep it on
              </button>
            </div>
          </div>
        ) : (
          <div class="cluster date-row__actions">
            <button type="button" class="btn btn--text btn--sm" onClick={() => setAction('places')}>
              Change places
            </button>
            <button type="button" class="btn btn--destructive-quiet btn--sm" onClick={() => setCancelling(true)}>
              Cancel this date
            </button>
          </div>
        ))}
    </div>
  );
}

/** Approvers: hosted dates and booked café events coming up, with numbers and contact details. */
export function HostedDatesPanel({ refresh }: { refresh?: number }) {
  const [dates, setDates] = useState<HostedDate[] | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ dates: HostedDate[] }>('/api/staff/booked-dates');
    if (res.ok) setDates(res.data.dates);
  }, []);
  useEffect(() => void load(), [load, refresh]);

  return (
    <section class="section" aria-labelledby="hosted-dates">
      <div class="section-head">
        <h2 id="hosted-dates">Bookings coming up</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        The next three weeks: every hosted session, and the café's own events people have booked. Cancelling a date here emails everyone booked.
      </p>
      {dates === null && <DiceLoader label="Loading bookings..." />}
      {dates && !dates.length && <p class="meta">No hosted sessions or bookings in the next three weeks.</p>}
      <div class="date-list date-list--staff" role="list">
        {dates?.map(d => (
          <DateRow
            key={d.occurrence_id}
            d={{ ...d, host_session_id: d.host_session_id ?? '' }}
            title={
              d.session
                ? `${d.session.name}${d.session.access === 'private' ? ' (private)' : ''} · ${d.session.host_name ?? d.session.host_email}`
                : `${d.event_name} · Café event`
            }
            contact
            maxPlaces={d.session ? MAX_PLACES.hosted : MAX_PLACES.cafe}
            onChanged={load}
          />
        ))}
      </div>
    </section>
  );
}
