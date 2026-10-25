// Admins: one event, every detail (docs/superpowers/specs/2026-10-18-admin-event-editor-design.md).
// Save sends only what changed; the server sends each part where it belongs: café details to the
// Logic Engine (in the app after the next sync), a host's session through the approved-change path
// (the host is emailed), places and booking straight away. Dates can be cancelled (everyone booked
// is emailed), hidden or given their own places, and the whole event can be stopped.
// Every Logic Engine column a person fills in by hand is here too, in sections (Posting,
// Michelle's voice, Social facts, Contact): each goes through the same queue as the details.

import { ArrowLeft, Ban, ChevronLeft, ChevronRight, ExternalLink, EyeOff, Plus, Trash2 } from 'lucide-preact';
import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { DiceLoader } from '../components/States';
import { longDate, shortDate, todayLondon } from '../lib/dates';
import { editorHref, neighbours, ORIGIN, originOf, trailFor } from '../lib/eventTrail';
import { loadTrail } from '../lib/eventTrailStore';
import { hostApi, MAX_PLACES, type AdminEventDetails, type AdminEventForm, type BookingMode, type EventVisibility } from '../lib/hostApi';
import { navigate } from '../lib/router';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/title';
import { KIND_LABEL } from './OrganiseEvents';
import { DatePlaces } from './OrganisePlaces';
import { ageRange, BOOKING_VIA, FACT_PRESETS, hasPresets, presetChoice, PRICE_FREE, ROLE_PRESETS, rolePreset } from '../../../src/social/presets';
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

type Body = {
  details?: Partial<AdminEventDetails>;
  sheet?: Record<string, string>;
  visibility?: EventVisibility;
  places?: number | null;
  booking_mode?: BookingMode | 'default';
};

// The Logic Engine's own headers (src/sync/sheetValues.ts EXTRA): RTD Sheet Writer matches them exactly.
const STANDARD_PROMPT = "Michelle's Standard Prompt";
const KPI_PROMPT = 'Michelles KPI Hook Prompt';
const TIKTOK = 'TikTok Video Blueprint';
const PROMPT_MAX = 20000;
const LONG_MAX = 5000;
const FACT_KEYS = ['Booking', 'Level', 'Age', 'Prizes', 'Format', 'Price', 'Bring', 'Food', 'Other'];
const ROLE_WORDS = 'host, DM, GM, organiser, leads, runs, sets up, caller, quizmaster, MC, presenter';
// The same role words the post checks read (src/social/validate.ts), loosely: the server has the last word.
const HAS_ROLE = /(?<![\p{L}\p{N}])(host\w*|dm|gm|dungeon\s+masters?|game\s+masters?|organi[sz]\w*|run|runs|running|ran|(set|sets|setting)\s+(\p{L}{1,10}\s+)?up|lead|leads|leading|led|quiz\s*masters?|mc|emcee|compere|callers?|presenters?)(?![\p{L}\p{N}])/iu;

/** The sheet column behind each detail, by tab (src/events/admin.ts COLUMNS). */
const DETAIL_COLUMN: Record<'event_index' | 'standard_diary', Partial<Record<keyof AdminEventDetails, string>>> = {
  event_index: { name: 'Event Name', description: 'Base Details', event_date: 'Event Date', start_time: 'Event Time', end_time: 'End Time', price: 'App Price', category: 'App Category' },
  standard_diary: { name: 'Group', description: 'Notes', event_date: 'Date', category: 'App Category' },
};

type FactRow = { key: string; value: string; choice?: string; url?: string; from?: string; to?: string };
type PersonRow = { name: string; role: string; other?: boolean };
const linesOf = (text: string) => text.split('\n').map(l => l.trim()).filter(Boolean);

/** Approved Facts as rows, or why they can't be (src/social/facts.ts parseFacts). */
function factRows(text: string): { rows: FactRow[] } | { why: string } {
  const rows: FactRow[] = [];
  for (const line of linesOf(text)) {
    const colon = line.indexOf(':');
    const key = colon > 0 ? FACT_KEYS.find(k => k.toLowerCase() === line.slice(0, colon).trim().toLowerCase()) : undefined;
    const value = colon > 0 ? line.slice(colon + 1).trim() : '';
    if (!key || !value) return { why: `“${line}” isn’t a “Key: value” fact with one of the keys below.` };
    rows.push({ key, value });
  }
  return { rows };
}

/** People & Roles as rows, or why they can't be (src/social/facts.ts parsePeople). */
function personRows(text: string): { rows: PersonRow[] } | { why: string } {
  const rows: PersonRow[] = [];
  for (const line of linesOf(text)) {
    const m = /^(.+?)(?:\s*[—–]\s*|\s+-\s+)(.+)$/.exec(line);
    if (!m) return { why: `“${line}” isn’t “Name - role”.` };
    rows.push({ name: m[1]!.trim(), role: m[2]!.trim() });
  }
  return { rows };
}

/** A Drive folder ID, or the ID in a pasted folder link. */
const folderId = (v: string) => /drive\.google\.com\/.*?(?:\/folders\/|[?&]id=)([A-Za-z0-9_-]+)/.exec(v)?.[1] ?? v.trim();
const short = (v: string) => (!v ? 'empty' : v.length > 80 ? `${v.slice(0, 80)}…` : v);

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
  // Unsaved changes in the details form, so leaving for another screen can ask first.
  const dirty = useRef(false);
  const onDirty = useCallback((d: boolean) => void (dirty.current = d), []);

  return (
    <div class="container organiser" data-surface="staff">
      <header class="page-head organiser-section__head">
        <EditorNav eventId={eventId} dirty={dirty} />
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
                  : `A change (${event.pending.id}) is on its way to the Logic Engine. Details can be changed again once it's back in the app, usually within a minute (10 minutes at most).`}
              </div>
            </div>
          )}
          {event.kind === 'market' ? (
            <>
              <section class="card card--pad stack" style={{ '--gap': '12px' }}>
                <p>Markets have their own editor, with pitches and vendors.</p>
                <p>
                  <a class="btn btn--secondary btn--sm" href="/organise/content#markets-admin">
                    Open Markets
                  </a>
                </p>
              </section>
              <EventSocialSection eventId={event.event_id} />
            </>
          ) : (
            <>
              <DetailsForm key={JSON.stringify(event)} event={event} onSaved={load} onDirty={onDirty} />
              <DatesList event={event} onChanged={load} />
              <EventSocialSection eventId={event.event_id} factsInEditor={'Approved Facts' in event.sheet} />
              <StopEvent event={event} onStopped={load} />
            </>
          )}
          <EditorNav eventId={eventId} dirty={dirty} bottom />
        </div>
      )}
    </div>
  );
}

/**
 * Back to the list the editor was opened from (Events or Social posts), and Previous / Next
 * through that list's order. Stepping replaces this entry, so Back is still one step away.
 */
function EditorNav({ eventId, dirty, bottom = false }: { eventId: string; dirty: { current: boolean }; bottom?: boolean }) {
  const from = originOf(location.search);
  const ids = trailFor(loadTrail(), from, eventId);
  const { prev, next } = neighbours(ids ?? [], eventId);
  const origin = ORIGIN[from];
  const leave = () => !dirty.current || window.confirm('You have changes that aren’t saved. Leave without saving?');
  // Bottom: only the steps, and only when there are any.
  if (bottom && !prev && !next) return null;

  const goBack = (e: MouseEvent) => {
    e.preventDefault();
    if (!leave()) return;
    // Straight back to the list keeps its place; a direct link has no list behind it.
    if (ids && history.state?.inApp) history.back();
    else navigate(origin.path);
  };
  const step = (to: string) => (e: MouseEvent) => {
    e.preventDefault();
    if (leave()) navigate(editorHref(to, from), { replace: true });
  };

  return (
    <nav class={`event-nav${bottom ? ' event-nav--bottom' : ''}`} aria-label={bottom ? 'Other events' : 'Event navigation'}>
      {!bottom && (
        <a class="btn btn--text btn--sm event-nav__back" href={origin.path} onClick={goBack}>
          <ArrowLeft size={16} aria-hidden="true" /> {origin.label}
        </a>
      )}
      {(prev || next) && (
        <span class="event-nav__steps">
          {prev && (
            <a class="btn btn--secondary btn--sm" href={editorHref(prev, from)} onClick={step(prev)} aria-label="Previous event">
              <ChevronLeft size={16} aria-hidden="true" /> Previous
            </a>
          )}
          {ids && (
            <span class="meta event-nav__count">
              {ids.indexOf(eventId) + 1} of {ids.length}
            </span>
          )}
          {next && (
            <a class="btn btn--secondary btn--sm" href={editorHref(next, from)} onClick={step(next)} aria-label="Next event">
              Next <ChevronRight size={16} aria-hidden="true" />
            </a>
          )}
        </span>
      )}
    </nav>
  );
}

function DetailsForm({ event, onSaved, onDirty }: { event: AdminEventForm; onSaved: () => void; onDirty: (dirty: boolean) => void }) {
  const [d, setD] = useState<AdminEventDetails>(event.details);
  const [sheet, setSheet] = useState<Record<string, string>>(
    () => Object.fromEntries(Object.entries(event.sheet).filter((e): e is [string, string] => e[1] !== null)),
  );
  const [visibility, setVisibility] = useState<EventVisibility>(event.visibility);
  const [places, setPlaces] = useState<string>(event.places === null ? '' : String(event.places));
  const [mode, setMode] = useState<BookingMode | 'default'>(event.booking_mode_set ?? 'default');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hosted = event.kind === 'host_session';
  const set = (k: keyof AdminEventDetails, v: string) => (setD({ ...d, [k]: v }), setWarning(null));
  const setCol = (c: string, v: string) => (setSheet(s => ({ ...s, [c]: v })), setWarning(null));

  const body = (): Body => {
    const b: Body = {};
    const details = Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== event.details[k as keyof AdminEventDetails]));
    if (Object.keys(details).length) b.details = details;
    const cols = Object.fromEntries(Object.entries(sheet).filter(([c, v]) => v !== event.sheet[c]));
    if (Object.keys(cols).length) b.sheet = cols;
    if (visibility !== event.visibility) b.visibility = visibility;
    const p = places.trim() === '' ? null : Number(places);
    if (p !== event.places) b.places = p;
    if (mode !== (event.booking_mode_set ?? 'default')) b.booking_mode = mode;
    return b;
  };
  const changed = Object.keys(body()).length > 0;
  useEffect(() => onDirty(changed), [changed, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

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
          ? 'Sent to the Logic Engine. It shows in the app usually within a minute (10 minutes at most).'
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
    const waiting = event.kind === 'event_index' || event.kind === 'standard_diary' ? event.pending_fields[DETAIL_COLUMN[event.kind][k] ?? ''] : undefined;
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
        {waiting && <Waiting to={waiting.to} />}
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
      {'Frequency' in event.sheet && (
        <SheetField event={event} column="Frequency" label="How often" errors={errors}>
          {id => (
            <>
              <select id={id} class="input" value={sheet.Frequency} onChange={e => setCol('Frequency', e.currentTarget.value)}>
                {[...event.frequency_options, ...(event.frequency_options.includes(event.sheet.Frequency ?? '') ? [] : [event.sheet.Frequency ?? ''])].map(f => (
                  <option key={f} value={f}>
                    {f || 'Not set'}
                    {event.frequency_options.includes(f) ? '' : ' (as in the sheet)'}
                  </option>
                ))}
              </select>
              <p class={sheet.Frequency !== event.sheet.Frequency ? 'field__error' : 'field__hint'}>
                This changes how the Logic Engine’s automation moves the date on: weekly and two-weekly dates roll forward by themselves, monthly and
                one-off dates are re-dated by hand.
              </p>
            </>
          )}
        </SheetField>
      )}

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
        {event.pending_fields['App Visibility'] && <Waiting to={VISIBILITY.find(v => v.value === event.pending_fields['App Visibility']!.to)?.label ?? ''} />}
        {errors.visibility && <p class="field__error">{errors.visibility}</p>}
      </fieldset>

      <h2>Booking</h2>
      <div class="field-row">
        <div class={`field${errors.places ? ' field--error' : ''}`}>
          <label for="ev-places">{hosted ? 'Places on every date' : 'Places for this event (app)'}</label>
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
            {hosted ? '' : 'Set here, straight away. Empty: Default places (sheet), or no limit.'}
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

      <SheetSections event={event} sheet={sheet} setCol={setCol} errors={errors} eventPrice={event.unavailable.price ? '' : d.price} />

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

/** A note under a field whose change is on its way to the Logic Engine. */
function Waiting({ to }: { to: string }) {
  return <p class="field__hint event-editor__waiting">Waiting to reach the sheet: {short(to)}</p>;
}

/**
 * One Logic Engine column: its input, or "not synced yet" while RTD Event Sync doesn't send it
 * (a value never known can't be changed, or a blank could overwrite real text in the sheet).
 */
function SheetField({
  event,
  column,
  label,
  hint,
  errors,
  children,
}: {
  event: AdminEventForm;
  column: string;
  label: string;
  hint?: string;
  errors: Record<string, string>;
  children: (id: string) => JSX.Element;
}) {
  if (!(column in event.sheet)) return null;
  const id = `ev-col-${column.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;
  const err = errors[column];
  const waiting = event.pending_fields[column];
  const synced = event.sheet[column] !== null;
  return (
    <div class={`field${err ? ' field--error' : ''}`}>
      <label for={synced ? id : undefined}>{label}</label>
      {synced ? (
        children(id)
      ) : (
        <p class="field__hint">
          <em>Not synced yet.</em> The app doesn’t receive the Logic Engine’s “{column}” column yet, so change it in the sheet for now.
        </p>
      )}
      {synced && hint && <p class="field__hint">{hint}</p>}
      {waiting && <Waiting to={waiting.to} />}
      {err && (
        <p id={`${id}-error`} class="field__error">
          {err}
        </p>
      )}
    </div>
  );
}

type SectionProps = {
  event: AdminEventForm;
  sheet: Record<string, string>;
  setCol: (c: string, v: string) => void;
  errors: Record<string, string>;
  /** The App Price as the form has it, for Price: “Same as the event price”; '' when there is none. */
  eventPrice: string;
};

/** Posting, Michelle's voice, Social facts and Contact: only the columns this tab has. */
function SheetSections({ event, sheet, setCol, errors, eventPrice }: SectionProps) {
  const has = (...cols: string[]) => cols.some(c => c in event.sheet);
  const text = (c: string) => (e: { currentTarget: { value: string } }) => setCol(c, e.currentTarget.value);
  const folder = folderId(sheet['Photo Folder ID'] ?? '');
  return (
    <>
      {has('Post Frequency (Days)', 'Target Post Time', 'Photo Folder ID', 'App Capacity') && (
        <>
          <h2 id="ev-posting">Posting</h2>
          <div class="field-row field-row--even">
            <SheetField event={event} column="Post Frequency (Days)" label="Post every (days)" hint="0 to 60." errors={errors}>
              {id => (
                <input id={id} class="input" type="number" inputMode="numeric" min={0} max={60} step={1} value={sheet['Post Frequency (Days)']} onInput={text('Post Frequency (Days)')} />
              )}
            </SheetField>
            <SheetField event={event} column="Target Post Time" label="Post at" errors={errors}>
              {id => <input id={id} class="input" type="time" value={sheet['Target Post Time']} onInput={text('Target Post Time')} />}
            </SheetField>
          </div>
          <SheetField event={event} column="Photo Folder ID" label="Photo folder" hint="The Google Drive folder’s ID, or paste its link." errors={errors}>
            {id => (
              <div class="stack" style={{ '--gap': '6px' }}>
                <input id={id} class="input" value={sheet['Photo Folder ID']} spellcheck={false} onInput={text('Photo Folder ID')} />
                {/^[A-Za-z0-9_-]{10,}$/.test(folder) && (
                  <a class="btn btn--text btn--sm" href={`https://drive.google.com/drive/folders/${folder}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={16} aria-hidden="true" /> Open the folder
                  </a>
                )}
              </div>
            )}
          </SheetField>
          <SheetField
            event={event}
            column="App Capacity"
            label="Default places (sheet)"
            hint="The Logic Engine’s App Capacity. When the change reaches the app it replaces Places for this event (app)."
            errors={errors}
          >
            {id => <input id={id} class="input" type="number" inputMode="numeric" min={1} max={1000} step={1} placeholder="None" value={sheet['App Capacity']} onInput={text('App Capacity')} />}
          </SheetField>
        </>
      )}

      {has(STANDARD_PROMPT, KPI_PROMPT, TIKTOK) && (
        <>
          <h2 id="ev-voice">Michelle’s voice</h2>
          {[
            [STANDARD_PROMPT, 'Standard prompt'],
            [KPI_PROMPT, 'KPI hook prompt', 'Used when the event’s Facebook views are low.'],
            [TIKTOK, 'TikTok video blueprint'],
          ].map(([c, label, hint]) => (
            <SheetField key={c} event={event} column={c!} label={label!} hint={hint} errors={errors}>
              {id => <textarea id={id} class="input event-editor__prompt" rows={10} maxLength={PROMPT_MAX} value={sheet[c!]} onInput={text(c!)} />}
            </SheetField>
          ))}
        </>
      )}

      {has('Approved Facts', 'People & Roles', 'Banned Phrases') && (
        <>
          <h2 id="social-facts">Social facts</h2>
          <SheetField event={event} column="Approved Facts" label="Approved facts" errors={errors}>
            {id => <FactsEditor id={id} value={sheet['Approved Facts'] ?? ''} eventPrice={eventPrice} onChange={v => setCol('Approved Facts', v)} />}
          </SheetField>
          <SheetField event={event} column="People & Roles" label="People & roles" errors={errors}>
            {id => <PeopleEditor id={id} value={sheet['People & Roles'] ?? ''} onChange={v => setCol('People & Roles', v)} />}
          </SheetField>
          <SheetField event={event} column="Banned Phrases" label="Banned phrases" hint="Separated by commas. Posts never use them." errors={errors}>
            {id => <textarea id={id} class="input" rows={2} maxLength={LONG_MAX} value={sheet['Banned Phrases']} onInput={text('Banned Phrases')} />}
          </SheetField>
        </>
      )}

      {has('Organiser Email') && (
        <>
          <h2 id="ev-contact">Contact</h2>
          <SheetField event={event} column="Organiser Email" label="Organiser email" errors={errors}>
            {id => <input id={id} class="input" type="email" autoComplete="off" value={sheet['Organiser Email']} onInput={text('Organiser Email')} />}
          </SheetField>
        </>
      )}
    </>
  );
}

/** Approved Facts as Key + value rows, saved as `Key: value` lines. Text that won't make rows stays a textarea. */
function FactsEditor({ id, value, onChange, eventPrice }: { id: string; value: string; onChange: (v: string) => void; eventPrice: string }) {
  const [parsed] = useState(() => factRows(value));
  const [rows, setRows] = useState<FactRow[]>(() => ('rows' in parsed ? parsed.rows.map(r => factRow(r.key, r.value, eventPrice)) : []));
  if ('why' in parsed)
    return (
      <>
        <textarea id={id} class="input" rows={6} maxLength={LONG_MAX} value={value} onInput={e => onChange(e.currentTarget.value)} />
        <p class="field__hint">
          Shown as written, because {parsed.why} One fact per line, like “Booking: essential”, with a key from: {FACT_KEYS.join(', ')}.
        </p>
      </>
    );
  const update = (next: FactRow[]) => {
    setRows(next);
    onChange(next.filter(r => r.value.trim()).map(r => `${r.key}: ${r.value.trim()}`).join('\n'));
  };
  const change = (i: number, patch: Partial<FactRow>) => update(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  // “Same as the event price” follows the App Price when the admin changes it here; nothing is rewritten before that.
  const shownPrice = useRef(eventPrice);
  useEffect(() => {
    if (shownPrice.current === eventPrice) return;
    shownPrice.current = eventPrice;
    if (eventPrice.trim() && rows.some(r => r.choice === EVENT_PRICE)) update(rows.map(r => (r.choice === EVENT_PRICE ? { ...r, value: eventPrice.trim() } : r)));
  }, [eventPrice]);
  return (
    <div class="stack event-editor__rows" style={{ '--gap': '8px' }} id={id} role="group">
      {!rows.length && <p class="meta">None yet.</p>}
      {rows.map((r, i) => (
        <div class="event-editor__row" key={i}>
          <select class="input" aria-label={`Fact ${i + 1} key`} value={r.key} onChange={e => change(i, factRow(e.currentTarget.value, r.value, eventPrice))}>
            {FACT_KEYS.map(k => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <FactValue row={r} n={i + 1} eventPrice={eventPrice} onChange={patch => change(i, patch)} />
          <button type="button" class="btn btn--text btn--sm" aria-label={`Remove fact ${i + 1}`} onClick={() => update(rows.filter((_, j) => j !== i))}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
      <div>
        <button type="button" class="btn btn--secondary btn--sm" onClick={() => setRows([...rows, factRow('Booking', '', eventPrice)])}>
          <Plus size={16} aria-hidden="true" /> Add a fact
        </button>
      </div>
    </div>
  );
}

const LINK = '__link';
const RANGE = '__range';
const EVENT_PRICE = '__event_price';
const OTHER = '__other';

/** A fact row as the editor holds it: the saved value as written, and which choice shows it. */
function factRow(key: string, value: string, eventPrice: string): FactRow {
  const c = presetChoice(key, value, eventPrice);
  if (c.kind === 'preset') return { key, value, choice: value.trim() ? c.value : '' };
  if (c.kind === 'link') return { key, value, choice: LINK, url: c.url };
  if (c.kind === 'range') return { key, value, choice: RANGE, from: c.from, to: c.to };
  if (c.kind === 'event_price') return { key, value, choice: EVENT_PRICE };
  // A new row of a key with presets starts unchosen; anything written is Other, as written.
  return { key, value, choice: hasPresets(key) && !value.trim() ? '' : OTHER };
}

/** The value of a fact: the key's presets with Other (free text) last, or free text for the keys without presets. */
function FactValue({ row, n, eventPrice, onChange }: { row: FactRow; n: number; eventPrice: string; onChange: (patch: Partial<FactRow>) => void }) {
  const label = `Fact ${n}`;
  const other = (
    <input class="input" aria-label={label} placeholder={hasPresets(row.key) ? 'Type your own' : ''} value={row.value} onInput={e => onChange({ value: e.currentTarget.value })} />
  );
  if (!hasPresets(row.key)) return other;
  const choose = (choice: string) => {
    if (choice === OTHER) return onChange({ choice });
    if (choice === LINK) return onChange({ choice, value: row.url?.trim() ? `${BOOKING_VIA}${row.url.trim()}` : '' });
    if (choice === RANGE) return onChange({ choice, value: row.from && row.to ? ageRange(row.from, row.to) : '' });
    if (choice === EVENT_PRICE) return onChange({ choice, value: eventPrice.trim() });
    onChange({ choice, value: choice });
  };
  const range = (from: string, to: string) => onChange({ from, to, value: from.trim() && to.trim() ? ageRange(from, to) : '' });
  return (
    <div class="stack" style={{ '--gap': '6px' }}>
      <select class="input" aria-label={label} value={row.choice} onChange={e => choose(e.currentTarget.value)}>
        {row.choice === '' && (
          <option value="" disabled>
            Choose…
          </option>
        )}
        {(row.key === 'Price' ? [] : FACT_PRESETS[row.key]).map(p => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        {row.key === 'Booking' && <option value={LINK}>Essential – book via link</option>}
        {row.key === 'Age' && <option value={RANGE}>Ages … to … years</option>}
        {row.key === 'Price' && (eventPrice.trim() || row.choice === EVENT_PRICE) && <option value={EVENT_PRICE}>Same as the event price ({eventPrice.trim() || row.value})</option>}
        {row.key === 'Price' && <option value={PRICE_FREE}>{PRICE_FREE}</option>}
        <option value={OTHER}>Other – type your own</option>
      </select>
      {row.choice === OTHER && other}
      {row.choice === LINK && (
        <input
          class="input"
          type="url"
          inputMode="url"
          aria-label={`${label} booking link`}
          placeholder="https://…"
          spellcheck={false}
          value={row.url ?? ''}
          onInput={e => {
            const url = e.currentTarget.value;
            onChange({ url, value: url.trim() ? `${BOOKING_VIA}${url.trim()}` : '' });
          }}
        />
      )}
      {row.choice === RANGE && (
        <div class="cluster" style={{ '--gap': '6px', flexWrap: 'nowrap' }}>
          <span>Ages</span>
          <input class="input" type="number" inputMode="numeric" min={0} max={99} aria-label={`${label} youngest age`} value={row.from ?? ''} onInput={e => range(e.currentTarget.value, row.to ?? '')} />
          <span>–</span>
          <input class="input" type="number" inputMode="numeric" min={0} max={99} aria-label={`${label} oldest age`} value={row.to ?? ''} onInput={e => range(row.from ?? '', e.currentTarget.value)} />
          <span>years</span>
        </div>
      )}
    </div>
  );
}

/** People & Roles as Name + Role rows, saved as `Name - role` lines. Text that won't make rows stays a textarea. */
function PeopleEditor({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [parsed] = useState(() => personRows(value));
  const [rows, setRows] = useState<PersonRow[]>(() => ('rows' in parsed ? parsed.rows.map(r => ({ ...r, other: !rolePreset(r.role) })) : []));
  const hint = `Pick a role, or type your own with a role word the post checks know: ${ROLE_WORDS}.`;
  if ('why' in parsed)
    return (
      <>
        <textarea id={id} class="input" rows={4} maxLength={LONG_MAX} value={value} onInput={e => onChange(e.currentTarget.value)} />
        <p class="field__hint">
          Shown as written, because {parsed.why} One person per line, like “Trixie - host”. Use a role word the post checks know: {ROLE_WORDS}.
        </p>
      </>
    );
  const update = (next: PersonRow[]) => {
    setRows(next);
    onChange(next.filter(r => r.name.trim() || r.role.trim()).map(r => `${r.name.trim()} - ${r.role.trim()}`).join('\n'));
  };
  const change = (i: number, patch: Partial<PersonRow>) => update(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div class="stack event-editor__rows" style={{ '--gap': '8px' }} id={id} role="group">
      {!rows.length && <p class="meta">None yet.</p>}
      {rows.map((r, i) => (
        <div key={i} class="stack" style={{ '--gap': '4px' }}>
          <div class="event-editor__row">
            <input class="input" aria-label={`Person ${i + 1} name`} placeholder="Name" value={r.name} onInput={e => change(i, { name: e.currentTarget.value })} />
            <div class="stack" style={{ '--gap': '6px' }}>
              <select
                class="input"
                aria-label={`Person ${i + 1} role`}
                value={r.other ? OTHER : (rolePreset(r.role) ?? '')}
                onChange={e => {
                  const v = e.currentTarget.value;
                  change(i, v === OTHER ? { other: true } : { other: false, role: v });
                }}
              >
                {!r.other && !rolePreset(r.role) && (
                  <option value="" disabled>
                    Choose a role…
                  </option>
                )}
                {ROLE_PRESETS.map(p => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option value={OTHER}>Other – type your own</option>
              </select>
              {r.other && (
                <input class="input" aria-label={`Person ${i + 1} role, your own`} placeholder="Role, e.g. sets up" value={r.role} onInput={e => change(i, { role: e.currentTarget.value })} />
              )}
            </div>
            <button type="button" class="btn btn--text btn--sm" aria-label={`Remove person ${i + 1}`} onClick={() => update(rows.filter((_, j) => j !== i))}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </div>
          {r.other && r.role.trim() !== '' && !HAS_ROLE.test(r.role) && (
            <p class="field__hint field__hint--warning" role="status">
              “{r.role}” has no role word the post checks know, so it can’t be saved. Use one of: {ROLE_WORDS}.
            </p>
          )}
        </div>
      ))}
      <div>
        <button type="button" class="btn btn--secondary btn--sm" onClick={() => setRows([...rows, { name: '', role: '', other: false }])}>
          <Plus size={16} aria-hidden="true" /> Add a person
        </button>
      </div>
      <p class="field__hint">{hint}</p>
    </div>
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
    toast(res.data.change ? 'Starting it again. The host has been emailed.' : 'Sent to the Logic Engine. It’s back in the app usually within a minute (10 minutes at most).');
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
