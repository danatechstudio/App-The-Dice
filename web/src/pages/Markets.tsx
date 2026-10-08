// Markets for vendors (docs/RTD_MARKETS.md): the markets taking applications,
// and the form to apply for a pitch. No account; the café team emails back.

import { CalendarDays, CircleCheck, Clock, ImagePlus, Info, PoundSterling, Send, Store, Trash2, UsersRound } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { DiceLoader, EmptyState, ErrorState } from '../components/States';
import { useApi } from '../lib/api';
import { longDate, shortDate, timeRange } from '../lib/dates';
import { hostApi } from '../lib/hostApi';
import { MAX_PHOTOS, shrinkPhoto, type PublicMarket } from '../lib/markets';
import { useTitle } from '../lib/title';
import { toast } from '../lib/toast';

function pitchesText(m: PublicMarket) {
  if (!m.open) return 'Applications closed';
  if (m.pitches_left === 0) return 'All pitches taken: join the waiting list';
  return `${m.pitches_left} of ${m.pitches} ${m.pitches === 1 ? 'pitch' : 'pitches'} left`;
}

function MarketFacts({ m }: { m: PublicMarket }) {
  return (
    <div class="facts">
      <div class="fact">
        <span class="fact__icon"><CalendarDays size={20} aria-hidden="true" /></span>
        <span><strong>{longDate(m.event_date)}</strong>{timeRange(m.start_time, m.end_time)}</span>
      </div>
      <div class="fact">
        <span class="fact__icon"><PoundSterling size={20} aria-hidden="true" /></span>
        <span><strong>{m.pitch_fee === 'Free' ? 'No pitch fee' : `${m.pitch_fee} pitch fee`}</strong>Paid once you're approved</span>
      </div>
      <div class="fact">
        <span class="fact__icon"><UsersRound size={20} aria-hidden="true" /></span>
        <span><strong>{pitchesText(m)}</strong>{m.open ? `Apply by ${longDate(m.applications_close)}` : ''}</span>
      </div>
    </div>
  );
}

/** /markets: every market still to come. */
export function Markets() {
  useTitle('Sell at our markets');
  const { data, error, loading } = useApi<{ markets: PublicMarket[] }>('/api/markets');
  return (
    <div class="container">
      <header class="page-head">
        <p class="label">Markets</p>
        <h1>Sell at our markets</h1>
      </header>
      <div class="notice notice--info">
        <Store size={22} aria-hidden="true" />
        <div>
          <strong>Makers, crafters and small traders welcome.</strong>
          <p>A few times a year the café fills with stalls. Pick a market, tell us about your stall, and the café team will email you with their decision.</p>
        </div>
      </div>
      <section class="section" aria-labelledby="markets-list">
        <h2 id="markets-list" class="visually-hidden">Markets</h2>
        {loading && !data && <DiceLoader label="Loading markets..." />}
        {error && !data && <ErrorState error={error} />}
        {data && !data.markets.length && (
          <EmptyState title="No markets are coming up just now." text="Check back soon: new markets are added here first." />
        )}
        <div class="list">
          {data?.markets.map(m => (
            <article class="card card--pad market-card" key={m.market_id}>
              <h3 class="display">{m.name}</h3>
              <MarketFacts m={m} />
              {m.open ? (
                <a class="btn btn--primary" href={`/markets/${m.market_id}`}>
                  Apply for a pitch
                </a>
              ) : (
                <a class="btn btn--secondary" href={`/markets/${m.market_id}`}>
                  See the details
                </a>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

/** /markets/:id: one market, and the application form. */
export function MarketPage({ marketId }: { marketId: string }) {
  const { data, error, loading } = useApi<{ market: PublicMarket }>(`/api/markets/${encodeURIComponent(marketId)}`);
  const m = data?.market;
  useTitle(m ? `Apply: ${m.name}` : 'Market');
  if (loading && !m) return <DiceLoader label="Loading the market..." />;
  if (!m) {
    return (
      <div class="container">
        {error?.status === 404 ? (
          <EmptyState title="We couldn't find that market." text="It may have finished. See what's coming up.">
            <a class="btn btn--primary" href="/markets">All markets</a>
          </EmptyState>
        ) : (
          <ErrorState error={error} />
        )}
      </div>
    );
  }
  return (
    <div class="container">
      <header class="page-head">
        <p class="label">
          <a href="/markets">Markets</a>
        </p>
        <h1>{m.name}</h1>
      </header>
      <div class="market-page">
        <div class="stack" style={{ '--gap': '16px' }}>
          <MarketFacts m={m} />
          {m.description && <p class="market-page__about">{m.description}</p>}
          {m.occurrence_id && (
            <p>
              <a href={`/event/${m.occurrence_id}`}>See it in the diary</a>
            </p>
          )}
        </div>
        {m.open ? (
          <VendorForm m={m} />
        ) : (
          <div class="notice notice--warning">
            <Info size={20} aria-hidden="true" />
            <p>Applications for this market have closed. <a href="/markets">See other markets</a>.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY = {
  stall_name: '',
  contact_name: '',
  email: '',
  mobile: '',
  products: '',
  links: '',
  insured: null as boolean | null,
  insurer: '',
  insurance_expiry: '',
  notes: '',
  website: '',
};

function VendorForm({ m }: { m: PublicMarket }) {
  const [f, setF] = useState(EMPTY);
  const [photos, setPhotos] = useState<{ key: number; url: string }[]>([]);
  const [reading, setReading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ application_id: string; waitlisted: boolean } | null>(null);
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setF(x => ({ ...x, [k]: v }));

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_PHOTOS - photos.length;
    if (files.length > room) toast(room ? `Only ${room} more ${room === 1 ? 'photo' : 'photos'} can be added.` : `Up to ${MAX_PHOTOS} photos.`);
    setReading(true);
    const added: { key: number; url: string }[] = [];
    for (const file of [...files].slice(0, room)) {
      const url = await shrinkPhoto(file);
      if (url) added.push({ key: Date.now() + Math.random(), url });
      else toast(`"${file.name}" couldn't be read. Try a JPEG or PNG.`);
    }
    setReading(false);
    setPhotos(p => [...p, ...added].slice(0, MAX_PHOTOS));
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const missing: Record<string, string> = {};
    if (f.stall_name.trim().length < 2) missing.stall_name = 'Enter your stall or business name.';
    if (f.contact_name.trim().length < 2) missing.contact_name = 'Enter your name.';
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) missing.email = 'Enter an email address, like name@example.com.';
    if (f.mobile.trim().length < 7) missing.mobile = 'Enter a mobile number, so we can reach you on the day.';
    if (f.products.trim().length < 10) missing.products = 'Tell us what you sell (at least a few words).';
    if (f.insured === null) missing.insured = 'Say whether you have public liability insurance.';
    if (f.insured && !f.insurer.trim()) missing.insurer = 'Enter your insurer.';
    if (f.insured && !f.insurance_expiry) missing.insurance_expiry = 'Enter the date your cover ends.';
    if (Object.keys(missing).length) {
      setErrors(missing);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.vendor-form .field--error input, .vendor-form .field--error textarea, .vendor-form .field--error button')?.focus());
      return;
    }
    setBusy(true);
    const res = await hostApi<{ application: { application_id: string; waitlisted: boolean } }>(`/api/markets/${m.market_id}/apply`, {
      ...f,
      insured: f.insured,
      photos: photos.map(p => ({ data: p.url })),
    });
    setBusy(false);
    if (res.ok) {
      setDone(res.data.application);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (res.kind === 'invalid' && res.errors) {
      setErrors(res.errors);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.vendor-form .field--error input, .vendor-form .field--error textarea, .vendor-form .field--error button')?.focus());
    } else toast(res.error);
  };

  if (done) {
    return (
      <section class="booking booking--done" aria-live="polite">
        <CircleCheck size={28} aria-hidden="true" />
        <h2 class="display">Application sent.</h2>
        <p>
          Your reference is <strong>{done.application_id}</strong>.
        </p>
        <p class="meta">
          {done.waitlisted
            ? "Every pitch has been taken for now, so you're on the waiting list. We've emailed you a copy, and the café team will be in touch if a pitch frees up."
            : "We've emailed you a copy. The café team will look at your application and email you with their decision."}
        </p>
      </section>
    );
  }

  const field = (k: string) => ({
    class: `field${errors[k] ? ' field--error' : ''}`,
    describedBy: errors[k] ? `v-${k}-error` : undefined,
    error: errors[k] ? <p id={`v-${k}-error`} class="field__error">{errors[k]}</p> : null,
  });
  const stall = field('stall_name');
  const contact = field('contact_name');
  const email = field('email');
  const mobile = field('mobile');
  const products = field('products');
  const links = field('links');
  const insured = field('insured');
  const insurer = field('insurer');
  const expiry = field('insurance_expiry');
  const photoField = field('photos');
  const notes = field('notes');

  return (
    <section class="card card--pad vendor-form" aria-labelledby="apply-title">
      <h2 id="apply-title" class="display">
        <Send size={20} aria-hidden="true" /> Apply for a pitch
      </h2>
      {m.pitches_left === 0 && (
        <div class="notice notice--warning">
          <Clock size={20} aria-hidden="true" />
          <p>Every pitch has been taken for now. You can still apply: you'll go on the waiting list.</p>
        </div>
      )}
      <form class="stack" style={{ '--gap': '18px' }} onSubmit={submit} noValidate>
        <div class={stall.class}>
          <label for="v-stall">Stall or business name</label>
          <input id="v-stall" class="input" value={f.stall_name} maxLength={80} autoComplete="organization" aria-invalid={!!errors.stall_name}
            aria-describedby={stall.describedBy} onInput={e => set('stall_name', e.currentTarget.value)} />
          {stall.error}
        </div>
        <div class={contact.class}>
          <label for="v-contact">Your name</label>
          <input id="v-contact" class="input" value={f.contact_name} maxLength={60} autoComplete="name" aria-invalid={!!errors.contact_name}
            aria-describedby={contact.describedBy} onInput={e => set('contact_name', e.currentTarget.value)} />
          {contact.error}
        </div>
        <div class="field-row">
          <div class={email.class}>
            <label for="v-email">Email</label>
            <input id="v-email" class="input" type="email" value={f.email} autoComplete="email" aria-invalid={!!errors.email}
              aria-describedby={email.describedBy} onInput={e => set('email', e.currentTarget.value)} />
            {email.error}
          </div>
          <div class={mobile.class}>
            <label for="v-mobile">Mobile</label>
            <input id="v-mobile" class="input" type="tel" value={f.mobile} autoComplete="tel" aria-invalid={!!errors.mobile}
              aria-describedby={mobile.describedBy} onInput={e => set('mobile', e.currentTarget.value)} />
            {mobile.error}
          </div>
        </div>
        <div class={products.class}>
          <label for="v-products">What do you sell?</label>
          <textarea id="v-products" class="input" rows={4} maxLength={1000} value={f.products} aria-invalid={!!errors.products}
            aria-describedby={`v-products-hint${products.describedBy ? ` ${products.describedBy}` : ''}`}
            placeholder="e.g. Hand-painted miniatures and dice trays, £5 to £40" onInput={e => set('products', e.currentTarget.value)} />
          <p id="v-products-hint" class="field__hint">The kind of things, and a rough price range.</p>
          {products.error}
        </div>
        <div class={links.class}>
          <label for="v-links">
            Website or social links <span class="field__optional">optional</span>
          </label>
          <textarea id="v-links" class="input" rows={2} maxLength={500} value={f.links} aria-describedby={`v-links-hint${links.describedBy ? ` ${links.describedBy}` : ''}`}
            placeholder="instagram.com/yourstall" onInput={e => set('links', e.currentTarget.value)} />
          <p id="v-links-hint" class="field__hint">Instagram, Facebook, Etsy or a website, one per line, so we can see your work.</p>
          {links.error}
        </div>

        <fieldset class={insured.class}>
          <legend>Do you have public liability insurance?</legend>
          <div class="segmented segmented--inline" role="group" aria-label="Public liability insurance" aria-describedby={insured.describedBy}>
            <button type="button" aria-pressed={f.insured === true} onClick={() => set('insured', true)}>Yes</button>
            <button type="button" aria-pressed={f.insured === false} onClick={() => set('insured', false)}>No</button>
          </div>
          {insured.error}
        </fieldset>
        {f.insured && (
          <div class="field-row">
            <div class={insurer.class}>
              <label for="v-insurer">Insurer</label>
              <input id="v-insurer" class="input" value={f.insurer} maxLength={80} aria-invalid={!!errors.insurer} aria-describedby={insurer.describedBy}
                onInput={e => set('insurer', e.currentTarget.value)} />
              {insurer.error}
            </div>
            <div class={expiry.class}>
              <label for="v-expiry">Cover ends</label>
              <input id="v-expiry" class="input" type="date" value={f.insurance_expiry} aria-invalid={!!errors.insurance_expiry}
                aria-describedby={expiry.describedBy} onInput={e => set('insurance_expiry', e.currentTarget.value)} />
              {expiry.error}
            </div>
          </div>
        )}

        <fieldset class={photoField.class}>
          <legend id="v-photos-label">
            Photos of your stall or products <span class="field__optional">optional, up to {MAX_PHOTOS}</span>
          </legend>
          <p id="v-photos-hint" class="field__hint">Only the café team sees them.</p>
          {photos.length > 0 && (
            <ul class="photo-picks" aria-label="Photos added">
              {photos.map((p, i) => (
                <li key={p.key}>
                  <img src={p.url} alt={`Photo ${i + 1}`} />
                  <button type="button" class="btn btn--icon btn--secondary" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos(list => list.filter(x => x.key !== p.key))}>
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {photos.length < MAX_PHOTOS && (
            <label class="btn btn--secondary photo-picks__add">
              <ImagePlus size={18} aria-hidden="true" /> {reading ? 'Adding...' : photos.length ? 'Add another photo' : 'Add photos'}
              <input type="file" accept="image/*" multiple class="visually-hidden" aria-labelledby="v-photos-label" aria-describedby="v-photos-hint"
                disabled={reading} onChange={e => (addPhotos(e.currentTarget.files), (e.currentTarget.value = ''))} />
            </label>
          )}
          {photoField.error}
        </fieldset>

        <div class={notes.class}>
          <label for="v-notes">
            Anything else we should know? <span class="field__optional">optional</span>
          </label>
          <textarea id="v-notes" class="input" rows={2} maxLength={500} value={f.notes} aria-describedby={notes.describedBy}
            placeholder="e.g. I need to be near a plug for lights" onInput={e => set('notes', e.currentTarget.value)} />
          {notes.error}
        </div>
        {/* Robots fill in every field; people never see this one. */}
        <div class="visually-hidden" aria-hidden="true">
          <label for="v-website">Leave this empty</label>
          <input id="v-website" tabIndex={-1} autoComplete="off" value={f.website} onInput={e => set('website', e.currentTarget.value)} />
        </div>
        {errors.form && <p class="field__error">{errors.form}</p>}
        <button type="submit" class="btn btn--primary btn--lg btn--block" disabled={busy || reading}>
          {busy ? 'Sending...' : 'Send application'}
        </button>
        <p class="meta">
          {m.pitch_fee === 'Free' ? 'There is no pitch fee. ' : `If you're approved, we'll email you how to pay the ${m.pitch_fee} pitch fee. `}
          The café team sees everything on this form. <a href="/privacy">How we use your details</a>
        </p>
      </form>
    </section>
  );
}

/** On a market's diary page: where vendors apply. */
export function MarketVendorPanel({ marketId }: { marketId: string }) {
  const { data } = useApi<{ market: PublicMarket }>(`/api/markets/${encodeURIComponent(marketId)}`);
  const m = data?.market;
  if (!m?.open) return null;
  return (
    <div class="notice notice--info">
      <Store size={20} aria-hidden="true" />
      <div>
        <strong>Want a stall?</strong>
        <p>
          {m.pitches_left ? `${m.pitches_left} ${m.pitches_left === 1 ? 'pitch' : 'pitches'} left` : 'Waiting list open'}, applications close{' '}
          {shortDate(m.applications_close)}. <a href={`/markets/${m.market_id}`}>Apply for a pitch</a>
        </p>
      </div>
    </div>
  );
}
