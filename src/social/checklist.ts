// The Approved Facts checklist in the event editor: one row per fact key, each Not decided (no line),
// Doesn't apply (`Key: none`) or Applies (`Key: value`), and a free list of Other lines. Pure and
// import-free, so the web app, the hub's counts (src/staff/summary.ts) and the social checks
// (src/social/validate.ts, which reads a `none` fact as "never claim it") share one reading.

/** The keys an admin decides for every event, in the order the checklist shows them and saves them. */
export const CHECKLIST_KEYS = ['Booking', 'Level', 'Age', 'Format', 'Prizes', 'Price', 'Bring', 'Food'] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];

/** A fact value that says the fact doesn't apply: "none", "n/a" or "not applicable", any case, a full stop allowed. */
export const isNoneValue = (value: string): boolean => /^(?:none|n\/a|not\s+applicable)\.?$/iu.test(value.trim());

/** What's saved for Doesn't apply. */
export const NONE = 'none';

export type FactState = { state: 'undecided' } | { state: 'none' } | { state: 'applies'; value: string };

export interface Checklist {
  rows: Record<ChecklistKey, FactState>;
  /** The Other lines' values, in order. */
  other: string[];
}

const linesOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

const keyOf = (raw: string): ChecklistKey | 'Other' | undefined =>
  raw.toLowerCase() === 'other' ? 'Other' : CHECKLIST_KEYS.find(k => k.toLowerCase() === raw.toLowerCase());

/** Every key Not decided and no Other lines. */
export const emptyChecklist = (): Checklist => ({
  rows: Object.fromEntries(CHECKLIST_KEYS.map(k => [k, { state: 'undecided' }])) as Record<ChecklistKey, FactState>,
  other: [],
});

/**
 * Approved Facts as a checklist, or why they can't be one (the editor then shows the text as written): a line that isn't
 * `Key: value` with a known key, or a key given twice. A key with no line is Not decided; a none value is Doesn't apply.
 */
export function readChecklist(text: string): { checklist: Checklist } | { why: string } {
  const checklist = emptyChecklist();
  const seen = new Set<string>();
  for (const line of linesOf(text)) {
    const colon = line.indexOf(':');
    const key = colon > 0 ? keyOf(line.slice(0, colon).trim()) : undefined;
    const value = colon > 0 ? line.slice(colon + 1).trim() : '';
    if (!key || !value) return { why: `“${line}” isn’t a “Key: value” fact with one of the keys below.` };
    if (key === 'Other') {
      checklist.other.push(value);
      continue;
    }
    if (seen.has(key)) return { why: `${key} is given more than once.` };
    seen.add(key);
    // Booking always applies: a "none" there is a value (it reads as drop in), not Doesn't apply.
    checklist.rows[key] = isNoneValue(value) && key !== 'Booking' ? { state: 'none' } : { state: 'applies', value };
  }
  return { checklist };
}

/**
 * The Approved Facts text for a checklist: Booking, Level, Age, Format, Prizes, Price, Bring, Food, then the Other lines.
 * Not decided saves nothing; Doesn't apply saves `Key: none`; Applies saves its value, and nothing while it has none.
 */
export function checklistText(c: Checklist): string {
  const lines: string[] = [];
  for (const key of CHECKLIST_KEYS) {
    const row = c.rows[key];
    if (row.state === 'none') lines.push(`${key}: ${NONE}`);
    else if (row.state === 'applies' && row.value.trim()) lines.push(`${key}: ${row.value.trim()}`);
  }
  for (const o of c.other) if (o.trim()) lines.push(`Other: ${o.trim()}`);
  return lines.join('\n');
}

/** Why a checklist can't be saved: an Applies row with no value. Empty when it can be. */
export function checklistProblems(c: Checklist): string[] {
  return CHECKLIST_KEYS.filter(k => {
    const row = c.rows[k];
    return row.state === 'applies' && !row.value.trim();
  }).map(k => `${k} applies but has no value: choose one, or set it back to Not decided${k === 'Booking' ? '' : ' or Doesn’t apply'}.`);
}

/**
 * Which of the eight keys Approved Facts decide: a `Key: value` line (any value, none included) decides its key.
 * Lines that can't be read decide nothing. Both lists are in checklist order.
 */
export function factsDecided(approvedFacts: string): { decided: ChecklistKey[]; undecided: ChecklistKey[] } {
  const have = new Set<ChecklistKey>();
  for (const line of linesOf(approvedFacts)) {
    const colon = line.indexOf(':');
    if (colon < 1 || !line.slice(colon + 1).trim()) continue;
    const key = keyOf(line.slice(0, colon).trim());
    if (key && key !== 'Other') have.add(key);
  }
  return { decided: CHECKLIST_KEYS.filter(k => have.has(k)), undecided: CHECKLIST_KEYS.filter(k => !have.has(k)) };
}
