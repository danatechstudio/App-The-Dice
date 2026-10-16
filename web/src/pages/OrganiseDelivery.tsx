// Delivery in the organiser (docs/RTD_EVENT_CONTROL_AUDIT.md §5.3; Stage 4b), for approvers
// and admins: how the last 7 days' emails and booking notifications have gone, and each one
// that's failing or was given up on. "Sent" only ever means Gmail or the push service
// accepted it: nothing can show that it was read.

import { Send } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { shortDate, todayLondon } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { toast } from '../lib/toast';

type Counts = { sent: number; waiting: number; failing: number; failed: number };

interface Overview {
  email: Counts;
  push: Counts;
  emails: {
    message_id: number;
    to: string;
    subject: string;
    attempts: number;
    last_error: string | null;
    next_attempt_at: string | null;
    given_up: boolean;
    created_at: string;
    contact: { name: string; mobile: string | null } | null;
  }[];
  pushes: { push_id: number; booking_id: string; title: string; attempts: number; last_error: string | null; next_attempt_at: string | null; given_up: boolean; created_at: string }[];
}

const clockOf = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const dayOf = (iso: string) => shortDate(todayLondon(new Date(iso)));

function summary(c: Counts, noun: string): string {
  const parts = [`${c.sent} sent`];
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  if (c.failing) parts.push(`${c.failing} being tried again`);
  if (c.failed) parts.push(`${c.failed} given up on`);
  return `${noun}: ${parts.join(', ')}`;
}

export function DeliveryPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<Overview>('/api/staff/delivery');
    if (res.ok) setData(res.data);
  }, []);
  useEffect(() => void load(), [load]);
  const retry = async (id: number) => {
    const res = await hostApi(`/api/staff/outbox/${id}/retry`, {});
    toast(res.ok ? 'Trying again within 5 minutes.' : res.error);
    load();
  };
  if (!data) return null;
  const problems = data.emails.length + data.pushes.length;

  return (
    <section class="section" aria-labelledby="delivery">
      <div class="section-head">
        <h2 id="delivery">Delivery {problems > 0 && <span class="count-badge">{problems}</span>}</h2>
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        How the app's emails and booking notifications have gone in the last 7 days. "Sent" means Gmail or the push service accepted it; nothing can show
        it was read. A failed one is tried again after 5 minutes, 15 minutes, 1 hour, 4 hours and 12 hours, then given up on.
      </p>
      <p class="meta">{summary(data.email, 'Emails')}</p>
      <p class="meta" style={{ marginBottom: '12px' }}>
        {summary(data.push, 'Notifications to people booked')}
      </p>
      {!problems && <p class="meta">Nothing has failed in the last 30 days.</p>}
      <div class="list">
        {data.emails.map(e => (
          <article key={`e${e.message_id}`} class="card card--pad stack" style={{ '--gap': '6px' }}>
            <div class="cluster" style={{ '--gap': '8px' }}>
              <strong>{e.subject}</strong>
              {e.given_up ? <Chip kind="cancelled">Given up</Chip> : <Chip kind="awaiting">Trying again</Chip>}
            </div>
            <p class="meta">
              To {e.to} · {dayOf(e.created_at)} · tried {e.attempts === 1 ? 'once' : `${e.attempts} times`}
              {e.next_attempt_at ? ` · next at ${clockOf(e.next_attempt_at)}` : ''}
            </p>
            {e.last_error && <p class="meta">Gmail said: {e.last_error}</p>}
            {e.contact && (
              <p class="meta">
                For {e.contact.name}
                {e.contact.mobile ? `, ${e.contact.mobile}` : ''}
              </p>
            )}
            {e.given_up && (
              <div>
                <button type="button" class="btn btn--secondary btn--sm" onClick={() => retry(e.message_id)}>
                  <Send size={16} aria-hidden="true" /> Try again now
                </button>
              </div>
            )}
          </article>
        ))}
        {data.pushes.map(p => (
          <article key={`p${p.push_id}`} class="card card--pad stack" style={{ '--gap': '6px' }}>
            <div class="cluster" style={{ '--gap': '8px' }}>
              <strong>{p.title}</strong>
              {p.given_up ? <Chip kind="cancelled">Given up</Chip> : <Chip kind="awaiting">Trying again</Chip>}
            </div>
            <p class="meta">
              Notification for booking {p.booking_id} · {dayOf(p.created_at)} · tried {p.attempts === 1 ? 'once' : `${p.attempts} times`}
              {p.next_attempt_at ? ` · next at ${clockOf(p.next_attempt_at)}` : ''}
            </p>
            {p.last_error && <p class="meta">{p.last_error} Their email went as usual.</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
