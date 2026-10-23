// The Logic Engine columns an admin can change from the organiser (Stage 6), in one
// canonical form for both directions: the sync stores them on each event
// (events.sheet_values), an edit records {from, to} in it, and RTD Sheet Writer's row is
// compared in it, so "6:30 PM" and "18:30", or "public" and "Public", are the same value.
// Pure: no I/O.

import { ukDate, weekdayOf } from '../lib/format';
import { parseClock, parseSheetDate } from '../lib/time';
import { CATEGORIES, visibilityOf, type Source, type SheetRow } from './normalise';

/**
 * The columns RTD Event Sync may not send yet (App-driven events, 23 Oct 2026). A row that hasn't
 * got one leaves it out of sheet_values, so the editor shows "not synced yet" and an edit can't
 * take a missing value for a blank one and write over real text in the sheet.
 */
export const EXTRA = {
  event_index: [
    'Frequency',
    'Post Frequency (Days)',
    'Target Post Time',
    'Photo Folder ID',
    "Michelle's Standard Prompt",
    'Michelles KPI Hook Prompt',
    'TikTok Video Blueprint',
    'Banned Phrases',
    'Organiser Email',
    'App Capacity',
    'Approved Facts',
    'People & Roles',
  ],
  standard_diary: ['Frequency', 'Approved Facts', 'People & Roles'],
} as const satisfies Record<Source, readonly string[]>;

/**
 * Editable columns, by tab. Never editable: Day (the writer sets it with a date), Last Post and
 * Next Post (the posting automation's), Event ID, App Host Session, Social Prompt and Social Prompt Status.
 */
export const EDITABLE = {
  event_index: ['Event Name', 'Base Details', 'Event Date', 'Event Time', 'End Time', 'Status', 'App Visibility', 'App Category', 'App Price', ...EXTRA.event_index],
  standard_diary: ['Group', 'Notes', 'Date', 'App Visibility', 'App Category', ...EXTRA.standard_diary],
} as const satisfies Record<Source, readonly string[]>;
export type Column = (typeof EDITABLE)[Source][number];

export const TAB: Record<Source, string> = { event_index: 'Event Index', standard_diary: 'Standard Diary' };

/** Frequency as each tab spells it. Master V1 rolls Two-Weekly on Event Index and Bi-Weekly on the Standard Diary. */
export const FREQUENCIES: Record<Source, readonly string[]> = {
  event_index: ['Weekly', 'Two-Weekly', 'Monthly', 'One-off'],
  standard_diary: ['Weekly', 'Bi-Weekly', 'Monthly'],
};
const FREQUENCY_SPELLING = ['Weekly', 'Two-Weekly', 'Bi-Weekly', 'Monthly', 'One-off'];

type Kind = 'text' | 'long' | 'date' | 'time' | 'status' | 'visibility' | 'category' | 'frequency' | 'whole';
const KIND: Record<Column, Kind> = {
  'Event Name': 'text', Group: 'text', 'Base Details': 'text', Notes: 'text', 'App Price': 'text',
  'Event Date': 'date', Date: 'date', 'Event Time': 'time', 'End Time': 'time',
  Status: 'status', 'App Visibility': 'visibility', 'App Category': 'category',
  Frequency: 'frequency', 'Post Frequency (Days)': 'whole', 'App Capacity': 'whole', 'Target Post Time': 'time',
  'Photo Folder ID': 'text', 'Organiser Email': 'text', 'Banned Phrases': 'long',
  "Michelle's Standard Prompt": 'long', 'Michelles KPI Hook Prompt': 'long', 'TikTok Video Blueprint': 'long',
  'Approved Facts': 'long', 'People & Roles': 'long',
};

const VISIBILITY_CELL: Record<string, string> = { public: 'Public', app_bookable: 'App Bookable', private: 'Private', hidden: 'Hidden' };

const text = (v: unknown) => String(v ?? '').replace(/\r\n?/g, '\n').trim();

export const isColumn = (source: Source, c: string): c is Column => (EDITABLE[source] as readonly string[]).includes(c);
export const isDateColumn = (c: Column) => KIND[c] === 'date';

/**
 * One cell in canonical form: always a string ('' for blank). Anything that doesn't parse
 * is kept as written, so it can never pass for a different, valid value.
 */
export function canon(column: Column, raw: unknown): string {
  const t = text(raw);
  switch (KIND[column]) {
    case 'date':
      return t === '' && typeof raw !== 'number' ? '' : (parseSheetDate(raw) ?? t);
    case 'time':
      return t === '' && typeof raw !== 'number' ? '' : (parseClock(raw) ?? t);
    case 'status':
      return t.toLowerCase() === 'active' ? 'Active' : t.toLowerCase() === 'inactive' ? 'Inactive' : t;
    case 'visibility':
      return visibilityOf(raw) ?? t;
    case 'category':
      return CATEGORIES.find(c => c.toLowerCase() === t.toLowerCase()) ?? t;
    case 'frequency':
      return FREQUENCY_SPELLING.find(f => f.toLowerCase() === t.toLowerCase()) ?? t;
    case 'whole':
      return /^\d{1,6}(?:\.0+)?$/.test(t) ? String(Number(t)) : t;
    default:
      return t;
  }
}

const isExtra = (source: Source, c: Column) => (EXTRA[source] as readonly string[]).includes(c);

/** The editable columns of one sheet row, canonical. A column in EXTRA that the row hasn't got is left out, never ''. */
export function sheetValuesOf(source: Source, row: SheetRow): Record<string, string> {
  return Object.fromEntries(EDITABLE[source].filter(c => !isExtra(source, c) || c in row).map(c => [c, canon(c, row[c])]));
}

/** A canonical value as the sheet stores it (dates DD/MM/YYYY, visibility "App Bookable"...). */
export function cellFor(column: Column, value: string): string {
  if (value === '') return '';
  switch (KIND[column]) {
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? ukDate(value) : value;
    case 'visibility':
      return VISIBILITY_CELL[value] ?? value;
    default:
      return value;
  }
}

/** The cells to write for these changes: Event ID to match on, each column, and Day with a date. */
export function cellsFor(eventId: string, changes: Partial<Record<Column, string>>): Record<string, string> {
  const cells: Record<string, string> = { 'Event ID': eventId };
  for (const [c, v] of Object.entries(changes) as [Column, string][]) {
    cells[c] = cellFor(c, v);
    if (isDateColumn(c) && /^\d{4}-\d{2}-\d{2}$/.test(v)) cells.Day = weekdayOf(v);
  }
  return cells;
}

export type Fields = Partial<Record<Column, { from: string; to: string }>>;

export type Check =
  | { action: 'write'; changes: Partial<Record<Column, string>>; found: Record<string, string> }
  | { action: 'none'; found: Record<string, string> }
  | { action: 'conflict'; columns: Column[]; found: Record<string, string> }
  | { action: 'error'; error: string };

/**
 * The writer's rows (the tab, or the rows it found by Event ID) against an edit. Exactly one
 * row must carry the Event ID. Per column: the sheet still holds `from` → write it; it already
 * holds `to` → nothing to do; anything else → a conflict, and nothing is written at all.
 */
export function checkRows(source: Source, eventId: string, fields: Fields, rows: SheetRow[]): Check {
  const tab = TAB[source];
  const mine = rows.filter(r => text(r['Event ID']) === eventId);
  if (!mine.length) return { action: 'error', error: `No row in ${tab} has Event ID ${eventId}` };
  if (mine.length > 1) return { action: 'error', error: `${eventId} is on ${mine.length} rows in ${tab}: fix the copy in the sheet` };
  const row = mine[0]!;
  const found: Record<string, string> = {};
  const changes: Partial<Record<Column, string>> = {};
  const clashes: Column[] = [];
  for (const [c, f] of Object.entries(fields) as [Column, { from: string; to: string }][]) {
    if (!(c in row)) return { action: 'error', error: `${tab} has no '${c}' column (was it renamed?)` };
    const now = canon(c, row[c]);
    found[c] = now;
    if (now === f.to) continue;
    if (now === f.from) changes[c] = f.to;
    else clashes.push(c);
  }
  if (clashes.length) return { action: 'conflict', columns: clashes, found };
  return Object.keys(changes).length ? { action: 'write', changes, found } : { action: 'none', found };
}

/** After writing: every written column now reads back as intended. Returns what's wrong, or null. */
export function verifyRows(source: Source, eventId: string, changes: Partial<Record<Column, string>>, rows: SheetRow[]): string | null {
  const tab = TAB[source];
  const mine = rows.filter(r => text(r['Event ID']) === eventId);
  if (mine.length !== 1) return mine.length ? `${eventId} is on ${mine.length} rows in ${tab}` : `No row in ${tab} has Event ID ${eventId} after writing`;
  for (const [c, want] of Object.entries(changes) as [Column, string][]) {
    const got = canon(c, mine[0]![c]);
    if (got !== want) return `After writing, ${c} reads '${text(mine[0]![c])}', not '${cellFor(c, want)}'`;
  }
  return null;
}
