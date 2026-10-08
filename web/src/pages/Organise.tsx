import { CalendarDays, Check, Clock, Info, Lock, LogOut, Minus, Plus, PoundSterling, Repeat, RotateCcw, Send, ShieldCheck, Trash2, UserMinus, UsersRound, X } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip, type ChipKind } from '../components/Chips';
import { DiceLoader, EmptyState } from '../components/States';
import { addDays, dayOfMonth, daysBetween, monthShort, shortDate, timeRange, todayLondon, weekday } from '../lib/dates';
import { SIGN_IN_URL, hostApi, type Access, type Frequency, type HostRecord, type HostSession, type HostUser, type SessionStatus } from '../lib/hostApi';
import { toast } from '../lib/toast';
import { HostedDatesPanel, SessionDates } from './OrganiseDates';
import { EventPlacesPanel, SessionPlaces } from './OrganisePlaces';
import { MarketApplicationsPanel, MarketsAdmin } from './OrganiseMarkets';
import type { StaffMarket } from '../lib/markets';
import { PushCard } from './OrganisePush';
import { RemindersAdmin } from './OrganiseReminders';
import { StatsAdmin } from './OrganiseStats';
import { ApproversPanel, JoinRequests, JoinScreen, removeAccess, setApprover } from './OrganiseTeam';
import { useTitle } from '../lib/title';

const STATUS: Record<SessionStatus, { chip: ChipKind; label: string; note: string }> = {
  submitted: { chip: 'awaiting', label: 'Awaiting approval', note: 'The café will review it soon.' },
  approved: { chip: 'approved', label: 'Approved', note: 'Approved. The café will add it to the diary.' },
  published: { chip: 'live', label: 'Live', note: 'In the diary and on the app.' },
  declined: { chip: 'draft', label: 'Not approved', note: '' },
  withdrawn: { chip: 'completed', label: 'Withdrawn', note: '' },
};

const ACTIVE: SessionStatus[] = ['submitted', 'approved', 'published'];

/** "12 Oct": for weekly sessions, where "Every Monday" already names the day. */
const dayMonth = (iso: string) => `${dayOfMonth(iso)} ${monthShort(iso)}`;

/** The date a session next runs: a weekly one moves on a week at a time. */
function nextDate(s: HostSession, today: string): string {
  if (s.frequency !== 'weekly' || s.event_date >= today || !ACTIVE.includes(s.status)) return s.event_date;
  return addDays(s.event_date, Math.ceil(daysBetween(s.event_date, today) / 7) * 7);
}

type SignedOut = { state: 'signed-out' | 'not-host' | 'error'; message: string; reason?: string };
type Gate = { state: 'loading' } | SignedOut | { state: 'ok'; user: HostUser; canReview: boolean; isAdmin: boolean };

/** /organise: the host organiser. Signing in goes through Cloudflare Access (SIGN_IN_URL). */
export function Organise() {
  useTitle('Host organiser');
  const [gate, setGate] = useState<Gate>({ state: 'loading' });
  const [sessions, setSessions] = useState<HostSession[] | null>(null);
  // The form: closed, a new session, or a declined / withdrawn one being sent again.
  const [form, setForm] = useState<null | 'new' | HostSession>(null);
  // Just back from signing in? Remember it (so a failure is explained, not
  // looped), then tidy the address bar.
  const [justSignedIn] = useState(() => new URLSearchParams(location.search).has('signed-in'));
  useEffect(() => {
    if (justSignedIn) history.replaceState(history.state, '', location.pathname);
  }, [justSignedIn]);

  const loadSessions = useCallback(async () => {
    const res = await hostApi<{ sessions: HostSession[] }>('/api/host/sessions');
    if (res.ok) setSessions(res.data.sessions);
  }, []);

  useEffect(() => {
    hostApi<{ user: HostUser; can_review: boolean; is_admin: boolean }>('/api/host/me').then(res => {
      if (res.ok) {
        setGate({ state: 'ok', user: res.data.user, canReview: res.data.can_review, isAdmin: res.data.is_admin });
        loadSessions();
      } else setGate({ state: res.kind === 'invalid' ? 'error' : res.kind, message: res.error, reason: res.reason });
    });
  }, [loadSessions]);

  useEffect(() => {
    if (sessions && !sessions.length) setForm('new');
  }, [sessions]);

  if (gate.state === 'loading') return <DiceLoader label="Opening the organiser..." />;
  // Signed in, but no access yet: onboarding (ask to host; café staff join the same way).
  if (gate.state === 'not-host') return <JoinScreen />;
  if (gate.state !== 'ok') return <Gatekeeper gate={gate} justSignedIn={justSignedIn} />;

  const today = todayLondon();
  const next = sortForHost(sessions ?? [], today).find(s => ACTIVE.includes(s.status) && nextDate(s, today) >= today);

  return (
    <div class="container organiser" data-surface="host">
      <header class="page-head organiser__head">
        <div>
          <p class="label">{gate.user.role === 'host' ? 'Host dashboard' : gate.user.role === 'admin' ? 'Admin' : 'Approver'}</p>
          <h1>Welcome back{gate.user.display_name ? `, ${gate.user.display_name}` : ''}</h1>
        </div>
        <a class="btn btn--text btn--sm" href="/cdn-cgi/access/logout">
          <LogOut size={16} aria-hidden="true" /> Sign out
        </a>
      </header>

      <div class="organiser__grid">
        <div class="stack" style={{ '--gap': '24px' }}>
          {next && (
            <section class="card host-dash__next" aria-labelledby="next-session">
              <p class="label">Next session</p>
              <h2 id="next-session" class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>
                {next.name}
              </h2>
              <SessionFacts s={next} />
              <div>
                <Chip kind={STATUS[next.status].chip}>{STATUS[next.status].label}</Chip>
              </div>
            </section>
          )}

          <section aria-labelledby="your-sessions">
            <div class="section-head">
              <h2 id="your-sessions">Your sessions</h2>
              {!form && (
                <button type="button" class="btn btn--primary btn--sm" onClick={() => setForm('new')}>
                  <Plus size={16} aria-hidden="true" /> Create session
                </button>
              )}
            </div>
            {sessions === null && <DiceLoader label="Loading your sessions..." />}
            {sessions && !sessions.length && <EmptyState title="No sessions yet." text="Create your first one and the café will take a look." />}
            <div class="list">
              {sessions && sortForHost(sessions, today).map(s => (
                <SessionCard key={s.session_id} s={s} onChange={loadSessions} onSendAgain={() => setForm(s)} />
              ))}
            </div>
          </section>
        </div>

        {form && (
          <SessionForm
            key={form === 'new' ? 'new' : form.session_id}
            again={form === 'new' ? undefined : form}
            onDone={created => {
              setForm(null);
              if (created) loadSessions();
            }}
          />
        )}
      </div>

      {gate.canReview && <StaffDesk onDecided={loadSessions} me={gate.user} isAdmin={gate.isAdmin} />}
    </div>
  );
}

/** Soonest upcoming first (weekly ones by their next week), then past sessions, most recent first. */
function sortForHost(list: HostSession[], today: string): HostSession[] {
  const key = (s: HostSession) => nextDate(s, today) + s.start_time;
  const upcoming = list.filter(s => nextDate(s, today) >= today).sort((a, b) => key(a).localeCompare(key(b)));
  const past = list.filter(s => nextDate(s, today) < today).sort((a, b) => key(b).localeCompare(key(a)));
  return [...upcoming, ...past];
}

function Gatekeeper({ gate, justSignedIn }: { gate: SignedOut; justSignedIn: boolean }) {
  if (gate.state === 'signed-out') {
    // Straight back from signing in yet still signed out: say so rather than
    // send them round the same loop.
    const stuck = justSignedIn;
    return (
      <div class="container" data-surface="host">
        <EmptyState
          title={stuck ? "We couldn't finish signing you in." : 'Please sign in to the organiser.'}
          text={
            stuck
              ? `Your sign-in didn't reach the organiser. Try once more; if it happens again, tell the café team it said "${gate.reason ?? 'no reason'}".`
              : 'The organiser is for Roll The Dice hosts. Sign in with the email the café has on file, and we will email you a code.'
          }
        >
          <div class="cluster" style={{ justifyContent: 'center' }}>
            <a class="btn btn--primary" href={SIGN_IN_URL}>{stuck ? 'Try again' : 'Sign in'}</a>
            {stuck && <a class="btn btn--text" href="/cdn-cgi/access/logout">Sign out</a>}
          </div>
        </EmptyState>
      </div>
    );
  }
  return (
    <div class="container" data-surface="host">
      <EmptyState title="That didn't load properly." text={gate.message}>
        <button type="button" class="btn btn--primary" onClick={() => location.reload()}>Try again</button>
      </EmptyState>
    </div>
  );
}

function SessionFacts({ s }: { s: HostSession }) {
  const next = nextDate(s, todayLondon());
  return (
    <p class="session-facts">
      {s.frequency === 'weekly' ? (
        <>
          <span><Repeat size={16} aria-hidden="true" />Every {weekday(s.event_date)}</span>
          <span><CalendarDays size={16} aria-hidden="true" />{next > s.event_date ? 'Next' : 'From'} {dayMonth(next)}</span>
        </>
      ) : (
        <span><CalendarDays size={16} aria-hidden="true" />{shortDate(s.event_date)}</span>
      )}
      <span><Clock size={16} aria-hidden="true" />{timeRange(s.start_time, s.end_time)}</span>
      <span><PoundSterling size={16} aria-hidden="true" />{s.price_label}</span>
      <span><UsersRound size={16} aria-hidden="true" />Up to {s.max_players}</span>
      {s.access === 'private' && <span><Lock size={16} aria-hidden="true" />Private</span>}
    </p>
  );
}

function SessionCard({ s, onChange, onSendAgain }: { s: HostSession; onChange: () => void; onSendAgain: () => void }) {
  const [busy, setBusy] = useState(false);
  const [changingPlaces, setChangingPlaces] = useState(false);
  const status = STATUS[s.status];
  // A weekly session keeps going until it's stopped, so only one-offs finish.
  const past = s.frequency === 'one-off' && s.event_date < todayLondon();
  const finished = past && (s.status === 'approved' || s.status === 'published');
  const withdraw = async () => {
    const ask = s.frequency === 'weekly' ? `Withdraw the weekly "${s.name}"? This stops every week of it.` : `Withdraw "${s.name}" on ${shortDate(s.event_date)}?`;
    if (!confirm(ask)) return;
    setBusy(true);
    const res = await hostApi(`/api/host/sessions/${s.session_id}/withdraw`, {});
    setBusy(false);
    toast(res.ok ? 'Session withdrawn.' : res.error);
    onChange();
  };
  const remove = async () => {
    if (!confirm(`Delete "${s.name}"? It goes from your list. (The café keeps a record.)`)) return;
    setBusy(true);
    const res = await hostApi(`/api/host/sessions/${s.session_id}/delete`, {});
    setBusy(false);
    toast(res.ok ? 'Session deleted.' : res.error);
    onChange();
  };
  const finishedRequest = s.status === 'declined' || s.status === 'withdrawn';
  return (
    <article class="card host-event">
      <div class="stack" style={{ '--gap': '6px' }}>
        <h3>{s.name}</h3>
        <SessionFacts s={s} />
        {s.status === 'declined' && s.decision_note && <p class="meta">Café note: {s.decision_note}</p>}
        {status.note && !past && <p class="meta">{status.note}</p>}
        {changingPlaces && (
          <SessionPlaces sessionId={s.session_id} current={s.max_players} onClose={() => setChangingPlaces(false)} onSaved={() => (setChangingPlaces(false), onChange())} />
        )}
        {s.dates && <SessionDates dates={s.dates} onChanged={onChange} />}
      </div>
      <div class="host-event__side">
        <Chip kind={finished ? 'completed' : status.chip}>{finished ? 'Completed' : status.label}</Chip>
        {s.status === 'published' && !finished && !changingPlaces && (
          <button type="button" class="btn btn--secondary btn--sm" onClick={() => setChangingPlaces(true)}>
            <UsersRound size={16} aria-hidden="true" /> Change places
          </button>
        )}
        {(s.status === 'submitted' || s.status === 'approved') && !past && (
          <button type="button" class="btn btn--destructive-quiet btn--sm" onClick={withdraw} disabled={busy}>
            Withdraw
          </button>
        )}
        {finishedRequest && (
          <div class="host-event__actions">
            <button type="button" class="btn btn--secondary btn--sm" onClick={onSendAgain} disabled={busy}>
              <RotateCcw size={16} aria-hidden="true" /> Edit and send again
            </button>
            <button type="button" class="btn btn--destructive-quiet btn--sm" onClick={remove} disabled={busy}>
              <Trash2 size={16} aria-hidden="true" /> Delete
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

const EMPTY = {
  name: '',
  frequency: 'one-off' as Frequency,
  access: 'open' as Access,
  event_date: '',
  start_time: '',
  end_time: '',
  paid: false,
  price: '',
  max_players: 6,
  description: '',
};

/** The form, filled in from a declined or withdrawn session (a date that's gone is left blank). */
function fromSession(s: HostSession, today: string): typeof EMPTY {
  return {
    name: s.name,
    frequency: s.frequency,
    access: s.access,
    event_date: s.event_date > today ? s.event_date : '',
    start_time: s.start_time,
    end_time: s.end_time ?? '',
    paid: s.price_pence > 0,
    price: s.price_pence ? (s.price_pence % 100 ? (s.price_pence / 100).toFixed(2) : String(s.price_pence / 100)) : '',
    max_players: s.max_players,
    description: s.description ?? '',
  };
}

/** Create a session, or (with `again`) edit a declined or withdrawn one and send it again. */
function SessionForm({ again, onDone }: { again?: HostSession; onDone: (created: boolean) => void }) {
  const [f, setF] = useState(() => (again ? fromSession(again, todayLondon()) : EMPTY));
  // On phones the form sits below the list: bring it into view when opened.
  useEffect(() => {
    const form = document.querySelector('.session-form');
    form?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    document.querySelector<HTMLInputElement>('#s-name')?.focus({ preventScroll: true });
  }, []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const today = todayLondon();
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setF(x => ({ ...x, [k]: v }));
  const players = (n: number) => set('max_players', Math.min(100, Math.max(1, Math.round(n) || 1)));

  const submit = async (e: Event) => {
    e.preventDefault();
    const pence = f.paid ? Math.round(Number(f.price) * 100) : 0;
    // Quick checks so every missing field is flagged at once; the server re-checks everything.
    const missing: Record<string, string> = {};
    if (f.name.trim().length < 3) missing.name = 'Give the session a name (at least 3 characters).';
    if (!f.event_date) missing.event_date = 'Choose a date.';
    if (!f.start_time) missing.start_time = 'Choose a start time.';
    if (f.end_time && f.start_time && f.end_time <= f.start_time) missing.end_time = 'End time must be after the start time.';
    if (f.paid && !(pence > 0 && pence <= 10_000)) missing.price_pence = 'Enter the cost per player (up to £100), or choose Free.';
    if (Object.keys(missing).length) {
      setErrors(missing);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.field--error input, .field--error button')?.focus());
      return;
    }
    setBusy(true);
    const res = await hostApi<{ session: HostSession }>(again ? `/api/host/sessions/${again.session_id}/resubmit` : '/api/host/sessions', {
      name: f.name,
      frequency: f.frequency,
      access: f.access,
      description: f.description,
      event_date: f.event_date,
      start_time: f.start_time,
      end_time: f.end_time,
      price_pence: pence,
      max_players: f.max_players,
    });
    setBusy(false);
    if (res.ok) {
      toast(again ? 'Sent to the café again.' : 'Sent to the café for approval.');
      setF(EMPTY);
      setErrors({});
      onDone(true);
    } else if (res.kind === 'invalid') {
      setErrors(res.errors ?? {});
      document.querySelector<HTMLElement>('.field--error input, .field--error textarea')?.focus();
    } else toast(res.error);
  };

  const field = (key: string) => ({
    class: `field${errors[key] ? ' field--error' : ''}`,
    describedBy: errors[key] ? `${key}-error` : undefined,
    error: errors[key] ? <p id={`${key}-error`} class="field__error">{errors[key]}</p> : null,
  });
  const name = field('name');
  const freq = field('frequency');
  const date = field('event_date');
  const weekly = f.frequency === 'weekly';
  const who = field('access');
  const isPrivate = f.access === 'private';
  const start = field('start_time');
  const end = field('end_time');
  const price = field('price_pence');
  const max = field('max_players');
  const desc = field('description');

  return (
    <section class="card card--pad session-form" aria-labelledby="create-session">
      <div class="section-head" style={{ marginBottom: 0 }}>
        <h2 id="create-session">{again ? 'Send it again' : 'Create a session'}</h2>
        <button type="button" class="btn btn--icon btn--text" onClick={() => onDone(false)} aria-label="Close the form">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {again && (
        <div class="notice notice--info">
          <Info size={20} aria-hidden="true" />
          <div>
            <strong>{again.status === 'declined' ? `The café didn't approve "${again.name}".` : `You withdrew "${again.name}".`}</strong>
            {again.status === 'declined' && again.decision_note && <p>Café note: "{again.decision_note}"</p>}
            <p>Change anything you need, then send it again. It keeps its number, {again.session_id}.</p>
          </div>
        </div>
      )}
      <form class="stack" style={{ '--gap': '18px' }} onSubmit={submit} noValidate>
        <div class={name.class}>
          <label for="s-name">Event name</label>
          <input id="s-name" class="input" value={f.name} maxLength={80} required aria-invalid={!!errors.name} aria-describedby={name.describedBy}
            placeholder="e.g. D&D One Shot" onInput={e => set('name', e.currentTarget.value)} />
          {name.error}
        </div>

        <fieldset class={freq.class}>
          <legend>How often?</legend>
          <div class="segmented segmented--inline" role="group" aria-label="How often" aria-describedby="s-freq-hint">
            <button type="button" aria-pressed={!weekly} onClick={() => set('frequency', 'one-off')}>One-off</button>
            <button type="button" aria-pressed={weekly} onClick={() => set('frequency', 'weekly')}>Weekly</button>
          </div>
          <p id="s-freq-hint" class="field__hint">
            {!weekly
              ? "A single session. The day after, we'll email you to see if you'd like to run it again."
              : f.event_date
                ? `Every ${weekday(f.event_date)}, starting ${dayMonth(f.event_date)}, until you or the café stop it.`
                : 'Every week on the same day, from the date you pick, until you or the café stop it.'}
          </p>
          {freq.error}
        </fieldset>

        <fieldset class={who.class}>
          <legend>Who can come?</legend>
          <div class="segmented segmented--inline" role="group" aria-label="Who can come" aria-describedby="s-access-hint">
            <button type="button" aria-pressed={!isPrivate} onClick={() => set('access', 'open')}>Open</button>
            <button type="button" aria-pressed={isPrivate} onClick={() => set('access', 'private')}>Private</button>
          </div>
          <p id="s-access-hint" class="field__hint">
            {isPrivate
              ? 'Just your group. The diary shows "Private session" at this time, without the name or details, so people can see the café is busy.'
              : 'Anyone can join. It goes in the diary with its name and details.'}
          </p>
          {who.error}
        </fieldset>

        <div class="field-row">
          <div class={date.class}>
            <label for="s-date">{weekly ? 'First date' : 'Date'}</label>
            <input id="s-date" class="input" type="date" value={f.event_date} min={addDays(today, 1)} max={addDays(today, 365)} required
              aria-invalid={!!errors.event_date} aria-describedby={date.describedBy} onInput={e => set('event_date', e.currentTarget.value)} />
            {date.error}
          </div>
          <div class={start.class}>
            <label for="s-start">Start time</label>
            <input id="s-start" class="input" type="time" value={f.start_time} required aria-invalid={!!errors.start_time}
              aria-describedby={start.describedBy} onInput={e => set('start_time', e.currentTarget.value)} />
            {start.error}
          </div>
          <div class={end.class}>
            <label for="s-end">
              End time <span class="field__optional">optional</span>
            </label>
            <input id="s-end" class="input" type="time" value={f.end_time} aria-invalid={!!errors.end_time} aria-describedby={end.describedBy}
              onInput={e => set('end_time', e.currentTarget.value)} />
            {end.error}
          </div>
        </div>

        <fieldset class={price.class}>
          <legend>Cost per player</legend>
          <div class="segmented segmented--inline" role="group" aria-label="Cost">
            <button type="button" aria-pressed={!f.paid} onClick={() => set('paid', false)}>Free</button>
            <button type="button" aria-pressed={f.paid} onClick={() => set('paid', true)}>Paid</button>
          </div>
          {f.paid && (
            <div class="input-money">
              <span aria-hidden="true">£</span>
              <input class="input" type="number" inputMode="decimal" min="0.5" max="100" step="0.5" value={f.price} aria-label="Cost per player in pounds"
                aria-invalid={!!errors.price_pence} aria-describedby={price.describedBy} placeholder="5.00" onInput={e => set('price', e.currentTarget.value)} />
            </div>
          )}
          <p class="field__hint">Paid at the café on the day. There's no online payment.</p>
          {price.error}
        </fieldset>

        <div class={max.class}>
          <label for="s-max">Max players</label>
          <div class="number-stepper">
            <button type="button" class="btn btn--secondary btn--icon" onClick={() => players(f.max_players - 1)} aria-label="One fewer player" disabled={f.max_players <= 1}>
              <Minus size={18} aria-hidden="true" />
            </button>
            <input id="s-max" class="input" type="number" inputMode="numeric" min="1" max="100" value={f.max_players}
              aria-invalid={!!errors.max_players} aria-describedby={max.describedBy} onInput={e => players(Number(e.currentTarget.value))} />
            <button type="button" class="btn btn--secondary btn--icon" onClick={() => players(f.max_players + 1)} aria-label="One more player" disabled={f.max_players >= 100}>
              <Plus size={18} aria-hidden="true" />
            </button>
          </div>
          {max.error}
        </div>

        <div class={desc.class}>
          <label for="s-desc">
            Description <span class="field__optional">optional</span>
          </label>
          <textarea id="s-desc" class="input" rows={4} maxLength={500} value={f.description} aria-describedby={`s-desc-count${desc.describedBy ? ` ${desc.describedBy}` : ''}`}
            placeholder="What will people play? Is it beginner friendly?" onInput={e => set('description', e.currentTarget.value)} />
          <p id="s-desc-count" class="field__hint">{f.description.length} / 500</p>
          {desc.error}
        </div>

        <button type="submit" class="btn btn--primary btn--lg btn--block" disabled={busy}>
          <Send size={18} aria-hidden="true" /> {busy ? 'Sending...' : again ? 'Send to the café again' : 'Send to the café for approval'}
        </button>
      </form>
    </section>
  );
}

/** Approvers and admins: join requests, sessions waiting for a decision, hosts; admins also choose approvers. */
function StaffDesk({ onDecided, me, isAdmin }: { onDecided: () => void; me: HostUser; isAdmin: boolean }) {
  const [pending, setPending] = useState<HostSession[] | null>(null);
  const [hosts, setHosts] = useState<HostRecord[] | null>(null);
  const [markets, setMarkets] = useState<StaffMarket[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(async () => {
    const [p, h, m] = await Promise.all([
      hostApi<{ sessions: HostSession[] }>('/api/staff/host-sessions?status=submitted'),
      hostApi<{ hosts: HostRecord[] }>('/api/staff/hosts'),
      hostApi<{ markets: StaffMarket[] }>('/api/staff/markets'),
    ]);
    if (p.ok) setPending(p.data.sessions.slice().reverse());
    if (h.ok) setHosts(h.data.hosts);
    if (m.ok) setMarkets(m.data.markets);
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <div data-surface="staff" class="staff-desk">
      <PushCard />
      <JoinRequests onDecided={load} />
      <section class="section" aria-labelledby="awaiting">
        <div class="section-head">
          <h2 id="awaiting">Sessions awaiting approval {pending && pending.length > 0 && <span class="count-badge">{pending.length}</span>}</h2>
        </div>
        {pending === null && <DiceLoader label="Loading submissions..." />}
        {pending && !pending.length && <p class="meta">Nothing waiting. New submissions from hosts appear here.</p>}
        <div class="list">
          {pending?.map(s => (
            <ReviewCard
              key={s.session_id}
              s={s}
              onDone={() => {
                load();
                onDecided();
              }}
            />
          ))}
        </div>
      </section>
      <MarketApplicationsPanel markets={markets} refresh={refresh} onChanged={load} />
      <HostedDatesPanel refresh={refresh} />
      <EventPlacesPanel refresh={refresh} />
      {isAdmin && <StatsAdmin />}
      {isAdmin && <RemindersAdmin />}
      {isAdmin && <MarketsAdmin markets={markets} onChanged={load} />}
      <HostsPanel hosts={hosts} isAdmin={isAdmin} onChanged={() => (load(), setRefresh(n => n + 1))} />
      {isAdmin && <ApproversPanel me={me} refresh={refresh} />}
    </div>
  );
}

function ReviewCard({ s, onDone }: { s: HostSession; onDone: () => void }) {
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(true);
    const res = await hostApi(`/api/staff/host-sessions/${s.session_id}/decision`, { decision, note });
    setBusy(false);
    toast(res.ok ? (decision === 'approve' ? `Approved "${s.name}".` : `Declined "${s.name}".`) : res.error);
    onDone();
  };
  return (
    <article class="card review-card">
      <div class="stack" style={{ '--gap': '6px' }}>
        <div class="cluster" style={{ '--gap': '8px' }}>
          <h3>{s.name}</h3>
          {!!s.resubmissions && <Chip kind="awaiting">Sent again</Chip>}
        </div>
        <SessionFacts s={s} />
        <p class="meta">
          From {s.host_name ?? s.host_email} · {s.session_id}
        </p>
        {s.description && <p>{s.description}</p>}
      </div>
      {declining ? (
        <div class="stack" style={{ '--gap': '8px' }}>
          <label class="label" for={`note-${s.session_id}`}>Note for the host (optional)</label>
          <textarea id={`note-${s.session_id}`} class="input" rows={2} maxLength={500} value={note} onInput={e => setNote(e.currentTarget.value)}
            placeholder="e.g. That date clashes with Quiz night. Could you do the week after?" />
          <div class="cluster">
            <button type="button" class="btn btn--destructive btn--sm" disabled={busy} onClick={() => decide('decline')}>Decline</button>
            <button type="button" class="btn btn--text btn--sm" onClick={() => setDeclining(false)}>Back</button>
          </div>
        </div>
      ) : (
        <div class="cluster">
          <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => decide('approve')}>
            <Check size={16} aria-hidden="true" /> Approve
          </button>
          <button type="button" class="btn btn--destructive-quiet btn--sm" disabled={busy} onClick={() => setDeclining(true)}>Decline</button>
        </div>
      )}
    </article>
  );
}

/** Everyone who can plan sessions. People join through Join requests; admins can make one an approver. */
function HostsPanel({ hosts, isAdmin, onChanged }: { hosts: HostRecord[] | null; isAdmin: boolean; onChanged: () => void }) {
  const active = hosts?.filter(h => h.active) ?? null;
  return (
    <section class="section" aria-labelledby="hosts">
      <div class="section-head">
        <h2 id="hosts">Hosts</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Hosts and café staff join by signing in at /organise and asking to host; their request appears under Join requests.
      </p>
      <div class="table-wrap">
        <table class="table table--stack">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {active?.map(h => (
              <tr key={h.user_id}>
                <td>{h.display_name ?? '—'}</td>
                <td>{h.email}</td>
                <td class={isAdmin ? 'table__action table__action--wide' : 'table__action'}>
                  <div class="table__buttons">
                    {isAdmin && (
                      <button type="button" class="btn btn--text btn--sm" onClick={async () => (await setApprover(h, true)) && onChanged()}>
                        <ShieldCheck size={16} aria-hidden="true" /> Make approver
                      </button>
                    )}
                    <button type="button" class="btn btn--text btn--sm" onClick={async () => (await removeAccess(h, 'a host')) && onChanged()}>
                      <UserMinus size={16} aria-hidden="true" /> Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {active && !active.length && (
              <tr>
                <td colSpan={3}>No hosts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
