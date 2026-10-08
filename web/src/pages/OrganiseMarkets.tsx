// Markets in the organiser (docs/RTD_MARKETS.md):
// - MarketsAdmin: admins set up a market (it reaches the diary within 15 minutes)
//   and change its pitches, fee, closing date and payment details;
// - MarketApplicationsPanel: approvers approve or decline vendors. Approving
//   emails the vendor the pitch fee and payment details.

import { Check, ChevronDown, Mail, Minus, Pencil, Phone, Plus, Store, X } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { DiceLoader } from '../components/States';
import { addDays, longDate, shortDate, timeRange, todayLondon } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { webLink, type StaffMarket, type VendorApplication } from '../lib/markets';
import { toast } from '../lib/toast';

const pounds = (pence: number) => (pence % 100 ? (pence / 100).toFixed(2) : String(pence / 100));

/** Admins: markets, and the form to set one up or change it. */
export function MarketsAdmin({ markets, onChanged }: { markets: StaffMarket[] | null; onChanged: () => void }) {
  const [editing, setEditing] = useState<StaffMarket | 'new' | null>(null);
  return (
    <section class="section" aria-labelledby="markets-admin">
      <div class="section-head">
        <h2 id="markets-admin">Markets</h2>
        {editing === null && (
          <button type="button" class="btn btn--secondary btn--sm" onClick={() => setEditing('new')}>
            <Plus size={16} aria-hidden="true" /> New market
          </button>
        )}
      </div>
      <p class="meta" style={{ marginBottom: '12px' }}>
        Set up a market and it goes in the diary within 15 minutes. Vendors apply at <a href="/markets">/markets</a>; approvers decide under Market
        applications.
      </p>
      {editing !== null && (
        <MarketForm
          market={editing === 'new' ? null : editing}
          onDone={changed => {
            setEditing(null);
            if (changed) onChanged();
          }}
        />
      )}
      {markets === null && <DiceLoader label="Loading markets..." />}
      {markets && !markets.length && editing === null && <p class="meta">No markets yet.</p>}
      <div class="list">
        {markets?.map(m => (
          <article class="card card--pad market-admin" key={m.market_id}>
            <div class="cluster" style={{ justifyContent: 'space-between' }}>
              <h3>{m.name}</h3>
              <Chip kind={m.status === 'published' ? 'live' : 'awaiting'}>{m.status === 'published' ? 'In the diary' : 'Adding to the diary'}</Chip>
            </div>
            <p class="meta">
              {longDate(m.event_date)}, {timeRange(m.start_time, m.end_time)} · {m.pitch_fee === 'Free' ? 'No pitch fee' : `${m.pitch_fee} a pitch`} · applications
              close {shortDate(m.applications_close)}
            </p>
            <p>
              <strong>
                {m.approved} of {m.pitches} pitches approved
              </strong>
              {m.pending > 0 && ` · ${m.pending} waiting for a decision`}
            </p>
            <div>
              <button type="button" class="btn btn--text btn--sm" onClick={() => setEditing(m)}>
                <Pencil size={16} aria-hidden="true" /> Change
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function MarketForm({ market, onDone }: { market: StaffMarket | null; onDone: (changed: boolean) => void }) {
  const today = todayLondon();
  const [f, setF] = useState(() => ({
    name: market?.name ?? '',
    description: market?.description ?? '',
    event_date: market?.event_date ?? '',
    start_time: market?.start_time ?? '10:00',
    end_time: market?.end_time ?? '16:00',
    pitches: market?.pitches ?? 12,
    fee: market ? pounds(market.pitch_fee_pence) : '',
    applications_close: market?.applications_close ?? '',
    payment_details: market?.payment_details ?? '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }));
  const pitches = (n: number) => set('pitches', Math.min(200, Math.max(1, Math.round(n) || 1)));

  const submit = async (e: Event) => {
    e.preventDefault();
    const pence = f.fee.trim() === '' ? 0 : Math.round(Number(f.fee) * 100);
    if (!Number.isFinite(pence) || pence < 0) {
      setErrors({ pitch_fee_pence: 'Enter the pitch fee in pounds, like 15, or leave it empty for no fee.' });
      return;
    }
    setBusy(true);
    const res = await hostApi<{ market: StaffMarket }>(market ? `/api/staff/markets/${market.market_id}` : '/api/staff/markets', {
      name: f.name,
      description: f.description,
      event_date: f.event_date,
      start_time: f.start_time,
      end_time: f.end_time,
      pitches: f.pitches,
      pitch_fee_pence: pence,
      applications_close: f.applications_close,
      payment_details: f.payment_details,
    });
    setBusy(false);
    if (res.ok) {
      toast(market ? 'Market saved.' : 'Market set up. It goes in the diary within 15 minutes.');
      onDone(true);
    } else if (res.kind === 'invalid') {
      setErrors(res.errors ?? {});
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.market-form .field--error input, .market-form .field--error textarea')?.focus());
    } else toast(res.error);
  };

  const field = (k: string) => ({
    class: `field${errors[k] ? ' field--error' : ''}`,
    describedBy: errors[k] ? `m-${k}-error` : undefined,
    error: errors[k] ? <p id={`m-${k}-error`} class="field__error">{errors[k]}</p> : null,
  });
  const name = field('name');
  const date = field('event_date');
  const start = field('start_time');
  const end = field('end_time');
  const desc = field('description');
  const pitch = field('pitches');
  const fee = field('pitch_fee_pence');
  const close = field('applications_close');
  const pay = field('payment_details');

  return (
    <section class="card card--pad market-form" aria-labelledby="market-form-title">
      <div class="section-head" style={{ marginBottom: 0 }}>
        <h3 id="market-form-title">{market ? `Change ${market.name}` : 'New market'}</h3>
        <button type="button" class="btn btn--icon btn--text" onClick={() => onDone(false)} aria-label="Close the form">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {market?.status === 'published' && (
        <p class="meta">It's in the diary already: if you change the name, date or times here, change its Event Index row in the Logic Engine too.</p>
      )}
      <form class="stack" style={{ '--gap': '18px' }} onSubmit={submit} noValidate>
        <div class={name.class}>
          <label for="m-name">Market name</label>
          <input id="m-name" class="input" value={f.name} maxLength={80} aria-invalid={!!errors.name} aria-describedby={name.describedBy}
            placeholder="e.g. Christmas Makers Market" onInput={e => set('name', e.currentTarget.value)} />
          {name.error}
        </div>
        <div class="field-row">
          <div class={date.class}>
            <label for="m-date">Date</label>
            <input id="m-date" class="input" type="date" value={f.event_date} min={addDays(today, 1)} max={addDays(today, 365)} aria-invalid={!!errors.event_date}
              aria-describedby={date.describedBy} onInput={e => set('event_date', e.currentTarget.value)} />
            {date.error}
          </div>
          <div class={start.class}>
            <label for="m-start">Start time</label>
            <input id="m-start" class="input" type="time" value={f.start_time} aria-invalid={!!errors.start_time} aria-describedby={start.describedBy}
              onInput={e => set('start_time', e.currentTarget.value)} />
            {start.error}
          </div>
          <div class={end.class}>
            <label for="m-end">
              End time <span class="field__optional">optional</span>
            </label>
            <input id="m-end" class="input" type="time" value={f.end_time} aria-invalid={!!errors.end_time} aria-describedby={end.describedBy}
              onInput={e => set('end_time', e.currentTarget.value)} />
            {end.error}
          </div>
        </div>
        <div class={desc.class}>
          <label for="m-desc">
            Description <span class="field__optional">optional</span>
          </label>
          <textarea id="m-desc" class="input" rows={3} maxLength={1000} value={f.description} aria-describedby={`m-desc-hint${desc.describedBy ? ` ${desc.describedBy}` : ''}`}
            placeholder="e.g. Local makers, crafts and gifts, with hot chocolate all day." onInput={e => set('description', e.currentTarget.value)} />
          <p id="m-desc-hint" class="field__hint">Shown to vendors, and used in the diary when it's first added.</p>
          {desc.error}
        </div>
        <div class="field-row">
          <div class={pitch.class}>
            <label for="m-pitches">Pitches</label>
            <div class="number-stepper">
              <button type="button" class="btn btn--secondary btn--icon" onClick={() => pitches(f.pitches - 1)} aria-label="One fewer pitch" disabled={f.pitches <= 1}>
                <Minus size={18} aria-hidden="true" />
              </button>
              <input id="m-pitches" class="input" type="number" inputMode="numeric" min="1" max="200" value={f.pitches} aria-invalid={!!errors.pitches}
                aria-describedby={pitch.describedBy} onInput={e => pitches(Number(e.currentTarget.value))} />
              <button type="button" class="btn btn--secondary btn--icon" onClick={() => pitches(f.pitches + 1)} aria-label="One more pitch" disabled={f.pitches >= 200}>
                <Plus size={18} aria-hidden="true" />
              </button>
            </div>
            {pitch.error}
          </div>
          <div class={fee.class}>
            <label for="m-fee">
              Pitch fee <span class="field__optional">empty for none</span>
            </label>
            <div class="input-money">
              <span aria-hidden="true">£</span>
              <input id="m-fee" class="input" type="number" inputMode="decimal" min="0" max="1000" step="0.5" value={f.fee} placeholder="15"
                aria-invalid={!!errors.pitch_fee_pence} aria-describedby={fee.describedBy} onInput={e => set('fee', e.currentTarget.value)} />
            </div>
            {fee.error}
          </div>
          <div class={close.class}>
            <label for="m-close">Applications close</label>
            <input id="m-close" class="input" type="date" value={f.applications_close} max={f.event_date || undefined} aria-invalid={!!errors.applications_close}
              aria-describedby={`m-close-hint${close.describedBy ? ` ${close.describedBy}` : ''}`} onInput={e => set('applications_close', e.currentTarget.value)} />
            <p id="m-close-hint" class="field__hint">The last day vendors can apply.</p>
            {close.error}
          </div>
        </div>
        <div class={pay.class}>
          <label for="m-pay">How approved vendors pay</label>
          <textarea id="m-pay" class="input" rows={4} maxLength={1000} value={f.payment_details}
            aria-describedby={`m-pay-hint${pay.describedBy ? ` ${pay.describedBy}` : ''}`}
            placeholder={'e.g. Bank transfer to Roll The Dice\nSort code 00-00-00, account 00000000\nWithin 7 days of approval, please.'}
            onInput={e => set('payment_details', e.currentTarget.value)} />
          <p id="m-pay-hint" class="field__hint">
            Bank details or a payment link. Only approved vendors see this, in their approval email, with their reference to quote.
          </p>
          {pay.error}
        </div>
        <div class="cluster">
          <button type="submit" class="btn btn--primary" disabled={busy}>
            {busy ? 'Saving...' : market ? 'Save changes' : 'Set up the market'}
          </button>
          <button type="button" class="btn btn--text" onClick={() => onDone(false)}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

const STATUS_LABEL: Record<VendorApplication['status'], string> = { pending: 'Waiting', approved: 'Approved', declined: 'Declined', withdrawn: 'Dropped out' };

/** Approvers and admins: vendors to approve, market by market. */
export function MarketApplicationsPanel({ markets, refresh, onChanged }: { markets: StaffMarket[] | null; refresh?: number; onChanged: () => void }) {
  const [apps, setApps] = useState<VendorApplication[] | null>(null);
  const load = useCallback(async () => {
    const res = await hostApi<{ applications: VendorApplication[] }>('/api/staff/market-applications');
    if (res.ok) setApps(res.data.applications);
  }, []);
  useEffect(() => void load(), [load, refresh]);
  const changed = () => (load(), onChanged());
  const today = todayLondon();
  const shown = (markets ?? []).filter(m => m.event_date >= addDays(today, -14) && (m.event_date >= today || apps?.some(a => a.market_id === m.market_id)));
  if (!markets || !shown.length) return null;
  const waiting = apps?.filter(a => a.status === 'pending').length ?? 0;

  return (
    <section class="section" aria-labelledby="market-applications-title" id="market-applications">
      <div class="section-head">
        <h2>
          <span id="market-applications-title">Market applications</span> {waiting > 0 && <span class="count-badge">{waiting}</span>}
        </h2>
      </div>
      {apps === null && <DiceLoader label="Loading applications..." />}
      {apps &&
        shown.map(m => {
          const mine = apps.filter(a => a.market_id === m.market_id);
          const pending = mine.filter(a => a.status === 'pending');
          const approved = mine.filter(a => a.status === 'approved');
          const rest = mine.filter(a => a.status === 'declined' || a.status === 'withdrawn');
          const full = approved.length >= m.pitches;
          return (
            <div class="market-review" key={m.market_id}>
              <h3 class="market-review__title">
                <Store size={18} aria-hidden="true" /> {m.name} · {shortDate(m.event_date)}
              </h3>
              <p class="meta">
                {approved.length} of {m.pitches} pitches approved{full ? ' (full: new applicants join the waiting list)' : ''} · {pending.length} waiting
              </p>
              {!mine.length && <p class="meta">No applications yet.</p>}
              <div class="list">
                {pending.map(a => (
                  <VendorCard key={a.application_id} a={a} full={full} onChanged={changed} />
                ))}
              </div>
              {approved.length > 0 && (
                <details class="market-review__more" open={!pending.length}>
                  <summary>
                    Approved ({approved.length}) <ChevronDown size={16} aria-hidden="true" />
                  </summary>
                  <div class="list">
                    {approved.map(a => (
                      <VendorCard key={a.application_id} a={a} full={full} onChanged={changed} />
                    ))}
                  </div>
                </details>
              )}
              {rest.length > 0 && (
                <details class="market-review__more">
                  <summary>
                    Declined or dropped out ({rest.length}) <ChevronDown size={16} aria-hidden="true" />
                  </summary>
                  <div class="list">
                    {rest.map(a => (
                      <VendorCard key={a.application_id} a={a} full={full} onChanged={changed} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
    </section>
  );
}

function VendorCard({ a, full, onChanged }: { a: VendorApplication; full: boolean; onChanged: () => void }) {
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(true);
    const res = await hostApi(`/api/staff/market-applications/${a.application_id}/decision`, { decision, note });
    setBusy(false);
    toast(res.ok ? (decision === 'approve' ? `Approved ${a.stall_name}. They'll be emailed the payment details.` : `Declined ${a.stall_name}.`) : res.error);
    if (res.ok) onChanged();
  };
  const droppedOut = async () => {
    if (!confirm(`Mark ${a.stall_name} as dropped out? Their pitch becomes free. They aren't emailed.`)) return;
    setBusy(true);
    const res = await hostApi(`/api/staff/market-applications/${a.application_id}/withdraw`, {});
    setBusy(false);
    toast(res.ok ? `${a.stall_name}: marked as dropped out.` : res.error);
    if (res.ok) onChanged();
  };
  const linkLines = (a.links ?? '').split(/\r?\n|,\s+/).map(s => s.trim()).filter(Boolean);
  return (
    <article class="card review-card vendor-card">
      <div class="stack" style={{ '--gap': '6px' }}>
        <div class="cluster" style={{ '--gap': '8px' }}>
          <h4>{a.stall_name}</h4>
          {a.status !== 'pending' && <Chip kind={a.status === 'approved' ? 'approved' : 'cancelled'}>{STATUS_LABEL[a.status]}</Chip>}
          {a.waitlisted && a.status === 'pending' && <Chip kind="awaiting">Waiting list</Chip>}
          {!a.insured && <Chip kind="awaiting">No insurance</Chip>}
          {a.insurance_lapses && <Chip kind="awaiting">Cover ends before the market</Chip>}
        </div>
        <p class="meta">
          {a.contact_name} · {a.application_id} · applied {shortDate(a.created_at.slice(0, 10))}
        </p>
        <p class="vendor-card__contact">
          <a href={`mailto:${a.email}`}>
            <Mail size={14} aria-hidden="true" /> {a.email}
          </a>
          <a href={`tel:${a.mobile.replace(/\s+/g, '')}`}>
            <Phone size={14} aria-hidden="true" /> {a.mobile}
          </a>
        </p>
        <p class="vendor-card__text">{a.products}</p>
        {linkLines.length > 0 && (
          <ul class="vendor-card__links">
            {linkLines.map(l => {
              const href = webLink(l);
              return <li key={l}>{href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow">{l}</a> : l}</li>;
            })}
          </ul>
        )}
        <p class="meta">
          Insurance: {a.insured ? `${a.insurer ?? 'yes'}${a.insurance_expiry ? `, until ${shortDate(a.insurance_expiry)} ${a.insurance_expiry.slice(0, 4)}` : ''}` : 'none'}
        </p>
        {a.notes && <p class="vendor-card__text">Note: {a.notes}</p>}
        {a.photos.length > 0 && (
          <div class="vendor-card__photos">
            {a.photos.map((id, i) => (
              <a key={id} href={`/api/staff/market-photos/${id}`} target="_blank" rel="noopener">
                <img src={`/api/staff/market-photos/${id}`} alt={`${a.stall_name}, photo ${i + 1}`} loading="lazy" />
              </a>
            ))}
          </div>
        )}
        {a.decision_note && <p class="meta">Café note: "{a.decision_note}"</p>}
      </div>
      {a.status === 'pending' &&
        (declining ? (
          <div class="stack" style={{ '--gap': '8px' }}>
            <label class="label" for={`vnote-${a.application_id}`}>Note for the vendor (optional)</label>
            <textarea id={`vnote-${a.application_id}`} class="input" rows={2} maxLength={500} value={note} onInput={e => setNote(e.currentTarget.value)}
              placeholder="e.g. We already have two dice makers this time. Do apply for the next one!" />
            <div class="cluster">
              <button type="button" class="btn btn--destructive btn--sm" disabled={busy} onClick={() => decide('decline')}>Decline</button>
              <button type="button" class="btn btn--text btn--sm" onClick={() => setDeclining(false)}>Back</button>
            </div>
          </div>
        ) : (
          <div class="cluster">
            <button type="button" class="btn btn--primary btn--sm" disabled={busy || full} onClick={() => decide('approve')}
              title={full ? 'Every pitch is taken. Add a pitch, or mark an approved vendor as dropped out.' : undefined}>
              <Check size={16} aria-hidden="true" /> Approve
            </button>
            <button type="button" class="btn btn--destructive-quiet btn--sm" disabled={busy} onClick={() => setDeclining(true)}>Decline</button>
            {full && <p class="meta">Every pitch is taken.</p>}
          </div>
        ))}
      {a.status === 'approved' && (
        <div>
          <button type="button" class="btn btn--text btn--sm" disabled={busy} onClick={droppedOut}>
            Mark as dropped out
          </button>
        </div>
      )}
    </article>
  );
}
