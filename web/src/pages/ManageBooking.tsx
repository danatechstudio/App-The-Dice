// /booking/:id#t=<secret>: the link in a booking confirmation. Shows the
// booking and lets the person cancel it. The secret stays in the # part, so
// it's never sent in a page request or kept in server logs.

import { Ban, CalendarDays, ChevronLeft, Clock, Ticket, UsersRound } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader, EmptyState } from '../components/States';
import { longDate, timeRange } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { useTitle } from '../lib/title';
import { toast } from '../lib/toast';

interface BookingView {
  booking_id: string;
  lead_name: string;
  party_size: number;
  status: 'confirmed' | 'cancelled';
  cancelled_by: 'customer' | 'host' | 'staff' | null;
  cancel_message: string | null;
  occurrence_id: string;
  name: string;
  event_date: string | null;
  start_time: string | null;
  end_time: string | null;
  price_display: string | null;
  can_cancel: boolean;
}

export function ManageBooking({ bookingId }: { bookingId: string }) {
  useTitle('Your booking');
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('t'));
  const [booking, setBooking] = useState<BookingView | null>(null);
  const [error, setError] = useState<string | null>(token ? null : 'This link is missing its secret part.');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!token) return;
    const res = await hostApi<{ booking: BookingView }>(`/api/bookings/${encodeURIComponent(bookingId)}/view`, { token });
    if (res.ok) setBooking(res.data.booking);
    else setError(res.error);
  }, [bookingId, token]);
  useEffect(() => void load(), [load]);

  if (error) {
    return (
      <div class="container">
        <EmptyState title="We couldn't find that booking." text={`${error} Use the link in your confirmation email, or ask the café.`}>
          <a class="btn btn--primary" href="/diary">See what's on</a>
        </EmptyState>
      </div>
    );
  }
  if (!booking) return <DiceLoader label="Finding your booking..." />;

  const cancel = async () => {
    if (!confirm(`Cancel your booking for ${booking.name}? Your places go back for someone else.`)) return;
    setBusy(true);
    const res = await hostApi(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, { token });
    setBusy(false);
    toast(res.ok ? 'Your booking is cancelled.' : res.error);
    load();
  };
  const cancelled = booking.status === 'cancelled';
  const range = timeRange(booking.start_time, booking.end_time);

  return (
    <div class="container manage-booking">
      <a class="back-link" href={`/event/${booking.occurrence_id}`}>
        <ChevronLeft size={20} aria-hidden="true" /> The session
      </a>
      <header class="page-head">
        <p class="label">Your booking · {booking.booking_id}</p>
        <h1 class={cancelled ? 'event-page__title--cancelled' : undefined}>{booking.name}</h1>
      </header>
      <section class="card card--pad stack" style={{ '--gap': '16px' }}>
        <div>
          <Chip kind={cancelled ? 'cancelled' : 'approved'}>
            {cancelled ? <Ban aria-hidden="true" /> : <Ticket aria-hidden="true" />}
            {cancelled ? 'Cancelled' : 'Booked'}
          </Chip>
        </div>
        {cancelled && booking.cancelled_by && booking.cancelled_by !== 'customer' && (
          <div class="notice notice--warning">
            <Ban size={20} aria-hidden="true" />
            <div>
              <strong>{booking.cancelled_by === 'host' ? 'The host cancelled this session.' : 'The café cancelled this session.'}</strong>
              {booking.cancel_message && <p>"{booking.cancel_message}"</p>}
            </div>
          </div>
        )}
        <div class="facts">
          {booking.event_date && (
            <div class="fact">
              <span class="fact__icon"><CalendarDays size={20} aria-hidden="true" /></span>
              <span><strong>{longDate(booking.event_date)}</strong></span>
            </div>
          )}
          {range && (
            <div class="fact">
              <span class="fact__icon"><Clock size={20} aria-hidden="true" /></span>
              <span><strong>{range}</strong></span>
            </div>
          )}
          <div class="fact">
            <span class="fact__icon"><UsersRound size={20} aria-hidden="true" /></span>
            <span>
              <strong>{booking.party_size} {booking.party_size === 1 ? 'place' : 'places'}</strong>
              Booked by {booking.lead_name}
            </span>
          </div>
        </div>
        {booking.can_cancel && (
          <div class="stack" style={{ '--gap': '8px' }}>
            <p class="meta">Can't make it any more? Cancelling gives your places to someone else, and lets the café know.</p>
            <div>
              <button type="button" class="btn btn--destructive" onClick={cancel} disabled={busy}>
                {busy ? 'Cancelling...' : 'Cancel my booking'}
              </button>
            </div>
          </div>
        )}
        {!cancelled && !booking.can_cancel && <p class="meta">This session has started or finished, so it can't be cancelled here. Please tell the café.</p>}
        {cancelled && (
          <a class="btn btn--primary" href="/diary">
            See what else is on
          </a>
        )}
        <p class="meta">
          <a href="/privacy">How we use your details</a>
        </p>
      </section>
    </div>
  );
}
