// "Interested in joining? Get in touch!" on a private game's page, instead of booking
// (docs/superpowers/specs/2026-10-18-private-events-design.md). The message goes to the café,
// and to the host for a host's session; they reply by email.

import { MessageCircle } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { Occurrence } from '../lib/api';
import { hostApi } from '../lib/hostApi';

const MESSAGE_MAX = 1000;

export function JoinPanel({ o }: { o: Occurrence }) {
  const [f, setF] = useState({ name: '', email: '', message: '', consent: false, website: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }));

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const res = await hostApi<{ ok: true }>(`/api/occurrences/${o.occurrence_id}/enquiry`, f);
    setBusy(false);
    if (res.ok) return setSent(true);
    if (res.kind === 'invalid' && res.errors) {
      setErrors(res.errors);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.join .field--error input, .join .field--error textarea')?.focus());
    } else setErrors({ form: res.error });
  };
  const field = (k: string) => ({
    class: `field${errors[k] ? ' field--error' : ''}`,
    describedBy: errors[k] ? `j-${k}-error` : undefined,
    error: errors[k] ? (
      <p id={`j-${k}-error`} class="field__error">
        {errors[k]}
      </p>
    ) : null,
  });
  const name = field('name');
  const email = field('email');
  const message = field('message');
  const consent = field('consent');

  return (
    <section class="booking join" aria-labelledby="join-title">
      <div class="booking__head">
        <h2 id="join-title" class="display">
          <MessageCircle size={20} aria-hidden="true" /> Interested in joining? Get in touch!
        </h2>
        <p class="meta">This is a private game. Send a message and the organiser will reply by email.</p>
      </div>
      {sent ? (
        <div class="notice notice--info" role="status">
          <div>
            <strong>Message sent.</strong>
            <p>The organiser will reply to {f.email} by email. Keep an eye on your inbox (and spam folder).</p>
          </div>
        </div>
      ) : (
        <form class="stack" style={{ '--gap': '14px' }} onSubmit={submit} noValidate>
          <div class={name.class}>
            <label for="j-name">Your name</label>
            <input
              id="j-name"
              class="input"
              value={f.name}
              maxLength={80}
              autoComplete="name"
              required
              aria-invalid={!!errors.name}
              aria-describedby={name.describedBy}
              onInput={e => set('name', e.currentTarget.value)}
            />
            {name.error}
          </div>
          <div class={email.class}>
            <label for="j-email">Email</label>
            <input
              id="j-email"
              class="input"
              type="email"
              value={f.email}
              autoComplete="email"
              required
              aria-invalid={!!errors.email}
              aria-describedby={email.describedBy}
              onInput={e => set('email', e.currentTarget.value)}
            />
            {email.error}
          </div>
          <div class={message.class}>
            <label for="j-message">Your message</label>
            <textarea
              id="j-message"
              class="input"
              rows={4}
              maxLength={MESSAGE_MAX}
              value={f.message}
              required
              aria-invalid={!!errors.message}
              aria-describedby={['j-message-count', message.describedBy].filter(Boolean).join(' ')}
              placeholder="Say hello, how often you play, and anything you'd like to ask."
              onInput={e => set('message', e.currentTarget.value)}
            />
            <p id="j-message-count" class="field__hint">
              {f.message.length} / {MESSAGE_MAX}
            </p>
            {message.error}
          </div>
          <div class={consent.class}>
            <label class="cluster" style={{ '--gap': '8px', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <input
                type="checkbox"
                checked={f.consent}
                aria-describedby={consent.describedBy}
                onChange={e => set('consent', e.currentTarget.checked)}
                style={{ marginTop: '4px' }}
              />
              <span>I'm happy for my name, email and message to go to the café and the game's organiser, so they can reply.</span>
            </label>
            {consent.error}
          </div>
          {/* Robots fill in every field; people never see this one. */}
          <div class="visually-hidden" aria-hidden="true">
            <label for="j-website">Leave this empty</label>
            <input id="j-website" tabIndex={-1} autoComplete="off" value={f.website} onInput={e => set('website', e.currentTarget.value)} />
          </div>
          {errors.form && (
            <p class="field__error" role="alert">
              {errors.form}
            </p>
          )}
          <button type="submit" class="btn btn--primary btn--lg btn--block" disabled={busy}>
            {busy ? 'Sending...' : 'Send message'}
          </button>
          <p class="meta booking__small">
            Kept for 90 days, then deleted. <a href="/privacy">How we use your details</a>
          </p>
        </form>
      )}
    </section>
  );
}
