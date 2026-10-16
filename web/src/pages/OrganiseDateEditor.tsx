// Dates in the app (Stage 5b), for approvers and admins: change one date without touching the
// Logic Engine: hide it in the app (or show it again), or give it its own description and
// price label. Dates, times and names are changed in the sheet; cancelling has its own button
// under Bookings coming up.

import { EyeOff, Pencil } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader } from '../components/States';
import { shortDate, timeRange } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { toast } from '../lib/toast';

interface AppDate {
  occurrence_id: string;
  name: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  event_visibility: string;
  hidden: boolean;
  event_description: string | null;
  description: string | null;
  event_price: string | null;
  price: string | null;
  bookings: number;
  people: number;
}

export function DatesPanel() {
  const [dates, setDates] = useState<AppDate[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ dates: AppDate[] }>('/api/staff/dates');
    if (res.ok) setDates(res.data.dates);
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <section class="section" aria-labelledby="app-dates">
      <div class="section-head">
        <h2 id="app-dates">Dates in the app</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        The next four weeks. Hide one date in the app, or give it its own description or price. This changes only the app: dates, times and names are
        changed in the Logic Engine, and to stop a date being advertised, cancel it.
      </p>
      {dates === null && <DiceLoader label="Loading dates..." />}
      {dates && !dates.length && <p class="meta">Nothing in the next four weeks.</p>}
      <div class="date-list date-list--staff" role="list">
        {dates?.map(d => (
          <div class="date-row" role="listitem" key={d.occurrence_id}>
            <div class="date-row__main">
              <div class="date-row__when">
                <strong class="date-row__title">{d.name}</strong>
                <span>
                  {shortDate(d.date)}
                  {d.start_time ? `, ${timeRange(d.start_time, d.end_time)}` : ''}
                </span>
              </div>
            </div>
            {(d.hidden || d.description || d.price) && (
              <div class="cluster" style={{ '--gap': '6px' }}>
                {d.hidden && (
                  <Chip kind="cancelled">
                    <EyeOff aria-hidden="true" /> Hidden in the app
                  </Chip>
                )}
                {d.description && <Chip kind="awaiting">Own description</Chip>}
                {d.price && <Chip kind="awaiting">Own price: {d.price}</Chip>}
              </div>
            )}
            {editing === d.occurrence_id ? (
              <DateEditor d={d} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />
            ) : (
              <div>
                <button type="button" class="btn btn--secondary btn--sm" onClick={() => setEditing(d.occurrence_id)}>
                  <Pencil size={16} aria-hidden="true" /> Change this date
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function DateEditor({ d, onClose, onSaved }: { d: AppDate; onClose: () => void; onSaved: () => void }) {
  const [hidden, setHidden] = useState(d.hidden);
  const [description, setDescription] = useState(d.description ?? '');
  const [price, setPrice] = useState(d.price ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warning, setWarning] = useState<{ bookings: number; people: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `date-${d.occurrence_id}`;
  const save = async (confirm: boolean) => {
    setBusy(true);
    setErrors({});
    const res = await hostApi<{ date: AppDate }>(`/api/staff/dates/${d.occurrence_id}`, { hidden, description, price, confirm });
    setBusy(false);
    if (res.ok) {
      toast(`${d.name}, ${shortDate(d.date)}: saved.`);
      return onSaved();
    }
    const w = res.status === 409 ? (res.body as { warning?: { bookings: number; people: number } } | undefined)?.warning : undefined;
    if (w) return setWarning(w);
    if (res.kind === 'invalid') setErrors(res.errors ?? { form: res.error });
    else setErrors({ form: res.error });
  };
  const isPrivate = d.event_visibility === 'private';
  return (
    <div class="stack" style={{ '--gap': '12px' }}>
      <label class="cluster" style={{ '--gap': '8px', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <input type="checkbox" checked={hidden} onChange={e => (setHidden(e.currentTarget.checked), setWarning(null))} style={{ marginTop: '4px' }} />
        <span>
          <strong>Hide this date in the app</strong>
          <span class="meta" style={{ display: 'block' }}>
            It leaves the diary and its page. The Logic Engine still has it, so it can still be advertised: to call it off, cancel it instead.
          </span>
        </span>
      </label>
      {!isPrivate && (
        <>
          <div class={`field${errors.description ? ' field--error' : ''}`}>
            <label for={`${id}-desc`}>
              Description for this date <span class="field__optional">optional</span>
            </label>
            <textarea id={`${id}-desc`} class="input" rows={3} maxLength={1000} value={description} placeholder={d.event_description ?? ''}
              onInput={e => setDescription(e.currentTarget.value)} />
            <p class="field__hint">Leave it empty to use the event's own.</p>
            {errors.description && <p class="field__error">{errors.description}</p>}
          </div>
          <div class={`field${errors.price ? ' field--error' : ''}`}>
            <label for={`${id}-price`}>
              Price for this date <span class="field__optional">optional</span>
            </label>
            <input id={`${id}-price`} class="input" maxLength={30} value={price} placeholder={d.event_price ?? 'e.g. £5 or Free'} onInput={e => setPrice(e.currentTarget.value)} />
            {errors.price && <p class="field__error">{errors.price}</p>}
          </div>
        </>
      )}
      {errors.form && (
        <p class="field__error" role="alert">
          {errors.form}
        </p>
      )}
      {warning ? (
        <div class="notice notice--warning" role="alert">
          <div>
            <strong>
              {warning.bookings === 1 ? '1 booking' : `${warning.bookings} bookings`} ({warning.people} {warning.people === 1 ? 'place' : 'places'}) on this date.
            </strong>
            <p>They stay booked and keep their emails and cancel links, but the date won't show in the app. Hide it anyway?</p>
            <div class="cluster">
              <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => save(true)}>
                Hide it
              </button>
              <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => setWarning(null)}>
                Back
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div class="cluster">
          <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => save(false)}>
            {busy ? 'Saving...' : 'Save'}
          </button>
          <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
