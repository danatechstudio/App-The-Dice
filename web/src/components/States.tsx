import { Dice1, Dice2, Dice3, Dice4, Dice5, Dice6, Dices } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { prefersReducedMotion } from '../lib/motion';
import type { ApiError } from '../lib/api';

const FACES = [Dice1, Dice2, Dice3, Dice4, Dice5, Dice6];

/** A tumbling die instead of a spinner. Static (face five) with reduced motion. */
export function DiceLoader({ label = "Loading what's happening..." }: { label?: string }) {
  const [face, setFace] = useState(4);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const id = setInterval(() => setFace(f => (f + 1) % 6), 900);
    return () => clearInterval(id);
  }, []);
  const Face = FACES[face]!;
  return (
    <div class="state" role="status">
      <span class="dice-loader" aria-hidden="true">
        <Face size={40} strokeWidth={1.75} />
      </span>
      <p class="state__text">{label}</p>
    </div>
  );
}

export function EmptyState({ title, text, children }: { title: string; text?: string; children?: ComponentChildren }) {
  return (
    <div class="state">
      <Dices class="state__art" size={44} strokeWidth={1.5} aria-hidden="true" />
      <p class="state__title">{title}</p>
      {text && <p class="state__text">{text}</p>}
      {children}
    </div>
  );
}

/** Customer-facing error: branded words, plain next step. */
export function ErrorState({ error, onRetry }: { error?: ApiError; onRetry?: () => void }) {
  const offline = error?.status === 0;
  return (
    <div class="state" role="alert">
      <Dices class="state__art" size={44} strokeWidth={1.5} aria-hidden="true" />
      <p class="state__title">That didn't roll properly.</p>
      <p class="state__text">{offline ? "You look to be offline. Check your connection and we'll try again." : 'Please try again.'}</p>
      {onRetry && (
        <button type="button" class="btn btn--secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Staff-facing error: keeps the technical detail people need to act. */
export function StaffError({ status, message, action }: { status: number; message: string; action: string }) {
  return (
    <div class="staff-error" role="alert">
      <strong>Request failed ({status})</strong>
      <p>
        <code>{message}</code>
      </p>
      <p>{action}</p>
    </div>
  );
}
