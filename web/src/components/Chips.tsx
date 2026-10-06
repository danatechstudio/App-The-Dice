import { Ban, Moon, Sparkles } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import type { Occurrence } from '../lib/api';
import { nowLondonTime, todayLondon } from '../lib/dates';

export type ChipKind =
  | 'today' | 'tonight' | 'booking-open' | 'nearly-full' | 'full' | 'free' | 'new' | 'cancelled'
  | 'category' | 'preview' | 'draft' | 'awaiting' | 'approved' | 'live' | 'completed';

export function Chip({ kind, children }: { kind: ChipKind; children: ComponentChildren }) {
  return <span class={`chip chip--${kind}`}>{children}</span>;
}

const EVENING = '17:00';

/** The status chips an occurrence earns, most important first. Only real data:
 *  no invented urgency. */
export function occurrenceChips(o: Occurrence, today = todayLondon()) {
  const chips: { kind: ChipKind; label: string }[] = [];
  if (o.status === 'cancelled') return [{ kind: 'cancelled' as const, label: 'Cancelled' }];
  if (o.date === today) {
    const ended = o.end_time && o.end_time <= nowLondonTime();
    if (!ended) chips.push(o.start_time && o.start_time >= EVENING ? { kind: 'tonight', label: 'Tonight' } : { kind: 'today', label: 'Today' });
  }
  if (o.bookable && o.status === 'scheduled') chips.push({ kind: 'booking-open', label: 'Book in the app' });
  if (o.price_display && /^free$/i.test(o.price_display.trim())) chips.push({ kind: 'free', label: 'Free' });
  return chips;
}

export function ChipRow({ chips }: { chips: { kind: ChipKind; label: string }[] }) {
  if (!chips.length) return null;
  return (
    <>
      {chips.map(c => (
        <Chip key={c.kind} kind={c.kind}>
          {c.kind === 'tonight' && <Moon aria-hidden="true" />}
          {c.kind === 'cancelled' && <Ban aria-hidden="true" />}
          {c.kind === 'new' && <Sparkles aria-hidden="true" />}
          {c.label}
        </Chip>
      ))}
    </>
  );
}
