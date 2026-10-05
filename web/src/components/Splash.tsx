import { ArrowRight, X } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import type { Occurrence } from '../lib/api';
import { addDays, longDate, nowLondonTime, timeRange, todayLondon } from '../lib/dates';
import { navigate } from '../lib/router';
import { read, write } from '../lib/storage';
import { Logo } from './Brand';
import { eventHref } from './EventCard';
import { EventArt } from './EventArt';

const RECENT_KEY = 'rtd.splash.recent';
const SEEN_KEY = 'rtd.splash.seen';
export const SPLASH_WINDOW_DAYS = 14; // matches settings.splash_window_days

/**
 * Spec §8: a random, promotable event in the next 14 days. Only scheduled
 * public occurrences reach the app; "promotable" here also means it has a
 * start time (regular room bookings in the Standard Diary don't). Prefers
 * artwork, and avoids the last few events shown.
 */
export function pickSplash(occurrences: Occurrence[], today = todayLondon(), now = nowLondonTime()): Occurrence | null {
  const end = addDays(today, SPLASH_WINDOW_DAYS);
  const firstPerEvent = new Map<string, Occurrence>();
  for (const o of occurrences) {
    if (o.status !== 'scheduled' || !o.start_time || o.date < today || o.date > end) continue;
    if (o.date === today && (o.end_time ?? o.start_time) <= now) continue;
    if (!firstPerEvent.has(o.event_id)) firstPerEvent.set(o.event_id, o);
  }
  let pool = [...firstPerEvent.values()];
  const withArt = pool.filter(o => o.image);
  if (withArt.length) pool = withArt;
  const recent = read<string[]>(RECENT_KEY, []);
  const fresh = pool.filter(o => !recent.includes(o.event_id));
  if (fresh.length) pool = fresh;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

export const splashSeenThisSession = () => read(SEEN_KEY, false, 'session');

export function markSplashShown(o: Occurrence): void {
  write(SEEN_KEY, true, 'session');
  write(RECENT_KEY, [o.event_id, ...read<string[]>(RECENT_KEY, []).filter(id => id !== o.event_id)].slice(0, 3));
}

export function Splash({ o, onClose }: { o: Occurrence; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, [onClose]);

  const view = () => {
    onClose();
    navigate(eventHref(o));
  };

  return (
    <div class="splash tone-navy" role="dialog" aria-modal="true" aria-labelledby="splash-title">
      <button ref={closeRef} type="button" class="btn btn--icon btn--outline-inverse splash__close" onClick={onClose} aria-label="Close and go to the app">
        <X size={22} aria-hidden="true" />
      </button>
      <div class="splash__inner">
        <Logo class="splash__logo" eager />
        <EventArt image={o.image} category={o.category} seed={o.event_id} eager />
        <p class="label splash__kicker">Coming up at Roll The Dice</p>
        <h1 id="splash-title" class="hero">
          {o.name}
        </h1>
        <div>
          <p class="splash__date">{longDate(o.date)}</p>
          <p class="splash__date">{timeRange(o.start_time, o.end_time)}</p>
        </div>
        {o.description && <p class="splash__desc">{o.description}</p>}
        <div class="stack" style={{ '--gap': '8px' }}>
          <button type="button" class="btn btn--inverse btn--lg btn--block" onClick={view}>
            View Event
          </button>
          <button type="button" class="btn btn--text" onClick={onClose}>
            Continue to app <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
