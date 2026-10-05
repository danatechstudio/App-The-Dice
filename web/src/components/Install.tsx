import { Download, Ellipsis, Share, SquarePlus, X } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import { useInstall } from '../lib/install';

/** Slim "get the app" strip at the very top of every page. */
export function InstallBanner() {
  const { bannerMode, install, dismiss } = useInstall();
  if (!bannerMode) return null;
  return (
    <aside class="install-banner" aria-label="Install the app">
      <div class="container install-banner__inner">
        <img class="install-banner__icon" src="/icons/icon-192.png" width={44} height={44} alt="" />
        <p class="install-banner__text">
          <strong>Roll The Dice app</strong>
          <span>{bannerMode === 'in-app' ? 'Open in your browser to install' : 'Free. Adds to your home screen.'}</span>
        </p>
        <button type="button" class="btn btn--primary btn--sm" onClick={install}>
          <Download size={16} aria-hidden="true" /> Install
        </button>
        <button type="button" class="btn btn--icon btn--text install-banner__close" onClick={dismiss} aria-label="Not now">
          <X size={20} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}

/** Footer link, still there after the banner is closed. */
export function InstallLink() {
  const { footerMode, install } = useInstall();
  if (!footerMode) return null;
  return (
    <button type="button" class="btn btn--secondary btn--sm" onClick={install}>
      <Download size={16} aria-hidden="true" /> Install the app
    </button>
  );
}

/** Step-by-step help where the browser has no install button. */
export function InstallHelp() {
  const { helpMode, closeHelp } = useInstall();
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!helpMode) return;
    done.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeHelp();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [helpMode]);
  if (!helpMode) return null;

  const inApp = helpMode === 'in-app';
  return (
    <div class="sheet-backdrop" onClick={e => e.target === e.currentTarget && closeHelp()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="install-help-title">
        <img class="sheet__icon" src="/icons/icon-192.png" width={56} height={56} alt="" />
        <h2 id="install-help-title" class="display">
          {inApp ? 'Open in your browser first' : 'Add Roll The Dice to your home screen'}
        </h2>
        {inApp ? (
          <ol class="steps" role="list">
            <li>
              <span class="steps__icon"><Ellipsis size={20} aria-hidden="true" /></span>
              <span>Tap the <strong>⋯</strong> menu, usually at the top right.</span>
            </li>
            <li>
              <span class="steps__icon">2</span>
              <span>Choose <strong>Open in browser</strong> (or Open in Safari / Chrome).</span>
            </li>
            <li>
              <span class="steps__icon">3</span>
              <span>Tap <strong>Install</strong> at the top of the page.</span>
            </li>
          </ol>
        ) : (
          <ol class="steps" role="list">
            <li>
              <span class="steps__icon"><Share size={20} aria-hidden="true" /></span>
              <span>Tap the <strong>Share</strong> button in the browser bar.</span>
            </li>
            <li>
              <span class="steps__icon"><SquarePlus size={20} aria-hidden="true" /></span>
              <span>Scroll down and tap <strong>Add to Home Screen</strong>.</span>
            </li>
            <li>
              <span class="steps__icon">3</span>
              <span>Tap <strong>Add</strong>. Roll The Dice appears with your other apps.</span>
            </li>
          </ol>
        )}
        <button ref={done} type="button" class="btn btn--primary btn--block" onClick={closeHelp}>
          Got it
        </button>
      </div>
    </div>
  );
}
