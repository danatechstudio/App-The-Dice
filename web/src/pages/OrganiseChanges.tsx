// Changing a live session (docs/RTD_HOST_PORTAL.md#changing-a-live-session; Stage 5a):
// - ChangeForm: a host asks for a change, starting from what the diary shows now;
// - ChangeStatus: on the host's card, how their latest request is going;
// - ChangesPanel: approvers and admins see each change side by side, and approve it or
//   decline it with a reason.
// Nothing public changes until it's approved; then it reaches the diary within about half an hour.

import { ArrowRight, Info, X } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { addDays, formatTime, shortDate, todayLondon } from '../lib/dates';
import { hostApi, type ChangeField, type ChangeRequest, type HostSession } from '../lib/hostApi';
import { toast } from '../lib/toast';

/** One value as people read it. */
function show(field: ChangeField, v: string | null): string {
  if (v === null || v === '') return 'None';
  if (field === 'event_date') return shortDate(v);
  if (field === 'start_time' || field === 'end_time') return formatTime(v) ?? v;
  if (field === 'access') return v === 'private' ? 'Private' : 'Open';
  return v;
}

/** Each change: what it is now, and what it would be. */
export function ChangeList({ c }: { c: ChangeRequest }) {
  return (
    <dl class="change-list stack" style={{ '--gap': '6px' }}>
      {c.changes.map(x => (
        <div key={x.field}>
          <dt class="label">{x.label}</dt>
          <dd class="cluster" style={{ '--gap': '6px', alignItems: 'baseline' }}>
            <span class="meta" style={{ textDecoration: 'line-through' }}>{show(x.field, x.now)}</span>
            <ArrowRight size={14} aria-label="becomes" />
            <strong>{show(x.field, x.proposed)}</strong>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** On the host's card: their latest request. */
export function ChangeStatus({ c, onChanged }: { c: ChangeRequest; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const withdraw = async () => {
    setBusy(true);
    const res = await hostApi(`/api/host/changes/${c.request_id}/withdraw`, {});
    setBusy(false);
    toast(res.ok ? 'Change request withdrawn.' : res.error);
    onChanged();
  };
  const head =
    c.status === 'pending'
      ? 'Change waiting for the café'
      : c.status === 'declined'
        ? "Change not approved"
        : c.applied
          ? 'Change approved'
          : 'Change approved: reaching the diary within about half an hour';
  return (
    <div class={`notice ${c.status === 'declined' ? 'notice--warning' : 'notice--info'}`}>
      <Info size={20} aria-hidden="true" />
      <div class="stack" style={{ '--gap': '6px' }}>
        <strong>{head}</strong>
        <ChangeList c={c} />
        {c.status === 'declined' && c.decision_note && <p>Café note: "{c.decision_note}"</p>}
        {c.status === 'pending' && (
          <div>
            <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={withdraw}>
              Withdraw this request
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A host asks to change their live session. Starts from what the diary shows now. */
export function ChangeForm({ s, onDone }: { s: HostSession; onDone: (sent: boolean) => void }) {
  const live = s.live!;
  const today = todayLondon();
  const [f, setF] = useState(() => ({
    name: live.name,
    description: live.description ?? '',
    event_date: live.event_date ?? '',
    start_time: live.start_time ?? '',
    end_time: live.end_time ?? '',
    paid: live.price_pence > 0,
    price: live.price_pence ? (live.price_pence % 100 ? (live.price_pence / 100).toFixed(2) : String(live.price_pence / 100)) : '',
    access: live.access,
    note: '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }));
  const id = `chg-${s.session_id}`;

  const submit = async (e: Event) => {
    e.preventDefault();
    const pence = f.paid ? Math.round(Number(f.price) * 100) : 0;
    if (f.paid && !(pence > 0 && pence <= 10_000)) return setErrors({ price_pence: 'Enter the cost per player (up to £100), or choose Free.' });
    setBusy(true);
    const res = await hostApi<{ request: ChangeRequest }>(`/api/host/sessions/${s.session_id}/changes`, {
      name: f.name,
      description: f.description,
      event_date: f.event_date,
      start_time: f.start_time,
      end_time: f.end_time,
      price_pence: pence,
      access: f.access,
      note: f.note,
    });
    setBusy(false);
    if (res.ok) {
      toast('Sent to the café. Nothing changes until they approve it.');
      return onDone(true);
    }
    if (res.kind === 'invalid') setErrors(res.errors ?? { form: res.error });
    else toast(res.error);
  };
  const field = (key: string) => ({
    class: `field${errors[key] ? ' field--error' : ''}`,
    error: errors[key] ? <p class="field__error">{errors[key]}</p> : null,
  });
  const weekly = s.frequency === 'weekly';

  return (
    <form class="card card--pad stack" style={{ '--gap': '14px' }} onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <div class="section-head" style={{ marginBottom: 0 }}>
        <h3 id={`${id}-title`}>Ask for a change</h3>
        <button type="button" class="btn btn--icon btn--text" onClick={() => onDone(false)} aria-label="Close the form">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <p class="meta">
        Change what you need. The café approves it first; until then the diary stays as it is. Places and cancelling a date don't need this: they change
        straight away.
      </p>
      <div class={field('name').class}>
        <label for={`${id}-name`}>Event name</label>
        <input id={`${id}-name`} class="input" value={f.name} maxLength={80} onInput={e => set('name', e.currentTarget.value)} />
        {field('name').error}
      </div>
      <div class={field('description').class}>
        <label for={`${id}-desc`}>Description</label>
        <textarea id={`${id}-desc`} class="input" rows={3} maxLength={500} value={f.description} onInput={e => set('description', e.currentTarget.value)} />
        {field('description').error}
      </div>
      <div class={field('event_date').class}>
        <label for={`${id}-date`}>{weekly ? 'Next date (moves every week to that day)' : 'Date'}</label>
        <input id={`${id}-date`} class="input" type="date" value={f.event_date} min={addDays(today, 1)} max={addDays(today, 365)}
          onInput={e => set('event_date', e.currentTarget.value)} />
        <p class="field__hint">If people are booked on the old date, the café decides how to tell them.</p>
        {field('event_date').error}
      </div>
      <div class="cluster" style={{ '--gap': '12px' }}>
        <div class={field('start_time').class}>
          <label for={`${id}-start`}>Start</label>
          <input id={`${id}-start`} class="input" type="time" value={f.start_time} onInput={e => set('start_time', e.currentTarget.value)} />
          {field('start_time').error}
        </div>
        <div class={field('end_time').class}>
          <label for={`${id}-end`}>
            End <span class="field__optional">optional</span>
          </label>
          <input id={`${id}-end`} class="input" type="time" value={f.end_time} onInput={e => set('end_time', e.currentTarget.value)} />
          {field('end_time').error}
        </div>
      </div>
      <p class="field__hint">Everyone booked is emailed a new time once it's approved.</p>
      <fieldset class={field('price_pence').class}>
        <legend>Cost per player</legend>
        <div class="segmented segmented--inline" role="group" aria-label="Cost per player">
          <button type="button" aria-pressed={!f.paid} onClick={() => set('paid', false)}>Free</button>
          <button type="button" aria-pressed={f.paid} onClick={() => set('paid', true)}>Paid</button>
        </div>
        {f.paid && (
          <input class="input" inputMode="decimal" aria-label="Cost in pounds" value={f.price} placeholder="e.g. 5" onInput={e => set('price', e.currentTarget.value)} />
        )}
        {field('price_pence').error}
      </fieldset>
      <fieldset class={field('access').class}>
        <legend>Who can come?</legend>
        <div class="segmented segmented--inline" role="group" aria-label="Who can come">
          <button type="button" aria-pressed={f.access === 'open'} onClick={() => set('access', 'open')}>Open</button>
          <button type="button" aria-pressed={f.access === 'private'} onClick={() => set('access', 'private')}>Private</button>
        </div>
        {field('access').error}
      </fieldset>
      <div class={field('note').class}>
        <label for={`${id}-note`}>
          A note to the café <span class="field__optional">optional</span>
        </label>
        <input id={`${id}-note`} class="input" maxLength={500} value={f.note} onInput={e => set('note', e.currentTarget.value)} />
        {field('note').error}
      </div>
      {errors.form && (
        <p class="field__error" role="alert">
          {errors.form}
        </p>
      )}
      <div class="cluster">
        <button type="submit" class="btn btn--primary" disabled={busy}>
          {busy ? 'Sending...' : 'Send to the café'}
        </button>
        <button type="button" class="btn btn--text" disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Approvers and admins: hosts' changes waiting for a decision. */
export function ChangesPanel() {
  const [list, setList] = useState<ChangeRequest[] | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ requests: ChangeRequest[] }>('/api/staff/change-requests');
    if (res.ok) setList(res.data.requests);
  }, []);
  useEffect(() => void load(), [load]);
  if (!list || !list.length) return null;
  return (
    <section class="section" aria-labelledby="changes">
      <div class="section-head">
        <h2 id="changes">
          Changes to approve <span class="count-badge">{list.length}</span>
        </h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Hosts' changes to their live sessions. Nothing changes in the diary until you approve; then it's there within about half an hour.
      </p>
      <div class="list">
        {list.map(c => (
          <ChangeCard key={c.request_id} c={c} onDone={load} />
        ))}
      </div>
    </section>
  );
}

function ChangeCard({ c, onDone }: { c: ChangeRequest; onDone: () => void }) {
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(true);
    setError(null);
    const res = await hostApi<{ request: ChangeRequest }>(`/api/staff/change-requests/${c.request_id}/decision`, { decision, note });
    setBusy(false);
    if (!res.ok) return setError(res.errors?.note ?? res.error);
    toast(decision === 'approve' ? `${c.name}: change approved.` : `${c.name}: change declined, and the host told why.`);
    onDone();
  };
  const fields = new Set(c.changes.map(x => x.field));
  const timeChange = fields.has('start_time') || fields.has('end_time');
  return (
    <article class="card review-card">
      <div class="stack" style={{ '--gap': '8px' }}>
        <div class="cluster" style={{ '--gap': '8px' }}>
          <h3>{c.name}</h3>
          <Chip kind="awaiting">Change</Chip>
        </div>
        <p class="meta">
          {c.host} · {c.frequency === 'weekly' ? 'Weekly' : 'One-off'} · asked {shortDate(todayLondon(new Date(c.created_at)))} · {c.request_id}
        </p>
        <ChangeList c={c} />
        {c.note && <p>"{c.note}"</p>}
        {c.bookings > 0 && (
          <p class="meta">
            {c.bookings === 1 ? '1 booking' : `${c.bookings} bookings`} ({c.people} {c.people === 1 ? 'place' : 'places'}) on dates to come.
            {timeChange ? ' They are emailed the new time when you approve.' : ''}
            {fields.has('event_date') ? ' A booked date that moves is held under Needs attention, so you decide how to tell them.' : ''}
          </p>
        )}
      </div>
      {declining ? (
        <div class="stack" style={{ '--gap': '8px' }}>
          <div class={`field${error ? ' field--error' : ''}`}>
            <label class="label" for={`cr-${c.request_id}-note`}>
              Why? The host is emailed this
            </label>
            <input id={`cr-${c.request_id}-note`} class="input" maxLength={500} value={note} onInput={e => setNote(e.currentTarget.value)} />
            {error && (
              <p class="field__error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div class="cluster">
            <button type="button" class="btn btn--destructive btn--sm" disabled={busy} onClick={() => decide('decline')}>
              Decline
            </button>
            <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => (setDeclining(false), setError(null))}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div class="stack" style={{ '--gap': '8px' }}>
          {error && (
            <p class="field__error" role="alert">
              {error}
            </p>
          )}
          <div class="cluster">
            <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => decide('approve')}>
              Approve
            </button>
            <button type="button" class="btn btn--destructive-quiet btn--sm" disabled={busy} onClick={() => setDeclining(true)}>
              Decline
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
