// Add to Calendar (spec §39): name, date, start/end, location, description, URL.
import type { PublicOccurrence } from './queries';
import { addDays } from './time';

type Opts = { origin: string; location: string };

const compactDate = (iso: string) => iso.replace(/-/g, '');
/** 2026-10-23T17:30:00.000Z → 20261023T173000Z */
const compactInstant = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** RFC 5545 text escaping. */
const text = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Fold lines longer than 75 octets (RFC 5545 §3.1), without splitting a character. */
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let current = '';
  for (const ch of line) {
    const limit = out.length ? 74 : 75; // continuation lines start with a space
    if (enc.encode(current + ch).length > limit) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.join('\r\n ');
}

function details(o: PublicOccurrence, url: string): string {
  return [o.description, url].filter(Boolean).join('\n\n');
}

const eventUrl = (o: PublicOccurrence, origin: string) => `${origin}/event/${o.occurrence_id}`;

export function calendarFile(o: PublicOccurrence, opts: Opts & { now: Date }): string {
  const url = eventUrl(o, opts.origin);
  const when =
    o.starts_at && o.ends_at
      ? [`DTSTART:${compactInstant(o.starts_at)}`, `DTEND:${compactInstant(o.ends_at)}`]
      : [`DTSTART;VALUE=DATE:${compactDate(o.date)}`, `DTEND;VALUE=DATE:${compactDate(addDays(o.date, 1))}`];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Roll The Dice//Companion App//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${o.occurrence_id}@${new URL(opts.origin).host}`,
    `DTSTAMP:${compactInstant(opts.now.toISOString())}`,
    ...when,
    `SUMMARY:${text(o.name)}`,
    `DESCRIPTION:${text(details(o, url))}`,
    `LOCATION:${text(opts.location)}`,
    `URL:${url}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(o: PublicOccurrence, opts: Opts): string {
  const dates =
    o.starts_at && o.ends_at
      ? `${compactInstant(o.starts_at)}/${compactInstant(o.ends_at)}`
      : `${compactDate(o.date)}/${compactDate(addDays(o.date, 1))}`;
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: o.name,
    dates,
    details: details(o, eventUrl(o, opts.origin)),
    location: opts.location,
  });
  return `https://calendar.google.com/calendar/render?${q}`;
}
