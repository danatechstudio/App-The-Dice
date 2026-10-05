// Turns raw Logic Engine rows (as read by n8n's Google Sheets node) into clean
// event records. Pure: no I/O, so every rule here is unit-tested.

import { parseClock, parseSheetDate } from '../lib/time';

export const CATEGORIES = ['Gaming', 'Quiz', 'Social', 'Club', 'Tournament', 'Market', 'Workshop', 'Other'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Visibility = 'public' | 'app_bookable' | 'private' | 'hidden';
export type Frequency = 'weekly' | 'fortnightly' | 'monthly' | 'one-off';
export type Source = 'event_index' | 'standard_diary';
export type SheetRow = Record<string, unknown>;

export interface NormalisedEvent {
  event_id: string;
  source: Source;
  source_row: number | null;
  event_name: string;
  display_name: string;
  category: Category | null;
  description: string | null;
  frequency: Frequency;
  repeatable: boolean;
  requires_redating: boolean;
  visibility: Visibility;
  sheet_status: string | null;
  active: boolean;
  photo_folder_id: string | null;
  /** The single date the Logic Engine currently holds for this event, if valid. */
  next: { date: string; start_time: string | null; end_time: string | null; all_day: boolean } | null;
}

export interface SyncWarning {
  code: 'missing_event_id' | 'duplicate_event_id' | 'invalid_date' | 'unknown_visibility' | 'unknown_category';
  source: Source;
  row: number | null;
  event_name: string;
  detail: string;
}

const EVENT_ID = /^RTD-EVT-\d{5,}$/;

const text = (v: unknown): string => String(v ?? '').trim();
const orNull = (s: string): string | null => (s === '' ? null : s);

function rowNumber(row: SheetRow): number | null {
  const n = Number(row['row_number']);
  return Number.isInteger(n) ? n : null;
}

export function visibilityOf(raw: unknown): Visibility | undefined {
  const v = text(raw).toLowerCase().replace(/[\s_-]+/g, ' ');
  if (v === '' || v === 'hidden') return 'hidden';
  if (v === 'public') return 'public';
  if (v === 'app bookable' || v === 'bookable') return 'app_bookable';
  if (v === 'private' || v === 'link only' || v === 'private / link only' || v === 'private link only') return 'private';
  return undefined;
}

export function frequencyOf(raw: unknown): Frequency {
  const f = text(raw).toLowerCase();
  if (f === 'weekly') return 'weekly';
  if (f === 'bi-weekly' || f === 'biweekly' || f === 'two-weekly' || f === 'fortnightly') return 'fortnightly';
  if (f === 'monthly') return 'monthly';
  return 'one-off';
}

/**
 * "Home Education Support ClubM" -> "Home Education Support Club": the sheet
 * tells same-named rows apart with a trailing weekday initial. Only M/T/W/F/S
 * after a lower-case letter is stripped, so names like "DnD" survive.
 */
export function displayNameOf(name: string): string {
  return name.replace(/([a-z])[MTWFS]$/, '$1').trim();
}

export function normaliseRows(
  source: Source,
  rows: SheetRow[],
): { events: NormalisedEvent[]; warnings: SyncWarning[]; skippedIds: string[] } {
  const isIndex = source === 'event_index';
  const nameKey = isIndex ? 'Event Name' : 'Group';
  const warnings: SyncWarning[] = [];
  const candidates: NormalisedEvent[] = [];

  for (const row of rows) {
    const name = text(row[nameKey]);
    if (!name) continue; // blank / ghost row
    const rowNo = rowNumber(row);
    const warn = (code: SyncWarning['code'], detail: string) =>
      warnings.push({ code, source, row: rowNo, event_name: name, detail });

    const eventId = text(row['Event ID']);
    if (!EVENT_ID.test(eventId)) {
      warn('missing_event_id', eventId ? `'${eventId}' is not an RTD-EVT id` : 'Event ID is blank');
      continue;
    }

    let visibility = visibilityOf(row['App Visibility']);
    if (!visibility) {
      warn('unknown_visibility', `'${text(row['App Visibility'])}' treated as Hidden`);
      visibility = 'hidden';
    }

    const categoryRaw = text(row['App Category']);
    let category: Category | null = null;
    if (categoryRaw) {
      category = CATEGORIES.find(c => c.toLowerCase() === categoryRaw.toLowerCase()) ?? null;
      if (!category) {
        warn('unknown_category', `'${categoryRaw}' treated as Other`);
        category = 'Other';
      }
    }

    const dateRaw = row[isIndex ? 'Event Date' : 'Date'];
    const date = parseSheetDate(dateRaw);
    if (!date && text(dateRaw)) warn('invalid_date', `'${text(dateRaw)}' is not a date`);
    const start = isIndex ? parseClock(row['Event Time']) : null;
    const end = isIndex && start ? parseClock(row['End Time']) : null;

    const frequency = frequencyOf(row['Frequency']);
    const status = text(row['Status']);
    candidates.push({
      event_id: eventId,
      source,
      source_row: rowNo,
      event_name: name,
      display_name: displayNameOf(name),
      category,
      description: orNull(text(row[isIndex ? 'Base Details' : 'Notes'])),
      frequency,
      repeatable: frequency !== 'one-off',
      // Event Index one-offs and monthlies are expired by RTD Event Guard and re-dated by hand.
      requires_redating: isIndex && (frequency === 'one-off' || frequency === 'monthly'),
      visibility,
      sheet_status: orNull(status),
      // Event Index: only an explicit Active counts. Standard Diary has no Status column.
      active: isIndex ? status.toLowerCase() === 'active' : status === '' || status.toLowerCase() === 'active',
      photo_folder_id: orNull(text(row['Photo Folder ID'])),
      next: date ? { date, start_time: start, end_time: end, all_day: start === null } : null,
    });
  }

  // An id used twice is ambiguous: skip every row carrying it rather than guess.
  const counts = new Map<string, number>();
  for (const e of candidates) counts.set(e.event_id, (counts.get(e.event_id) ?? 0) + 1);
  const skippedIds = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  const events = candidates.filter(e => {
    if ((counts.get(e.event_id) ?? 0) === 1) return true;
    warnings.push({
      code: 'duplicate_event_id',
      source,
      row: e.source_row,
      event_name: e.event_name,
      detail: `${e.event_id} appears on more than one row`,
    });
    return false;
  });

  return { events, warnings, skippedIds };
}
