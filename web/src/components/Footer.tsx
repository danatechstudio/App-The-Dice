import { Download } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { prefersReducedMotion, setReducedMotion } from '../lib/motion';
import { DiceMark } from './Brand';

type InstallEvent = Event & { prompt: () => Promise<void> };
let deferred: InstallEvent | null = null;
const waiting = new Set<() => void>();
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferred = e as InstallEvent;
  waiting.forEach(w => w());
});

export function useInstall() {
  const [can, setCan] = useState(!!deferred);
  useEffect(() => {
    const update = () => setCan(!!deferred);
    waiting.add(update);
    return () => void waiting.delete(update);
  }, []);
  const install = async () => {
    await deferred?.prompt();
    deferred = null;
    setCan(false);
  };
  return { canInstall: can, install };
}

export function Footer() {
  const [reduced, setReduced] = useState(prefersReducedMotion());
  const { canInstall, install } = useInstall();
  return (
    <footer class="footer">
      <div class="container footer__inner">
        <div class="footer__brand">
          <DiceMark />
          <span>Roll The Dice Board Game Café</span>
        </div>
        <div class="cluster">
          {canInstall && (
            <button type="button" class="btn btn--secondary btn--sm" onClick={install}>
              <Download size={16} aria-hidden="true" /> Install the app
            </button>
          )}
          <button
            type="button"
            class="switch"
            role="switch"
            aria-checked={reduced}
            onClick={() => {
              setReducedMotion(!reduced);
              setReduced(!reduced);
            }}
          >
            <span class="switch__track" aria-hidden="true" />
            Reduce motion
          </button>
        </div>
      </div>
    </footer>
  );
}
