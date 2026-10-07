// Booking places on an event page (docs/RTD_BOOKINGS.md): every public café
// event and open host session. No account: name, email, how many. The
// confirmation email has a link to cancel.

import { CircleCheck, Info, Minus, Plus, Ticket } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { Occurrence } from '../lib/api';
import { longDate, timeRange } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { toast } from '../lib/toast';

export type Availability =
  | { bookable: false }
  | { bookable: true; open: boolean; reason: 'full' | 'closed' | 'cancelled' | null; capacity: number | null; places_left: number | null; max_party: number };

const placesText = (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`;

export function BookingPanel({ o }: { o: Occurrence }) {
  const [avail, setAvail] = useState<Availability | null>(null);
  const [done, setDone] = useState<{ email: string; party: number; manage: string } | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<Availability>(`/api/bookings/availability/${encodeURIComponent(o.occurrence_id)}`);
    setAvail(res.ok ? res.data : { bookable: false });
  }, [o.occurrence_id]);
  useEffect(() => void load(), [load]);

  if (!avail) return <p class="meta booking__loading">Checking places...</p>;
  if (!avail.bookable) {
    return (
      <div class="notice">
        <Info size={20} aria-hidden="true" color="var(--rtd-secondary)" />
        <p class="meta">Online booking isn't open for this event. Ask the café team to save you a place.</p>
      </div>
    );
  }
  if (done) {
    return (
      <section class="booking booking--done" aria-live="polite">
        <CircleCheck size={28} aria-hidden="true" />
        <h2 class="display">You're booked.</h2>
        <p>
          {placesText(done.party)} on {longDate(o.date)}
          {timeRange(o.start_time, o.end_time) ? `, ${timeRange(o.start_time, o.end_time)}` : ''}.
        </p>
        <p class="meta">We've emailed {done.email} a confirmation, with a link to cancel if your plans change.</p>
        <a class="btn btn--secondary btn--sm" href={done.manage}>
          See your booking
        </a>
      </section>
    );
  }
  if (!avail.open) {
    if (avail.reason === 'cancelled') return null; // the page already says so
    return (
      <div class="notice notice--warning">
        <Info size={20} aria-hidden="true" />
        <p>{avail.reason === 'full' ? 'This session is full. Ask the café if a place frees up.' : 'Booking has closed for this session.'}</p>
      </div>
    );
  }
  return <BookingForm o={o} avail={avail} onBooked={setDone} onChanged={load} />;
}

function BookingForm({
  o,
  avail,
  onBooked,
  onChanged,
}: {
  o: Occurrence;
  avail: Extract<Availability, { bookable: true }>;
  onBooked: (d: { email: string; party: number; manage: string }) => void;
  onChanged: () => void;
}) {
  const [f, setF] = useState({ lead_name: '', email: '', mobile: '', party_size: 1, notes: '', website: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }));
  const party = (n: number) => set('party_size', Math.min(avail.max_party, Math.max(1, Math.round(n) || 1)));

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const res = await hostApi<{ manage_path: string; booking: { email: string; party_size: number } }>('/api/bookings', {
      occurrence_id: o.occurrence_id,
      ...f,
    });
    setBusy(false);
    if (res.ok) return onBooked({ email: res.data.booking.email, party: res.data.booking.party_size, manage: res.data.manage_path });
    if (res.kind === 'invalid' && res.errors) {
      setErrors(res.errors);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.booking .field--error input, .booking .field--error textarea')?.focus());
    } else {
      toast(res.error);
    }
    onChanged(); // places may have changed
  };
  const field = (k: string) => ({
    class: `field${errors[k] ? ' field--error' : ''}`,
    describedBy: errors[k] ? `b-${k}-error` : undefined,
    error: errors[k] ? <p id={`b-${k}-error`} class="field__error">{errors[k]}</p> : null,
  });
  const name = field('lead_name');
  const email = field('email');
  const mobile = field('mobile');
  const size = field('party_size');
  const notes = field('notes');

  return (
    <section class="booking" aria-labelledby="book-title">
      <div class="booking__head">
        <h2 id="book-title" class="display">
          <Ticket size={20} aria-hidden="true" /> Book a place
        </h2>
        {avail.places_left !== null && avail.capacity !== null && (
          <p class="meta">
            {placesText(avail.places_left)} left of {avail.capacity}
          </p>
        )}
      </div>
      <form class="stack" style={{ '--gap': '14px' }} onSubmit={submit} noValidate>
        <div class={name.class}>
          <label for="b-name">Your name</label>
          <input id="b-name" class="input" value={f.lead_name} maxLength={60} autoComplete="name" required aria-invalid={!!errors.lead_name}
            aria-describedby={name.describedBy} onInput={e => set('lead_name', e.currentTarget.value)} />
          {name.error}
        </div>
        <div class={email.class}>
          <label for="b-email">Email</label>
          <input id="b-email" class="input" type="email" value={f.email} autoComplete="email" required aria-invalid={!!errors.email}
            aria-describedby={`b-email-hint${email.describedBy ? ` ${email.describedBy}` : ''}`} onInput={e => set('email', e.currentTarget.value)} />
          <p id="b-email-hint" class="field__hint">For your confirmation, and to tell you if anything changes.</p>
          {email.error}
        </div>
        <div class={mobile.class}>
          <label for="b-mobile">
            Mobile <span class="field__optional">optional</span>
          </label>
          <input id="b-mobile" class="input" type="tel" value={f.mobile} autoComplete="tel" aria-invalid={!!errors.mobile}
            aria-describedby={mobile.describedBy} onInput={e => set('mobile', e.currentTarget.value)} />
          {mobile.error}
        </div>
        <div class={size.class}>
          <label for="b-size">How many places?</label>
          <div class="number-stepper">
            <button type="button" class="btn btn--secondary btn--icon" onClick={() => party(f.party_size - 1)} aria-label="One fewer place" disabled={f.party_size <= 1}>
              <Minus size={18} aria-hidden="true" />
            </button>
            <input id="b-size" class="input" type="number" inputMode="numeric" min="1" max={avail.max_party} value={f.party_size}
              aria-invalid={!!errors.party_size} aria-describedby={size.describedBy} onInput={e => party(Number(e.currentTarget.value))} />
            <button type="button" class="btn btn--secondary btn--icon" onClick={() => party(f.party_size + 1)} aria-label="One more place"
              disabled={f.party_size >= avail.max_party}>
              <Plus size={18} aria-hidden="true" />
            </button>
          </div>
          {size.error}
        </div>
        <div class={notes.class}>
          <label for="b-notes">
            Anything we should know? <span class="field__optional">optional</span>
          </label>
          <textarea id="b-notes" class="input" rows={2} maxLength={300} value={f.notes} aria-describedby={notes.describedBy}
            placeholder="e.g. First time playing" onInput={e => set('notes', e.currentTarget.value)} />
          {notes.error}
        </div>
        {/* Robots fill in every field; people never see this one. */}
        <div class="visually-hidden" aria-hidden="true">
          <label for="b-website">Leave this empty</label>
          <input id="b-website" tabIndex={-1} autoComplete="off" value={f.website} onInput={e => set('website', e.currentTarget.value)} />
        </div>
        {errors.form && <p class="field__error">{errors.form}</p>}
        <button type="submit" class="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy ? 'Booking...' : `Book ${placesText(f.party_size)}`}
        </button>
        <p class="meta booking__small">
          {o.price_display && !/^free$/i.test(o.price_display.trim()) ? 'Pay at the café on the day. ' : ''}
          The café (and the host, for a hosted session) sees your name, how many are coming and your note. Only the café sees your email and mobile.{' '}
          <a href="/privacy">How we use your details</a>
        </p>
      </form>
    </section>
  );
}
