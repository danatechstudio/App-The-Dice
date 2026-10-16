// Needs attention in the organiser (docs/RTD_EVENT_CONTROL_AUDIT.md G-2, Stage 3b), for
// approvers and admins: events whose date has passed with nothing after it, and events
// with no usable date in the Logic Engine. Each one stays until someone sets a new date,
// archives it, or closes it; looking at it never does. Admins switch it on and off.

import { CalendarPlus, Check, TriangleAlert } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { addDays, daysBetween, formatTime, shortDate, todayLondon } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { toast } from '../lib/toast';

type Action = 'renew' | 'archive' | 'complete' | 'dismiss';

interface Item {
  item_id: number;
  ref: string;
  kind: 'expired' | 'no_date';
  name: string;
  source: 'event_index' | 'standard_diary' | 'app';
  frequency: string;
  date: string | null;
  start_time: string | null;
  detail: string | null;
  detail_kind: 'blank' | 'text' | 'past' | null;
  resolution: 'renewed' | 'archived' | 'completed' | 'dismissed' | null;
  renew_date: string | null;
  renew_waiting: boolean;
  resolved_by: string | null;
  resolution_note: string | null;
  opened_at: string;
  resolved_at: string | null;
  actions: Action[];
  sheet: 'auto' | 'manual';
  inactive: boolean;
}

type Overview =
  | { enabled: false }
  | { enabled: true; blocked: number; open: Item[]; resolved: Item[]; no_end_time: { event_id: string; name: string; date: string }[] };

const FREQUENCY: Record<string, string> = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', 'one-off': 'One-off' };
const RESOLVED: Record<string, string> = { renewed: 'New date', archived: 'Archived', completed: 'Finished, no new date', dismissed: 'Left as it is' };
const DONE: Record<Action, (name: string) => string> = {
  renew: name => `${name}: new date saved.`,
  archive: name => `${name}: archived.`,
  complete: name => `${name}: marked finished.`,
  dismiss: name => `${name}: left as it is. It comes back here if its date changes.`,
};

const londonDay = (iso: string) => todayLondon(new Date(iso));
const by = (who: string | null) => (who === 'sheet' ? 'the Logic Engine' : who === 'system' ? 'the app' : (who ?? ''));

function waiting(openedAt: string): string {
  const days = daysBetween(londonDay(openedAt), todayLondon());
  return days <= 0 ? 'since today' : days === 1 ? 'for 1 day' : `for ${days} days`;
}

/** Why it's here, in a sentence. */
function why(i: Item): string {
  if (i.kind === 'expired') return `Finished ${shortDate(i.date!)}${i.start_time ? ` (${formatTime(i.start_time)})` : ''}, and has no next date.`;
  if (i.detail_kind === 'past') return `Its date in the Logic Engine, ${i.detail}, has passed, so it isn't in the diary.`;
  if (i.detail_kind === 'text') return `The Logic Engine says "${i.detail}", which isn't a date, so it isn't in the diary.`;
  return "No date in the Logic Engine, so it isn't in the diary.";
}

export function AttentionPanel({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<Overview>('/api/staff/attention');
    if (res.ok) setData(res.data);
  }, []);
  useEffect(() => void load(), [load]);
  const toggle = async (on: boolean) => {
    const res = await hostApi<{ enabled: boolean }>('/api/staff/attention/switch', { on });
    toast(res.ok ? `Needs attention is ${on ? 'on' : 'off'}.` : res.error);
    load();
  };

  if (!data) return null;
  if (!data.enabled) {
    if (!isAdmin) return null;
    return (
      <section class="section" aria-labelledby="attention">
        <div class="section-head">
          <h2 id="attention">Needs attention</h2>
        </div>
        <p class="meta" style={{ marginBottom: '12px' }}>
          Lists events whose date has passed with nothing after it, and events with no usable date in the Logic Engine, until someone sets a new date,
          archives it or closes it. Approvers see it too. It's switched off.
        </p>
        <button type="button" class="btn btn--primary btn--sm" onClick={() => toggle(true)}>
          Switch on
        </button>
      </section>
    );
  }

  return (
    <section class="section" aria-labelledby="attention">
      <div class="section-head">
        <h2 id="attention">Needs attention {data.open.length > 0 && <span class="count-badge">{data.open.length}</span>}</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Events whose date has passed with nothing after it, and events with no usable date in the Logic Engine. Each one stays here until someone sets a
        new date, archives it or closes it.
      </p>
      {data.blocked > 0 && (
        <div class="notice notice--warning" role="alert">
          <TriangleAlert size={22} aria-hidden="true" />
          <div>
            <strong>{data.blocked} would have appeared at once, so none were added.</strong>
            <p>That usually means the Logic Engine was read wrongly. Check the sheet; the list catches up within the hour once it looks right.</p>
          </div>
        </div>
      )}
      {!data.open.length && <p class="meta">Nothing needs attention.</p>}
      <div class="list">
        {data.open.map(i => (
          <AttentionCard key={i.item_id} item={i} onDone={load} />
        ))}
      </div>
      {data.no_end_time.length > 0 && (
        <div class="stack" style={{ '--gap': '6px', marginTop: '16px' }}>
          <h3>No end time</h3>
          <p class="meta">
            These show in the diary until an hour after they start. Add an End Time in the Logic Engine to keep them up for as long as they run.
          </p>
          <ul class="list" role="list">
            {data.no_end_time.map(e => (
              <li key={e.event_id} class="meta">
                <strong>{e.name}</strong>, next on {shortDate(e.date)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.resolved.length > 0 && (
        <details class="recent-reminders">
          <summary>Sorted in the last 30 days ({data.resolved.length})</summary>
          <ul class="list" role="list">
            {data.resolved.map(i => (
              <li key={i.item_id} class="card card--pad recent-reminder">
                <div class="cluster" style={{ justifyContent: 'space-between' }}>
                  <strong>{i.name}</strong>
                  <span class="meta">{shortDate(londonDay(i.resolved_at!))}</span>
                </div>
                <p class="meta">
                  {RESOLVED[i.resolution!]}
                  {i.renew_date ? `: ${shortDate(i.renew_date)}` : ''} · by {by(i.resolved_by)} · {i.ref}
                </p>
                {i.resolution_note && <p class="meta">{i.resolution_note}</p>}
                {i.renew_waiting && (
                  <div>
                    <Chip kind="awaiting">Waiting for the Logic Engine</Chip>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {isAdmin && (
        <div style={{ marginTop: '12px' }}>
          <button type="button" class="btn btn--text btn--sm" onClick={() => toggle(false)}>
            Switch Needs attention off
          </button>
        </div>
      )}
    </section>
  );
}

function AttentionCard({ item, onDone }: { item: Item; onDone: () => void }) {
  const [mode, setMode] = useState<'renew' | 'archive' | null>(null);
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = todayLondon();
  const id = `att-${item.item_id}`;

  const act = async (action: Action) => {
    setBusy(true);
    setError(null);
    const res = await hostApi<{ item: Item }>(`/api/staff/attention/${item.item_id}/resolve`, {
      action,
      ...(action === 'renew' ? { date } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.errors?.date ?? res.errors?.note ?? res.error);
      if (res.status === 409) onDone(); // someone else got there first
      return;
    }
    toast(DONE[action](item.name));
    onDone();
  };

  const noteField = (
    <div class="field">
      <label class="label" for={`${id}-note`}>
        Note (optional)
      </label>
      <input id={`${id}-note`} class="input" maxLength={300} value={note} onInput={e => setNote(e.currentTarget.value)} />
    </div>
  );

  return (
    <article class="card review-card">
      <div class="stack" style={{ '--gap': '6px' }}>
        <div class="cluster" style={{ '--gap': '8px' }}>
          <h3>{item.name}</h3>
          <Chip kind={item.kind === 'expired' ? 'completed' : 'awaiting'}>{item.kind === 'expired' ? 'Date passed' : 'No date'}</Chip>
        </div>
        <p>{why(item)}</p>
        <p class="meta">
          {[FREQUENCY[item.frequency], item.source === 'standard_diary' ? 'Standard Diary' : 'Event Index', `waiting ${waiting(item.opened_at)}`, item.ref]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {!item.actions.includes('renew') && (
          <p class="meta">
            {item.source === 'standard_diary'
              ? 'To give it a new date, change it in the Standard Diary tab: this clears itself when the date arrives.'
              : "Hosts' sessions and markets are run again from the organiser."}
          </p>
        )}
      </div>

      {mode === 'renew' && (
        <div class="stack" style={{ '--gap': '8px' }}>
          <div class={`field${error ? ' field--error' : ''}`}>
            <label class="label" for={`${id}-date`}>
              New date
            </label>
            <p id={`${id}-date-hint`} class="field__hint">
              The Logic Engine is updated within 15 minutes, with the same times. It's then in the diary and posted as usual.
            </p>
            <input id={`${id}-date`} class="input" type="date" value={date} min={addDays(today, 1)} max={addDays(today, 365)} required
              aria-describedby={`${id}-date-hint`} aria-invalid={!!error} onInput={e => setDate(e.currentTarget.value)} />
          </div>
          {noteField}
          <div class="cluster">
            <button type="button" class="btn btn--primary btn--sm" disabled={busy || !date} onClick={() => act('renew')}>
              {busy ? 'Saving...' : 'Save the new date'}
            </button>
            <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => setMode(null)}>
              Back
            </button>
          </div>
        </div>
      )}

      {mode === 'archive' && (
        <div class="stack" style={{ '--gap': '8px' }}>
          <p class="meta">
            {item.inactive
              ? "It's already switched off in the Logic Engine, so nothing changes there. It won't come back here."
              : item.sheet === 'auto'
                ? "It's switched off in the Logic Engine within 15 minutes, so it's no longer posted or in the diary."
                : 'Also hide it in the Standard Diary tab (App Visibility: Hidden), or it stays in the sheet.'}
          </p>
          {noteField}
          <div class="cluster">
            <button type="button" class="btn btn--destructive btn--sm" disabled={busy} onClick={() => act('archive')}>
              {busy ? 'Saving...' : 'Archive'}
            </button>
            <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => setMode(null)}>
              Back
            </button>
          </div>
        </div>
      )}

      {mode === null && (
        <div class="cluster">
          {item.actions.includes('renew') && (
            <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => setMode('renew')}>
              <CalendarPlus size={16} aria-hidden="true" /> Set a new date
            </button>
          )}
          {item.actions.includes('complete') && (
            <button type="button" class="btn btn--secondary btn--sm" disabled={busy} onClick={() => act('complete')}>
              <Check size={16} aria-hidden="true" /> Finished, no new date
            </button>
          )}
          {item.actions.includes('archive') && (
            <button type="button" class="btn btn--destructive-quiet btn--sm" disabled={busy} onClick={() => setMode('archive')}>
              Archive
            </button>
          )}
          {item.actions.includes('dismiss') && (
            <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => act('dismiss')}>
              Leave as it is
            </button>
          )}
        </div>
      )}
      {error && (
        <p class="field__error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
