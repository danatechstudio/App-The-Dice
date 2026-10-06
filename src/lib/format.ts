// Words for emails and n8n feeds: London dates and times as people say them,
// and HTML escaping for anything a person typed.

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...o });
const LONG = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const SHORT = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const WEEKDAY = fmt({ weekday: 'long' });

/** "Saturday 10 October" */
export const longDate = (iso: string) => LONG.format(at(iso));
/** "Sat 10 Oct" */
export const shortDate = (iso: string) => SHORT.format(at(iso));
/** "Saturday" */
export const weekdayOf = (iso: string) => WEEKDAY.format(at(iso));
/** "10/10/2026", as the Logic Engine stores dates */
export const ukDate = (iso: string) => iso.split('-').reverse().join('/');

/** "19:00" → "7pm", "19:30" → "7:30pm", "12:00" → "12pm" */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

/** "7pm–10pm", or "7pm" without an end */
export const timeLabel = (start: string | null, end: string | null) =>
  start ? (end ? `${clock(start)}–${clock(end)}` : clock(start)) : 'Time to be confirmed';

export const firstName = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] || 'there';

/** "1 place", "3 places" */
export const places = (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]!);
