// Dates arrive as London calendar dates (YYYY-MM-DD) and wall-clock times
// (HH:MM), so they are formatted as-is, never shifted through a time zone.

const LONDON = 'Europe/London';

export function todayLondon(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LONDON, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function nowLondonTime(now = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}

const asUtc = (iso: string) => new Date(`${iso}T12:00:00Z`);

export function addDays(iso: string, days: number): string {
  const d = asUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((asUtc(to).getTime() - asUtc(from).getTime()) / 86_400_000);
}

const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(asUtc(iso));

/** Fri 23 Oct */
export const shortDate = (iso: string) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
/** Friday 23 October */
export const longDate = (iso: string) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' });
/** Friday */
export const weekday = (iso: string) => fmt(iso, { weekday: 'long' });
/** 23 */
export const dayOfMonth = (iso: string) => fmt(iso, { day: 'numeric' });
/** OCT */
export const monthShort = (iso: string) => fmt(iso, { month: 'short' });

/** "18:30" → "6:30 PM", "19:00" → "7 PM" */
export function formatTime(hhmm: string | null): string | null {
  if (!hhmm) return null;
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
}

export function timeRange(start: string | null, end: string | null): string | null {
  const s = formatTime(start);
  if (!s) return null;
  const e = formatTime(end);
  return e ? `${s} – ${e}` : s;
}

/** "Today", "Tomorrow", or "Fri 23 Oct" */
export function dayLabel(iso: string, today = todayLondon()): string {
  const diff = daysBetween(today, iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return shortDate(iso);
}

/** "Fri 23 Oct · 6:30 PM", or "· Time TBC" when the diary has no time. */
export function whenLabel(o: { date: string; start_time: string | null }, today = todayLondon()): string {
  return `${dayLabel(o.date, today)} · ${formatTime(o.start_time) ?? 'Time TBC'}`;
}
