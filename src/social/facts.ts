// What the café has written down about an event for its social posts, read the way the
// master prompt needs it: Approved Facts as `Key: value` lines, People & Roles as
// `Name — role` lines. Pure: no I/O. Gemini only ever sees the SourceFields below, so a
// date or a time can never reach it, and the fingerprint of those fields is what tells
// the system a prompt has gone stale.

import { sha256 } from '../bookings/bookings';

export const FACT_KEYS = ['Booking', 'Level', 'Age', 'Prizes', 'Format', 'Price', 'Bring', 'Food', 'Other'] as const;
export type FactKey = (typeof FACT_KEYS)[number];

/** The three owner columns as the sheet holds them: raw cell text, '' when blank. */
export interface SocialValues {
  approved_facts: string;
  people_roles: string;
  banned_phrases: string;
}

export interface Person {
  name: string;
  role: string;
}

/** The only event data that goes to Gemini. No dates, times, other events, emails or history. */
export interface SourceFields {
  event_id: string;
  name: string;
  source: 'event_index' | 'standard_diary';
  frequency: string;
  /** Base Details on Event Index, Notes on Standard Diary. */
  base_details: string;
  approved_facts: string;
  people_roles: string;
  category: string;
  visibility: string;
  /** App Price as written; '' when there is none. */
  price: string;
  /** App Capacity as a number in text; '' when there is none. */
  capacity: string;
}

/** The non-blank lines of a cell, each with its 1-based line number in the cell. */
const linesOf = (text: string): { n: number; line: string }[] =>
  text
    .split(/\r?\n/)
    .map((line, i) => ({ n: i + 1, line: line.trim() }))
    .filter(l => l.line !== '');

/**
 * Approved Facts: one `Key: value` per line, the key from FACT_KEYS (any case). A key can
 * repeat. A line that isn't that, names another key or has no value is reported, not guessed at.
 */
export function parseFacts(text: string): { facts: Partial<Record<FactKey, string[]>>; errors: string[] } {
  const facts: Partial<Record<FactKey, string[]>> = {};
  const errors: string[] = [];
  for (const { n, line } of linesOf(text)) {
    const colon = line.indexOf(':');
    if (colon < 1) {
      errors.push(`Line ${n}: "${line}" is not a "Key: value" fact`);
      continue;
    }
    const rawKey = line.slice(0, colon).trim();
    const key = FACT_KEYS.find(k => k.toLowerCase() === rawKey.toLowerCase());
    if (!key) {
      errors.push(`Line ${n}: "${rawKey}" is not a fact key (use ${FACT_KEYS.join(', ')})`);
      continue;
    }
    const value = line.slice(colon + 1).trim();
    if (!value) {
      errors.push(`Line ${n}: "${key}" has no value`);
      continue;
    }
    (facts[key] ??= []).push(value);
  }
  return { facts, errors };
}

// The first em dash or en dash, or a hyphen with a space either side (so "Mary-Jane" stays whole).
const PERSON = /^(.+?)(?:\s*[—–]\s*|\s+-\s+)(.+)$/;

/** People & Roles: one `Name — role` per line. `-` and `–` are accepted for `—`. */
export function parsePeople(text: string): { people: Person[]; errors: string[] } {
  const people: Person[] = [];
  const errors: string[] = [];
  for (const { n, line } of linesOf(text)) {
    const m = PERSON.exec(line);
    if (!m) {
      errors.push(`Line ${n}: "${line}" is not "Name — role"`);
      continue;
    }
    people.push({ name: m[1]!.trim(), role: m[2]!.trim() });
  }
  return { people, errors };
}

const textOf = (v: unknown): string => (v == null ? '' : String(v));

/** The whitelisted fields of an `events` row (display_name, description, social_values …). */
export function sourceFields(row: Record<string, unknown>): SourceFields {
  let social: Partial<SocialValues> = {};
  try {
    const parsed: unknown = typeof row.social_values === 'string' ? JSON.parse(row.social_values) : null;
    if (parsed && typeof parsed === 'object') social = parsed as Partial<SocialValues>;
  } catch {
    // A value that won't read is the same as none: the prompt is built from what can be read.
  }
  return {
    event_id: textOf(row.event_id),
    name: textOf(row.display_name),
    // An event made in the app has no sheet tab; it reads as Event Index.
    source: row.source === 'standard_diary' ? 'standard_diary' : 'event_index',
    frequency: textOf(row.frequency),
    base_details: textOf(row.description),
    approved_facts: textOf(social.approved_facts),
    people_roles: textOf(social.people_roles),
    category: textOf(row.category),
    visibility: textOf(row.visibility),
    price: textOf(row.price_display),
    capacity: textOf(row.default_capacity),
  };
}

/**
 * sha256 of the fields' canonical JSON (keys sorted) without the event id, so two events with
 * the same facts share a fingerprint and a prompt is regenerated only when a fact changes.
 */
export async function fingerprint(f: SourceFields): Promise<string> {
  const { event_id: _eventId, ...rest } = f;
  const sorted = Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(JSON.stringify(Object.fromEntries(sorted)));
}
