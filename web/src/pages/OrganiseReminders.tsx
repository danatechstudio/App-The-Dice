// Event reminders in the organiser, for admins (docs/RTD_ALERTS.md): a push
// notification about one event to every device with event alerts on, and the
// same words (with the event's photo) on the café's Facebook page. A second one
// about the same event within 24 hours needs confirming.

import { BellRing, Megaphone, Send, TriangleAlert, X } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader } from '../components/States';
import { shortDate, timeRange } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { toast } from '../lib/toast';

interface ReminderEvent {
  occurrence_id: string;
  event_id: string;
  name: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  bookable: boolean;
  suggested: { title: string; body: string };
  last_sent_at: string | null;
}

interface SentReminder {
  send_id: number;
  kind: 'manual' | 'auto';
  event_id: string;
  occurrence_id: string;
  title: string;
  body: string;
  sent_by: string;
  devices: number;
  delivered: number;
  failed: number;
  /** Taps on it (docs/RTD_STATS.md). */
  opened: number;
  social: 'pending' | 'posted' | 'failed' | null;
  social_error: string | null;
  created_at: string;
}

interface Overview {
  devices: number;
  last_auto_at: string | null;
  recent: SentReminder[];
  events: ReminderEvent[];
}

interface Warning {
  kind: 'manual' | 'auto';
  title: string;
  sent_by: string;
  created_at: string;
}

const TITLE_MAX = 60;
const BODY_MAX = 180;
const DAY_MS = 24 * 3_600_000;

/** "just now", "40 minutes ago", "5 hours ago", or the date and time. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Europe/London' });
}

const devicesLabel = (n: number) => `${n} ${n === 1 ? 'device' : 'devices'}`;

export function RemindersAdmin() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState<ReminderEvent | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<Overview>('/api/staff/reminders');
    if (res.ok) setData(res.data);
    else setError(res.error);
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <section class="section" aria-labelledby="reminders-admin">
      <div class="section-head">
        <h2 id="reminders-admin">Event reminders</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Send a reminder about an event to everyone with event alerts on
        {data ? ` (${devicesLabel(data.devices)} now)` : ''}. It goes on the café's Facebook page too, unless you say not to. The app also sends one
        itself at 8pm, about a random event in the next three days, at most every 48 hours
        {data?.last_auto_at ? ` (last: ${ago(data.last_auto_at)})` : ''}.
      </p>
      {error && !data && <p class="meta">{error}</p>}
      {!data && !error && <DiceLoader label="Loading events..." />}
      {composing && (
        <ReminderForm
          key={composing.occurrence_id}
          event={composing}
          devices={data?.devices ?? 0}
          onDone={sent => {
            setComposing(null);
            if (sent) void load();
          }}
        />
      )}
      {data && !data.events.length && <p class="meta">No public events in the next two weeks.</p>}
      {data && data.events.length > 0 && (
        <div class="table-wrap">
          <table class="table table--stack reminder-events">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Next date</th>
                <th scope="col">Last reminder</th>
                <th scope="col"><span class="visually-hidden">Send</span></th>
              </tr>
            </thead>
            <tbody>
              {data.events.map(e => {
                const recent = !!e.last_sent_at && Date.now() - Date.parse(e.last_sent_at) < DAY_MS;
                return (
                  <tr key={e.occurrence_id}>
                    <td data-label="Event"><strong>{e.name}</strong></td>
                    <td data-label="Next date">
                      {shortDate(e.date)}
                      {e.start_time ? `, ${timeRange(e.start_time, e.end_time)}` : ''}
                    </td>
                    <td data-label="Last reminder">
                      {e.last_sent_at ? (recent ? <Chip kind="awaiting">{ago(e.last_sent_at)}</Chip> : ago(e.last_sent_at)) : <span class="meta">None yet</span>}
                    </td>
                    <td class="table__action">
                      <button type="button" class="btn btn--secondary btn--sm" onClick={() => setComposing(e)} disabled={composing?.occurrence_id === e.occurrence_id}>
                        <BellRing size={16} aria-hidden="true" /> Remind
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.recent.length > 0 && <RecentReminders recent={data.recent} />}
    </section>
  );
}

function ReminderForm({ event, devices, onDone }: { event: ReminderEvent; devices: number; onDone: (sent: boolean) => void }) {
  const [title, setTitle] = useState(event.suggested.title.slice(0, TITLE_MAX));
  const [body, setBody] = useState(event.suggested.body.slice(0, BODY_MAX));
  const [social, setSocial] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warning, setWarning] = useState<Warning | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (confirm: boolean) => {
    setBusy(true);
    const res = await hostApi<{ send: { devices: number; social: boolean } }>('/api/staff/reminders', {
      occurrence_id: event.occurrence_id,
      title,
      body,
      social,
      confirm,
    });
    setBusy(false);
    if (res.ok) {
      const where = res.data.send.social ? ' and the Facebook page' : '';
      toast(res.data.send.devices ? `Reminder on its way to ${devicesLabel(res.data.send.devices)}${where}.` : `Saved. No devices have alerts on yet${where ? `; it's going to the Facebook page` : ''}.`);
      onDone(true);
    } else if (res.kind === 'invalid') setErrors(res.errors ?? {});
    else if (res.status === 409 && (res.body as { warning?: Warning }).warning) setWarning((res.body as { warning: Warning }).warning);
    else toast(res.error);
  };

  const submit = (e: Event) => {
    e.preventDefault();
    const missing: Record<string, string> = {};
    if (title.trim().length < 3) missing.title = 'Give it a title of at least 3 characters.';
    if (body.trim().length < 5) missing.body = 'Write a message of at least 5 characters.';
    setErrors(missing);
    if (!Object.keys(missing).length) void send(false);
  };

  return (
    <section class="card card--pad reminder-form" aria-labelledby="reminder-form-title">
      <div class="section-head" style={{ marginBottom: 0 }}>
        <h3 id="reminder-form-title">Remind everyone about {event.name}</h3>
        <button type="button" class="btn btn--icon btn--text" onClick={() => onDone(false)} aria-label="Close the form">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <form class="stack" style={{ '--gap': '18px' }} onSubmit={submit} noValidate>
        <div class={`field${errors.title ? ' field--error' : ''}`}>
          <label for="r-title">Title</label>
          <input id="r-title" class="input" value={title} maxLength={TITLE_MAX} aria-invalid={!!errors.title}
            aria-describedby={`r-title-count${errors.title ? ' r-title-error' : ''}`} onInput={e => setTitle(e.currentTarget.value)} />
          <p id="r-title-count" class="field__hint">{title.length} of {TITLE_MAX}</p>
          {errors.title && <p id="r-title-error" class="field__error">{errors.title}</p>}
        </div>
        <div class={`field${errors.body ? ' field--error' : ''}`}>
          <label for="r-body">Message</label>
          <textarea id="r-body" class="input" rows={3} maxLength={BODY_MAX} value={body} aria-invalid={!!errors.body}
            aria-describedby={`r-body-count${errors.body ? ' r-body-error' : ''}`} onInput={e => setBody(e.currentTarget.value)} />
          <p id="r-body-count" class="field__hint">
            {body.length} of {BODY_MAX}. Tapping the notification opens the event in the app.
          </p>
          {errors.body && <p id="r-body-error" class="field__error">{errors.body}</p>}
        </div>
        <fieldset class="field">
          <legend>Post on Facebook too?</legend>
          <div class="segmented segmented--inline" role="group" aria-label="Post on Facebook too">
            <button type="button" aria-pressed={social} onClick={() => setSocial(true)}>Yes</button>
            <button type="button" aria-pressed={!social} onClick={() => setSocial(false)}>No</button>
          </div>
          <p class="field__hint">The same title and message, a link to the event in the app, and the event's photo if it has one.</p>
        </fieldset>

        <div class="stack" style={{ '--gap': '8px' }}>
          <p class="label">Preview</p>
          <div class="notification-preview" aria-label="How the notification looks">
            <img src="/icons/icon-192.png" width={36} height={36} alt="" />
            <div>
              <strong>{title.trim() || 'Title'}</strong>
              <p>{body.trim() || 'Message'}</p>
            </div>
          </div>
          <p class="meta">
            Goes to {devicesLabel(devices)}
            {social ? ' and the Facebook page' : ''}. Phones that are off get it when they're back on, for up to 12 hours.
          </p>
        </div>

        {warning ? (
          <div class="notice notice--warning" role="alert">
            <TriangleAlert size={22} aria-hidden="true" />
            <div class="stack" style={{ '--gap': '10px' }}>
              <div>
                <strong>A reminder about this event went out {ago(warning.created_at)}.</strong>
                <p>
                  "{warning.title}", {warning.kind === 'auto' ? 'sent automatically' : `sent by ${warning.sent_by}`}. Sending another so soon may annoy people
                  and make them turn alerts off.
                </p>
              </div>
              <div class="cluster" style={{ '--gap': '8px' }}>
                <button type="button" class="btn btn--primary btn--sm" onClick={() => send(true)} disabled={busy}>
                  <Send size={16} aria-hidden="true" /> Send another anyway
                </button>
                <button type="button" class="btn btn--text btn--sm" onClick={() => onDone(false)} disabled={busy}>
                  Don't send
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div class="cluster" style={{ '--gap': '8px' }}>
            <button type="submit" class="btn btn--primary" disabled={busy}>
              <Send size={18} aria-hidden="true" /> {busy ? 'Sending...' : 'Send reminder'}
            </button>
            <button type="button" class="btn btn--text" onClick={() => onDone(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

function RecentReminders({ recent }: { recent: SentReminder[] }) {
  return (
    <details class="recent-reminders">
      <summary>Latest reminders</summary>
      <ul class="list" role="list">
        {recent.map(r => (
          <li key={r.send_id} class="card card--pad recent-reminder">
            <div class="cluster" style={{ justifyContent: 'space-between' }}>
              <strong>{r.title}</strong>
              <span class="meta">{ago(r.created_at)}</span>
            </div>
            <p class="meta">{r.body}</p>
            <p class="meta">
              {r.kind === 'auto' ? 'Automatic' : `By ${r.sent_by}`} · {r.delivered} of {devicesLabel(r.devices)} reached
              {r.failed > 0 ? `, ${r.failed} not` : ''}
              {r.delivered + r.failed < r.devices ? ' (still sending)' : ''}
              {r.opened > 0 ? ` · ${r.opened} tapped` : ''}
            </p>
            {r.social && (
              <p class="meta recent-reminder__social">
                <Megaphone size={14} aria-hidden="true" />
                {r.social === 'posted' ? 'Posted on Facebook' : r.social === 'pending' ? 'Posting on Facebook...' : `Facebook post failed: ${r.social_error ?? 'no reason given'}`}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
