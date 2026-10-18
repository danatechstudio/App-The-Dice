// The deterministic checks on what Gemini writes (spec §4). Pure functions: no I/O and no
// clock, so the same input always gets the same answer. They fail closed: anything they can't
// verify is a fail with a reason, and nothing is approved on Gemini's word alone.
//
// The text helpers (findDates, findTimes, findMoney, findNames, phraseRegex) are shared with
// the post check, which works on the same kinds of text.

import { CATEGORIES } from '../sync/normalise';
import { FACT_KEYS, parseFacts, parsePeople, type FactKey, type SourceFields } from './facts';
import { SCHEDULE_RULE } from './instruction';

export type PromptStatus = 'approved' | 'review_required' | 'blocked';

export interface Claim {
  claim: string;
  source_field: string;
}

export interface PromptVerdict {
  status: PromptStatus;
  /** With SCHEDULE_RULE appended when approved; Gemini's text as written for review; null when blocked or when there is none. */
  master_prompt: string | null;
  claims: Claim[];
  /** Questions for an admin: Gemini's own, and the validator's. */
  ambiguities: string[];
  errors: string[];
}

export const MAX_PROMPT_CHARS = 3000;

// ---------------------------------------------------------------------------------------------
// Text helpers

const LETTER_OR_DIGIT = '[\\p{L}\\p{N}]';
/** A word: letters and digits, with inner apostrophes and hyphens ("Liv's", "Mary-Jane"). */
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Lower-case words and numbers of a text, possessive 's dropped, punctuation folded away. "£4.50" gives "4.50". */
export function tokens(text: string): string[] {
  const folded = text
    .toLowerCase()
    .replace(/['’]s(?![\p{L}\p{N}])/gu, '')
    .replace(/['’]/g, '');
  return folded.match(/\d+(?:\.\d+)?|[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Matches a phrase as whole words, any case, whatever punctuation or spacing sits between its
 * words: "Magic: The Gathering" also finds "magic the gathering". Null for a phrase with no words.
 */
export function phraseRegex(phrase: string): RegExp | null {
  const words = phrase.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu);
  if (!words) return null;
  const body = words.map(w => w.replace(/['’]/g, "['’]")).join('[^\\p{L}\\p{N}]+');
  return new RegExp(`(?<!${LETTER_OR_DIGIT})${body}(?!${LETTER_OR_DIGIT})`, 'giu');
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
/** 1–12 for a month name or its short form; 0 for lower-case "may", which is the verb. */
const monthOf = (word: string): number => (word === 'may' ? 0 : MONTH_NAMES.findIndex(m => m.startsWith(word.toLowerCase().replace('.', '').slice(0, 3))) + 1);

/** A date, weekday or relative day found in text. Numbers are as written; month is 1–12, weekday 0 (Sunday) – 6. */
export interface DateMention {
  text: string;
  day?: number;
  month?: number;
  year?: number;
  weekday?: number;
  /** "today", "tonight", "tomorrow", "this weekend" … */
  relative?: string;
}

const year4 = (y: string | undefined): number | undefined => (y === undefined ? undefined : y.length === 2 ? 2000 + Number(y) : Number(y));
const validDay = (d: number, m: number): boolean => d >= 1 && d <= 31 && m >= 1 && m <= 12;

const DATE_PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => Omit<DateMention, 'text'> | null }[] = [
  // 2026-10-23
  { re: /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g, read: m => dmy(m[3], m[2], m[1]) },
  // 23/10/2026, 23-10-2026, 23.10.2026 (a hyphen or dot needs the year, so "2-4 players" isn't a date)
  { re: /(?<![\d./-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\d./-]*\d)/g, read: m => dmy(m[1], m[3], m[4]) },
  // 23/10
  { re: /(?<![\d./-])(\d{1,2})\/(\d{1,2})(?![\d/])/g, read: m => dmy(m[1], m[2]) },
  // 23 October, 23rd Oct, 23rd of October 2026
  {
    re: new RegExp(`(?<!${LETTER_OR_DIGIT})(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}(?:,?\\s+(\\d{4}))?(?!\\p{L})`, 'giu'),
    read: m => dmy(m[1], String(monthOf(m[2]!)), m[3]),
  },
  // October 23, Oct 23rd, October 23, 2026
  {
    re: new RegExp(`(?<!\\p{L})${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!${LETTER_OR_DIGIT})`, 'giu'),
    read: m => dmy(m[2], String(monthOf(m[1]!)), m[3]),
  },
  // October 2026
  { re: new RegExp(`(?<!\\p{L})${MONTH}\\s+(\\d{4})(?!\\d)`, 'giu'), read: m => (monthOf(m[1]!) ? { month: monthOf(m[1]!), year: Number(m[2]) } : null) },
  // Friday, Fridays
  {
    re: /(?<!\p{L})(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?(?!\p{L})/giu,
    read: m => ({ weekday: WEEKDAY_NAMES.indexOf(m[1]!.toLowerCase()) }),
  },
  // Fri, Sat … only capitalised, so "sat down" isn't a day
  {
    re: /(?<!\p{L})(Sun|Mon|Tues?|Weds?|Thu(?:rs?)?|Fri|Sat)(?!\p{L})/gu,
    read: m => ({ weekday: WEEKDAY_NAMES.findIndex(d => d.startsWith(m[1]!.toLowerCase().slice(0, 3))) }),
  },
  // today, tonight, tomorrow, this weekend, next week …
  {
    re: /(?<!\p{L})(today|tonight|tomorrow|yesterday|(?:this|next|last)\s+(?:week|weekend|month|year|morning|afternoon|evening|night))(?!\p{L})/giu,
    read: m => ({ relative: m[1]!.toLowerCase().replace(/\s+/g, ' ') }),
  },
];

function dmy(d: string | undefined, m: string | undefined, y?: string): Omit<DateMention, 'text'> | null {
  const day = Number(d);
  const month = Number(m);
  if (!validDay(day, month)) return null;
  const year = year4(y);
  return year === undefined ? { day, month } : { day, month, year };
}

/** Every date, weekday and relative day in the text, in the order found; overlapping finds count once. */
export function findDates(text: string): DateMention[] {
  const found: (DateMention & { at: number; end: number })[] = [];
  for (const { re, read } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const at = m.index!;
      const end = at + m[0].length;
      if (found.some(f => at < f.end && end > f.at)) continue;
      const parsed = read(m);
      if (parsed) found.push({ text: m[0], ...parsed, at, end });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, end: _end, ...d }) => d);
}

/** A £ amount, in pence. */
export interface MoneyMention {
  text: string;
  pence: number;
}

const MONEY = /£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)|(?<![\d.])(\d+)(?:\.(\d{1,2}))?\s*(?:pounds?|quid|gbp)(?!\p{L})/giu;
const pence = (pounds: string, part: string | undefined): number => Number(pounds.replace(/,/g, '')) * 100 + Number((part ?? '').padEnd(2, '0'));

/** Every money amount in the text ("£4", "£4.00", "£ 10", "5 pounds"), so "£4" and "£4.00" compare equal. */
export function findMoney(text: string): MoneyMention[] {
  return [...text.matchAll(MONEY)].map(m => ({ text: m[0], pence: m[1] !== undefined ? pence(m[1], m[2]) : pence(m[3]!, m[4]) }));
}

/** A time found in text, with the minutes after midnight it could mean. No readings means it can't be checked ("7 o'clock", "half seven"). */
export interface TimeMention {
  text: string;
  readings: number[];
}

const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const HOUR_WORD = `(?:\\d{1,2}|${NUMBER_WORDS.join('|')})`;

function clock(h: number, min: number, meridiem: string | undefined): number[] {
  if (min > 59) return [];
  if (meridiem) {
    if (h < 1 || h > 12) return [];
    const base = (h % 12) * 60 + min;
    return [meridiem.toLowerCase().startsWith('p') ? base + 720 : base];
  }
  if (h > 23) return [];
  // "7.30" could be morning or evening.
  return h >= 1 && h <= 12 ? [h * 60 + min, (h % 12) * 60 + min + 720] : [h * 60 + min];
}

const TIME_PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => number[] | null }[] = [
  // 7:30pm, 7.30 pm, 19:00, 18.30 (not part of a longer number or a dotted date)
  {
    re: /(?<![\d.,:/])(\d{1,2})[:.](\d{2})(?:\s*([ap])\.?m\.?(?!\p{L}))?(?!\d|[.:/]\d)/giu,
    read: m => {
      const r = clock(Number(m[1]), Number(m[2]), m[3]);
      return r.length ? r : null;
    },
  },
  // The start of a range, "7-10pm": as written it could be morning or evening.
  {
    re: /(?<![\d.,:/])(\d{1,2})(?![\d.:])(?=\s*[-–]\s*\d{1,2}(?:[:.]\d{2})?\s*[ap]\.?m)/giu,
    read: m => {
      const r = clock(Number(m[1]), 0, undefined);
      return r.length ? r : null;
    },
  },
  // 7pm, 7 pm, 7 p.m.
  {
    re: /(?<![\d.,:/])(\d{1,2})\s*([ap])\.?m\.?(?!\p{L})/giu,
    read: m => {
      const r = clock(Number(m[1]), 0, m[2]);
      return r.length ? r : null;
    },
  },
  { re: /(?<!\p{L})(noon|midday)(?!\p{L})/giu, read: () => [720] },
  { re: /(?<!\p{L})midnight(?!\p{L})/giu, read: () => [0] },
  // Times that can't be checked against a schedule
  { re: new RegExp(`(?<!\\p{L})${HOUR_WORD}\\s*o['’]?clock(?!\\p{L})`, 'giu'), read: () => [] },
  { re: new RegExp(`(?<!\\p{L})(?:half|quarter)\\s+(?:past\\s+|to\\s+)?${HOUR_WORD}(?!${LETTER_OR_DIGIT})`, 'giu'), read: () => [] },
];

/** Every clock time in the text. Money is ignored, so "£4.50" isn't a time. */
export function findTimes(text: string): TimeMention[] {
  const masked = text.replace(MONEY, m => ' '.repeat(m.length));
  const found: (TimeMention & { at: number; end: number })[] = [];
  for (const { re, read } of TIME_PATTERNS) {
    for (const m of masked.matchAll(re)) {
      const at = m.index!;
      const end = at + m[0].length;
      if (found.some(f => at < f.end && end > f.at)) continue;
      const readings = read(m);
      if (readings) found.push({ text: m[0], readings, at, end });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ text, readings }) => ({ text, readings }));
}

// Capitalised words that are never anyone's name: the venue and its platforms, labels, months and
// days, and the words a prompt capitalises for emphasis or in headings.
const BRAND_NAMES = ['Roll The Dice', 'Cleethorpes', 'Meridian Point', 'Facebook', 'Instagram', 'TikTok'];
const COMMON_WORDS = [
  ...['i', 'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'not', 'no', 'yes', 'only', 'never', 'always', 'must', 'should', 'do', "don't", 'does', 'is', 'are'],
  ...['be', 'all', 'any', 'none', 'every', 'each', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its', 'this', 'that', 'use'],
  ...['avoid', 'include', 'mention', 'important', 'note', 'ok', 'uk', 'event', 'events', 'name', 'description', 'details', 'base', 'approved', 'facts'],
  ...['fact', 'people', 'roles', 'role', 'category', 'price', 'capacity', 'source', 'field', 'fields', 'terminology', 'permitted', 'prohibited'],
  ...['assumptions', 'tone', 'boundaries', 'call', 'calls', 'action', 'actions', 'cta', 'safe', 'rule', 'rules', 'schedule', 'guidance', 'editorial'],
  ...['key', 'post', 'posts', 'caption', 'captions', 'hashtag', 'hashtags', 'social', 'media', 'board', 'game', 'games', 'cafe', 'café', 'venue'],
];

const wordKey = (w: string): string =>
  w
    .toLowerCase()
    .replace(/['’]s$/, '')
    .replace(/['’]/g, '');

function addWords(into: Set<string>, text: string): void {
  for (const w of text.match(WORD) ?? []) {
    const key = wordKey(w);
    into.add(key);
    for (const part of key.split('-')) into.add(part);
  }
}

const BASE_ALLOWED = new Set<string>();
const SHORT_DAYS_AND_MONTHS = [
  ...MONTH_NAMES.map(m => m.slice(0, 3)),
  'sept',
  'mon',
  'tue',
  'tues',
  'wed',
  'weds',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
];
for (const t of [
  ...BRAND_NAMES,
  ...CATEGORIES,
  ...FACT_KEYS,
  ...MONTH_NAMES,
  ...WEEKDAY_NAMES,
  ...WEEKDAY_NAMES.map(d => `${d}s`),
  ...SHORT_DAYS_AND_MONTHS,
  ...COMMON_WORDS,
]) {
  addWords(BASE_ALLOWED, t);
}

function isAllowed(word: string, allowed: Set<string>): boolean {
  const key = wordKey(word);
  const known = (k: string) => allowed.has(k) || (k.length > 3 && k.endsWith('s') && allowed.has(k.slice(0, -1)));
  return known(key) || key.split('-').every(known);
}

// Words like "Mr." end in a full stop without ending the sentence.
const NOT_A_SENTENCE_END = /(?:^|[^\p{L}])(?:mr|mrs|ms|dr|e\.g|i\.e|vs)\.$/iu;

/** Whether the word at index i starts a sentence, a line or a list item. A colon doesn't count. */
function startsSentence(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /[ \t"“‘'(\[]/.test(text[j]!)) j--;
  if (j < 0 || text[j] === '\n' || text[j] === '\r') return true;
  // A bullet, number or heading marker that starts its line: "- ", "* ", "## ".
  if (/[-*•#>]/.test(text[j]!)) {
    let k = j;
    while (k >= 0 && /[-*•#> \t]/.test(text[k]!)) k--;
    return k < 0 || text[k] === '\n' || text[k] === '\r';
  }
  while (j >= 0 && /["”’')\]]/.test(text[j]!)) j--;
  return j >= 0 && /[.!?…]/.test(text[j]!) && !NOT_A_SENTENCE_END.test(text.slice(Math.max(0, j - 5), j + 1));
}

/**
 * Capitalised words that aren't allowed: not in `allowed` (words or phrases, any case), not a
 * built-in venue, label, month, day or common word, not starting a sentence and not a hashtag.
 * Neighbouring finds are joined ("Trixie Smith"). Each is reported once.
 */
export function findNames(text: string, allowed: Iterable<string>): string[] {
  const ok = new Set(BASE_ALLOWED);
  for (const a of allowed) addWords(ok, a);
  const found: string[] = [];
  let run: string[] = [];
  let lastEnd = 0;
  const flush = () => {
    if (run.length) found.push(run.join(' '));
    run = [];
  };
  for (const m of text.matchAll(WORD)) {
    const word = m[0];
    const at = m.index!;
    if (!/^[ \t]+$/.test(text.slice(lastEnd, at))) flush();
    lastEnd = at + word.length;
    const name = /^\p{Lu}/u.test(word) && text[at - 1] !== '#' && !isAllowed(word, ok) && !startsSentence(text, at);
    if (name) run.push(word);
    else flush();
  }
  flush();
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------------------------
// The generated prompt (§4A)

type FieldRef = { field: 'name' | 'base_details' | 'people_roles' | 'category' | 'price' | 'capacity' } | { fact: FactKey };
const PLAIN_FIELDS = ['name', 'base_details', 'people_roles', 'category', 'price', 'capacity'] as const;

/** A claim's source_field, if it is one of the whitelisted fields. */
function fieldRef(sourceField: string): FieldRef | null {
  const s = sourceField.trim();
  const plain = PLAIN_FIELDS.find(f => f === s);
  if (plain) return { field: plain };
  const fact = s.startsWith('approved_facts.') ? FACT_KEYS.find(k => k.toLowerCase() === s.slice('approved_facts.'.length).toLowerCase()) : undefined;
  return fact ? { fact } : null;
}

// Words too common to show that a claim came from a field.
const STOP_WORDS = new Set([
  ...['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'if', 'then', 'than', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'into'],
  ...['about', 'up', 'out', 'over', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'it', 'its', 'this', 'that', 'these', 'those', 'there'],
  ...['here', 'has', 'have', 'had', 'having', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'not'],
  ...['no', 'yes', 'we', 'us', 'our', 'you', 'your', 'they', 'them', 'their', 'he', 'him', 'his', 'she', 'her', 'i', 'me', 'my', 'who', 'whom'],
  ...['which', 'what', 'when', 'where', 'how', 'all', 'any', 'some', 'every', 'each', 'very', 'just', 'also', 'only', 'more', 'most', 'event', 'events'],
]);

const isNumber = (t: string): boolean => /^\d+(?:\.\d+)?$/.test(t);

/** At least one distinctive word or number of the claim appears in the field's value. */
function traces(claim: string, value: string): boolean {
  const have = tokens(value);
  const words = new Set(have);
  const numbers = have.filter(isNumber).map(Number);
  return tokens(claim).some(t => (isNumber(t) ? numbers.includes(Number(t)) : t.length > 1 && !STOP_WORDS.has(t) && words.has(t)));
}

/** Why a claim can't be traced to its field, or null when it can. */
function untraced(c: Claim, ref: FieldRef, f: SourceFields, facts: Partial<Record<FactKey, string[]>>): string | null {
  if ('fact' in ref) {
    const values = facts[ref.fact];
    if (!values?.length) return `Claim "${c.claim}" not found in approved_facts.${ref.fact}: there is no ${ref.fact} fact`;
    return traces(c.claim, values.join('\n')) ? null : `Claim "${c.claim}" not found in approved_facts.${ref.fact}`;
  }
  return traces(c.claim, String(f[ref.field] ?? '')) ? null : `Claim "${c.claim}" not found in ${ref.field}`;
}

/** The event's own price in pence: its App Price and any Approved Facts Price line. */
function ownPrices(f: SourceFields, facts: Partial<Record<FactKey, string[]>>): number[] {
  const amounts = [f.price, ...(facts.Price ?? [])].flatMap(t => findMoney(t).map(m => m.pence));
  const bare = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(f.price);
  if (bare) amounts.push(pence(bare[1]!, bare[2]));
  return amounts;
}

/** What's wrong with the prompt text itself: dates, times, other prices, other events and unknown names. */
function promptTextErrors(prompt: string, f: SourceFields, facts: Partial<Record<FactKey, string[]>>, otherEventNames: string[]): string[] {
  const errors: string[] = [];
  // The event's own name is its identity, not a claim: "Friday Night Magic" isn't a weekday.
  const own = phraseRegex(f.name);
  const text = own ? prompt.replace(own, ' ') : prompt;

  for (const d of findDates(text)) errors.push(`The prompt states a date or day, "${d.text}"; the date comes only from the schedule at posting time`);
  for (const t of findTimes(text)) errors.push(`The prompt states a time, "${t.text}"; the time comes only from the schedule at posting time`);
  const allowedPence = ownPrices(f, facts);
  for (const m of findMoney(text)) {
    if (!allowedPence.includes(m.pence)) errors.push(`The prompt states "${m.text}", which isn't the event's own price${f.price ? ` (${f.price})` : ''}`);
  }
  const ownName = tokens(f.name).join(' ');
  for (const other of otherEventNames) {
    const name = other.trim();
    if (name.length < 4 || tokens(name).join(' ') === ownName) continue;
    const re = phraseRegex(name);
    if (re?.test(text)) errors.push(`The prompt names another event, "${name}"`);
  }
  for (const n of findNames(prompt, [f.name, f.base_details, f.approved_facts, f.people_roles, f.category])) {
    errors.push(`The prompt names "${n}", which isn't in People & Roles or the event's own fields`);
  }
  return errors;
}

const INSTRUCTION_LIKE = /ignore (all |the )?(previous|above)|system prompt|you are now|disregard/i;

/** Source fields that read like instructions to Gemini. */
function instructionFlags(f: SourceFields): string[] {
  const fields: [string, string][] = [
    ['The event name', f.name],
    ['Base Details', f.base_details],
    ['Approved Facts', f.approved_facts],
    ['People & Roles', f.people_roles],
    ['App Price', f.price],
  ];
  return fields.flatMap(([label, value]) => {
    const m = INSTRUCTION_LIKE.exec(value);
    return m ? [`${label} contains instructions ("${m[0]}"). They went to Gemini only as quoted data, but check the wording before approving.`] : [];
  });
}

// Booking wording: "drop in" and its kind, and "booking essential" and its kind.
const DROP_IN =
  /(?<!\p{L})(drop[ -]?ins?|walk[ -]?ins?|just turn up|turn up on the (?:night|day)|pop in|open table|open play|no booking(?: needed| required)?|no need to book|booking (?:is )?not (?:required|needed|necessary|essential))(?!\p{L})/giu;
const BOOKED =
  /(?<!\p{L})(booking (?:is )?(?:essential|required|needed|necessary)|must book|book ahead|book in advance|pre-?book(?:ing)?|advance booking|booking only)(?!\p{L})/iu;
// A Booking fact's value only has to say the word: "Booking: essential", "Booking: not required".
const DROP_IN_VALUE = /^(?:no|none|never|not (?:required|needed|necessary|essential))(?!\p{L})/iu;
const BOOKED_VALUE = /(?<!\p{L})(essential|required|needed|necessary|must|yes|advance|ahead|only)(?!\p{L})/iu;

/** The first drop-in phrase in the text. */
const dropInIn = (text: string): string | null => text.match(DROP_IN)?.[0] ?? null;
/** The first booking-needed phrase, once drop-in phrases are taken out ("booking not required" isn't "required"). */
const bookedIn = (text: string): string | null => BOOKED.exec(text.replace(DROP_IN, ' '))?.[0] ?? null;

/** What one Booking fact says, judged on its value alone. */
function bookingFact(value: string): { booked: boolean; dropIn: boolean } {
  const dropIn = dropInIn(value) !== null || DROP_IN_VALUE.test(value);
  const rest = value.replace(DROP_IN, ' ').replace(DROP_IN_VALUE, ' ');
  return { booked: BOOKED_VALUE.test(rest), dropIn };
}

/** Booking facts and the other text contradicting each other on format, as questions for an admin. */
function formatQuestions(f: SourceFields, facts: Partial<Record<FactKey, string[]>>): string[] {
  const questions: string[] = [];
  const booking = facts.Booking ?? [];
  const bookedFact = booking.find(v => bookingFact(v).booked);
  const dropInFact = booking.find(v => bookingFact(v).dropIn);
  if (bookedFact && dropInFact) {
    questions.push(`Approved Facts give Booking as both "${bookedFact}" and "${dropInFact}". Is it booked or drop in?`);
  }
  const others: [string, string][] = [['Base Details', f.base_details]];
  for (const key of FACT_KEYS) if (key !== 'Booking') for (const v of facts[key] ?? []) others.push([`Approved Facts ${key}`, v]);
  for (const [label, text] of others) {
    const dropIn = dropInIn(text);
    const booked = bookedIn(text);
    if (bookedFact && dropIn) questions.push(`Approved Facts say "Booking: ${bookedFact}", but ${label} says "${dropIn}". Is it booked or drop in?`);
    if (dropInFact && booked) questions.push(`Approved Facts say "Booking: ${dropInFact}", but ${label} says "${booked}". Is it booked or drop in?`);
    if (!bookedFact && !dropInFact && dropIn && booked) questions.push(`${label} says both "${booked}" and "${dropIn}". Is it booked or drop in?`);
  }
  return questions;
}

type ReadOutput =
  | { blocked: string }
  | { status: unknown; prompt: string | null; claims: { claim: Claim; ref: FieldRef }[]; ambiguities: string[]; errors: string[] };

/** The shape checks. A breach that leaves nothing safe to read is `blocked`. */
function readOutput(output: unknown): ReadOutput {
  let o = output;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return { blocked: 'The output is not JSON' };
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { blocked: 'The output is not a JSON object' };
  const r = o as Record<string, unknown>;
  const errors: string[] = [];

  const texts = (key: 'ambiguities' | 'questions'): string[] => {
    const v = r[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      errors.push(`"${key}" is not a list`);
      return [];
    }
    if (v.some(q => typeof q !== 'string')) errors.push(`"${key}" holds something that isn't text`);
    return v.filter((q): q is string => typeof q === 'string' && q.trim() !== '').map(q => q.trim());
  };
  const ambiguities = [...texts('ambiguities'), ...texts('questions')];

  const status = r.status;
  if (status !== 'ok' && status !== 'review_required') {
    errors.push(`"status" is ${status === undefined ? 'missing' : JSON.stringify(status)}, not "ok" or "review_required"`);
  }

  const mp = r.master_prompt;
  let prompt: string | null = null;
  if (typeof mp === 'string' && mp.trim() !== '') {
    const length = [...mp].length;
    if (length > MAX_PROMPT_CHARS) return { blocked: `master_prompt is ${length} characters, over the ${MAX_PROMPT_CHARS} limit` };
    prompt = mp;
  } else {
    // Gemini is told to write no prompt when it has questions, so that alone isn't malformed.
    const asked = status === 'review_required' && ambiguities.length > 0 && (mp === undefined || mp === null || typeof mp === 'string');
    if (!asked)
      return {
        blocked: mp === undefined || mp === null ? 'master_prompt is missing' : typeof mp === 'string' ? 'master_prompt is empty' : 'master_prompt is not text',
      };
  }

  // With no prompt there is nothing to claim, so a missing list then reads as empty.
  const rawClaims = r.claims === undefined && prompt === null ? [] : r.claims;
  if (!Array.isArray(rawClaims)) return { blocked: '"claims" is not a list' };
  const claims: { claim: Claim; ref: FieldRef }[] = [];
  for (const [i, c] of rawClaims.entries()) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { blocked: `Claim ${i + 1} is not an object` };
    const { claim, source_field } = c as Record<string, unknown>;
    const ref = typeof source_field === 'string' ? fieldRef(source_field) : null;
    if (!ref || typeof source_field !== 'string')
      return { blocked: `Claim ${i + 1} cites ${source_field === undefined ? 'no field' : JSON.stringify(source_field)}, which isn't an approved field` };
    if (typeof claim !== 'string' || claim.trim() === '') {
      errors.push(`Claim ${i + 1} has no text`);
      continue;
    }
    claims.push({ claim: { claim, source_field }, ref });
  }
  return { status, prompt, claims, ambiguities, errors };
}

/**
 * Checks Gemini's output for one event against that event's fields (spec §4A). `output` is the
 * parsed JSON or its text. Approved only when every check passes and nothing is ambiguous; the
 * approved prompt then carries SCHEDULE_RULE.
 */
export function validatePrompt(output: unknown, f: SourceFields, ctx: { otherEventNames: string[] }): PromptVerdict {
  const read = readOutput(output);
  if ('blocked' in read) return { status: 'blocked', master_prompt: null, claims: [], ambiguities: [], errors: [read.blocked] };

  const { prompt } = read;
  const errors = [...read.errors];
  const ambiguities = [...read.ambiguities];
  if (read.status === 'review_required' && ambiguities.length === 0) ambiguities.push('Gemini asked for review without giving a question');

  const { facts, errors: factErrors } = parseFacts(f.approved_facts);
  const { errors: peopleErrors } = parsePeople(f.people_roles);
  errors.push(...factErrors.map(e => `Approved Facts: ${e}`), ...peopleErrors.map(e => `People & Roles: ${e}`));

  if (prompt !== null) {
    if (read.claims.length === 0) errors.push('The output lists no claims, so nothing in the prompt can be traced to the event');
    for (const { claim, ref } of read.claims) {
      const why = untraced(claim, ref, f, facts);
      if (why) errors.push(why);
    }
    errors.push(...promptTextErrors(prompt, f, facts, ctx.otherEventNames));
  }
  ambiguities.push(...instructionFlags(f), ...formatQuestions(f, facts));

  const unique = (list: string[]) => [...new Set(list)];
  const approved = prompt !== null && errors.length === 0 && ambiguities.length === 0;
  return {
    status: approved ? 'approved' : 'review_required',
    master_prompt: approved ? `${prompt}\n\n${SCHEDULE_RULE}` : prompt,
    claims: read.claims.map(c => c.claim),
    ambiguities: unique(ambiguities),
    errors: unique(errors),
  };
}
