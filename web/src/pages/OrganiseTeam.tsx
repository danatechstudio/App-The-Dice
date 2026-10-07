// Onboarding in the organiser (docs/RTD_ONBOARDING.md). Hosts and café staff join the same way:
// - JoinScreen: someone signed in without access asks to host;
// - JoinRequests: approvers (Michelle) and admins approve or decline;
// - ApproversPanel: admins see who approves, and can turn an approver back into a host.

import { Check, Info, LogOut, Send, UserMinus } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader, EmptyState } from '../components/States';
import { longDate } from '../lib/dates';
import { hostApi, type Application, type HostUser, type JoinMe, type TeamMember } from '../lib/hostApi';
import { toast } from '../lib/toast';

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
        Your request is with the café.
      </h2>
      <p>We'll email {email} when it's been looked at.</p>
      <p class="meta">
        Sent {dateOf(app.created_at)} · What you would like to run: {app.about}
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
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const send = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const res = await hostApi<{ application: Application }>('/api/join/apply', { display_name: name, about });
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
        Ask to host games
      </h2>
      <p class="meta" style={{ marginTop: '4px' }}>
        For hosts and café staff alike. Once the café approves you, you can plan sessions. The café checks each session before it goes on the app.
      </p>
      <form class="stack" style={{ '--gap': '18px', marginTop: '16px' }} onSubmit={send} noValidate>
        <div class={`field${errors.display_name ? ' field--error' : ''}`}>
          <label for="j-name">Your name</label>
          <input id="j-name" class="input" value={name} maxLength={60} autoComplete="name" aria-invalid={!!errors.display_name}
            aria-describedby={errors.display_name ? 'display_name-error' : undefined} onInput={e => setName(e.currentTarget.value)} />
          {err('display_name')}
        </div>
        <div class={`field${errors.about ? ' field--error' : ''}`}>
          <label for="j-about">What would you like to run?</label>
          <textarea id="j-about" class="input" rows={4} maxLength={500} value={about} aria-invalid={!!errors.about}
            aria-describedby={errors.about ? 'about-error' : undefined}
            placeholder="e.g. beginner-friendly D&D one-shots, or a monthly Catan night. If you work at the café, say so."
            onInput={e => setAbout(e.currentTarget.value)} />
          {err('about')}
        </div>
        <button type="submit" class="btn btn--primary btn--lg btn--block" disabled={busy}>
          <Send size={18} aria-hidden="true" /> {busy ? 'Sending...' : 'Send request'}
        </button>
        <p class="meta">
          The café team sees your name, your sign-in email and what you'd like to run. <a href="/privacy">How we use your details</a>
        </p>
      </form>
    </section>
  );
}

/** Approvers and admins: everyone asking to host. */
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
      {apps && !apps.length && <p class="meta">No one waiting. People asking to host, café staff included, appear here.</p>}
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
        <h3>{app.display_name}</h3>
        <p class="meta">
          {app.email} · asked {dateOf(app.created_at)} · {app.application_id}
        </p>
        <p>
          <strong>Would like to run:</strong> {app.about}
        </p>
      </div>
      {declining ? (
        <div class="stack" style={{ '--gap': '8px' }}>
          <label class="label" for={`app-note-${app.application_id}`}>Note for {app.display_name} (optional)</label>
          <textarea id={`app-note-${app.application_id}`} class="input" rows={2} maxLength={500} value={note} onInput={e => setNote(e.currentTarget.value)}
            placeholder="e.g. We already run D&D on Fridays. Fancy a board game night instead?" />
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

/** Offboarding: removes someone's access (their past and live sessions stay). */
export async function removeAccess(person: { user_id: string; display_name: string | null; email: string }, what: string): Promise<boolean> {
  const who = person.display_name ?? person.email;
  if (!confirm(`Remove ${who} as ${what}? They won't be able to sign in to the organiser. Sessions already in the diary stay; change those in the Logic Engine.`)) return false;
  const res = await hostApi(`/api/staff/users/${person.user_id}/remove`, {});
  toast(res.ok ? `${who} has been removed.` : res.error);
  return res.ok;
}

/** Admins: make a host an approver (they approve join requests and sessions), or back. */
export async function setApprover(person: { user_id: string; display_name: string | null; email: string }, approver: boolean): Promise<boolean> {
  const who = person.display_name ?? person.email;
  const ask = approver
    ? `Make ${who} an approver? They'll approve join requests and sessions, and can remove hosts.`
    : `Stop ${who} approving? They'll stay on as a host.`;
  if (!confirm(ask)) return false;
  const res = await hostApi(`/api/staff/users/${person.user_id}/approver`, { approver });
  toast(res.ok ? (approver ? `${who} is now an approver.` : `${who} is a host again.`) : res.error);
  return res.ok;
}

/** Admins only: who approves. Approvers are chosen from the hosts (Make approver). */
export function ApproversPanel({ me, refresh }: { me: HostUser; refresh: number }) {
  const [list, setList] = useState<TeamMember[] | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ approvers: TeamMember[] }>('/api/staff/approvers');
    if (res.ok) setList(res.data.approvers);
  }, []);
  useEffect(() => void load(), [load, refresh]);

  return (
    <section class="section" aria-labelledby="approvers">
      <div class="section-head">
        <h2 id="approvers">Approvers</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Approvers say yes or no to join requests and sessions. Everyone else can only plan sessions. To add one, use Make approver in the Hosts table.
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
            {list === null && (
              <tr>
                <td colSpan={4}>Loading...</td>
              </tr>
            )}
            {list?.map(t => (
              <tr key={t.user_id}>
                <td>{t.display_name ?? '—'}</td>
                <td>{t.email}</td>
                <td>{t.role === 'admin' ? 'Admin' : 'Approver'}</td>
                <td class="table__action">
                  {t.role === 'staff' && t.user_id !== me.user_id && (
                    <button type="button" class="btn btn--text btn--sm" onClick={async () => (await setApprover(t, false)) && load()}>
                      <UserMinus size={16} aria-hidden="true" /> Stop approving
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
