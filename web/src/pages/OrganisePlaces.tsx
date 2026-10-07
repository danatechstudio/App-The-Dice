// Places in the organiser (docs/RTD_BOOKINGS.md#places):
// - PlacesEditor: a number of places, with an optional "clear" choice;
// - SessionPlaces: a host changes every date of their own live session;
// - EventPlacesPanel: approvers set places for the café's own events.
// The server refuses a number below what's already booked, and says on which date.

import { Minus, Plus, UsersRound } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { DiceLoader } from '../components/States';
import { shortDate } from '../lib/dates';
import { hostApi, MAX_PLACES, type EventPlaces } from '../lib/hostApi';
import { toast } from '../lib/toast';

const placesText = (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`;
const FREQUENCY: Record<string, string> = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', 'one-off': 'One-off' };

/** Saves places, or clears them (null). Resolves to an error message, or null when saved. */
type Save = (places: number | null) => Promise<string | null>;

export function PlacesEditor({
  id,
  label,
  hint,
  initial,
  max,
  saveLabel,
  clearLabel,
  onSave,
  onClose,
}: {
  id: string;
  label: string;
  hint?: string;
  initial: number;
  max: number;
  saveLabel: string;
  /** Offered when there's a number to go back from, e.g. "Same as the other dates". */
  clearLabel?: string;
  onSave: Save;
  onClose: () => void;
}) {
  const [n, setN] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (v: number) => setN(Math.min(max, Math.max(1, Math.round(v) || 1)));
  const save = async (places: number | null) => {
    setBusy(true);
    const problem = await onSave(places);
    setBusy(false);
    setError(problem);
  };
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div class={`places-editor${error ? ' field--error' : ''}`}>
      <label class="label" for={id}>
        {label}
      </label>
      {hint && (
        <p id={hintId} class="field__hint">
          {hint}
        </p>
      )}
      <div class="number-stepper">
        <button type="button" class="btn btn--secondary btn--icon" onClick={() => set(n - 1)} aria-label="One fewer place" disabled={n <= 1 || busy}>
          <Minus size={18} aria-hidden="true" />
        </button>
        <input id={id} class="input" type="number" inputMode="numeric" min="1" max={max} value={n} aria-invalid={!!error}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined} onInput={e => set(Number(e.currentTarget.value))} />
        <button type="button" class="btn btn--secondary btn--icon" onClick={() => set(n + 1)} aria-label="One more place" disabled={n >= max || busy}>
          <Plus size={18} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <p id={errorId} class="field__error" role="alert">
          {error}
        </p>
      )}
      <div class="cluster">
        <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => save(n)}>
          {busy ? 'Saving...' : saveLabel}
        </button>
        {clearLabel && (
          <button type="button" class="btn btn--secondary btn--sm" disabled={busy} onClick={() => save(null)}>
            {clearLabel}
          </button>
        )}
        <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A host: the places on every date of their own live session. */
export function SessionPlaces({ sessionId, current, onClose, onSaved }: { sessionId: string; current: number; onClose: () => void; onSaved: () => void }) {
  const save: Save = async places => {
    const res = await hostApi<{ places: number }>(`/api/host/sessions/${sessionId}/places`, { places });
    if (!res.ok) return res.errors?.places ?? res.error;
    toast(`Saved: ${placesText(res.data.places)} on every date.`);
    onSaved();
    return null;
  };
  return (
    <PlacesEditor
      id={`places-${sessionId}`}
      label="Places on every date"
      hint="Changes straight away; no new approval needed. A date with people booked can't go below that number."
      initial={current}
      max={MAX_PLACES.hosted}
      saveLabel="Save for every date"
      onSave={save}
      onClose={onClose}
    />
  );
}

/** A host or an approver: the places on one date. */
export function DatePlaces({
  occurrenceId,
  current,
  own,
  max,
  onClose,
  onSaved,
}: {
  occurrenceId: string;
  current: number | null;
  own: number | null;
  max: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const save: Save = async places => {
    const res = await hostApi<{ capacity: number | null }>(`/api/host/occurrences/${occurrenceId}/places`, { places });
    if (!res.ok) return res.errors?.places ?? res.error;
    toast(places === null ? 'Saved: same as the other dates.' : `Saved: ${placesText(places)} on this date.`);
    onSaved();
    return null;
  };
  return (
    <PlacesEditor
      id={`date-places-${occurrenceId}`}
      label="Places on this date"
      initial={current ?? 20}
      max={max}
      saveLabel="Save for this date"
      clearLabel={own !== null ? 'Same as the other dates' : undefined}
      onSave={save}
      onClose={onClose}
    />
  );
}

/** Approvers: places for the café's own events, instead of App Capacity in the sheet. */
export function EventPlacesPanel({ refresh }: { refresh?: number }) {
  const [events, setEvents] = useState<EventPlaces[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ events: EventPlaces[] }>('/api/staff/event-places');
    if (res.ok) setEvents(res.data.events);
  }, []);
  useEffect(() => void load(), [load, refresh]);

  return (
    <section class="section" aria-labelledby="event-places">
      <div class="section-head">
        <h2 id="event-places">Places for café events</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        How many people can book each of the café's own events. With no number, there's no limit. A number set here is used instead of App Capacity in the
        sheet, until someone changes App Capacity there. Hosts set their own sessions' places.
      </p>
      {events === null && <DiceLoader label="Loading events..." />}
      {events && !events.length && <p class="meta">No café events can be booked at the moment.</p>}
      <div class="date-list date-list--staff" role="list">
        {events?.map(e => {
          const from = e.app_places !== null ? 'set here' : e.sheet_places !== null ? 'from the sheet' : null;
          return (
            <div class="date-row" role="listitem" key={e.event_id}>
              <div class="date-row__main">
                <div class="date-row__when">
                  <strong class="date-row__title">{e.name}</strong>
                  <span>
                    {[e.frequency ? FREQUENCY[e.frequency] ?? null : null, `next ${shortDate(e.next_date)}`].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <span class="date-row__count">
                  <UsersRound size={16} aria-hidden="true" /> {e.places === null ? 'No limit' : placesText(e.places)}
                  {from && <span class="meta"> ({from})</span>}
                </span>
              </div>
              {(e.most_booked > 0 || e.dates_with_own_places > 0) && (
                <p class="meta">
                  {[
                    e.most_booked > 0 ? `Most booked on one date: ${e.most_booked}` : null,
                    e.dates_with_own_places > 0
                      ? `${e.dates_with_own_places === 1 ? '1 date has' : `${e.dates_with_own_places} dates have`} its own number (saving here replaces it)`
                      : null,
                  ]
                    .filter(Boolean)
                    .join('. ')}
                </p>
              )}
              {editing === e.event_id ? (
                <PlacesEditor
                  id={`event-places-${e.event_id}`}
                  label={`Places on every date of ${e.name}`}
                  initial={e.places ?? Math.max(20, e.most_booked)}
                  max={MAX_PLACES.cafe}
                  saveLabel="Save for every date"
                  clearLabel={e.app_places !== null ? (e.sheet_places !== null ? `Use the sheet's ${e.sheet_places}` : 'No limit') : undefined}
                  onSave={async places => {
                    const res = await hostApi<{ capacity: number | null }>(`/api/staff/events/${e.event_id}/places`, { places });
                    if (!res.ok) return res.errors?.places ?? res.error;
                    toast(res.data.capacity === null ? `${e.name}: no limit.` : `${e.name}: ${placesText(res.data.capacity)} on every date.`);
                    setEditing(null);
                    load();
                    return null;
                  }}
                  onClose={() => setEditing(null)}
                />
              ) : (
                <div>
                  <button type="button" class="btn btn--secondary btn--sm" onClick={() => setEditing(e.event_id)}>
                    {e.places === null ? 'Set a limit' : 'Change places'}
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
