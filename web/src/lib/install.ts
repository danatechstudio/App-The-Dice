// Install state for the banner, the footer and the help sheet.
import { useEffect, useState } from 'preact/hooks';
import { installMode, type InstallMode } from './install-mode';
import { read, write } from './storage';
import { count } from './stats';
import { toast } from './toast';

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const DISMISSED_KEY = 'rtd.install.dismissed';
let deferred: PromptEvent | null = null;
let installed = false;
let helpOpen = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

// Registered as early as possible: Chrome can fire this before the app renders.
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); // we show our own banner instead of the browser's mini-bar
  deferred = e as PromptEvent;
  notify();
});

window.addEventListener('appinstalled', () => {
  installed = true;
  deferred = null;
  count('install');
  notify();
  toast('Installed. Find Roll The Dice on your home screen.');
});

const standalone = () =>
  installed || matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function modeFor(respectDismissal: boolean): InstallMode {
  return installMode({
    ua: navigator.userAgent,
    standalone: standalone(),
    canPrompt: !!deferred,
    touchMac: navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1,
    dismissedAt: respectDismissal ? read<number | null>(DISMISSED_KEY, null) : null,
    now: Date.now(),
  });
}

export function useInstall() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const update = () => setTick(t => t + 1);
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);

  /** Install now (Chrome and friends), or show how (iPhone, in-app browsers). */
  async function install() {
    if (deferred) {
      const e = deferred;
      deferred = null; // a prompt can only be used once
      await e.prompt();
      notify();
      return;
    }
    helpOpen = true;
    notify();
  }

  return {
    /** For the top banner: hidden for a while after "Not now". */
    bannerMode: modeFor(true),
    /** For the footer link: always available until installed. */
    footerMode: modeFor(false),
    helpMode: helpOpen ? modeFor(false) : null,
    install,
    dismiss() {
      write(DISMISSED_KEY, Date.now());
      notify();
    },
    closeHelp() {
      helpOpen = false;
      notify();
    },
  };
}
