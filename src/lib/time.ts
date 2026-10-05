// Dates in this app are calendar dates in Europe/London ("YYYY-MM-DD") and
// wall-clock times in Europe/London ("HH:MM"). Instants are ISO strings in UTC.

const TZ = 'Europe/London';
const DAY_MS = 86_400_000;

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Today's date in London for the given instant. */
export function londonDate(instant: Date): string {
  return dateFormat.format(instant);
}

export function addDays(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

function isoFromParts(y: number, m: number, d: number): string | null {
  if (!(y >= 2000 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Parses a Logic Engine date cell. The sheet stores UK text (23/10/2026); ISO
 * and Google serial numbers are accepted too. Free text ("Every Thursday")
 * returns null.
 */
export function parseSheetDate(raw: unknown): string | null {
  if (typeof raw === 'number') {
    if (raw < 20_000 || raw > 80_000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(raw) * DAY_MS).toISOString().slice(0, 10);
  }
  const s = String(raw ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return isoFromParts(y, Number(m[2]), Number(m[1]));
  }
  return null;
}

/** Parses "18:30", "6:30 PM", "6pm" or a sheet time fraction (0.77…) into "HH:MM". */
export function parseClock(raw: unknown): string | null {
  if (typeof raw === 'number') {
    if (!(raw >= 0 && raw < 1)) return null;
    const minutes = Math.round(raw * 1440) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const s = String(raw ?? '').trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  const ampm = m[3];
  if (!m[2] && !ampm) return null; // a bare number is not a time
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'am' && h === 12) h = 0;
    if (ampm === 'pm' && h !== 12) h += 12;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function londonOffsetMinutes(instantMs: number): number {
  const parts = partsFormat.formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instantMs) / 60_000);
}

/** Converts a London wall-clock date and time to a UTC ISO instant (BST-aware). */
export function londonToUtc(dateIso: string, hhmm: string): string {
  const [y, mo, d] = dateIso.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall - londonOffsetMinutes(wall) * 60_000;
  const settled = wall - londonOffsetMinutes(utc) * 60_000;
  if (settled !== utc) utc = settled;
  return new Date(utc).toISOString();
}

/**
 * Start and end instants for an occurrence. A missing end time means a one-hour
 * slot; an end at or before the start runs past midnight (matches the existing
 * calendar sync). No start time means an all-day occurrence.
 */
export function occurrenceInstants(
  dateIso: string,
  start: string | null,
  end: string | null,
): { startsAt: string | null; endsAt: string | null } {
  if (!start) return { startsAt: null, endsAt: null };
  const startsAt = londonToUtc(dateIso, start);
  if (!end) return { startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString() };
  let endsAt = londonToUtc(dateIso, end);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) endsAt = londonToUtc(addDays(dateIso, 1), end);
  return { startsAt, endsAt };
}
