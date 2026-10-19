// Admins: one event, every detail (docs/superpowers/specs/2026-10-18-admin-event-editor-design.md).
// Save sends only what changed; the server sends each part where it belongs: café details to the
// Logic Engine (in the app after the next sync), a host's session through the approved-change path
// (the host is emailed), places and booking straight away. Dates can be cancelled (everyone booked
// is emailed), hidden or given their own places, and the whole event can be stopped.

import { ArrowLeft, Ban, EyeOff } from 'lucide-preact';
import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { DiceLoader } from '../components/States';
import { longDate, shortDate, todayLondon } from '../lib/dates';
import { hostApi, MAX_PLACES, type AdminEventDetails, type AdminEventForm, type BookingMode, type EventVisibility } from '../lib/hostApi';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/title';
import { KIND_LABEL } from './OrganiseEvents';
import { DatePlaces } from './OrganisePlaces';
import { EventSocialSection } from './OrganiseSocial';

const CATEGORIES = ['Gaming', 'Quiz', 'Social', 'Club', 'Tournament', 'Market', 'Workshop', 'Other'];
const VISIBILITY: { value: EventVisibility; label: string; hint: string }[] = [
  { value: 'public', label: 'Public', hint: 'In the diary with its name and details.' },
  { value: 'app_bookable', label: 'App Bookable', hint: 'In the diary, and people can book it in the app.' },
  { value: 'private', label: 'Private game', hint: 'In the diary by name and description, with no booking. People can message to ask about joining.' },
  { value: 'hidden', label: 'Hidden', hint: 'Not in the app at all.' },
];
const MODES: { value: BookingMode | 'default'; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'none', label: 'Not required' },
  { value: 'optional', label: 'Optional' },
  { value: 'required', label: 'Required' },
];
const LABELS: Record<keyof AdminEventDetails, string> = {
  name: 'Name',
  description: 'Description',
  event_date: 'Date',
  start_time: 'Start time',
  end_time: 'End time',
  price: 'Price',
  category: 'Category',
};

type Body = { details?: Partial<AdminEventDetails>; visibility?: EventVisibility; places?: number | null; booking_mode?: BookingMode | 'default' };

export function EventEditor({ eventId }: { eventId: string }) {
  const [event, setEvent] = useState<AdminEventForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ event: AdminEventForm }>(`/api/staff/events/${eventId}`);
    if (res.ok) setEvent(res.data.event);
    else setError(res.error);
  }, [eventId]);
  useEffect(() => void load(), [load]);
  useTitle(event ? `Edit ${event.name}` : 'Edit event');

  return (
    <div class="container organiser" data-surface="staff">
      <header class="page-head organiser-section__head">
        <a class="btn btn--text btn--sm organiser-section__back" href="/organise/events">
          <ArrowLeft size={16} aria-hidden="true" /> Events & dates
        </a>
        <h1>{event?.name ?? 'Edit event'}</h1>
        {event && (
          <p class="meta">
            {KIND_LABEL[event.kind]} · {event.event_id}
            {!event.active && ' · Stopped'}
          </p>
        )}
      </header>
      {error && <p class="field__error">{error}</p>}
      {!event && !error && <DiceLoader label="Loading the event..." />}
      {event && (
        <div class="staff-section event-editor">
          {event.pending && (
            <div class="notice notice--info" role="status">
              <div>
                {event.pending.kind === 'host_change'
                  ? `The host has asked for a change (${event.pending.id}). Approve or decline it under To approve before changing the session here.`
                  : `A change (${event.pending.id}) is on its way to the Logic Engine. Details can be changed again once it's in the app, within about half an hour.`}
              </div>
            </div>
          )}
          {event.kind === 'market' ? (
            <section class="card card--pad stack" style={{ '--gap': '12px' }}>
              <p>Markets have their own editor, with pitches and vendors.</p>
              <p>
                <a class="btn btn--secondary btn--sm" href="/organise/content#markets-admin">
                  Open Markets
                </a>
              </p>
            </section>
          ) : (
            <>
              <DetailsForm key={JSON.stringify(event)} event={event} onSaved={load} />
              <DatesList event={event} onChanged={load} />
              <EventSocialSection eventId={event.event_id} />
              <StopEvent event={event} onStopped={load} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DetailsForm({ event, onSaved }: { event: AdminEventForm; onSaved: () => void }) {
  const [d, setD] = useState<AdminEventDetails>(event.details);
  const [visibility, setVisibility] = useState<EventVisibility>(event.visibility);
  const [places, setPlaces] = useState<string>(event.places === null ? '' : String(event.places));
  const [mode, setMode] = useState<BookingMode | 'default'>(event.booking_mode_set ?? 'default');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hosted = event.kind === 'host_session';
  const set = (k: keyof AdminEventDetails, v: string) => (setD({ ...d, [k]: v }), setWarning(null));

  const body = (): Body => {
    const b: Body = {};
    const details = Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== event.details[k as keyof AdminEventDetails]));
    if (Object.keys(details).length) b.details = details;
    if (visibility !== event.visibility) b.visibility = visibility;
    const p = places.trim() === '' ? null : Number(places);
    if (p !== event.places) b.places = p;
    if (mode !== (event.booking_mode_set ?? 'default')) b.booking_mode = mode;
    return b;
  };
  const changed = Object.keys(body()).length > 0;

  const save = async (confirm: boolean) => {
    setBusy(true);
    setErrors({});
    const b = body();
    const res = await hostApi<{ sheet_edit?: unknown; change?: unknown }>(`/api/staff/events/${event.event_id}`, { ...b, confirm });
    setBusy(false);
    if (res.ok) {
      setWarning(null);
      toast(
        res.data.sheet_edit
          ? 'Sent to the Logic Engine. It shows in the app within about 20 minutes.'
          : res.data.change
            ? 'Changed. The host has been emailed, and it reaches the diary within about half an hour.'
            : 'Saved.',
      );
      return onSaved();
    }
    const w = res.status === 409 ? (res.body as { warning?: unknown } | undefined)?.warning : undefined;
    if (w) return setWarning(typeof w === 'string' ? w : 'People are booked. Save anyway?');
    if (res.kind === 'invalid') {
      setErrors(res.errors ?? { form: res.error });
      if (!res.errors) return;
      document
        .querySelector<HTMLElement>('.event-editor .field--error input, .event-editor .field--error textarea, .event-editor .field--error select')
        ?.focus();
      return;
    }
    setErrors({ form: res.error });
  };

  const field = (k: keyof AdminEventDetails, input: (id: string, describedBy?: string) => JSX.Element) => {
    const id = `ev-${k}`;
    const why = event.unavailable[k];
    const err = errors[k];
    return (
      <div class={`field${err ? ' field--error' : ''}`}>
        <label for={why ? undefined : id}>{LABELS[k]}</label>
        {why ? (
          <p class="field__hint">
            {event.details[k] || <em>none</em>} · {why}
          </p>
        ) : (
          input(id, err ? `${id}-error` : undefined)
        )}
        {err && (
          <p id={`${id}-error`} class="field__error">
            {err}
          </p>
        )}
      </div>
    );
  };

  return (
    <section class="card card--pad stack" style={{ '--gap': '16px' }} aria-labelledby="ev-details">
      <h2 id="ev-details">Details</h2>
      {field('name', (id, by) => (
        <input id={id} class="input" value={d.name} maxLength={100} aria-describedby={by} onInput={e => set('name', e.currentTarget.value)} />
      ))}
      {field('description', (id, by) => (
        <textarea
          id={id}
          class="input"
          rows={4}
          value={d.description}
          maxLength={3000}
          aria-describedby={by}
          onInput={e => set('description', e.currentTarget.value)}
        />
      ))}
      <div class="field-row">
        {field('event_date', (id, by) => (
          <input
            id={id}
            class="input"
            type="date"
            value={d.event_date}
            min={todayLondon()}
            aria-describedby={by}
            onInput={e => set('event_date', e.currentTarget.value)}
          />
        ))}
        {field('start_time', (id, by) => (
          <input id={id} class="input" type="time" value={d.start_time} aria-describedby={by} onInput={e => set('start_time', e.currentTarget.value)} />
        ))}
        {field('end_time', (id, by) => (
          <input id={id} class="input" type="time" value={d.end_time} aria-describedby={by} onInput={e => set('end_time', e.currentTarget.value)} />
        ))}
      </div>
      <div class="field-row">
        {field('price', (id, by) => (
          <input
            id={id}
            class="input"
            value={d.price}
            placeholder="£5 or Free"
            maxLength={40}
            aria-describedby={by}
            onInput={e => set('price', e.currentTarget.value)}
          />
        ))}
        {field('category', (id, by) => (
          <select id={id} class="input" value={d.category} aria-describedby={by} onChange={e => set('category', e.currentTarget.value)}>
            <option value="">None</option>
            {CATEGORIES.map(c => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ))}
      </div>

      <fieldset class={`field stack${errors.visibility ? ' field--error' : ''}`} style={{ '--gap': '8px' }}>
        <legend class="label">Who can see it</legend>
        {VISIBILITY.map(v => (
          <label key={v.value} class="choice">
            <input
              type="radio"
              name="ev-visibility"
              value={v.value}
              checked={visibility === v.value}
              onChange={() => (setVisibility(v.value), setWarning(null))}
            />
            <span>
              <strong>{v.label}</strong>
              <span class="meta">{v.hint}</span>
            </span>
          </label>
        ))}
        {errors.visibility && <p class="field__error">{errors.visibility}</p>}
      </fieldset>

      <h2>Booking</h2>
      <div class="field-row">
        <div class={`field${errors.places ? ' field--error' : ''}`}>
          <label for="ev-places">Places on every date</label>
          <input
            id="ev-places"
            class="input"
            type="number"
            inputMode="numeric"
            min={Math.max(1, event.most_booked)}
            max={hosted ? MAX_PLACES.hosted : MAX_PLACES.cafe}
            value={places}
            placeholder={hosted ? '' : 'No limit'}
            aria-describedby="ev-places-hint"
            onInput={e => setPlaces(e.currentTarget.value)}
          />
          <p id="ev-places-hint" class="field__hint">
            {event.most_booked > 0 ? `${event.most_booked} booked on the busiest date, so no fewer than that. ` : ''}
            {hosted ? '' : 'Empty: the sheet’s App Capacity, or no limit.'}
          </p>
          {errors.places && <p class="field__error">{errors.places}</p>}
        </div>
        <div class={`field${errors.booking_mode ? ' field--error' : ''}`}>
          <label for="ev-mode">Need to book?</label>
          <select id="ev-mode" class="input" value={mode} onChange={e => setMode(e.currentTarget.value as BookingMode | 'default')}>
            {MODES.map(m => (
              <option key={m.value} value={m.value}>
                {m.value === 'default' ? `${m.label} (${MODES.find(x => x.value === event.booking_mode)?.label ?? ''})` : m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {errors.form && (
        <p class="field__error" role="alert">
          {errors.form}
        </p>
      )}
      {warning ? (
        <div class="notice notice--warning" role="alert">
          <div class="stack" style={{ '--gap': '8px' }}>
            <p>{warning}</p>
            <div class="cluster">
              <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => save(true)}>
                Save anyway
              </button>
              <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => setWarning(null)}>
                Back
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div class="cluster">
          <button type="button" class="btn btn--primary" disabled={busy || !changed} onClick={() => save(false)}>
            {busy ? 'Saving...' : 'Save changes'}
          </button>
          <span class="meta">
            {hosted
              ? 'The host is emailed what you change.'
              : event.kind === 'standard_diary'
                ? 'Details go to the Standard Diary tab.'
                : 'Details go to the Logic Engine first.'}
          </span>
        </div>
      )}
    </section>
  );
}

function DatesList({ event, onChanged }: { event: AdminEventForm; onChanged: () => void }) {
  const [open, setOpen] = useState<{ id: string; action: 'cancel' | 'places' } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const hide = async (id: string, hidden: boolean, confirm = false): Promise<void> => {
    const res = await hostApi(`/api/staff/dates/${id}`, { hidden, confirm });
    if (res.ok) return void (toast(hidden ? 'Date hidden.' : 'Date shown again.'), onChanged());
    const w = res.status === 409 ? (res.body as { warning?: { bookings: number } } | undefined)?.warning : undefined;
    if (w && window.confirm(`${w.bookings === 1 ? '1 booking' : `${w.bookings} bookings`} on this date. They stay booked. Hide it anyway?`))
      return hide(id, hidden, true);
    if (!w) toast(res.error);
  };
  const cancel = async (id: string) => {
    setBusy(true);
    const res = await hostApi<{ cancelled_bookings: number }>(`/api/host/occurrences/${id}/cancel`, { message });
    setBusy(false);
    if (!res.ok) return toast(res.error);
    const n = res.data.cancelled_bookings;
    toast(n ? `Cancelled. ${n} ${n === 1 ? 'booking' : 'bookings'} will be emailed.` : 'Date cancelled.');
    setOpen(null);
    setMessage('');
    onChanged();
  };

  return (
    <section class="section" aria-labelledby="ev-dates">
      <div class="section-head">
        <h2 id="ev-dates">Dates to come</h2>
      </div>
      {!event.dates.length && <p class="meta">No dates to come.</p>}
      <div class="date-list date-list--staff" role="list">
        {event.dates.map(dt => {
          const cancelled = dt.status === 'cancelled';
          return (
            <div class={`date-row${cancelled ? ' date-row--cancelled' : ''}`} role="listitem" key={dt.occurrence_id}>
              <div class="date-row__main">
                <div class="date-row__when">
                  <strong class="date-row__title">{shortDate(dt.date)}</strong>
                  <span>{[dt.start_time, cancelled ? 'Cancelled' : null, dt.hidden ? 'Hidden' : null].filter(Boolean).join(' · ') || 'All day'}</span>
                </div>
                <span class="date-row__count">
                  {dt.booked} booked{dt.capacity !== null ? ` of ${dt.capacity}` : ''}
                  {dt.places !== null && <span class="meta"> (own number)</span>}
                </span>
              </div>
              {!cancelled && open?.id === dt.occurrence_id && open.action === 'cancel' && (
                <div class="stack" style={{ '--gap': '8px' }}>
                  <label class="label" for={`msg-${dt.occurrence_id}`}>
                    Message to people booked <span class="field__optional">optional</span>
                  </label>
                  <textarea
                    id={`msg-${dt.occurrence_id}`}
                    class="input"
                    rows={2}
                    maxLength={500}
                    value={message}
                    onInput={e => setMessage(e.currentTarget.value)}
                  />
                  <div class="cluster">
                    <button type="button" class="btn btn--destructive btn--sm" disabled={busy} onClick={() => cancel(dt.occurrence_id)}>
                      {busy ? 'Cancelling...' : `Cancel ${longDate(dt.date)}`}
                    </button>
                    <button type="button" class="btn btn--text btn--sm" onClick={() => setOpen(null)}>
                      Back
                    </button>
                  </div>
                </div>
              )}
              {!cancelled && open?.id === dt.occurrence_id && open.action === 'places' && (
                <DatePlaces
                  occurrenceId={dt.occurrence_id}
                  current={dt.capacity}
                  own={dt.places}
                  max={event.kind === 'host_session' ? MAX_PLACES.hosted : MAX_PLACES.cafe}
                  onClose={() => setOpen(null)}
                  onSaved={() => (setOpen(null), onChanged())}
                />
              )}
              {!cancelled && open?.id !== dt.occurrence_id && (
                <div class="cluster">
                  <button type="button" class="btn btn--secondary btn--sm" onClick={() => setOpen({ id: dt.occurrence_id, action: 'cancel' })}>
                    <Ban size={16} aria-hidden="true" /> Cancel this date
                  </button>
                  <button type="button" class="btn btn--secondary btn--sm" onClick={() => hide(dt.occurrence_id, !dt.hidden)}>
                    <EyeOff size={16} aria-hidden="true" /> {dt.hidden ? 'Show this date' : 'Hide this date'}
                  </button>
                  <button type="button" class="btn btn--secondary btn--sm" onClick={() => setOpen({ id: dt.occurrence_id, action: 'places' })}>
                    Places
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StopEvent({ event, onStopped }: { event: AdminEventForm; onStopped: () => void }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [warning, setWarning] = useState<{ dates: number; bookings: number; people: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const stopped = event.kind === 'standard_diary' ? event.visibility === 'hidden' : !event.active;
  // A hidden Standard Diary group comes back by choosing who can see it, above.
  if (stopped && event.kind === 'standard_diary') return null;
  if (stopped) return <StartEvent event={event} onStarted={onStopped} />;

  const stop = async (confirm: boolean) => {
    setBusy(true);
    const res = await hostApi<{ cancelled_bookings: number; note?: string }>(`/api/staff/events/${event.event_id}/stop`, { message, confirm });
    setBusy(false);
    if (res.ok) {
      const n = res.data.cancelled_bookings;
      toast(
        [n ? `${n} ${n === 1 ? 'booking' : 'bookings'} cancelled and emailed.` : null, res.data.note ?? null, 'Stopping it now.'].filter(Boolean).join(' '),
      );
      return onStopped();
    }
    const w = res.status === 409 ? (res.body as { warning?: typeof warning } | undefined)?.warning : undefined;
    if (w) return setWarning(w);
    toast(res.error);
  };

  return (
    <section class="card card--pad stack event-editor__danger" style={{ '--gap': '12px' }} aria-labelledby="ev-stop">
      <h2 id="ev-stop">Stop running this event</h2>
      <p class="meta">
        {event.kind === 'standard_diary'
          ? 'Hides the group in the app (the Standard Diary has no Status column). People booked on dates to come are cancelled and emailed first.'
          : event.kind === 'host_session'
            ? 'Sets the session to Inactive in the Logic Engine; the host is emailed. People booked on dates to come are cancelled and emailed first.'
            : 'Sets Status to Inactive in the Logic Engine. People booked on dates to come are cancelled and emailed first.'}
      </p>
      {!open ? (
        <div>
          <button type="button" class="btn btn--destructive-quiet btn--sm" onClick={() => setOpen(true)}>
            Stop running…
          </button>
        </div>
      ) : (
        <>
          <label class="label" for="ev-stop-msg">
            Message to people booked <span class="field__optional">optional</span>
          </label>
          <textarea id="ev-stop-msg" class="input" rows={2} maxLength={500} value={message} onInput={e => setMessage(e.currentTarget.value)} />
          {warning && (
            <div class="notice notice--warning" role="alert">
              <div>
                {warning.bookings === 1 ? '1 booking' : `${warning.bookings} bookings`} ({warning.people} {warning.people === 1 ? 'place' : 'places'}) on{' '}
                {warning.dates === 1 ? '1 date' : `${warning.dates} dates`}. Each one is cancelled and emailed.
              </div>
            </div>
          )}
          <div class="cluster">
            <button type="button" class="btn btn--destructive btn--sm" disabled={busy} onClick={() => stop(!!warning)}>
              {busy ? 'Stopping...' : warning ? `Cancel ${warning.dates === 1 ? 'the date' : `${warning.dates} dates`} and stop` : 'Stop running'}
            </button>
            <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => (setOpen(false), setWarning(null))}>
              Back
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** A stopped event: start it running again (Status Active in the Logic Engine). */
function StartEvent({ event, onStarted }: { event: AdminEventForm; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    const res = await hostApi<{ sheet_edit?: unknown; change?: unknown }>(`/api/staff/events/${event.event_id}`, { active: true });
    setBusy(false);
    if (!res.ok) return toast(res.error);
    toast(res.data.change ? 'Starting it again. The host has been emailed.' : 'Sent to the Logic Engine. It’s back in the app within about 20 minutes.');
    onStarted();
  };
  return (
    <section class="card card--pad stack" style={{ '--gap': '12px' }} aria-labelledby="ev-start">
      <h2 id="ev-start">This event is stopped</h2>
      <p class="meta">
        Starting it again sets Status to Active in the Logic Engine. Its dates come back with the next sync; check them, and who can see it, once they do.
      </p>
      <div>
        <button type="button" class="btn btn--primary btn--sm" disabled={busy || !!event.pending} onClick={start}>
          {busy ? 'Starting...' : 'Start running again'}
        </button>
      </div>
    </section>
  );
}
