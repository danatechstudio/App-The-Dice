// Changing events in the Logic Engine from the organiser (docs/RTD_EVENT_CONTROL_AUDIT.md §4,
// Stage 6), admins only. A change goes to the sheet first (n8n RTD Sheet Writer, matched on
// Event ID) and reaches the app with the next sync, like an edit typed into the sheet. If the
// sheet changed in the meantime nothing is written, and the admin chooses which to keep.

import { AlertTriangle, Pencil, RotateCcw, Undo2 } from 'lucide-preact';
import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { Chip, type ChipKind } from '../components/Chips';
import { DiceLoader } from '../components/States';
import { shortDate, todayLondon } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { toast } from '../lib/toast';

type Mode = 'off' | 'staging' | 'shadow' | 'live';
type Target = Exclude<Mode, 'off'>;
type Fields = Record<string, { from: string; to: string }>;

interface Edit {
  edit_id: string;
  event_id: string;
  name: string | null;
  tab: string;
  target: Target;
  fields: Fields;
  note: string | null;
  requested_by: string;
  status: 'queued' | 'written' | 'synced' | 'overtaken' | 'dry_run' | 'conflict' | 'dead' | 'cancelled';
  found: Record<string, string> | null;
  cells: Record<string, string> | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  written_at: string | null;
  resolution: string | null;
  created_at: string;
}

interface Overview {
  mode: Mode;
  counts: { queued: number; conflict: number; dead: number };
  edits: Edit[];
  last_sync: { status: string; received_at: string; events_seen: number; warnings: { event_name: string; detail: string }[] } | null;
}

interface SheetEvent {
  event_id: string;
  source: 'event_index' | 'standard_diary';
  tab: string;
  name: string;
  active: boolean;
  frequency: string;
  values: Record<string, string>;
  bookings: number;
  open_edit: string | null;
}

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'Nothing is written. Change events in the sheet.' },
  { mode: 'staging', label: 'Test copy', hint: 'Changes are written to the test copy of the Logic Engine, never the real one. The app doesn’t change.' },
  { mode: 'shadow', label: 'Trial', hint: 'Each change is checked against the real Logic Engine and shows what would be written, but nothing is.' },
  { mode: 'live', label: 'Live', hint: 'Changes are written to the Logic Engine, then reach the app and everything that reads the sheet.' },
];

const WHERE: Record<Target, string> = { staging: 'Test copy', shadow: 'Trial', live: 'Live' };

const STATUS: Record<Edit['status'], { label: string; kind: ChipKind }> = {
  queued: { label: 'Waiting to be written', kind: 'awaiting' },
  written: { label: 'In the sheet', kind: 'approved' },
  synced: { label: 'In the app', kind: 'live' },
  overtaken: { label: 'Changed again in the sheet', kind: 'completed' },
  dry_run: { label: 'Trial done', kind: 'completed' },
  conflict: { label: 'The sheet changed', kind: 'cancelled' },
  dead: { label: 'Not written', kind: 'cancelled' },
  cancelled: { label: 'Withdrawn', kind: 'completed' },
};

const VISIBILITY: Record<string, string> = { public: 'Public', app_bookable: 'App Bookable', private: 'Private', hidden: 'Hidden' };
const CATEGORIES = ['Gaming', 'Quiz', 'Social', 'Club', 'Tournament', 'Market', 'Workshop', 'Other'];

const clockOf = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const when = (iso: string) => `${shortDate(todayLondon(new Date(iso)))}, ${clockOf(iso)}`;
const isIso = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A value as people read it. */
function show(column: string, v: string | undefined): string {
  if (!v) return 'nothing';
  if (column === 'App Visibility') return VISIBILITY[v] ?? v;
  if ((column === 'Event Date' || column === 'Date') && isIso(v)) return shortDate(v);
  // A prompt can run to pages: the start is enough to tell changes apart here.
  return v.length > 120 ? `${v.slice(0, 120)}…` : v;
}

export function SheetSyncPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [events, setEvents] = useState<SheetEvent[] | null>(null);
  const load = useCallback(async () => {
    const [o, e] = await Promise.all([hostApi<Overview>('/api/staff/sheet-sync'), hostApi<{ events: SheetEvent[] }>('/api/staff/sheet-events')]);
    if (o.ok) setData(o.data);
    if (e.ok) setEvents(e.data.events);
  }, []);
  useEffect(() => void load(), [load]);
  if (!data) return null;
  const problems = data.counts.conflict + data.counts.dead;

  return (
    <section class="section" aria-labelledby="sheet-sync">
      <div class="section-head">
        <h2 id="sheet-sync">Logic Engine changes {problems > 0 && <span class="count-badge">{problems}</span>}</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Change an event’s name, details, next date, times, Status or app columns here, and it’s written to its row in the Logic Engine (found by Event
        ID). The writer starts as soon as you save and the app syncs straight after, so it shows usually within a minute (10 minutes at most, on the timers). If the sheet has changed since, nothing is written and you choose which to keep.
      </p>
      <ModePicker mode={data.mode} onSaved={load} />
      {data.last_sync && <LastSync sync={data.last_sync} />}
      <EventEditor mode={data.mode} events={events} onSaved={load} />
      <h3 class="label" style={{ margin: '20px 0 8px' }}>
        Changes
      </h3>
      {!data.edits.length && <p class="meta">No changes made from the app yet.</p>}
      <div class="list">
        {data.edits.map(e => (
          <EditCard key={e.edit_id} e={e} onChanged={load} />
        ))}
      </div>
    </section>
  );
}

function ModePicker({ mode, onSaved }: { mode: Mode; onSaved: () => void }) {
  const [choice, setChoice] = useState<Mode>(mode);
  const [busy, setBusy] = useState(false);
  useEffect(() => setChoice(mode), [mode]);
  const save = async () => {
    setBusy(true);
    const res = await hostApi<{ mode: Mode }>('/api/staff/sheet-sync/mode', { mode: choice });
    setBusy(false);
    toast(res.ok ? `Logic Engine changes: ${MODES.find(m => m.mode === res.data.mode)!.label}.` : res.error);
    onSaved();
  };
  return (
    <fieldset class="field stack" style={{ '--gap': '8px', marginBottom: '16px' }}>
      <legend class="label">Where changes go</legend>
      {MODES.map(m => (
        <label key={m.mode} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px', alignItems: 'start' }}>
          <input type="radio" name="sheet-mode" value={m.mode} checked={choice === m.mode} onChange={() => setChoice(m.mode)} style={{ marginTop: '4px' }} />
          <span>
            <strong>
              {m.label}
              {m.mode === mode ? ' (now)' : ''}
            </strong>
            <span class="meta" style={{ display: 'block' }}>
              {m.hint}
            </span>
          </span>
        </label>
      ))}
      {choice === 'live' && mode !== 'live' && (
        <div class="notice notice--warning" role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <p>Live writes to the real Logic Engine, which the posters, social posts and calendar also read. Changes already made keep where they were going.</p>
        </div>
      )}
      <div>
        <button type="button" class="btn btn--primary btn--sm" disabled={busy || choice === mode} onClick={save}>
          {busy ? 'Saving...' : 'Save'}
        </button>
      </div>
    </fieldset>
  );
}

function LastSync({ sync }: { sync: NonNullable<Overview['last_sync']> }) {
  return (
    <div class="stack" style={{ '--gap': '4px', marginBottom: '16px' }}>
      <p class="meta">
        Last read from the Logic Engine: {when(sync.received_at)}, {sync.status === 'ok' ? `${sync.events_seen} events` : 'refused (see Sync health)'}
        {sync.warnings.length ? `, ${sync.warnings.length} ${sync.warnings.length === 1 ? 'row needs' : 'rows need'} a look` : ''}.
      </p>
      {sync.warnings.length > 0 && (
        <details>
          <summary class="meta">Rows that need a look</summary>
          <ul class="meta">
            {sync.warnings.map((w, i) => (
              <li key={i}>
                {w.event_name}: {w.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function EditCard({ e, onChanged }: { e: Edit; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (action: string, done: string) => {
    setBusy(true);
    const res = await hostApi(`/api/staff/sheet-edits/${e.edit_id}/resolve`, { action });
    setBusy(false);
    toast(res.ok ? done : res.error);
    onChanged();
  };
  const s = STATUS[e.status];
  return (
    <article class="card card--pad stack" style={{ '--gap': '6px' }}>
      <div class="cluster" style={{ '--gap': '8px' }}>
        <strong>{e.name ?? e.event_id}</strong>
        <Chip kind={s.kind}>{s.label}</Chip>
        {e.target !== 'live' && <Chip kind="preview">{WHERE[e.target]}</Chip>}
      </div>
      <ul class="meta" style={{ margin: 0, paddingLeft: '18px' }}>
        {Object.entries(e.fields).map(([c, f]) => (
          <li key={c}>
            <strong>{c}:</strong> {show(c, f.from)} → {show(c, f.to)}
            {e.status === 'conflict' && e.found && e.found[c] !== f.from && e.found[c] !== f.to && <> · the sheet now has <strong>{show(c, e.found[c])}</strong></>}
          </li>
        ))}
      </ul>
      <p class="meta">
        {e.edit_id} · {e.tab} · {e.requested_by} · {when(e.created_at)}
        {e.note ? ` · “${e.note}”` : ''}
      </p>
      {e.status === 'queued' && (
        <p class="meta">
          {e.attempts ? `Tried ${e.attempts === 1 ? 'once' : `${e.attempts} times`}${e.last_error ? `: ${e.last_error}` : ''}. ` : ''}
          {e.next_attempt_at ? `Next try at ${clockOf(e.next_attempt_at)}.` : 'The writer starts when you save, and runs every 5 minutes as well.'}
        </p>
      )}
      {e.status === 'written' && e.target === 'live' && <p class="meta">Written {e.written_at ? clockOf(e.written_at) : ''}: shows in the app after the next sync.</p>}
      {e.status === 'written' && e.target === 'staging' && (
        <p class="meta">Written to the test copy{e.written_at ? ` at ${clockOf(e.written_at)}` : ''}. The real Logic Engine and the app are unchanged.</p>
      )}
      {e.status === 'dry_run' && (
        <p class="meta">
          {e.cells && Object.keys(e.cells).length > 1
            ? `Would write: ${Object.entries(e.cells).filter(([c]) => c !== 'Event ID').map(([c, v]) => `${c} “${v}”`).join(', ')}.`
            : 'The sheet already had it: nothing to write.'}
        </p>
      )}
      {e.status === 'overtaken' && <p class="meta">It was written, but the sheet changed again before the app read it: the sheet’s value stands.</p>}
      {e.status === 'conflict' && <p class="meta">Nothing was written. Keep what the sheet has now, or write your change over it.</p>}
      {e.status === 'dead' && e.last_error && <p class="meta">{e.last_error}</p>}
      <div class="cluster">
        {e.status === 'queued' && (
          <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => act('withdraw', 'Withdrawn.')}>
            <Undo2 size={16} aria-hidden="true" /> Withdraw
          </button>
        )}
        {e.status === 'conflict' && (
          <>
            <button type="button" class="btn btn--secondary btn--sm" disabled={busy} onClick={() => act('keep_sheet', 'Kept the sheet’s.')}>
              Keep the sheet’s
            </button>
            <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => act('write_mine', 'Writing yours within 5 minutes.')}>
              Write mine over it
            </button>
          </>
        )}
        {e.status === 'dead' && (
          <button type="button" class="btn btn--secondary btn--sm" disabled={busy} onClick={() => act('retry', 'Trying again within 5 minutes.')}>
            <RotateCcw size={16} aria-hidden="true" /> Try again
          </button>
        )}
      </div>
    </article>
  );
}

function EventEditor({ mode, events, onSaved }: { mode: Mode; events: SheetEvent[] | null; onSaved: () => void }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (events ?? []).filter(e => !q || e.name.toLowerCase().includes(q) || e.event_id.toLowerCase().includes(q)).slice(0, 12);
  }, [events, query]);
  const event = events?.find(e => e.event_id === picked) ?? null;

  if (mode === 'off') return <p class="meta">Choose where changes go to change an event here.</p>;
  if (events === null) return <DiceLoader label="Loading events..." />;
  return (
    <div class="card card--pad stack" style={{ '--gap': '12px' }}>
      <h3 class="label">Change an event{mode !== 'live' ? ` (${WHERE[mode]})` : ''}</h3>
      {event ? (
        <SheetEditForm key={event.event_id} e={event} mode={mode} onClose={() => setPicked(null)} onSaved={() => (setPicked(null), onSaved())} />
      ) : (
        <>
          <div class="field">
            <label for="sheet-find">Find an event</label>
            <input id="sheet-find" class="input" type="search" value={query} placeholder="Name or RTD-EVT number" onInput={ev => setQuery(ev.currentTarget.value)} />
            <p class="field__hint">The café’s own events from the last sync. Host sessions are changed through their host; markets under Markets.</p>
          </div>
          <div class="list" role="list">
            {matches.map(e => (
              <div key={e.event_id} role="listitem" class="cluster" style={{ '--gap': '8px', justifyContent: 'space-between' }}>
                <span>
                  <strong>{e.name}</strong>
                  <span class="meta" style={{ display: 'block' }}>
                    {e.tab} · {e.active ? show(e.source === 'event_index' ? 'Event Date' : 'Date', e.values['Event Date'] ?? e.values.Date) : 'Inactive'} ·{' '}
                    {VISIBILITY[e.values['App Visibility'] ?? ''] ?? e.values['App Visibility']}
                    {e.open_edit ? ` · change ${e.open_edit} on its way` : ''}
                  </span>
                </span>
                <button type="button" class="btn btn--secondary btn--sm" disabled={!!e.open_edit} onClick={() => setPicked(e.event_id)}>
                  <Pencil size={16} aria-hidden="true" /> Change
                </button>
              </div>
            ))}
            {!matches.length && <p class="meta">No events match.</p>}
          </div>
        </>
      )}
    </div>
  );
}

function SheetEditForm({ e, mode, onClose, onSaved }: { e: SheetEvent; mode: Mode; onClose: () => void; onSaved: () => void }) {
  const isIndex = e.source === 'event_index';
  const nameCol = isIndex ? 'Event Name' : 'Group';
  const detailsCol = isIndex ? 'Base Details' : 'Notes';
  const dateCol = isIndex ? 'Event Date' : 'Date';
  const sheetDate = e.values[dateCol] ?? '';
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...e.values, [dateCol]: isIso(sheetDate) ? sheetDate : '' }));
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (c: string) => (ev: { currentTarget: { value: string } }) => (setValues(v => ({ ...v, [c]: ev.currentTarget.value })), setWarning(null));
  // Only what differs from the sheet; a date the sheet holds as text stays as it is unless one is picked.
  const changed = Object.fromEntries(Object.entries(values).filter(([c, v]) => (c === dateCol && !isIso(sheetDate) ? v !== '' : v !== (e.values[c] ?? ''))));

  const save = async (confirm: boolean) => {
    setBusy(true);
    setErrors({});
    const res = await hostApi<{ edit: Edit }>(`/api/staff/events/${e.event_id}/sheet-edit`, { values: changed, note, confirm });
    setBusy(false);
    if (res.ok) {
      toast(mode === 'shadow' ? `${e.name}: trial queued.` : `${e.name}: on its way to the ${mode === 'staging' ? 'test copy' : 'Logic Engine'}.`);
      return onSaved();
    }
    const w = res.status === 409 ? (res.body as { warning?: string } | undefined)?.warning : undefined;
    if (w) return setWarning(w);
    if (res.kind === 'invalid') setErrors(res.errors ?? { form: res.error });
    else setErrors({ form: res.error });
  };

  const field = (c: string, label: string, input: JSX.Element, hint?: string) => (
    <div class={`field${errors[c] ? ' field--error' : ''}`}>
      <label for={`se-${c}`}>{label}</label>
      {input}
      {hint && <p class="field__hint">{hint}</p>}
      {errors[c] && <p class="field__error">{errors[c]}</p>}
    </div>
  );
  const id = (c: string) => `se-${c}`;
  return (
    <div class="stack" style={{ '--gap': '12px' }}>
      <p class="meta">
        <strong>{e.name}</strong> · {e.event_id} · {e.tab}
        {e.frequency !== 'one-off' ? ` · ${e.frequency}` : ''}
      </p>
      {field(nameCol, isIndex ? 'Event name' : 'Group', <input id={id(nameCol)} class="input" maxLength={100} value={values[nameCol]} onInput={set(nameCol)} />,
        'The posters and social posts tell rows apart by name, so it can’t match another row.')}
      {field(detailsCol, isIndex ? 'Base details' : 'Notes', <textarea id={id(detailsCol)} class="input" rows={4} maxLength={3000} value={values[detailsCol]} onInput={set(detailsCol)} />)}
      {field(dateCol, 'Next date', <input id={id(dateCol)} class="input" type="date" value={values[dateCol]} onInput={set(dateCol)} />,
        !isIso(sheetDate) ? (sheetDate ? `The sheet has “${sheetDate}”, which isn’t a date.` : 'The sheet has no date.') : e.frequency !== 'one-off' ? 'The date the sheet holds now; it rolls on as usual.' : undefined)}
      {isIndex && (
        <div class="cluster" style={{ '--gap': '12px', alignItems: 'flex-start' }}>
          {field('Event Time', 'Starts', <input id={id('Event Time')} class="input" type="time" value={values['Event Time']} onInput={set('Event Time')} />, 'Empty: all day.')}
          {field('End Time', 'Ends', <input id={id('End Time')} class="input" type="time" value={values['End Time']} onInput={set('End Time')} />)}
        </div>
      )}
      {isIndex &&
        field('Status', 'Status', (
          <select id={id('Status')} class="input" value={values.Status} onChange={set('Status')}>
            {!['Active', 'Inactive'].includes(values.Status ?? '') && <option value={values.Status}>{values.Status || '(blank)'}</option>}
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
        ), 'Inactive takes it out of the diary, the posters and the posts.')}
      {field('App Visibility', 'Who can see it in the app', (
        <select id={id('App Visibility')} class="input" value={values['App Visibility']} onChange={set('App Visibility')}>
          {!VISIBILITY[values['App Visibility'] ?? ''] && <option value={values['App Visibility']}>{values['App Visibility']}</option>}
          {Object.entries(VISIBILITY).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      ))}
      {field('App Category', 'Category', (
        <select id={id('App Category')} class="input" value={values['App Category']} onChange={set('App Category')}>
          {!['', ...CATEGORIES].includes(values['App Category'] ?? '') && <option value={values['App Category']}>{values['App Category']}</option>}
          <option value="">(none)</option>
          {CATEGORIES.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ))}
      {isIndex && field('App Price', 'Price', <input id={id('App Price')} class="input" maxLength={40} value={values['App Price']} placeholder="e.g. £5 or Free" onInput={set('App Price')} />)}
      <div class="field">
        <label for="se-note">
          Note <span class="field__optional">optional</span>
        </label>
        <input id="se-note" class="input" maxLength={500} value={note} onInput={ev => setNote(ev.currentTarget.value)} />
        <p class="field__hint">Kept with the change, for the record.</p>
      </div>
      {e.bookings > 0 && <p class="meta">{e.bookings === 1 ? '1 booking' : `${e.bookings} bookings`} on dates to come.</p>}
      {errors.form && (
        <p class="field__error" role="alert">
          {errors.form}
        </p>
      )}
      {warning ? (
        <div class="notice notice--warning" role="alert">
          <div>
            <strong>{warning}</strong>
            <div class="cluster" style={{ marginTop: '8px' }}>
              <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => save(true)}>
                Change it anyway
              </button>
              <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => setWarning(null)}>
                Back
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div class="cluster">
          <button type="button" class="btn btn--primary btn--sm" disabled={busy || !Object.keys(changed).length} onClick={() => save(false)}>
            {busy ? 'Saving...' : mode === 'shadow' ? 'Try it' : 'Send to the sheet'}
          </button>
          <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
