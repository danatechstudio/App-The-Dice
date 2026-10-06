// Onboarding in the organiser (docs/RTD_ONBOARDING.md):
// - JoinScreen: someone signed in without access asks to host games or join the café team;
// - JoinRequests: staff approve host requests, admins also approve café team requests;
// - TeamPanel: admins see the café team and can remove staff.

import { Check, Info, LogOut, Send, UserMinus } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader, EmptyState } from '../components/States';
import { longDate } from '../lib/dates';
import { hostApi, type Application, type HostUser, type JoinMe, type TeamMember } from '../lib/hostApi';
import { toast } from '../lib/toast';

const ROLE_LABEL = { host: 'Host games', staff: 'Café team' } as const;
const dateOf = (iso: string) => longDate(iso.slice(0, 10));

/** Signed in, but no access yet: ask for it, or see where the request is. */
export function JoinScreen() {
  const [me, setMe] = useState<JoinMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<JoinMe>('/api/join/me');
    if (!res.ok) return setError(res.error);
    // Approved since the page opened: straight into the organiser.
    if (res.data.has_access) return location.reload();
    setMe(res.data);
  }, []);
  useEffect(() => void load(), [load]);

  if (error) {
    return (
      <div class="container" data-surface="host">
        <EmptyState title="That didn't load properly." text={error}>
          <button type="button" class="btn btn--primary" onClick={() => location.reload()}>Try again</button>
        </EmptyState>
      </div>
    );
  }
  if (!me) return <DiceLoader label="Checking your sign-in..." />;
  const app = me.application;

  return (
    <div class="container join" data-surface="host">
      <header class="page-head organiser__head">
        <div>
          <p class="label">Get set up</p>
          <h1>Join Roll The Dice</h1>
          <p class="meta">Signed in as {me.email}</p>
        </div>
        <a class="btn btn--text btn--sm" href="/cdn-cgi/access/logout">
          <LogOut size={16} aria-hidden="true" /> Sign out
        </a>
      </header>
      <div class="join__body">
        {app?.status === 'pending' ? (
          <PendingRequest app={app} email={me.email} onWithdrawn={load} />
        ) : (
          <>
            {app?.status === 'declined' && (
              <div class="notice notice--warning">
                <Info size={20} aria-hidden="true" />
                <div>
                  <strong>Your last request wasn't approved.</strong>
                  {app.decision_note && <p>"{app.decision_note}"</p>}
                  <p>You're welcome to send another one.</p>
                </div>
              </div>
            )}
            <JoinForm onSent={load} />
          </>
        )}
      </div>
    </div>
  );
}

function PendingRequest({ app, email, onWithdrawn }: { app: Application; email: string; onWithdrawn: () => void }) {
  const [busy, setBusy] = useState(false);
  const withdraw = async () => {
    if (!confirm('Withdraw your request?')) return;
    setBusy(true);
    const res = await hostApi('/api/join/withdraw', {});
    setBusy(false);
    toast(res.ok ? 'Request withdrawn.' : res.error);
    onWithdrawn();
  };
  return (
    <section class="card card--pad stack" style={{ '--gap': '12px' }} aria-labelledby="request">
      <div>
        <Chip kind="awaiting">Awaiting approval</Chip>
      </div>
      <h2 id="request" class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>
        {app.role === 'staff' ? 'Your café team request is with an admin.' : 'Your request to host is with the café team.'}
      </h2>
      <p>We'll email {email} when it's been looked at.</p>
      <p class="meta">
        Sent {dateOf(app.created_at)} · {app.role === 'staff' ? 'Role' : 'What you would like to run'}: {app.about}
      </p>
      <div>
        <button type="button" class="btn btn--destructive-quiet btn--sm" onClick={withdraw} disabled={busy}>
          Withdraw request
        </button>
      </div>
    </section>
  );
}

function JoinForm({ onSent }: { onSent: () => void }) {
  const [role, setRole] = useState<'host' | 'staff'>('host');
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const staff = role === 'staff';

  const send = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const res = await hostApi<{ application: Application }>('/api/join/apply', { role, display_name: name, about });
    setBusy(false);
    if (res.ok) {
      toast('Request sent.');
      onSent();
    } else if (res.kind === 'invalid') {
      setErrors(res.errors ?? {});
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.join .field--error input, .join .field--error textarea')?.focus());
    } else toast(res.error);
  };
  const err = (k: string) => (errors[k] ? <p id={`${k}-error`} class="field__error">{errors[k]}</p> : null);

  return (
    <section class="card card--pad" aria-labelledby="join-form">
      <h2 id="join-form" class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>
        What would you like to do?
      </h2>
      <form class="stack" style={{ '--gap': '18px', marginTop: '16px' }} onSubmit={send} noValidate>
        <fieldset class={`field${errors.role ? ' field--error' : ''}`}>
          <legend class="visually-hidden">I would like to</legend>
          <div class="segmented segmented--inline" role="group" aria-label="I would like to" aria-describedby="j-role-hint">
            {(['host', 'staff'] as const).map(r => (
              <button key={r} type="button" aria-pressed={role === r} onClick={() => setRole(r)}>
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
          <p id="j-role-hint" class="field__hint">
            {staff
              ? 'For people who work at the café. An admin checks café team requests.'
              : 'Run games for other people at the café. The café team checks every request.'}
          </p>
          {err('role')}
        </fieldset>
        <div class={`field${errors.display_name ? ' field--error' : ''}`}>
          <label for="j-name">Your name</label>
          <input id="j-name" class="input" value={name} maxLength={60} autoComplete="name" aria-invalid={!!errors.display_name}
            aria-describedby={errors.display_name ? 'display_name-error' : undefined} onInput={e => setName(e.currentTarget.value)} />
          {err('display_name')}
        </div>
        <div class={`field${errors.about ? ' field--error' : ''}`}>
          <label for="j-about">{staff ? 'Your role at the café' : 'What would you like to run?'}</label>
          <textarea id="j-about" class="input" rows={staff ? 2 : 4} maxLength={500} value={about} aria-invalid={!!errors.about}
            aria-describedby={errors.about ? 'about-error' : undefined}
            placeholder={staff ? 'e.g. front of house, kitchen, events' : 'e.g. beginner-friendly D&D one-shots, or a monthly Catan night'}
            onInput={e => setAbout(e.currentTarget.value)} />
          {err('about')}
        </div>
        <button type="submit" class="btn btn--primary btn--lg btn--block" disabled={busy}>
          <Send size={18} aria-hidden="true" /> {busy ? 'Sending...' : 'Send request'}
        </button>
      </form>
    </section>
  );
}

/** Staff: host requests. Admins: café team requests too. */
export function JoinRequests({ onDecided }: { onDecided?: () => void }) {
  const [apps, setApps] = useState<Application[] | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ applications: Application[] }>('/api/staff/applications?status=pending');
    if (res.ok) setApps(res.data.applications);
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <section class="section" aria-labelledby="join-requests">
      <div class="section-head">
        <h2 id="join-requests">Join requests {apps && apps.length > 0 && <span class="count-badge">{apps.length}</span>}</h2>
      </div>
      {apps === null && <DiceLoader label="Loading requests..." />}
      {apps && !apps.length && <p class="meta">No one waiting. People asking to host or join the café team appear here.</p>}
      <div class="list">
        {apps?.map(a => (
          <ApplicationCard
            key={a.application_id}
            app={a}
            onDone={() => {
              load();
              onDecided?.();
            }}
          />
        ))}
      </div>
    </section>
  );
}

function ApplicationCard({ app, onDone }: { app: Application; onDone: () => void }) {
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const staff = app.role === 'staff';
  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(true);
    const res = await hostApi(`/api/staff/applications/${app.application_id}/decision`, { decision, note });
    setBusy(false);
    toast(res.ok ? (decision === 'approve' ? `${app.display_name} can now sign in.` : `Declined ${app.display_name}.`) : res.error);
    onDone();
  };
  return (
    <article class="card review-card">
      <div class="stack" style={{ '--gap': '6px' }}>
        <div class="cluster" style={{ '--gap': '8px' }}>
          <h3>{app.display_name}</h3>
          <Chip kind={staff ? 'approved' : 'category'}>{staff ? 'Café team' : 'Host'}</Chip>
        </div>
        <p class="meta">
          {app.email} · asked {dateOf(app.created_at)} · {app.application_id}
        </p>
        <p>
          <strong>{staff ? 'Role:' : 'Would like to run:'}</strong> {app.about}
        </p>
      </div>
      {declining ? (
        <div class="stack" style={{ '--gap': '8px' }}>
          <label class="label" for={`app-note-${app.application_id}`}>Note for {app.display_name} (optional)</label>
          <textarea id={`app-note-${app.application_id}`} class="input" rows={2} maxLength={500} value={note} onInput={e => setNote(e.currentTarget.value)}
            placeholder={staff ? "e.g. Sorry, we couldn't find you on the rota." : 'e.g. We already run D&D on Fridays. Fancy a board game night instead?'} />
          <div class="cluster">
            <button type="button" class="btn btn--destructive btn--sm" disabled={busy} onClick={() => decide('decline')}>Decline</button>
            <button type="button" class="btn btn--text btn--sm" onClick={() => setDeclining(false)}>Back</button>
          </div>
        </div>
      ) : (
        <div class="cluster">
          <button type="button" class="btn btn--primary btn--sm" disabled={busy} onClick={() => decide('approve')}>
            <Check size={16} aria-hidden="true" /> {staff ? 'Approve for café team' : 'Approve host'}
          </button>
          <button type="button" class="btn btn--destructive-quiet btn--sm" disabled={busy} onClick={() => setDeclining(true)}>Decline</button>
        </div>
      )}
    </article>
  );
}

/** Offboarding: removes someone's access (their past and live sessions stay). */
export async function removeAccess(person: { user_id: string; display_name: string | null; email: string }, what: string): Promise<boolean> {
  const who = person.display_name ?? person.email;
  if (!confirm(`Remove ${who} as ${what}? They won't be able to sign in to the organiser. Sessions already in the diary stay; change those in the Logic Engine.`)) return false;
  const res = await hostApi(`/api/staff/users/${person.user_id}/remove`, {});
  toast(res.ok ? `${who} has been removed.` : res.error);
  return res.ok;
}

/** Admins only: who is on the café team. Staff are added by approving their join request. */
export function TeamPanel({ me }: { me: HostUser }) {
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ team: TeamMember[] }>('/api/staff/team');
    if (res.ok) setTeam(res.data.team);
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <section class="section" aria-labelledby="team">
      <div class="section-head">
        <h2 id="team">Café team</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        New team members sign in at /organise and choose "Café team"; their request appears under Join requests for an admin to approve.
      </p>
      <div class="table-wrap">
        <table class="table table--stack">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {team === null && (
              <tr>
                <td colSpan={4}>Loading...</td>
              </tr>
            )}
            {team?.map(t => (
              <tr key={t.user_id}>
                <td>{t.display_name ?? '—'}</td>
                <td>{t.email}</td>
                <td>{t.role === 'admin' ? 'Admin' : 'Staff'}</td>
                <td class="table__action">
                  {t.role === 'staff' && t.user_id !== me.user_id && (
                    <button type="button" class="btn btn--text btn--sm" onClick={async () => (await removeAccess(t, 'café team')) && load()}>
                      <UserMinus size={16} aria-hidden="true" /> Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
