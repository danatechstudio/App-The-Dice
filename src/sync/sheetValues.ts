// The Logic Engine columns an admin can change from the organiser (Stage 6), in one
// canonical form for both directions: the sync stores them on each event
// (events.sheet_values), an edit records {from, to} in it, and RTD Sheet Writer's row is
// compared in it, so "6:30 PM" and "18:30", or "public" and "Public", are the same value.
// Pure: no I/O.

import { ukDate, weekdayOf } from '../lib/format';
import { parseClock, parseSheetDate } from '../lib/time';
import { CATEGORIES, visibilityOf, type Source, type SheetRow } from './normalise';

/** Editable columns, by tab. Frequency, App Capacity, Photo Folder ID and App Host Session never are. */
export const EDITABLE = {
  event_index: ['Event Name', 'Base Details', 'Event Date', 'Event Time', 'End Time', 'Status', 'App Visibility', 'App Category', 'App Price'],
  standard_diary: ['Group', 'Notes', 'Date', 'App Visibility', 'App Category'],
} as const satisfies Record<Source, readonly string[]>;
export type Column = (typeof EDITABLE)[Source][number];

export const TAB: Record<Source, string> = { event_index: 'Event Index', standard_diary: 'Standard Diary' };

type Kind = 'text' | 'date' | 'time' | 'status' | 'visibility' | 'category';
const KIND: Record<Column, Kind> = {
  'Event Name': 'text', Group: 'text', 'Base Details': 'text', Notes: 'text', 'App Price': 'text',
  'Event Date': 'date', Date: 'date', 'Event Time': 'time', 'End Time': 'time',
  Status: 'status', 'App Visibility': 'visibility', 'App Category': 'category',
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
    default:
      return t;
  }
}

/** The editable columns of one sheet row, canonical. */
export function sheetValuesOf(source: Source, row: SheetRow): Record<string, string> {
  return Object.fromEntries(EDITABLE[source].map(c => [c, canon(c, row[c])]));
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
