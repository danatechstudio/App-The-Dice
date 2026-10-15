// The update screen: shown over everything once a newer build is live, with
// one way out, Update now (lib/update.ts).

import { RefreshCw } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { applyUpdate, useUpdateAvailable } from '../lib/update';

export function UpdatePrompt({ path }: { path: string }) {
  const available = useUpdateAvailable(path);
  const button = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (available) button.current?.focus();
  }, [available]);
  if (!available) return null;
  return (
    <div class="sheet-backdrop update-backdrop">
      <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-text">
        <img class="sheet__icon" src="/icons/icon-192.png" width={56} height={56} alt="" />
        <h2 id="update-title" class="display">
          A new version is ready
        </h2>
        <p id="update-text">We've updated Roll The Dice. Update now to carry on: it only takes a second.</p>
        <button
          ref={button}
          type="button"
          class="btn btn--primary btn--lg btn--block"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void applyUpdate();
          }}
        >
          <RefreshCw size={20} aria-hidden="true" /> {busy ? 'Updating...' : 'Update now'}
        </button>
      </div>
    </div>
  );
}
