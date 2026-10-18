// The deterministic checks on what Gemini writes (spec §4). Pure functions: no I/O and no
// clock, so the same input always gets the same answer. They fail closed: anything they can't
// verify is a fail with a reason, and nothing is approved on Gemini's word alone.
//
// The text helpers (findDates, findTimes, findMoney, findNames, capitalisedWords, phraseRegex,
// ownPrices) are shared with the post check, which works on the same kinds of text. A date or
// time they can't read is still reported (with nothing read from it), so callers fail it.

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
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
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

// A line break is \n, \r, \r\n, or the Unicode line or paragraph separator, wherever lines matter.
const LINE_BREAK = '(?:\\r\\n|[\\n\\r\\u2028\\u2029])';
const LINE_BREAK_CHAR = /[\n\r\u2028\u2029]/u;
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/gu;
const lineBreaks = (text: string): number => (text.match(LINE_BREAKS) ?? []).length;
/** White space that isn't a line break. */
const HSPACE = '[^\\S\\n\\r\\u2028\\u2029]';

// What may sit between the words of an event name: nothing, up to three spaces, tabs, dashes or
// "&", the word "and", or one line break. Never a full stop or a blank line; always bounded, so
// long runs of spaces stay quick. Non-breaking, en, em and thin spaces are spaces.
const SPACE_CHARS = ' \\t\\u00A0\\u2002\\u2003\\u2009\\u202F';
const SPACE = `[${SPACE_CHARS}]`;
const SPACE_RE = new RegExp(SPACE, 'u');
const NAME_GAP_CHAR = `[${SPACE_CHARS}\\-–—&]`;
const NAME_GAP = `(?:${NAME_GAP_CHAR}{0,3}|${SPACE}{1,3}and${SPACE}{1,3}|${NAME_GAP_CHAR}{0,2}${LINE_BREAK}${NAME_GAP_CHAR}?)`;

/**
 * The separator between two words of a name, as written there: its punctuation, with up to two
 * spaces either side ("Magic: The" also matches "magic:the" and "magic : the"), either apostrophe
 * for one. Null when it is only spaces, which NAME_GAP covers.
 */
function separatorRegex(sep: string): string | null {
  const chars = [...sep];
  while (chars.length && SPACE_RE.test(chars[0]!)) chars.shift();
  while (chars.length && SPACE_RE.test(chars[chars.length - 1]!)) chars.pop();
  if (!chars.length) return null;
  const core = chars.map(c => (SPACE_RE.test(c) ? SPACE : /['’]/u.test(c) ? "['’]" : c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))).join('');
  // Only punctuation gets the loose spaces: "Board and Brew" keeps a space either side of "and".
  if (chars.some(c => LETTER_OR_DIGIT_RE.test(c))) return `${SPACE}${core}${SPACE}`;
  return `${SPACE}{0,2}${core}${SPACE}{0,2}`;
}

/**
 * Matches a phrase as whole words, any case. Between two of its words goes NAME_GAP ("#QuizNight"
 * finds "Quiz Night", and "&" or "and" may join them) or the separator the phrase itself has there
 * ("Magic: The Gathering", "Yu-Gi-Oh! Locals"). The last word may take an "s" ("Quiz Nights").
 * Null for a phrase with no words.
 */
export function phraseRegex(phrase: string): RegExp | null {
  const words = [...phrase.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].filter(w => w[0].toLowerCase() !== 'and');
  if (!words.length) return null;
  const word = (w: RegExpMatchArray) => w[0].replace(/['’]/g, "['’]");
  const body = words
    .map((w, i) => {
      if (i === 0) return word(w);
      const before = words[i - 1]!;
      const sep = separatorRegex(phrase.slice(before.index! + before[0].length, w.index!));
      return `(?:${NAME_GAP}${sep ? `|${sep}` : ''})${word(w)}`;
    })
    .join('');
  return new RegExp(`(?<!${LETTER_OR_DIGIT})${body}s?(?!${LETTER_OR_DIGIT})`, 'giu');
}

type Span = [number, number];
const spansOf = (re: RegExp | null, text: string): Span[] => (re ? [...text.matchAll(re)].map(m => [m.index!, m.index! + m[0].length] as Span) : []);
const within = (at: number, end: number, spans: Span[]): boolean => spans.some(([s, e]) => at >= s && end <= e);

/** Runs every pattern over the text; where two finds overlap, the earlier pattern wins. Sorted by position. */
function scan<T>(text: string, patterns: { re: RegExp; read: (m: RegExpMatchArray) => T | null }[]): (T & { text: string; index: number })[] {
  const found: (T & { text: string; index: number })[] = [];
  for (const { re, read } of patterns) {
    for (const m of text.matchAll(re)) {
      const at = m.index!;
      const end = at + m[0].length;
      if (found.some(f => at < f.index + f.text.length && end > f.index)) continue;
      const value = read(m);
      if (value) found.push({ ...value, text: m[0], index: at });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
/** 1–12 for a month name or its short form; 0 for lower-case "may", which may well be the verb. */
const monthOf = (word: string): number => (word === 'may' ? 0 : MONTH_NAMES.findIndex(m => m.startsWith(word.toLowerCase().replace('.', '').slice(0, 3))) + 1);

/**
 * A date, weekday or relative day found in text, at `index`. Numbers are as written; month is
 * 1–12, weekday 0 (Sunday) – 6. A date-shaped find that can't be read ("10/23", "31/02", "23 may")
 * comes back with no day, month or year: it is still a date, and fails any check.
 */
export interface DateMention {
  text: string;
  index: number;
  day?: number;
  month?: number;
  year?: number;
  weekday?: number;
  /** "today", "tonight", "tomorrow", "this weekend" … */
  relative?: string;
}
type DateFields = Omit<DateMention, 'text' | 'index'>;

const year4 = (y: string | undefined): number | undefined => (y === undefined ? undefined : y.length === 2 ? 2000 + Number(y) : Number(y));
const leap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** A day and month (and year) if they make a real date; otherwise an unreadable date. */
function dmy(d: string | undefined, m: string | number | undefined, y?: string): DateFields {
  const day = Number(d);
  const month = Number(m);
  const year = year4(y);
  const days = [31, year !== undefined && !leap(year) ? 28 : 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!)) return {};
  return year === undefined ? { day, month } : { day, month, year };
}
// "6 may book": lower-case "may" after a number, then a verb, is the verb.
const MAY_THEN_VERB = /^\s+(?:book|join|come|attend|bring|play|sign|enter|take|need)(?!\p{L})/iu;
const dayOnly = (d: string | undefined): DateFields => (Number(d) >= 1 && Number(d) <= 31 ? { day: Number(d) } : {});

// "the 5th edition", "the 1st place team", "the 20th session" aren't dates.
const NOT_A_DAY_AFTER =
  '(?!\\s+(?:place|prizes?|edition|hand|times?|rounds?|games?|floor|players?|teams?|half|anniversary|birthday|years?|sessions?|weeks?|visits?)(?!\\p{L}))';

const DATE_PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => DateFields | null }[] = [
  // 2026-10-23
  { re: /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g, read: m => dmy(m[3], m[2], m[1]) },
  // 23/10/2026, 23-10-2026, 23.10.2026 (a hyphen or dot needs the year, so "2-4 players" isn't a date)
  { re: /(?<![\d./-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\d./-]*\d)/g, read: m => dmy(m[1], m[3], m[4]) },
  // 23/10
  { re: /(?<![\d./-])(\d{1,2})\/(\d{1,2})(?![\d/])/g, read: m => dmy(m[1], m[2]) },
  // 23 October, 23rd Oct, 23rd of October 2026
  {
    re: new RegExp(`(?<!${LETTER_OR_DIGIT})(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}(?:,?\\s+(\\d{4}))?(?!\\p{L})`, 'giu'),
    read: m => {
      if (monthOf(m[2]!)) return dmy(m[1], monthOf(m[2]!), m[3]);
      // Lower-case "may" (no full stop) then a verb is the verb; otherwise a date that can't be read.
      return !m[0].endsWith('.') && MAY_THEN_VERB.test(m.input!.slice(m.index! + m[0].length)) ? null : {};
    },
  },
  // October 23, Oct 23rd, October 23, 2026
  {
    re: new RegExp(`(?<!\\p{L})${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!${LETTER_OR_DIGIT})`, 'giu'),
    read: m => (monthOf(m[1]!) ? dmy(m[2], monthOf(m[1]!), m[3]) : {}),
  },
  // on the 23rd, the 1st
  { re: new RegExp(`(?<!\\p{L})(?:on\\s+the|the|on)\\s+(\\d{1,2})(?:st|nd|rd|th)(?!\\p{L})${NOT_A_DAY_AFTER}`, 'giu'), read: m => dayOnly(m[1]) },
  // 23rd of
  { re: new RegExp(`(?<!${LETTER_OR_DIGIT})(\\d{1,2})(?:st|nd|rd|th)\\s+of(?!\\p{L})`, 'giu'), read: m => dayOnly(m[1]) },
  // October 2026
  { re: new RegExp(`(?<!\\p{L})${MONTH}\\s+(\\d{4})(?!\\d)`, 'giu'), read: m => (monthOf(m[1]!) ? { month: monthOf(m[1]!), year: Number(m[2]) } : {}) },
  // October, Oct: a month on its own, except lower-case "may" and "march", which are usually verbs
  {
    re: /(?<!\p{L})(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?(?!\p{L})/giu,
    read: m => (m[1] === 'may' || m[1] === 'march' ? null : { month: monthOf(m[1]!) }),
  },
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

/** Every date, weekday, month and relative day in the text, in order; overlapping finds count once. */
export function findDates(text: string): DateMention[] {
  return scan(text, DATE_PATTERNS);
}

/** A money amount, in pence, at `index`. "free", "no charge" and "no cost" are 0; a negated "free" ("not free") isn't a price. */
export interface MoneyMention {
  text: string;
  index: number;
  pence: number;
}

const pence = (pounds: string, part: string | undefined): number => Number(pounds.replace(/,/g, '')) * 100 + Number((part ?? '').padEnd(2, '0'));

// A "free" straight after a negative isn't a price: "not free", "isn't entirely free", "no free play".
const NOT_NEGATED = "(?<!(?<!\\p{L})(?:not|isn['’]t|aren['’]t|wasn['’]t|no|never)\\s+(?:(?:entirely|completely|totally|really|actually|quite|always)\\s+)?)";

const MONEY_PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => { pence: number } }[] = [
  // £4, £4.00, £ 10, £1,000
  { re: /£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/gu, read: m => ({ pence: pence(m[1]!, m[2]) }) },
  // GBP 10
  { re: /(?<!\p{L})gbp\s?(\d+)(?:\.(\d{1,2}))?(?!\d)/giu, read: m => ({ pence: pence(m[1]!, m[2]) }) },
  // 10 pounds, 5 quid, 10 GBP
  { re: /(?<![\d.£])(\d+)(?:\.(\d{1,2}))?\s*(?:pounds?|quid|gbp)(?!\p{L})/giu, read: m => ({ pence: pence(m[1]!, m[2]) }) },
  // 50p (not "7pm" or "7p.m.")
  { re: /(?<![\d.£])(\d+)p(?!\p{L}|\.m)/giu, read: m => ({ pence: Number(m[1]) }) },
  // free of charge, complimentary, costs nothing, no entry fee, no cover charge
  {
    re: new RegExp(`(?<![\\p{L}-])${NOT_NEGATED}(?:free of charge|complimentary|costs? nothing|no entry fee|no cover charge)(?![\\p{L}-])`, 'giu'),
    read: () => ({ pence: 0 }),
  },
  // no charge, no cost
  { re: /(?<!\p{L})no (?:charge|cost)(?!\p{L})/giu, read: () => ({ pence: 0 }) },
  // free (not "feel free" or "gluten-free")
  { re: new RegExp(`(?<![\\p{L}-])(?<!feel\\s+)${NOT_NEGATED}free(?![\\p{L}-])`, 'giu'), read: () => ({ pence: 0 }) },
];

/** Every money amount in the text, so "£4" and "£4.00" compare equal, and "free" is £0. */
export function findMoney(text: string): MoneyMention[] {
  return scan(text, MONEY_PATTERNS);
}

/** The event's own prices in pence: its App Price (a bare number counts as pounds) and any Approved Facts `Price` line. */
export function ownPrices(f: SourceFields): number[] {
  const { facts } = parseFacts(f.approved_facts);
  const amounts = [f.price, ...(facts.Price ?? [])].flatMap(t => findMoney(t).map(m => m.pence));
  const bare = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(f.price);
  if (bare) amounts.push(pence(bare[1]!, bare[2]));
  return amounts;
}

/**
 * A time found in text, at `index`, with the minutes after midnight it could mean. No readings
 * means it can't be checked against a schedule ("7 o'clock", "half seven").
 */
export interface TimeMention {
  text: string;
  index: number;
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
  // "7.30" could be morning or evening; a bare 12 is midnight or midday.
  return h >= 1 && h <= 12 ? [(h % 12) * 60 + min, (h % 12) * 60 + min + 720] : [h * 60 + min];
}
const readClock = (h: string | undefined, min: string | undefined, meridiem: string | undefined): { readings: number[] } | null => {
  const readings = clock(Number(h), Number(min ?? 0), meridiem);
  return readings.length ? { readings } : null;
};
/** For a find that is clearly a clock time ("25:00", "13pm"): readings, or none when it can't be read. */
const readClockShaped = (h: string | undefined, min: string | undefined, meridiem: string | undefined) => ({
  readings: clock(Number(h), Number(min ?? 0), meridiem),
});

// A number after "at" or "from" that counts something else: "from 2 to 6 players", "at 4 tables", "18+".
// "capped at 6" and "max at 6" are counts too.
const NOT_AN_HOUR_AFTER = `(?:\\s*(?:-|–|to)\\s*(?:\\d{1,3}|${NUMBER_WORDS.join('|')}))?\\s*(?:\\+|%|(?:players?|people|persons?|years?|yrs?|teams?|tables?|seats?|places?|spaces?|guests?|rounds?|games?|minutes?|mins?|hours?|hrs?|weeks?|months?|days?|kids|children|adults|percent|pence|pounds?|quid|p)(?!\\p{L}))`;
// The words that start a bare hour: "at 7", "from seven till late", "doors 7", "starts at 7", "until 9".
const TIME_CUE =
  '(?<!\\p{L})(?:(?<!(?<!\\p{L})(?:capped|limited|max|maximum|up\\s+to)\\s+)at|from|until|till|til|doors(?:\\s+open)?(?:\\s+at)?|starts?(?:\\s+at)?|starting(?:\\s+at)?|begins?(?:\\s+at)?)';
// Minutes in words after an hour in words ("seven thirty"): a time, but not one that can be read reliably.
const WORD_MINUTES = `(?:${SPACE}+|${SPACE}*-${SPACE}*)(?:fifteen|thirty|(?:twenty|forty|fifty)(?:${SPACE}|-)*five|twenty|forty|fifty|five|ten|\\d{2})(?!\\p{L})`;

const TILL_LATE = "(?:till|until|['’]?til)\\s+late(?!\\p{L})";
const ONWARDS = 'onwards?(?!\\p{L})';
// "round 7 onwards", "level 3 onwards", "ages 8 onwards" count something else. Only before "onwards":
// "every week 7 till late" is a time.
const NOT_A_COUNT_BEFORE = '(?<!(?<!\\p{L})(?:round|level|series|book|chapter|act|volume|grade|page|ages?|aged|over|under)\\s+)';
const hourOf = (word: string): string => String(NUMBER_WORDS.indexOf(word.toLowerCase()) + 1);
// After an hour in words, only these make it a count: "at one of our tables", "from two of them",
// "learn from one another". "at seven of course" is still a time.
const NOT_AN_HOUR_WORD_AFTER = '(?!\\s+of\\s+(?:our|the|your|these|those|them|us)(?!\\p{L}))(?!(?<=(?<!\\p{L})one)\\s+another(?!\\p{L}))';

const TIME_PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => { readings: number[] } | null }[] = [
  // 7:30pm, 7.30 pm, 19:00, 18.30 (not part of a longer number or a dotted date)
  { re: /(?<![\d.,:/])(\d{1,2})[:.](\d{2})(?:\s*([ap])\.?m\.?(?!\p{L}))?(?!\d|[.:/]\d)/giu, read: m => readClockShaped(m[1], m[2], m[3]) },
  // The start of a range, "7-10pm": as written it could be morning or evening.
  { re: /(?<![\d.,:/])(\d{1,2})(?![\d.:])(?=\s*[-–]\s*\d{1,2}(?:[:.]\d{2})?\s*[ap]\.?m)/giu, read: m => readClock(m[1], '0', undefined) },
  // 7pm, 7 pm, 7 p.m.
  { re: /(?<![\d.,:/])(\d{1,2})\s*([ap])\.?m\.?(?!\p{L})/giu, read: m => readClockShaped(m[1], '0', m[2]) },
  { re: /(?<!\p{L})(?:noon|midday)(?!\p{L})/giu, read: () => ({ readings: [720] }) },
  { re: /(?<!\p{L})midnight(?!\p{L})/giu, read: () => ({ readings: [0] }) },
  // Times that can't be checked against a schedule
  { re: new RegExp(`(?<!\\p{L})${HOUR_WORD}\\s*o['’]?clock(?!\\p{L})`, 'giu'), read: () => ({ readings: [] }) },
  { re: new RegExp(`(?<!\\p{L})(?:half|quarter)\\s+(?:past\\s+|to\\s+)?${HOUR_WORD}(?!${LETTER_OR_DIGIT})`, 'giu'), read: () => ({ readings: [] }) },
  // A bare hour after a time word, in digits or words: "at 7", "from 7 till late", "doors 7", "starts at seven", "until 9".
  // Not "at one of our tables" or "from one another" (NOT_AN_HOUR_WORD_AFTER); "at seven thirty" is a time that can't be read.
  {
    re: new RegExp(
      `${TIME_CUE}\\s+(?:(\\d{1,2})(?!\\d|[.:]\\d)|(${NUMBER_WORDS.join('|')})(?:ish)?(?!\\p{L})${NOT_AN_HOUR_WORD_AFTER}(${WORD_MINUTES}(?:\\s*[ap]\\.?m\\.?(?!\\p{L}))?)?)(?!\\s*[ap]\\.?m(?!\\p{L}))(?!${NOT_AN_HOUR_AFTER})`,
      'giu',
    ),
    read: m => (m[3] ? { readings: [] } : readClock(m[1] ?? hourOf(m[2]!), '0', undefined)),
  },
  // A bare hour before "till late": "7 till late"
  { re: new RegExp(`(?<![\\d.,:/£])(\\d{1,2})\\s*${TILL_LATE}`, 'giu'), read: m => readClock(m[1], '0', undefined) },
  // ... or before "onwards" (not "round 7 onwards", "ages 8 onwards")
  { re: new RegExp(`(?<![\\d.,:/£])${NOT_A_COUNT_BEFORE}(\\d{1,2})\\s*${ONWARDS}`, 'giu'), read: m => readClock(m[1], '0', undefined) },
  // An hour in words: "seven till late", "eight onwards", "nine pm"
  { re: new RegExp(`(?<!\\p{L})(${NUMBER_WORDS.join('|')})\\s*${TILL_LATE}`, 'giu'), read: m => readClock(hourOf(m[1]!), '0', undefined) },
  { re: new RegExp(`(?<!\\p{L})${NOT_A_COUNT_BEFORE}(${NUMBER_WORDS.join('|')})\\s*${ONWARDS}`, 'giu'), read: m => readClock(hourOf(m[1]!), '0', undefined) },
  { re: new RegExp(`(?<!\\p{L})(${NUMBER_WORDS.join('|')})\\s*([ap])\\.?m\\.?(?!\\p{L})`, 'giu'), read: m => readClockShaped(hourOf(m[1]!), '0', m[2]) },
];

/** Every clock time in the text. Money is ignored, so "£4.50" isn't a time. */
export function findTimes(text: string): TimeMention[] {
  let masked = text;
  for (const m of findMoney(text)) masked = masked.slice(0, m.index) + ' '.repeat(m.text.length) + masked.slice(m.index + m.text.length);
  return scan(masked, TIME_PATTERNS).map(t => ({ ...t, text: text.slice(t.index, t.index + t.text.length) }));
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

/** The words of a text that are written with a capital there: free text allows a name only like that. */
export function capitalisedWords(text: string): string[] {
  return (text.match(WORD) ?? []).filter(w => /^\p{Lu}/u.test(w));
}

// Words like "Mr." end in a full stop without ending the sentence.
const NOT_A_SENTENCE_END = /(?:^|[^\p{L}])(?:mr|mrs|ms|dr|e\.g|i\.e|vs)\.$/iu;

// The section labels a prompt is written under; the word after "Tone:" starts a sentence, the word after "Host:" doesn't.
const SECTION_LABELS = new Set(
  [
    'tone',
    'tone boundaries',
    'terminology',
    'approved terminology',
    'description',
    'accurate description',
    'event description',
    'permitted facts',
    'facts',
  ].concat(
    ['prohibited assumptions', 'prohibited', 'calls to action', 'call to action', 'safe calls to action', 'schedule', 'rules', 'guidance', 'format'],
    ['audience', 'style', 'voice', 'notes'],
  ),
);

/** Whether the colon at `colon` ends a section label that starts its line (after any bullet, number or emphasis). */
function endsSectionLabel(text: string, colon: number): boolean {
  let lineStart = colon;
  while (lineStart > 0 && !LINE_BREAK_CHAR.test(text[lineStart - 1]!)) lineStart--;
  const label = text
    .slice(lineStart, colon)
    .replace(/^[\s\-*•#>]*(?:\d+[.)]\s*)?/, '')
    .replace(/[*_]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return SECTION_LABELS.has(label);
}

/** Whether the word at index i starts a sentence, a line, a list item or a section ("Tone: Warm"). */
function startsSentence(text: string, i: number): boolean {
  let j = i - 1;
  // Spaces, opening quotes and brackets, and markdown emphasis.
  while (j >= 0 && /[ \t"“‘'(\[*_]/.test(text[j]!)) j--;
  if (j < 0 || LINE_BREAK_CHAR.test(text[j]!)) return true;
  // A bullet, number or heading marker that starts its line: "- ", "• ", "## ".
  if (/[-•#>]/.test(text[j]!)) {
    let k = j;
    while (k >= 0 && /[-*•#> \t]/.test(text[k]!)) k--;
    if (k < 0 || LINE_BREAK_CHAR.test(text[k]!)) return true;
  }
  if (text[j] === ':') return endsSectionLabel(text, j);
  while (j >= 0 && /["”’')\]*_]/.test(text[j]!)) j--;
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

// Wording the prompt forbids ('never say "tonight"', "do not imply free entry") is a banned word, not a claim.
const PROHIBITION_VERB =
  '(?:say(?:s|ing)?|us(?:e|es|ing)|writ(?:e|es|ing)|mention(?:s|ing)?|describ(?:e|es|ing)|call(?:s|ing)?|stat(?:e|es|ing)|claim(?:s|ing)?|impl(?:y|ies|ying)|promis(?:e|es|ing)|suggest(?:s|ing)?|advertis(?:e|es|ing)|refer(?:s|ring)?\\s+to|includ(?:e|es|ing))';
const NEGATIVE =
  "(?<!\\p{L})(?:never|do not|don['’]t|must not|mustn['’]t|avoid|should not|shouldn['’]t)(?:\\s+(?:ever|again|explicitly|directly|actually|specifically|literally|otherwise|even|falsely|wrongly|incorrectly)){0,2}\\s+";
/** "never say", "do not ever use", "avoid mentioning": a negative, at most two adverbs, then a verb of saying. Bare "no" isn't one. */
const PROHIBITION = new RegExp(`${NEGATIVE}${PROHIBITION_VERB}(?!\\p{L})`, 'giu');
// What a prohibition forbids: a few words ("it", "these words", "relative dates"), two such joined
// by "or" or "and" ("dates or times").
const OBJECT_WORD =
  '(?:it|its|the|a|an|any|these|those|this|that|such|words?|phrases?|terms?|expressions?|wording|dates?|times?|days?|prices?|claims?|labels?|language|relative|specific|exact|other|particular)(?!\\p{L})';
const OBJECT = `(?:\\s+${OBJECT_WORD}){1,3}(?:\\s+(?:or|and)(?:\\s+${OBJECT_WORD}){1,3})?`;
// Between a prohibition and the first quoted item it forbids: an object, then "such as", "like",
// "as", "e.g." or ":", or nothing. A bare comma ends it: 'never mention prices, "£10" is the price'.
const FIRST_ITEM_GAP = new RegExp(`(?:${OBJECT})?(?:\\s*(?::|(?:such\\s+as|like|as)(?!\\p{L})|e\\.g\\.))?\\s*`, 'iuy');
// Between one forbidden quoted item and the next: only spaces, commas, "or", "and" and "nor".
const NEXT_ITEM_GAP = /(?:\s|,|(?<!\p{L})(?:or|and|nor)(?!\p{L}))*/iuy;
// Where an item is forbidden, written after it: "in the prompt", "in captions", "anywhere".
const ITEM_PLACE = `(?:in|within|from)${HSPACE}+(?:(?:the|any|a|an|your|our|each|every|all)${HSPACE}+)?(?:prompts?|posts?|captions?|copy|text|wording|messages?|hashtags?)`;
const ITEM_SCOPE = `(?:anywhere(?:${HSPACE}+${ITEM_PLACE})?|${ITEM_PLACE})(?!\\p{L})${HSPACE}*`;
// What must follow a forbidden item, so that it isn't the start of a claim ('"£10 door fee" applies'):
// a list joiner, a closing bracket, the end of a clause or sentence, or the end of the line.
const ITEM_END = new RegExp(`${HSPACE}*(?:${ITEM_SCOPE})?(?:$|${LINE_BREAK}|[,.!?;:)\\]]|(?:or|and|nor)(?!\\p{L}))`, 'iuy');
// An item whose clause ends inside its own quote marks ('"tonight," "tomorrow," or "this weekend."') has ended already.
const ENDS_INSIDE = /[,.!?;:]\s*$/u;
const MAX_ITEM_WORDS = 3;
// A price straight after one of these is the thing forbidden: "never describe it as free", "do not imply free entry".
const MONEY_PROHIBITION = new RegExp(
  `${NEGATIVE}(?:describ(?:e|es|ing)\\s+(?:it|this|the\\s+event|the\\s+session)\\s+as|call(?:s|ing)?\\s+it|say(?:s|ing)?\\s+(?:that\\s+)?(?:it(?:['’]s|\\s+is)|(?:entry|this|the\\s+event)\\s+is)|impl(?:y|ies|ying)|advertis(?:e|es|ing)|promis(?:e|es|ing)|claim(?:s|ing)?|mention(?:s|ing)?|suggest(?:s|ing)?)\\s+$`,
  'iu',
);

const QUOTE_MARK = /["“”‘’']/u;
// An apostrophe that starts a word isn't a quote mark in these: 'til, 'tis, 'em, 'cause, rock 'n' roll, the '90s.
const ELISION = /^['’](?:n['’]|(?:til|till|tis|twas|em|cause|cos|bout|n)(?![\p{L}\p{N}])|\d{2}s?(?![\p{L}\p{N}]))/iu;

/**
 * The quoted stretches of a text, outermost only, or null when its quote marks don't pair up.
 * Every kind of mark (" “ ” ‘ ’, and a straight ' used as one) goes on one stack: a close that
 * doesn't match the open on top, an open that is never closed, or a close with nothing open, and
 * nothing pairs. Apostrophes aren't quote marks: one inside a word ("don't", "90's"), a word-start
 * elision ('til, rock 'n' roll, the '90s), or one ending a word while no single quote is open
 * ("the players' night").
 */
function quotedStretches(text: string): Span[] | null {
  const open: { mark: string; at: number }[] = [];
  const spans: Span[] = [];
  const close = (at: number) => {
    const opened = open.pop()!;
    if (!open.length) spans.push([opened.at, at + 1]);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!QUOTE_MARK.test(c)) continue;
    const top = open[open.length - 1]?.mark;
    if (c === '“' || c === '‘' || (c === '"' && top !== '"')) {
      open.push({ mark: c, at: i });
      continue;
    }
    if (c === '"' || c === '”') {
      if (top !== (c === '"' ? '"' : '“')) return null;
      close(i);
      continue;
    }
    // A single quote mark, straight or curly, or an apostrophe.
    const before = i > 0 && LETTER_OR_DIGIT_RE.test(text[i - 1]!);
    const after = LETTER_OR_DIGIT_RE.test(text[i + 1] ?? '');
    if (before && after) continue;
    const elision = before ? null : ELISION.exec(text.slice(i, i + 8));
    if (elision) {
      // Both marks of 'n' are apostrophes, even inside a single-quoted stretch.
      if (/^['’]n['’]/u.test(elision[0])) i += 2;
      continue;
    }
    // A mark that doesn't start a word closes a single quote of its own kind. Otherwise, after a
    // letter it is a possessive ("the players' night"); a straight one opens a quote; a curly one
    // closes nothing, so nothing pairs.
    const opener = c === "'" ? "'" : '‘';
    if (!(after && !before) && top === opener) close(i);
    else if (before) continue;
    else if (c === "'") open.push({ mark: c, at: i });
    else return null;
  }
  return open.length ? null : spans;
}

/** Whether a quoted stretch can be a forbidden item: at most three words, on one line, and then nothing that goes on to say more. */
function isListItem(text: string, [start, end]: Span): boolean {
  const inside = text.slice(start + 1, end - 1);
  if ((inside.match(/[\p{L}\p{N}]+/gu) ?? []).length > MAX_ITEM_WORDS || LINE_BREAK_CHAR.test(inside)) return false;
  ITEM_END.lastIndex = end;
  return ENDS_INSIDE.test(inside) || ITEM_END.test(text);
}

/**
 * What the prompt forbids rather than claims, and nothing more. Read in the text as written: a
 * prohibition outside any quote, then only the quoted items that follow it as a list ('never say
 * "tonight" or "tomorrow"'), over one line break at most. Each item is at most three words on one
 * line, followed by a list joiner, a closing bracket, the end of a clause or the end of the line;
 * anything else ends the list. For money not in quotes, only a price straight after "describe it
 * as", "call it", "imply" and the like. Where the quote marks don't pair up, a quote can't be told
 * from the text around it, so nothing in the prompt is exempt.
 */
function prohibitions(text: string): { quoted: Span[]; forbidsMoneyAt: (index: number) => boolean } {
  const quotes = quotedStretches(text);
  if (!quotes) return { quoted: [], forbidsMoneyAt: () => false };
  // Only outermost quotes can be items, and no gap lets a quote mark through, so a prohibition inside a quote reaches nothing.
  const quoteAt = new Map(quotes.map(q => [q[0], q]));
  const quoted: Span[] = [];
  for (const p of text.matchAll(PROHIBITION)) {
    let pos = p.index! + p[0].length;
    let gap = FIRST_ITEM_GAP;
    for (;;) {
      gap.lastIndex = pos;
      const between = gap.exec(text)?.[0] ?? '';
      const q = lineBreaks(between) > 1 ? undefined : quoteAt.get(pos + between.length);
      if (!q || !isListItem(text, q)) break;
      quoted.push(q);
      pos = q[1];
      gap = NEXT_ITEM_GAP;
    }
  }
  return {
    quoted,
    // Quoted money goes by the list rule above; this is for money outside quotes.
    forbidsMoneyAt: index => !quotes.some(([s, e]) => index >= s && index < e) && MONEY_PROHIBITION.test(text.slice(0, index)),
  };
}

const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** A name with its separators taken out, with "&" read as "and" and as nothing: "Board & Brew" → boardandbrew, boardbrew. */
function squashed(name: string): string[] {
  const base = name.replace(/&/g, ' and ');
  return [...new Set([squash(base), squash(base.replace(/(?<!\p{L})and(?!\p{L})/giu, ' '))])].filter(Boolean);
}
const positions = (hay: string, needle: string): number[] => {
  const at: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) at.push(i);
  return at;
};

/** Whether an event name of six letters or more is squashed into a hashtag ("#RTDQuizNight"), other than inside `ownName` there. */
function inHashtag(text: string, name: string, ownName: string): boolean {
  if ((name.match(/\p{L}/gu) ?? []).length < 6) return false;
  const own = squashed(ownName);
  return [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].some(([, body]) => {
    const tag = squash(body!);
    const ownSpans = own.flatMap(o => positions(tag, o).map(i => [i, i + o.length] as Span));
    return squashed(name).some(n => positions(tag, n).some(i => !within(i, i + n.length, ownSpans)));
  });
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

/**
 * Why a claim isn't in a field's value, or null when it is: every number in the claim must be
 * there, and at least one distinctive word (or number) of it.
 */
function traceProblem(claim: string, value: string): string | null {
  const have = tokens(value);
  const words = new Set(have);
  const numbers = have.filter(isNumber).map(Number);
  const said = tokens(claim);
  const missing = said.filter(t => isNumber(t) && !numbers.includes(Number(t)));
  if (missing.length) return `${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} there`;
  const found = said.some(t => (isNumber(t) ? numbers.includes(Number(t)) : t.length > 1 && !STOP_WORDS.has(t) && words.has(t)));
  return found ? null : '';
}

/** Why a claim can't be traced to its field, or null when it can. */
function untraced(c: Claim, ref: FieldRef, f: SourceFields, facts: Partial<Record<FactKey, string[]>>): string | null {
  const field = 'fact' in ref ? `approved_facts.${ref.fact}` : ref.field;
  if ('fact' in ref && !facts[ref.fact]?.length) return `Claim "${c.claim}" not found in ${field}: there is no ${ref.fact} fact`;
  const value = 'fact' in ref ? facts[ref.fact]!.join('\n') : String(f[ref.field] ?? '');
  const problem = traceProblem(c.claim, value);
  if (problem === null) return null;
  return `Claim "${c.claim}" not found in ${field}${problem ? `: ${problem}` : ''}`;
}

/** What's wrong with the prompt text itself: dates, times, other prices, other events and unknown names. */
function promptTextErrors(prompt: string, f: SourceFields, otherEventNames: string[]): string[] {
  const errors: string[] = [];
  // The event's own name is its identity, not a claim: "Friday Night Magic" isn't a weekday.
  const own = spansOf(phraseRegex(f.name), prompt);
  const forbidden = prohibitions(prompt);
  const counts = (m: { index: number; text: string }, skip: Span[]) => !within(m.index, m.index + m.text.length, skip);

  for (const d of findDates(prompt)) {
    if (counts(d, [...own, ...forbidden.quoted]))
      errors.push(`The prompt states a date or day, "${d.text}"; the date comes only from the schedule at posting time`);
  }
  for (const t of findTimes(prompt)) {
    if (counts(t, [...own, ...forbidden.quoted])) errors.push(`The prompt states a time, "${t.text}"; the time comes only from the schedule at posting time`);
  }
  const allowedPence = ownPrices(f);
  for (const m of findMoney(prompt)) {
    if (counts(m, [...own, ...forbidden.quoted]) && !forbidden.forbidsMoneyAt(m.index) && !allowedPence.includes(m.pence)) {
      errors.push(`The prompt states "${m.text}", which isn't the event's own price${f.price ? ` (${f.price})` : ''}`);
    }
  }
  // Another event counts wherever it appears, hashtags included, except as part of this event's own name.
  for (const other of otherEventNames) {
    const name = other.trim();
    if (name.length < 4) continue;
    const named = spansOf(phraseRegex(name), prompt).some(([at, end]) => !within(at, end, own)) || inHashtag(prompt, name, f.name);
    if (named) errors.push(`The prompt names another event, "${name}"`);
  }
  const people = parsePeople(f.people_roles).people.map(p => p.name);
  const allowed = [f.name, f.category, ...people, ...[f.base_details, f.approved_facts, f.people_roles].flatMap(capitalisedWords)];
  for (const n of findNames(prompt, allowed)) {
    errors.push(`The prompt names "${n}", which isn't in People & Roles or the event's own fields`);
  }
  return errors;
}

// Source text that reads like an instruction to Gemini. "You are welcome to …" isn't one.
const INSTRUCTION_LIKE = [
  /\bignore\b[^.]{0,40}\b(rules?|instructions?|prompt|above|previous|prior)\b/i,
  /\bforget\b[^.]{0,20}\b(instructions?|rules?)\b/i,
  /\byou are now\b/i,
  /\b(act as|pretend (to be|you are))\b/i,
  /\bsystem prompt\b/i,
  /\bdisregard\b/i,
];

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
    const m = INSTRUCTION_LIKE.map(re => re.exec(value)).find(Boolean);
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
    errors.push(...promptTextErrors(prompt, f, ctx.otherEventNames));
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
