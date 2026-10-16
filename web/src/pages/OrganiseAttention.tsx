// Needs attention in the organiser (docs/RTD_EVENT_CONTROL_AUDIT.md G-2, Stage 3b), for
// approvers and admins: events whose date has passed with nothing after it, and events
// with no usable date in the Logic Engine. Each one stays until someone sets a new date,
// archives it, or closes it; looking at it never does. Admins switch it on and off, and
// choose who gets the emails (Stage 3c): a notice when a date passes, and a reminder
// every morning until it's sorted. Stage 4b adds booked dates the Logic Engine moved
// (nobody booked is told until someone chooses), and emails to customers that didn't go.

import { CalendarClock, CalendarPlus, Check, Mail, MailWarning, TriangleAlert } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { addDays, daysBetween, formatTime, shortDate, todayLondon } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { toast } from '../lib/toast';

type Action = 'renew' | 'archive' | 'complete' | 'dismiss' | 'tell' | 'cancel';

interface Item {
  item_id: number;
  ref: string;
  kind: 'expired' | 'no_date' | 'moved' | 'undelivered';
  name: string;
  source: 'event_index' | 'standard_diary' | 'app';
  frequency: string;
  date: string | null;
  start_time: string | null;
  detail: string | null;
  detail_kind: 'blank' | 'text' | 'past' | null;
  resolution: 'renewed' | 'archived' | 'completed' | 'dismissed' | 'notified' | 'cancelled' | 'sent' | null;
  renew_date: string | null;
  renew_waiting: boolean;
  resolved_by: string | null;
  resolution_note: string | null;
  opened_at: string;
  resolved_at: string | null;
  actions: Action[];
  sheet: 'auto' | 'manual';
  inactive: boolean;
  occurrence_id: string | null;
  moved: { new_occurrence_id: string | null; new_date: string | null; new_start_time: string | null; can_tell: boolean; bookings: number; people: number } | null;
  undelivered: {
    message_id: number | null;
    subject: string | null;
    attempts: number;
    last_error: string | null;
    next_attempt_at: string | null;
    given_up: boolean;
    contact: { name: string; email: string | null; mobile: string | null } | null;
  } | null;
}

type Delivery = 'queued' | 'sent' | 'stuck' | 'failing' | 'failed' | null;

interface Emails {
  on: boolean;
  to: string[];
  digest: { queued_at: string; state: Delivery } | null;
  test: { queued_at: string; state: Delivery } | null;
  items: Record<string, { first_notified_at: string | null; notice: Delivery; reminder_count: number; last_reminded_at: string | null }>;
}

type Overview =
  | { enabled: false }
  | { enabled: true; blocked: number; open: Item[]; resolved: Item[]; no_end_time: { event_id: string; name: string; date: string }[]; emails: Emails };

const FREQUENCY: Record<string, string> = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', 'one-off': 'One-off' };
const RESOLVED: Record<string, string> = {
  renewed: 'New date',
  archived: 'Archived',
  completed: 'Finished, no new date',
  dismissed: 'Left as it is',
  notified: 'Told it has moved',
  cancelled: 'Bookings cancelled',
  sent: 'Went on a later try',
};
const DONE: Record<Action, (name: string) => string> = {
  renew: name => `${name}: new date saved.`,
  archive: name => `${name}: archived.`,
  complete: name => `${name}: marked finished.`,
  dismiss: name => `${name}: left as it is. It comes back here if its date changes.`,
  tell: name => `${name}: everyone booked is being told it has moved.`,
  cancel: name => `${name}: bookings cancelled, and everyone booked is being told.`,
};
const places = (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`;
const bookings = (n: number) => `${n} ${n === 1 ? 'booking' : 'bookings'}`;

const londonDay = (iso: string) => todayLondon(new Date(iso));
const by = (who: string | null) => (who === 'sheet' ? 'the Logic Engine' : who === 'system' ? 'the app' : (who ?? ''));

/** "sent" only ever means Gmail accepted it: there's no proof it was delivered or read. */
const DELIVERY: Record<'queued' | 'sent' | 'stuck' | 'failing' | 'failed', string> = {
  queued: 'queued, going out within 5 minutes',
  sent: 'sent (Gmail accepted it)',
  stuck: "not sent yet after 30 minutes: check RTD Outbox in n8n",
  failing: "Gmail refused it; it's tried again by itself",
  failed: "couldn't be sent: see Delivery",
};

/** How an item's emails have gone, in a line. */
function emailLine(i: Item, emails: Emails): string | null {
  if (i.kind === 'no_date' || !emails.on) return null;
  const e = emails.items[i.item_id];
  const parts: string[] = [];
  if (e?.notice) parts.push(`Notice ${DELIVERY[e.notice]}`);
  else if (e?.first_notified_at) parts.push('In the morning reminder');
  else parts.push('Notice goes out within the hour');
  if (e && e.reminder_count > 0) parts.push(`reminded ${e.reminder_count === 1 ? 'once' : `${e.reminder_count} times`}, last ${shortDate(londonDay(e.last_reminded_at!))}`);
  return parts.join(' · ');
}

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
        Events whose date has passed with nothing after it, events with no usable date in the Logic Engine, booked dates the Logic Engine moved, and
        emails to customers that didn't go. Each one stays here until someone decides.
      </p>
      {isAdmin ? (
        <EmailSettings emails={data.emails} onChanged={load} />
      ) : (
        data.emails.on && <p class="meta" style={{ marginBottom: '12px' }}>Reminders are emailed to {data.emails.to.join(' and ')}.</p>
      )}
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
        {data.open.map(i =>
          i.kind === 'moved' ? (
            <MovedCard key={i.item_id} item={i} email={emailLine(i, data.emails)} onDone={load} />
          ) : i.kind === 'undelivered' ? (
            <UndeliveredCard key={i.item_id} item={i} onDone={load} />
          ) : (
            <AttentionCard key={i.item_id} item={i} email={emailLine(i, data.emails)} onDone={load} />
          ),
        )}
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

/** Admins: who gets the emails, on or off, and a test. */
function EmailSettings({ emails, onChanged }: { emails: Emails; onChanged: () => void }) {
  const [to, setTo] = useState(emails.to.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (body: { to?: string; on?: boolean }, done: string) => {
    setBusy(true);
    setError(null);
    const res = await hostApi<{ on: boolean; to: string[] }>('/api/staff/attention/emails', body);
    setBusy(false);
    if (!res.ok) return setError(res.errors?.to ?? res.error);
    toast(done);
    onChanged();
  };
  const test = async () => {
    setBusy(true);
    const res = await hostApi<{ to: string[] }>('/api/staff/attention/emails/test', {});
    setBusy(false);
    toast(res.ok ? `Test queued for ${res.data.to.join(' and ')}. It goes out within 5 minutes.` : res.error);
    onChanged();
  };
  const changed = to.trim() !== emails.to.join(', ');
  return (
    <div class="card card--pad stack" style={{ '--gap': '8px', marginBottom: '16px' }}>
      <h3 class="cluster" style={{ '--gap': '8px' }}>
        <Mail size={18} aria-hidden="true" /> Email reminders {emails.on ? <Chip kind="live">On</Chip> : <Chip kind="draft">Off</Chip>}
      </h3>
      <p class="meta">
        A notice when a date passes with nothing after it, then a reminder every morning at about 9am listing everything still waiting, until it's sorted.
        Opening an email doesn't sort anything.
      </p>
      <div class={`field${error ? ' field--error' : ''}`}>
        <label class="label" for="att-email-to">
          Send them to
        </label>
        <p id="att-email-to-hint" class="field__hint">
          Up to 5 addresses, separated by commas.
        </p>
        <input id="att-email-to" class="input" type="text" inputMode="email" autoComplete="off" value={to} aria-describedby="att-email-to-hint"
          aria-invalid={!!error} onInput={e => setTo(e.currentTarget.value)} />
        {error && (
          <p class="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div class="cluster">
        {changed && (
          <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => save({ to }, 'Addresses saved.')}>
            Save addresses
          </button>
        )}
        {emails.on ? (
          <button type="button" class="btn btn--secondary btn--sm" disabled={busy} onClick={() => save({ on: false }, 'Email reminders are off.')}>
            Switch off
          </button>
        ) : (
          <button type="button" class="btn btn--primary btn--sm" disabled={busy || changed || !emails.to.length}
            onClick={() => save({ on: true }, 'Email reminders are on.')}>
            Switch on
          </button>
        )}
        {emails.to.length > 0 && (
          <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={test}>
            Send a test
          </button>
        )}
      </div>
      {(emails.digest || emails.test) && (
        <p class="meta">
          {[
            emails.digest && `Latest morning reminder: ${shortDate(londonDay(emails.digest.queued_at))}, ${DELIVERY[emails.digest.state ?? 'queued']}`,
            emails.test && `Latest test: ${DELIVERY[emails.test.state ?? 'queued']}`,
          ]
            .filter(Boolean)
            .join('. ')}
        </p>
      )}
    </div>
  );
}

function AttentionCard({ item, email, onDone }: { item: Item; email: string | null; onDone: () => void }) {
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
        {email && (
          <p class="meta cluster" style={{ '--gap': '6px' }}>
            <Mail size={14} aria-hidden="true" /> <span>{email}</span>
          </p>
        )}
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

/** Resolves one item, and says how it went. */
function useResolve(item: Item, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: Action, note?: string) => {
    setBusy(true);
    setError(null);
    const res = await hostApi<{ item: Item }>(`/api/staff/attention/${item.item_id}/resolve`, { action, ...(note?.trim() ? { note: note.trim() } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.errors?.note ?? res.error);
      if (res.status === 409) onDone();
      return;
    }
    toast(DONE[action](item.name));
    onDone();
  };
  return { busy, error, act };
}

/** A booked date the Logic Engine moved (G-4): nobody booked is told until someone chooses. Bookings are never moved. */
function MovedCard({ item, email, onDone }: { item: Item; email: string | null; onDone: () => void }) {
  const m = item.moved!;
  const [mode, setMode] = useState<'tell' | 'cancel' | null>(null);
  const [note, setNote] = useState('');
  const { busy, error, act } = useResolve(item, onDone);
  const id = `att-${item.item_id}`;
  const when = (date: string | null, time: string | null) => (date ? `${shortDate(date)}${time ? ` (${formatTime(time)})` : ''}` : '');
  return (
    <article class="card review-card">
      <div class="stack" style={{ '--gap': '6px' }}>
        <div class="cluster" style={{ '--gap': '8px' }}>
          <h3>{item.name}</h3>
          <Chip kind="awaiting">
            <CalendarClock aria-hidden="true" /> Moved, with bookings
          </Chip>
        </div>
        <p>
          {when(item.date, item.start_time)} has moved in the Logic Engine{m.new_date ? ` to ${when(m.new_date, m.new_start_time)}` : ''}.{' '}
          {bookings(m.bookings)} ({places(m.people)}) {m.bookings === 1 ? 'was' : 'were'} for the old date, and nobody has told them yet.
        </p>
        <p class="meta">{[`waiting ${waiting(item.opened_at)}`, item.ref].join(' · ')}</p>
        {email && (
          <p class="meta cluster" style={{ '--gap': '6px' }}>
            <Mail size={14} aria-hidden="true" /> <span>{email}</span>
          </p>
        )}
        <p class="meta">If the move was a mistake, put the date back in the sheet: this clears itself and the bookings stand.</p>
      </div>
      {mode ? (
        <div class="stack" style={{ '--gap': '8px' }}>
          <p class="meta">
            {mode === 'tell'
              ? `Their bookings for ${shortDate(item.date!)} are cancelled, and each person is emailed (and notified, if they asked) that it has moved to ${shortDate(m.new_date!)}, with a link to book it.`
              : 'Their bookings are cancelled, and each person is emailed (and notified, if they asked) that it is cancelled.'}
          </p>
          <div class="field">
            <label class="label" for={`${id}-note`}>
              A message to them (optional)
            </label>
            <input id={`${id}-note`} class="input" maxLength={300} value={note} onInput={e => setNote(e.currentTarget.value)} />
          </div>
          {error && (
            <p class="field__error" role="alert">
              {error}
            </p>
          )}
          <div class="cluster">
            <button type="button" class={`btn btn--sm ${mode === 'tell' ? 'btn--primary' : 'btn--destructive'}`} disabled={busy} onClick={() => act(mode, note)}>
              {busy ? 'Sending...' : mode === 'tell' ? `Tell ${m.bookings === 1 ? 'them' : `all ${m.bookings}`}` : 'Cancel their bookings'}
            </button>
            <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => setMode(null)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <div class="cluster">
          {item.actions.includes('tell') && (
            <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => setMode('tell')}>
              Tell them it has moved
            </button>
          )}
          {item.actions.includes('cancel') && (
            <button type="button" class="btn btn--destructive-quiet btn--sm" disabled={busy} onClick={() => setMode('cancel')}>
              Cancel their bookings
            </button>
          )}
          <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => act('dismiss')}>
            Leave it
          </button>
        </div>
      )}
    </article>
  );
}

/** An email to a customer about their booking that didn't go. It's tried again by itself; this says who to reach. */
function UndeliveredCard({ item, onDone }: { item: Item; onDone: () => void }) {
  const u = item.undelivered!;
  const { busy, error, act } = useResolve(item, onDone);
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    const res = await hostApi(`/api/staff/outbox/${u.message_id}/retry`, {});
    setRetrying(false);
    toast(res.ok ? 'Trying again within 5 minutes.' : res.error);
    onDone();
  };
  return (
    <article class="card review-card">
      <div class="stack" style={{ '--gap': '6px' }}>
        <div class="cluster" style={{ '--gap': '8px' }}>
          <h3>{item.name}</h3>
          <Chip kind="cancelled">
            <MailWarning aria-hidden="true" /> Email not sent
          </Chip>
        </div>
        <p>
          "{u.subject}" couldn't be sent{u.contact ? ` to ${u.contact.name}` : ''}
          {item.date ? `, booked on ${shortDate(item.date)}` : ''}.
        </p>
        <p class="meta">
          {u.given_up
            ? `Given up after ${u.attempts} tries.`
            : `Tried ${u.attempts === 1 ? 'once' : `${u.attempts} times`}; it's tried again by itself${u.next_attempt_at ? ` at ${formatTime(new Date(u.next_attempt_at).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }))}` : ''}.`}
          {u.last_error ? ` Gmail said: ${u.last_error}` : ''}
        </p>
        {u.contact && (
          <p class="meta">
            To reach them another way: {[u.contact.email, u.contact.mobile].filter(Boolean).join(' · ')}
          </p>
        )}
        <p class="meta">{item.ref}</p>
      </div>
      {error && (
        <p class="field__error" role="alert">
          {error}
        </p>
      )}
      <div class="cluster">
        {u.given_up && u.message_id && (
          <button type="button" class="btn btn--secondary btn--sm" disabled={retrying} onClick={retry}>
            Try again now
          </button>
        )}
        <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={() => act('dismiss')}>
          Sorted another way
        </button>
      </div>
    </article>
  );
}
