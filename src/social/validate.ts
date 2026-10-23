// The deterministic checks on what Gemini writes (spec §4): the master prompt (§4A) and the
// final post (§4B). Pure functions: no I/O, and the post check is given the time rather than
// reading a clock, so the same input always gets the same answer. They fail closed: anything
// they can't verify is a fail with a reason, and nothing is approved on Gemini's word alone.
//
// The text helpers (findDates, findTimes, findMoney, findNames, capitalisedWords, phraseRegex,
// ownPrices) are shared with the post check, which works on the same kinds of text. A date or
// time they can't read is still reported (with nothing read from it), so callers fail it.

import type { BookingMode } from '../lib/queries';
import { addDays, londonDate } from '../lib/time';
import { CATEGORIES } from '../sync/normalise';
import { FACT_KEYS, parseFacts, parsePeople, type FactKey, type Person, type SourceFields } from './facts';
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
  /** "today", "tonight", "tomorrow", "this weekend" …; "this", "coming", "next" or "last" before a weekday, "week" after one; "christmas". */
  relative?: string;
  /** For "the 2nd Friday of October": which of the month's weekdays it is, 1–5, or -1 for the last. */
  nth?: number;
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

// "the 5th edition", "the 1st place team", "the 20th session", "the 3rd tournament" aren't dates. "the 30th quiz night" is.
const NOT_A_DAY_AFTER =
  '(?!\\s+(?:place|prizes?|edition|hand|times?|rounds?|games?|floor|players?|teams?|half|anniversary|birthday|years?|sessions?|weeks?|visits?|meetups?|tournaments?|leagues?)(?!\\p{L}))';

// How an event recurs: "every 2nd Friday", "on the first and third Tuesday", "the last Friday", "1st Saturday of the
// month". Only 1st–5th, first–fifth and last count; it is read whole, as its weekday, which is still checked.
const RECUR_ORDINAL = '(?:[1-5](?:st|nd|rd|th)|first|second|third|fourth|fifth|last)';
const RECUR_LIST = `${RECUR_ORDINAL}(?:\\s*(?:,|and|&|or)\\s*${RECUR_ORDINAL})*`;
const RECUR_WEEKDAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)s?';
const weekdayOf = (word: string): number => WEEKDAY_NAMES.findIndex(d => d.startsWith(word.toLowerCase().slice(0, 3)));
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
/** 1–5 for "1st"/"first" … "5th"/"fifth", -1 for "last". */
const nthOf = (word: string): number => (/^last$/i.test(word) ? -1 : /^\d/.test(word) ? Number(word[0]) : ORDINALS.indexOf(word.toLowerCase()) + 1);

/** "the 2nd Friday of October" in a year, as "YYYY-MM-DD", or null when the month has no such day. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): string | null {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lastWeekday = new Date(Date.UTC(year, month - 1, days)).getUTCDay();
  const day = nth === -1 ? days - ((lastWeekday - weekday + 7) % 7) : 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7;
  return day <= days ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

// Fixed holidays are dates. "Christmas" on its own is a theme, fine from 1 to 26 December, and so is "Halloween" (but not "on
// Halloween" or "Halloween night") all October; Easter and the other moveable feasts can't be checked.
const HOLIDAYS: Record<string, DateFields> = {
  halloween: { day: 31, month: 10 },
  'christmas day': { day: 25, month: 12 },
  'christmas eve': { day: 24, month: 12 },
  'boxing day': { day: 26, month: 12 },
  'new years eve': { day: 31, month: 12 },
  nye: { day: 31, month: 12 },
  'new years day': { day: 1, month: 1 },
  'bonfire night': { day: 5, month: 11 },
  'guy fawkes': { day: 5, month: 11 },
  'guy fawkes night': { day: 5, month: 11 },
  valentines: { day: 14, month: 2 },
  'valentines day': { day: 14, month: 2 },
  christmas: { relative: 'christmas' },
};
const HOLIDAY =
  "(?<!\\p{L})(halloween|nye|(?:christmas|xmas)\\s+(?:day|eve)|boxing\\s+day|new\\s+year['’]?s\\s+(?:eve|day)|bonfire\\s+night|guy\\s+fawkes(?:\\s+night)?|valentine['’]?s(?:\\s+day)?|christmas|xmas|easter(?:\\s+(?:sunday|monday))?|good\\s+friday|pancake\\s+day|shrove\\s+tuesday|mother['’]?s\\s+day|mothering\\s+sunday|father['’]?s\\s+day)(?!\\p{L})";
const holidayOf = (said: string): DateFields => HOLIDAYS[said.toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ').replace(/^xmas/, 'christmas')] ?? {};
/** "the day after Halloween" is 1 November; "Christmas" counts as the 25th here. Moveable feasts can't be read. */
function holidayOffset(said: string, days: number): DateFields {
  const h = holidayOf(said);
  const [day, month] = h.relative === 'christmas' ? [25, 12] : [h.day, h.month];
  if (day === undefined || month === undefined) return {};
  const at = new Date(Date.UTC(2001, month - 1, day + days));
  return { day: at.getUTCDate(), month: at.getUTCMonth() + 1 };
}

const DATE_PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => DateFields | null }[] = [
  // the last Friday of October, the 2nd Friday in October 2026: a real date, worked out in the year (not after every or each).
  // Two or more ordinals ("the 2nd and 4th Friday of October") can't be read.
  {
    re: new RegExp(
      `(?<![\\p{L}\\p{N}])(?<!(?<!\\p{L})(?:every|each)\\s+(?:the\\s+)?)(?:(?:on\\s+)?the\\s+)?(${RECUR_LIST})\\s+${RECUR_WEEKDAY}\\s+(?:of|in)\\s+${MONTH}(?:,?\\s+(\\d{4}))?(?!\\p{L})`,
      'giu',
    ),
    read: m => {
      const nths = m[1]!.split(/\s*(?:,|and|&|or)\s*/i);
      if (nths.length > 1 || !monthOf(m[3]!)) return {};
      return { nth: nthOf(nths[0]!), weekday: weekdayOf(m[2]!), month: monthOf(m[3]!), ...(m[4] ? { year: Number(m[4]) } : {}) };
    },
  },
  // the day after Halloween, the day before Christmas Eve
  {
    re: new RegExp(`(?<!\\p{L})(?:the\\s+)?day\\s+(after|before)\\s+${HOLIDAY.slice('(?<!\\p{L})'.length)}`, 'giu'),
    read: m => holidayOffset(m[2]!, m[1]!.toLowerCase() === 'after' ? 1 : -1),
  },
  // every 2nd Friday, on the first and third Tuesday, 1st Saturday of the month
  {
    re: new RegExp(`(?<!\\p{L})(?:every|each|on\\s+every|on\\s+the|the)\\s+${RECUR_LIST}\\s+${RECUR_WEEKDAY}(?!\\p{L})`, 'giu'),
    read: m => ({ weekday: weekdayOf(m[1]!) }),
  },
  {
    re: new RegExp(`(?<![\\p{L}\\p{N}])${RECUR_LIST}\\s+${RECUR_WEEKDAY}\\s+of\\s+(?:the|each|every)\\s+month(?!\\p{L})`, 'giu'),
    read: m => ({ weekday: weekdayOf(m[1]!) }),
  },
  // "on Halloween" and "Halloween night" are 31 October
  { re: /(?<!\p{L})(?:on\s+halloween|halloween\s+night)(?!\p{L})/giu, read: () => ({ day: 31, month: 10 }) },
  // Halloween, Christmas Eve, Bonfire Night … ("Halloween" on its own is a theme, fine all October)
  { re: new RegExp(HOLIDAY, 'giu'), read: m => (m[1]!.toLowerCase() === 'halloween' ? { relative: 'halloween' } : holidayOf(m[1]!)) },
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
  // October 23, Oct 23rd, October 23, 2026 (not "October 23:45", which is a month and a time)
  {
    re: new RegExp(`(?<!\\p{L})${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!${LETTER_OR_DIGIT}|[:.]\\d)`, 'giu'),
    read: m => (monthOf(m[1]!) ? dmy(m[2], monthOf(m[1]!), m[3]) : {}),
  },
  // on the 23rd, the 1st
  { re: new RegExp(`(?<!\\p{L})(?:on\\s+the|the|on)\\s+(\\d{1,2})(?:st|nd|rd|th)(?!\\p{L})${NOT_A_DAY_AFTER}`, 'giu'), read: m => dayOnly(m[1]) },
  // 23rd of
  { re: new RegExp(`(?<!${LETTER_OR_DIGIT})(\\d{1,2})(?:st|nd|rd|th)\\s+of(?!\\p{L})`, 'giu'), read: m => dayOnly(m[1]) },
  // 23rd, Friday 30th: an ordinal on its own is a day of the month
  { re: new RegExp(`(?<!${LETTER_OR_DIGIT})(\\d{1,2})(?:st|nd|rd|th)(?!\\p{L})${NOT_A_DAY_AFTER}`, 'giu'), read: m => dayOnly(m[1]) },
  // October 2026
  { re: new RegExp(`(?<!\\p{L})${MONTH}\\s+(\\d{4})(?!\\d)`, 'giu'), read: m => (monthOf(m[1]!) ? { month: monthOf(m[1]!), year: Number(m[2]) } : {}) },
  // October, Oct: a month on its own, except lower-case "may" and "march", which are usually verbs
  {
    re: /(?<!\p{L})(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?(?!\p{L})/giu,
    read: m => (m[1] === 'may' || m[1] === 'march' ? null : { month: monthOf(m[1]!) }),
  },
  // this Friday, coming Friday, next Friday: a weekday relative to today
  {
    re: /(?<!\p{L})(this|coming|next|last)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?!\p{L})/giu,
    read: m => ({ weekday: WEEKDAY_NAMES.indexOf(m[2]!.toLowerCase()), relative: m[1]!.toLowerCase() }),
  },
  // this Fri, next sat.
  {
    re: /(?<!\p{L})(this|coming|next|last)\s+(mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)\.?(?!\p{L})/giu,
    // "enjoy this sun": lower-case "sun" is the weather.
    read: m => (m[2] === 'sun' ? null : { weekday: weekdayOf(m[2]!), relative: m[1]!.toLowerCase() }),
  },
  // Friday week, Fri week: a week on from a weekday
  {
    re: /(?<!\p{L})(monday|tuesday|wednesday|thursday|friday|saturday|sunday|Mon|Tues?|Weds?|Thu(?:rs?)?|Fri|Sat|Sun)\.?\s+week(?!\p{L})/giu,
    read: m => ({ weekday: WEEKDAY_NAMES.findIndex(d => d.startsWith(m[1]!.toLowerCase().slice(0, 3))), relative: 'week' }),
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

/**
 * A money amount, in pence, at `index`. "free", "no charge" and "no cost" are 0; a negated "free" ("not free") isn't a price.
 * NaN when part of it can't be read ("two pounds and a half"), so it matches no price.
 */
export interface MoneyMention {
  text: string;
  index: number;
  pence: number;
}

const pence = (pounds: string, part: string | undefined): number => Number(pounds.replace(/,/g, '')) * 100 + Number((part ?? '').padEnd(2, '0'));

// A "free" straight after a negative isn't a price: "not free", "isn't entirely free", "no free play".
const NOT_NEGATED = "(?<!(?<!\\p{L})(?:not|isn['’]t|aren['’]t|wasn['’]t|no|never)\\s+(?:(?:entirely|completely|totally|really|actually|quite|always)\\s+)?)";

// Numbers written as words, 1–99: "five", "fifteen", "twenty-five", "twenty five".
const ONES = 'one two three four five six seven eight nine'.split(' ');
const TEENS = 'ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
const NUMBER_WORD = `(?:(?:${TENS.join('|')})(?:[-\\s]+(?:${ONES.join('|')}))?|${TEENS.join('|')}|${ONES.join('|')})(?!\\p{L})`;
// Pounds may also run to hundreds and thousands: "one hundred", "a hundred and fifty", "two thousand".
const BIG_NUMBER_WORD = `(?:(?:a|${NUMBER_WORD})\\s+(?:hundred|thousand)(?:\\s+(?:and\\s+)?${NUMBER_WORD})?|${NUMBER_WORD})`;
function numberWord(text: string): number {
  let total = 0;
  let n = 0;
  for (const w of text.toLowerCase().split(/[-\s]+/)) {
    if (w === 'hundred') n = (n || 1) * 100;
    else if (w === 'thousand') {
      total += (n || 1) * 1000;
      n = 0;
    } else if (w === 'a') n += 1;
    else if (w !== 'and') n += TENS.includes(w) ? (TENS.indexOf(w) + 2) * 10 : TEENS.includes(w) ? TEENS.indexOf(w) + 10 : ONES.indexOf(w) + 1;
  }
  return total + n;
}
// After a price word, number words are pounds, and a second one 10–99 is pence: "entry is three", "entry's two fifty",
// "tickets: two-fifty". Not before a count or "of" ("entry is two rounds", "price of one").
const PRICE_WORD = "(?<!\\p{L})(?:entry(?:['’]s)?|tickets?|prices?|costs?)(?:\\s*:|\\s+(?:is|are))?";
// After "it's", "just" or "only", only an amount that ends its clause or is "each": "just two fifty!", not "only two places left".
const LOOSE_PRICE_WORD = "(?<!\\p{L})(?:it['’]s|is\\s+just|just|only)";
const PENCE_NUMBER_WORD = `(?:(?:${TENS.join('|')})(?:[-\\s]+(?:${ONES.join('|')}))?|${TEENS.join('|')})(?!\\p{L})`;
const WORD_AMOUNT = `(${NUMBER_WORD})(?:[-\\s]+(${PENCE_NUMBER_WORD}))?`;
const COUNTED =
  "(?:players?|people|persons?|years?|yrs?|teams?|tables?|seats?|places?|spaces?|guests?|rounds?|games?|questions?|minutes?|mins?|hours?|hrs?|weeks?|months?|days?|kids|children|adults|of|more|left|o['’]?clock|[ap]\\.?m\\.?)";
const NOT_COUNTED = `(?!\\s*${COUNTED}(?!\\p{L}))`;
const AMOUNT_ENDS = '(?=\\s*(?:[.!?,;)]|$|(?:each|per|a\\s+head|a\\s+person)(?!\\p{L})))';
const wordAmount = (m: RegExpMatchArray): { pence: number } => ({ pence: numberWord(m[1]!) * 100 + (m[2] ? numberWord(m[2]) : 0) });
// Pence after pounds: "two pounds fifty", "£2 fifty", "5 pounds 50". "and a half" can't be read, so the amount fails.
const PENCE_AFTER = `(?:\\s+(?:and\\s+)?(?:(?<pw>${NUMBER_WORD})|(?<pd>\\d{1,2})(?!\\d|[.:]\\d)|(?<ph>(?:a\\s+)?half)(?!\\p{L})))?`;
const PENCE_WORD_AFTER = `(?:\\s+(?:and\\s+)?(?:(?<pw>${NUMBER_WORD})|(?<ph>(?:a\\s+)?half)(?!\\p{L})))?`;
const penceAfter = (m: RegExpMatchArray): number => {
  const g = m.groups ?? {};
  if (g.ph) return NaN;
  if (g.pd) return Number(g.pd);
  if (!g.pw) return 0;
  const p = numberWord(g.pw);
  return p < 100 ? p : NaN;
};

const MONEY_PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => { pence: number } }[] = [
  // £4, £4.00, £ 10, £1,000
  {
    re: new RegExp(`£\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2})(?!\\d)|(?!\\d)${PENCE_WORD_AFTER})`, 'giu'),
    read: m => ({ pence: pence(m[1]!, m[2]) + penceAfter(m) }),
  },
  // GBP 10
  { re: /(?<!\p{L})gbp\s?(\d+)(?:\.(\d{1,2}))?(?!\d)/giu, read: m => ({ pence: pence(m[1]!, m[2]) }) },
  // 10 pounds, 5 quid, 10 GBP, a 10-pound note, 5 pounds 50
  {
    re: new RegExp(`(?<![\\d.£])(\\d+)(?:\\.(\\d{1,2}))?[\\s-]*(?:pounds?|quid|gbp)(?!\\p{L})${PENCE_AFTER}`, 'giu'),
    read: m => ({ pence: pence(m[1]!, m[2]) + penceAfter(m) }),
  },
  // five pounds, twenty-five quid, a ten-pound entry, two pounds fifty, a fiver, a tenner
  {
    re: new RegExp(`(?<!\\p{L})(${BIG_NUMBER_WORD})[\\s-]+(?:pounds?|quid)(?!\\p{L})${PENCE_AFTER}`, 'giu'),
    read: m => ({ pence: numberWord(m[1]!) * 100 + penceAfter(m) }),
  },
  // entry is three, entry's two fifty, costs four ninety-nine, just two-fifty!, five each
  { re: new RegExp(`${PRICE_WORD}\\s+${WORD_AMOUNT}${NOT_COUNTED}`, 'giu'), read: wordAmount },
  { re: new RegExp(`${LOOSE_PRICE_WORD}\\s+${WORD_AMOUNT}${AMOUNT_ENDS}`, 'giu'), read: wordAmount },
  { re: new RegExp(`(?<!\\p{L})(${NUMBER_WORD})()\\s+each(?!\\p{L})`, 'giu'), read: wordAmount },
  { re: /(?<!\p{L})(fiver|tenner)s?(?!\p{L})/giu, read: m => ({ pence: m[1]!.toLowerCase() === 'fiver' ? 500 : 1000 }) },
  // 50p (not "7pm" or "7p.m.")
  { re: /(?<![\d.£])(\d+)p(?!\p{L}|\.m)/giu, read: m => ({ pence: Number(m[1]) }) },
  // free of charge, complimentary, costs nothing, no entry fee, no cover charge
  {
    re: new RegExp(`(?<![\\p{L}-])${NOT_NEGATED}(?:free of charge|complimentary|costs? nothing|no entry fee|no cover charge)(?![\\p{L}-])`, 'giu'),
    read: () => ({ pence: 0 }),
  },
  // no charge, no cost
  { re: /(?<!\p{L})no (?:charge|cost)(?!\p{L})/giu, read: () => ({ pence: 0 }) },
  // free-to-enter, free-entry, free-of-charge
  {
    re: new RegExp(`(?<![\\p{L}-])${NOT_NEGATED}free-(?:to-(?:enter|play|join|attend)|entry|admission|of-charge)(?![\\p{L}-])`, 'giu'),
    read: () => ({ pence: 0 }),
  },
  // free (not "feel free" or "gluten-free")
  { re: new RegExp(`(?<![\\p{L}-])(?<!feel\\s+)${NOT_NEGATED}free(?![\\p{L}-])`, 'giu'), read: () => ({ pence: 0 }) },
];

/** Every money amount in the text, so "£4" and "£4.00" compare equal, and "free" is £0. */
export function findMoney(text: string): MoneyMention[] {
  return scan(text, MONEY_PATTERNS);
}

/** Prices in pence from an App Price (a bare number counts as pounds) and Approved Facts `Price` lines. */
function pricesOf(price: string, priceFacts: string[] = []): number[] {
  const amounts = [price, ...priceFacts].flatMap(t => findMoney(t).map(m => m.pence)).filter(p => !Number.isNaN(p));
  const bare = /^\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(price);
  if (bare) amounts.push(pence(bare[1]!, bare[2]));
  return amounts;
}

/** The event's own prices in pence: its App Price (a bare number counts as pounds) and any Approved Facts `Price` line. */
export function ownPrices(f: SourceFields): number[] {
  return pricesOf(f.price, parseFacts(f.approved_facts).facts.Price);
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
// The words that start a bare hour: "at 7", "from seven till late", "doors 7", "starts at 7", "until 9", "by 7" (not "followed by 3", "hosted by 2").
const TIME_CUE =
  '(?<!\\p{L})(?:(?<!(?<!\\p{L})(?:capped|limited|max|maximum|up\\s+to)\\s+)at|from|until|till|til|(?<!(?<!\\p{L})(?:followed|hosted|run|led|organi[sz]ed|won|beaten|divided|split|multiplied)\\s+)by|doors(?:\\s+open)?(?:\\s+at)?|starts?(?:\\s+at)?|starting(?:\\s+at)?|begins?(?:\\s+at)?)';
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
  // A bare hour after a time and "to" or a dash: the 11 of "6:30pm to 11" (not "from 2 to 6 players")
  {
    re: new RegExp(
      `(?<=(?:\\d[:.]\\d{2}|\\d\\s*[ap]\\.?m\\.?)\\s*)(?:to|-|–)\\s*(\\d{1,2})(?!\\d|[.:]\\d)(?!\\s*[ap]\\.?m(?!\\p{L}))(?!${NOT_AN_HOUR_AFTER})`,
      'giu',
    ),
    read: m => readClock(m[1], '0', undefined),
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

/** Every clock time in the text. Money and dates are ignored, so "£4.50" isn't a time, and nor is the 21 of "starting 21/10/2026". */
export function findTimes(text: string): TimeMention[] {
  let masked = text;
  for (const m of [...findMoney(text), ...findDates(text)])
    masked = masked.slice(0, m.index) + ' '.repeat(m.text.length) + masked.slice(m.index + m.text.length);
  return scan(masked, TIME_PATTERNS).map(t => ({ ...t, text: text.slice(t.index, t.index + t.text.length) }));
}

// Capitalised words that are never anyone's name: the venue and its platforms, labels, months and
// days, and the words a prompt capitalises for emphasis or in headings.
const BRAND_NAMES = ['Roll The Dice', 'RTD', 'Cleethorpes', 'Meridian Point', 'Facebook', 'Instagram', 'TikTok'];
const COMMON_WORDS = [
  // Michelle writes as herself ("I'm hosting"); "Host" is a role word, not a name; "FREE" is the price, in capitals.
  ...["i'm", "i've", "i'll", "i'd", 'host', 'hosts', 'free'],
  ...['i', 'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'not', 'no', 'yes', 'only', 'never', 'always', 'must', 'should', 'do', "don't", 'does', 'is', 'are'],
  ...['be', 'all', 'any', 'none', 'every', 'each', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its', 'this', 'that', 'use'],
  ...['avoid', 'include', 'mention', 'important', 'note', 'ok', 'uk', 'event', 'events', 'name', 'description', 'details', 'base', 'approved', 'facts'],
  ...['fact', 'people', 'roles', 'role', 'category', 'price', 'capacity', 'source', 'field', 'fields', 'terminology', 'permitted', 'prohibited'],
  ...['assumptions', 'tone', 'boundaries', 'call', 'calls', 'action', 'actions', 'cta', 'safe', 'rule', 'rules', 'schedule', 'guidance', 'editorial'],
  ...['key', 'post', 'posts', 'caption', 'captions', 'hashtag', 'hashtags', 'social', 'media', 'board', 'game', 'games', 'cafe', 'café', 'venue'],
  ...['trivia', 'fun', 'team', 'teams', 'friend', 'friends', 'food', 'drink', 'drinks', 'snack', 'snacks'],
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

/** The built-in allowed words, and the words of `allowed`. */
function allowedSet(allowed: Iterable<string>): Set<string> {
  const ok = new Set(BASE_ALLOWED);
  for (const a of allowed) addWords(ok, a);
  return ok;
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

// A prompt's headings are written in capitals ("PUBLISHING & SCHEDULE RULES:"): a word of two or more capitals and no small
// letters, or an abbreviation's plural ("URLs", "FAQs").
const isAllCaps = (word: string): boolean => (word.match(/\p{Lu}/gu) ?? []).length >= 2 && !/\p{Ll}/u.test(word.replace(/s$/, ''));
// The words a label may join with: "Safe Call to Action", "Target Audience / Age", "Strict Boundary on Content".
const LABEL_JOINERS = new Set(['and', 'or', 'to', 'of', 'for', 'the', 'a', 'an', 'on', 'in', 'with', 'by', 'at', 'from', 'per']);
// Words a prompt's labels are made of, known or not to the event: "Target Audience:", "Ticket Price:".
const LABEL_WORDS = new Set(
  [...SECTION_LABELS].flatMap(l => l.split(' ')).concat(
    ['target', 'requirement', 'requirements', 'details', 'detail', 'name', 'price', 'ticket', 'capacity', 'category', 'info', 'information', 'cost'],
    ['leader', 'leaders'],
  ),
);
const LABEL_LINE = /^[ \t]*(?:[-*•#>]+[ \t]*|\d{1,3}[.)][ \t]*)?[*_]*([^:]{1,80}?)[*_]*[ \t]*:/u;

/**
 * The labels of a prompt's lines: the text before the first colon, after any bullet or number
 * ("- Booking Requirement:", "Target Audience / Age:"). Only up to six words, each capitalised or a
 * joiner, with nothing but spaces, "&", "/" and "-" between, and one of them a word already known
 * ("Booking", "Age", "Event") or a label word ("Target Audience"), so "- Trixie Smith: helper" and "Write about Trixie: …" aren't labels.
 */
function labelSpans(text: string, ok: Set<string>): Span[] {
  const spans: Span[] = [];
  for (const line of text.matchAll(/^.*$/gmu)) {
    const m = LABEL_LINE.exec(line[0]);
    const label = m?.[1];
    if (!m || !label || !/^[\p{L}\p{N}'’ \t&/-]+$/u.test(label)) continue;
    const words = label.match(WORD) ?? [];
    const titled = words.every(w => /^[\p{Lu}\p{N}]/u.test(w) || LABEL_JOINERS.has(w.toLowerCase()));
    if (words.length > 6 || !titled || !words.some(w => isAllowed(w, ok) || LABEL_WORDS.has(w.toLowerCase()))) continue;
    const at = line.index! + m[0].lastIndexOf(label);
    spans.push([at, at + label.length]);
  }
  return spans;
}

/** The words of a prompt's line labels that are label words ("Host/Leader:", "Event Leader:"): never a name beside a role word. */
function labelWordSpans(text: string, allowed: Iterable<string>): Span[] {
  const labels = labelSpans(text, allowedSet(allowed));
  return [...text.matchAll(WORD)]
    .filter(m => LABEL_WORDS.has(m[0].toLowerCase()) && within(m.index!, m.index! + m[0].length, labels))
    .map(m => [m.index!, m.index! + m[0].length] as Span);
}

// A web address: "https://www.eventbrite.co.uk/o/89845223753", "www.example.com/events". Its host and path end at "?" or "#".
const WEB_ADDRESS = /(?<![\p{L}\p{N}])(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]{1,200}/giu;
const URL_QUERY = /[?#].*$/su;
/** The host and path of each web address in a text. */
const urlsIn = (text: string): string[] => [...text.matchAll(WEB_ADDRESS)].map(m => m[0].replace(URL_QUERY, ''));

/** Whether the word at `at`..`end` opens a value or an aside, after a colon or "(", and runs on in small letters ("Prizes: Cash prizes", "(Check the schedule)"). */
function startsValue(text: string, at: number, end: number): boolean {
  let j = at - 1;
  while (j >= 0 && /[ \t"“‘'*_]/.test(text[j]!)) j--;
  return j >= 0 && (text[j] === ':' || text[j] === '(') && /^[ \t]{1,3}\p{Ll}/u.test(text.slice(end, end + 4));
}

/** Whether the word at `at` comes straight after a colon ("Booking: Essential"). */
function afterColon(text: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && /[ \t"“‘'*_]/.test(text[j]!)) j--;
  return j >= 0 && text[j] === ':';
}

/**
 * Capitalised words that aren't allowed: not in `allowed` (words or phrases, any case), not a
 * built-in venue, label, month, day or common word, not starting a sentence and not a hashtag.
 * Neighbouring finds are joined ("Trixie Smith"). Each is reported once.
 *
 * In a prompt (`prompt`), which is written as headings, labels and lists, neither are words in
 * capitals ("PUBLISHING", "FREE"), the words of a line's label ("Booking Requirement:"), nor the
 * first word of a value or an aside that runs on in small letters ("Age Guidance: Family friendly"),
 * nor a value word written in `valueWords` in any case ("Booking: Essential"), nor anything inside a web address.
 * "Host: Trixie" still names Trixie. Another event's name in capitals is caught by its own check.
 */
export function findNames(text: string, allowed: Iterable<string>, opts: { prompt?: boolean; valueWords?: string[] } = {}): string[] {
  const ok = allowedSet(allowed);
  const labels = opts.prompt ? labelSpans(text, ok) : [];
  const urls = opts.prompt ? spansOf(WEB_ADDRESS, text) : [];
  const values = new Set((opts.valueWords ?? []).map(w => w.toLowerCase()));
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
    const layout = opts.prompt === true && (isAllCaps(word) || within(at, lastEnd, labels) || within(at, lastEnd, urls) || startsValue(text, at, lastEnd) || (values.has(word.toLowerCase()) && afterColon(text, at)));
    const name = /^\p{Lu}/u.test(word) && text[at - 1] !== '#' && !isAllowed(word, ok) && !startsSentence(text, at) && !layout;
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
  "(?<!\\p{L})(?:never|do not|don['’]t|must not|mustn['’]t|(?<!(?:never|not|n['’]t)\\s+)avoid|should not|shouldn['’]t)(?:\\s+(?:ever|again|explicitly|directly|actually|specifically|literally|otherwise|even|falsely|wrongly|incorrectly)){0,2}\\s+";
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
// What may follow a comma after a forbidden item: another item, a list joiner or the end of the line.
// Anything else is a clause about the item ('"£10", which is paid on the door').
const AFTER_COMMA = `${HSPACE}*(?=$|${LINE_BREAK}|["“‘']|(?:or|and|nor)(?!\\p{L}))`;
// What must follow a forbidden item, so that it isn't the start of a claim ('"£10 door fee" applies'):
// a list joiner, a closing bracket, the end of a clause or sentence, or the end of the line.
const ITEM_END = new RegExp(`${HSPACE}*(?:${ITEM_SCOPE})?(?:$|${LINE_BREAK}|[.!?;:)\\]]|,${AFTER_COMMA}|(?:or|and|nor)(?!\\p{L}))`, 'iuy');
const AFTER_INSIDE_COMMA = new RegExp(`${HSPACE}*(?:$|${LINE_BREAK}|[.!?;:)\\]]|,${AFTER_COMMA}|["“‘']|(?:or|and|nor)(?!\\p{L}))`, 'iuy');
// An item whose clause ends inside its own quote marks ('"tonight." or "this weekend."') has ended already;
// one ending in a comma ('"tonight," "tomorrow,"') is followed as if the comma were outside.
const ENDS_INSIDE = /[.!?;:]\s*$/u;
// Where a list of forbidden items must stop: with the sentence, or with another prohibition. After the
// last item (and any "in the prompt"), only a full stop, ! or ?, a closing bracket, the end of the line
// before a new sentence, a bullet or a blank line, or ", and do not…" / "; never…". Anything else
// ('"£10", and it is paid on the door') makes the items a claim.
// (Two patterns, as "a new sentence" must be told by its capital letter, which a case-blind pattern can't.)
const LIST_END = new RegExp(`${HSPACE}*(?:${ITEM_SCOPE})?(?:[.!?)\\]]|[,;:]?${HSPACE}*(?:$|${LINE_BREAK}(?=\\s*(?:$|[-*•>#\\d\\p{Lu}]))))`, 'uy');
const LIST_THEN_PROHIBITION = new RegExp(`${HSPACE}*(?:${ITEM_SCOPE})?[,;]?${HSPACE}*(?:(?:and|or|but)${HSPACE}+)?(?=${NEGATIVE})`, 'iuy');
const ENDS_SENTENCE_INSIDE = /[.!?]\s*$/u;
const MAX_ITEM_WORDS = 3;
// A plain quoted item may run to six words ('never say "you don't need to book"'): no digit, £, capital, date, time, price or number word.
const MAX_PLAIN_ITEM_WORDS = 6;
// A long item that opens like a clause about the item before it ('"£10", "which is paid on the door"') is no forbidden item.
const CLAUSE_START = /^\s*(?:which|that|who|whom|whose|where|when|while|because|cause|since|as|so|and|but|or|if|unless|though|although)(?![\p{L}\p{N}])/iu;
// A price straight after one of these is the thing forbidden: "never describe it as free", "do not imply free entry".
const MONEY_PROHIBITION = new RegExp(
  `${NEGATIVE}(?:describ(?:e|es|ing)\\s+(?:it|this|the\\s+event|the\\s+session)\\s+as|call(?:s|ing)?\\s+it|say(?:s|ing)?\\s+(?:that\\s+)?(?:it(?:['’]s|\\s+is)|(?:entry|this|the\\s+event)\\s+is)|impl(?:y|ies|ying)|advertis(?:e|es|ing)|promis(?:e|es|ing)|claim(?:s|ing)?|mention(?:s|ing)?|suggest(?:s|ing)?)\\s+$`,
  'iu',
);

// Words that tie a quoted item to a date, a time or an amount.
const DATED_WORDS = new Set([
  ...MONTH_NAMES,
  ...WEEKDAY_NAMES,
  ...SHORT_DAYS_AND_MONTHS,
  ...ONES,
  ...TEENS,
  ...TENS,
  ...['hundred', 'thousand', 'noon', 'midday', 'midnight', 'am', 'pm', 'oclock', 'half', 'quarter', 'today', 'tonight', 'tomorrow', 'yesterday'],
  ...['week', 'weeks', 'weekend', 'weekends', 'month', 'year', 'next', 'last', 'pound', 'pounds', 'quid', 'pence', 'fiver', 'tenner', 'free'],
]);

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

/** Whether a quoted item says nothing about when or how much: no digit, £, capital letter, date, time, price, number, month, weekday or relative day. */
function plainItem(inside: string): boolean {
  if (/[\d£$€\p{Lu}]/u.test(inside) || findDates(inside).length || findTimes(inside).length || findMoney(inside).length) return false;
  return !tokens(inside).some(w => DATED_WORDS.has(w));
}

/** Whether a quoted stretch can be a forbidden item: at most three words (six plain ones), on one line, and then nothing that goes on to say more. */
function isListItem(text: string, [start, end]: Span): boolean {
  const inside = text.slice(start + 1, end - 1);
  const words = (inside.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  if (words > MAX_PLAIN_ITEM_WORDS || (words > MAX_ITEM_WORDS && (!plainItem(inside) || CLAUSE_START.test(inside))) || LINE_BREAK_CHAR.test(inside))
    return false;
  if (ENDS_INSIDE.test(inside)) return true;
  const follows = /,\s*$/u.test(inside) ? AFTER_INSIDE_COMMA : ITEM_END;
  follows.lastIndex = end;
  return follows.test(text);
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
    const items: Span[] = [];
    for (;;) {
      gap.lastIndex = pos;
      const between = gap.exec(text)?.[0] ?? '';
      const q = lineBreaks(between) > 1 ? undefined : quoteAt.get(pos + between.length);
      if (!q || !isListItem(text, q)) break;
      items.push(q);
      pos = q[1];
      gap = NEXT_ITEM_GAP;
    }
    const last = items[items.length - 1];
    if (!last) continue;
    LIST_END.lastIndex = LIST_THEN_PROHIBITION.lastIndex = pos;
    if (ENDS_SENTENCE_INSIDE.test(text.slice(last[0] + 1, last[1] - 1)) || LIST_END.test(text) || LIST_THEN_PROHIBITION.test(text)) quoted.push(...items);
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

/** Whether an event name of `minLetters` letters or more is squashed into a hashtag ("#RTDQuizNight"), other than inside one of `ownNames` there. */
function inHashtag(text: string, name: string, ownNames: string[], minLetters = 6): boolean {
  if ((name.match(/\p{L}/gu) ?? []).length < minLetters) return false;
  const own = ownNames.flatMap(squashed);
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

/** What's wrong with the prompt text itself: dates, times, other prices, other events and unknown names. Also run on an admin's own text (src/social/prompts.ts). */
export function promptTextErrors(prompt: string, f: SourceFields, otherEventNames: string[]): string[] {
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
    const named = spansOf(phraseRegex(name), prompt).some(([at, end]) => !within(at, end, own)) || inHashtag(prompt, name, [f.name]);
    if (named) errors.push(`The prompt names another event, "${name}"`);
  }
  const people = parsePeople(f.people_roles).people;
  // A web address in Base Details or Approved Facts allows the words of its host and path, in any case ("Eventbrite").
  const allowed = [
    f.name,
    f.category,
    ...people.map(p => p.name),
    ...[f.base_details, f.approved_facts, f.people_roles].flatMap(capitalisedWords),
    ...[f.base_details, f.approved_facts].flatMap(urlsIn),
  ];
  // Gemini capitalises a fact's own word as a label's value ("Booking: Essential").
  const valueWords = [f.base_details, f.approved_facts].flatMap(t => t.match(WORD) ?? []);
  for (const n of findNames(prompt, allowed, { prompt: true, valueWords })) {
    errors.push(`The prompt names "${n}", which isn't in People & Roles or the event's own fields`);
  }
  // Format claims and role words, as in a post, except where the prompt forbids them ('never say "drop in"').
  const exempt = [...own, ...forbidden.quoted, ...forbiddenLists(prompt)];
  const support = { name: f.name, base_details: f.base_details, facts: parseFacts(f.approved_facts).facts, booking_mode: null };
  for (const p of claimProblems(prompt, exempt, support, true)) errors.push(`In the prompt, ${p}`);
  // A role beside a name is allowed only as People & Roles give it, or where Base Details or Approved Facts write that name with that role.
  // A label word in a line's label ("Host/Leader:") isn't anyone's name.
  const labelWords = labelWordSpans(prompt, allowed);
  for (const p of roleProblems(prompt, exempt, people, rolePairs([f.base_details, f.approved_facts]), labelWords)) errors.push(`In the prompt, ${p}`);
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

// Booking wording: "drop in" and its kind, and "booking essential" and its kind. Any negated booking word is drop in
// ("no booking", "you won't need a ticket", "don't bother booking", "booking? not necessary"), except "not booked
// yet?" and "haven't got your tickets yet?" with nothing reassuring after them, and "nobody can play without
// booking", which say booking is needed ("do not book" is still drop in). "No walk-ins" and "no ticket, no entry"
// say booking is needed too. "Booking is optional" is a third kind.
// "Don't forget to book" isn't negated booking.
const NOT_NEEDED = "(?:is\\s+not|are\\s+not|isn['’]t|aren['’]t|not)\\s+(?:required|needed|necessary)";
const NEGATIVE_WORD =
  "(?:(?<!\\p{L})(?:no|not|without|never|nobody|no\\s+one|no\\s+need\\s+(?:to|for)|don['’]t\\s+bother(?:\\s+with)?|don['’]t\\s+worry\\s+about)|n['’]t)";
const GAP_WORD = "\\s+(?!(?:forget|miss|hesitate|wait|delay|leave)(?!\\p{L}))\\p{L}+(?:['’]\\p{L}+)?";
const BOOKING_WORD = '(?:pre-?)?(?:book|reserv|ticket)\\p{L}*';
const DROP_IN = new RegExp(
  `(?:(?<!\\p{L})(?:drop[ -]?ins?|walk[ -]?ins?|just turn up|turn up on the (?:night|day)|pop in|rock up|come along on the (?:night|day)|open table|open play|no need to book|(?:bookings?|tickets?|reservations?)[?.]?\\s+${NOT_NEEDED})` +
    `|${NEGATIVE_WORD}(?:${GAP_WORD}){0,2}\\s+${BOOKING_WORD})(?!\\p{L})`,
  'giu',
);
// "Not booked yet?", "haven't got tickets?": booking is needed, unless the same or the next sentence reassures ("No worries, just come along",
// "You're still welcome", "Swing by anyway").
const NOT_BOOKED_YET = new RegExp(
  "(?<!\\p{L})(?:(?:not|haven['’]t|have\\s+not|yet\\s+to)\\s+(?:booked|got\\s+(?:(?:your|a|any)\\s+)?tickets?|reserved)|(?:haven['’]t|have\\s+not|yet\\s+to)\\s+book)(?:\\s+yet)?(?!\\p{L})",
  'giu',
);
const REASSURANCE = new RegExp(
  "(?<!\\p{L})(?:no\\s+(?:worries|worry|problems?|bother|stress)|(?:doesn['’]t|does\\s+not|don['’]t|won['’]t)\\s+matter|don['’]t\\s+worry|never\\s+mind" +
    "|(?:that['’]s|it['’]s|that\\s+is|it\\s+is)\\s+(?:fine|ok|okay|alright|all\\s+right)|still\\s+(?:come|join|turn\\s+up|drop\\s+in|pop|play|welcome|love|swing)" +
    '|come\\s+anyway|\\p{L}+\\s+(?:by|in|along|down|over)\\s+anyway|just\\s+(?:come|turn\\s+up|drop\\s+in|pop\\s+in|rock\\s+up|show\\s+up|walk\\s+in))(?!\\p{L})',
  'iu',
);
// A sentence ends at . ! ? or … before a space, or at a line break; a blank line is one end.
const SENTENCE_END = new RegExp(`(?:[.!?…]+(?=\\s|$)|${LINE_BREAK})(?:${HSPACE}*${LINE_BREAK})*`, 'gu');
/** Whether the rest of the sentence ending at or after `end`, or the sentence after it, reassures. Bounded to 300 characters. */
function reassuredAfter(text: string, end: number): boolean {
  const rest = text.slice(end, end + 300);
  let cut = rest.length;
  let ends = 0;
  for (const m of rest.matchAll(SENTENCE_END)) {
    if (++ends === 2) {
      cut = m.index! + m[0].length;
      break;
    }
  }
  return REASSURANCE.test(rest.slice(0, cut));
}
// "Nobody can play without booking": only with one of these verbs between.
const CANT_WITHOUT = new RegExp(
  "(?<!\\p{L})(?:can['’]t|cannot|can\\s+not|nobody\\s+can|no\\s+one\\s+can|not\\s+able\\s+to)\\s+(?:play|join|enter|get\\s+in|take\\s+part|attend)\\s+without\\s+(?:booking|a\\s+ticket|tickets|reserving)(?!\\p{L})",
  'giu',
);
// A negated drop-in says booking is needed: "no walk-ins", "no ticket, no entry", "nobody gets in without a ticket", "booking only".
const NO_DROP_IN = new RegExp(
  '(?<!\\p{L})(?:(?:no|not|never)\\s+(?:drop[ -]?ins?|walk[ -]?ins?)|no\\s+tickets?\\s*[,;:–—-]?\\s*no\\s+(?:entry|entries|admission|way\\s+in)' +
    '|(?:nobody|no\\s+one|no-one)\\s+(?:gets?|comes?|goes?)\\s+in\\s+without\\s+(?:a\\s+ticket|tickets?|a\\s+booking|booking)|booking\\s+only)(?!\\p{L})',
  'giu',
);
/** The stretches of a text that say booking is needed in negated words ("not booked yet? book now", "no walk-ins"). */
function bookingNeededSpans(text: string): Span[] {
  const notYet = [...text.matchAll(NOT_BOOKED_YET)].filter(m => !reassuredAfter(text, m.index! + m[0].length));
  return [...notYet.map(m => [m.index!, m.index! + m[0].length] as Span), ...spansOf(CANT_WITHOUT, text), ...spansOf(NO_DROP_IN, text)];
}
/** The drop-in phrases of a text, leaving out negated booking that says booking is needed. */
const dropInMatches = (text: string): RegExpMatchArray[] => {
  const needed = bookingNeededSpans(text);
  return [...text.matchAll(DROP_IN)].filter(m => !within(m.index!, m.index! + m[0].length, needed));
};
// Booking said to be optional: "booking is optional", "booking: not essential", "booking isn't really necessary", "you don't need to have booked".
const NOT_ESSENTIAL = "(?:not|isn['’]t|aren['’]t|is\\s+not|are\\s+not)\\s+(?:(?:really|strictly|absolutely|totally)\\s+)?(?:essential|required|necessary|needed|compulsory|mandatory)";
const OPTIONAL_SAID = `(?:(?:is|are)\\s+)?(?:(?<!(?:not|n['’]t)\\s+)optional|${NOT_ESSENTIAL})`;
// "Recommended, not essential", "advised, not required", "not essential, but recommended": optional too, with a booking word within three words.
const ADVISED = '(?:(?:highly|strongly)\\s+)?(?:recommended|advised|suggested|encouraged|preferred)';
const ADVISED_NOT_ESSENTIAL = `(?:${ADVISED}\\s*,\\s*(?:but\\s+)?${NOT_ESSENTIAL}|${NOT_ESSENTIAL}\\s*,\\s*(?:but\\s+)?${ADVISED})`;
const BOOKING_OPTIONAL = new RegExp(
  `(?:(?<!\\p{L})${BOOKING_WORD}[?:.,]?(?:\\s+\\p{L}+(?:['’]\\p{L}+)?){0,3}?\\s+${ADVISED_NOT_ESSENTIAL}` +
    `|(?<!\\p{L})${ADVISED_NOT_ESSENTIAL}(?:\\s+\\p{L}+(?:['’]\\p{L}+)?){0,3}?\\s+${BOOKING_WORD}` +
    `|(?<!\\p{L})${BOOKING_WORD}[?:.,]?(?:\\s+\\p{L}+(?:['’]\\p{L}+)?){0,3}?\\s+${OPTIONAL_SAID}|(?<!\\p{L})(?<!(?:not|n['’]t)\\s+)optional(?:\\s+\\p{L}+){0,3}?\\s+${BOOKING_WORD}` +
    `|${NEGATIVE_WORD}(?:${GAP_WORD}){0,3}\\s+need(?:ed)?\\s+to\\s+have\\s+(?:pre-?)?(?:booked|reserved|got\\s+(?:(?:a|any|your)\\s+)?tickets?))(?!\\p{L})`,
  'giu',
);
// A Booking fact that says booking is optional.
const OPTIONAL_VALUE = /(?<!\p{L})(?:optional|recommended|advised|preferred|prefered|encouraged|suggested|not\s+(?:essential|required|needed|necessary|compulsory))(?!\p{L})/iu;
const blank = (text: string, spans: Span[]): string => spans.reduce((t, [at, end]) => t.slice(0, at) + ' '.repeat(end - at) + t.slice(end), text);
/** The text with its drop-in phrases blanked out. */
function withoutDropIns(text: string): string {
  const spans = dropInMatches(text).map(m => [m.index!, m.index! + m[0].length] as Span);
  return blank(text, spans);
}
const BOOKED =
  /(?<!\p{L})(booking (?:is )?(?:essential|required|needed|necessary)|must book|book ahead|book in advance|pre-?book(?:ing)?|advance booking|booking only)(?!\p{L})/iu;
// A Booking fact's value only has to say the word: "Booking: essential", "Booking: not required".
const DROP_IN_VALUE = /^(?:no|none|never|not (?:required|needed|necessary|essential))(?!\p{L})/iu;
const BOOKED_VALUE = /(?<!\p{L})(essential|required|needed|necessary|must|yes|advance|ahead|only)(?!\p{L})/iu;

/** The first drop-in phrase in the text. */
const dropInIn = (text: string): string | null => dropInMatches(text)[0]?.[0] ?? null;
/** The first booking-needed phrase, once drop-in phrases are taken out ("booking not required" isn't "required"). */
const bookedIn = (text: string): string | null => BOOKED.exec(withoutDropIns(text))?.[0] ?? null;

/** What one Booking fact says, judged on its value alone. */
function bookingFact(value: string): { booked: boolean; dropIn: boolean } {
  const dropIn = dropInIn(value) !== null || DROP_IN_VALUE.test(value);
  const rest = withoutDropIns(value).replace(DROP_IN_VALUE, ' ');
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

// ---------------------------------------------------------------------------------------------
// Claims and roles, checked in the prompt and in posts

/** What an event's own data supports: its name, Base Details, Approved Facts and, for a post, the app's booking setting. */
interface Support {
  name: string;
  base_details: string;
  facts: Partial<Record<FactKey, string[]>>;
  /** null for a prompt: the fields Gemini sees have no booking setting. */
  booking_mode: BookingMode | null;
}

// The keyword groups (spec §4B). Each word needs its fact, or the same word in Base Details. Drop-in words are DROP_IN.
const BOOKING_WORDS =
  /(?<![\p{L}\p{N}])(?:book(?:s|ed|ings?)?|reserv(?:e|es|ed|ing|ations?)|secure\s+(?:a|your)\s+(?:seat|spot|place|table)s?|places|spaces|sell(?:s|ing)?\s+out|sold\s+out)(?![\p{L}\p{N}])/giu;
const LEVEL_WORDS =
  /(?<![\p{L}\p{N}])(?:beginners?(?:[- ]friendly)?|no\s+(?:prior\s+)?experience(?:\s+(?:needed|necessary|required))?|all\s+(?:skill\s+)?levels|learn(?:ing)?\s+(?:how\s+)?to\s+play|first[- ]?timers?|newbies?|newcomers?|novices?|never\s+played)(?![\p{L}\p{N}])/giu;
const PRIZE_WORDS = /(?<![\p{L}\p{N}])(?:prizes?|win(?:s|ning|ners?)?|cash|troph(?:y|ies)|jackpots?)(?![\p{L}\p{N}])/giu;
// A prize word in Base Details also supports win, wins, winner(s) and winning; cash and jackpots still need a Prizes fact.
const BASE_PRIZE_WORD = /(?<!\p{L})(?:prizes?|troph(?:y|ies))(?!\p{L})/iu;
const AGE_WORDS =
  /(?<![\p{L}\p{N}])(?:kids?|child(?:ren)?|famil(?:y|ies)|all\s+ages|ages?\s+\d{1,2}(?:\s*\+|\s+and\s+(?:up|over|above))?|\d{1,2}\s+and\s+(?:over|up|above)|\d{1,2}\s?\+|(?:over|under)[- ]?\d{1,2}s?|adults?(?:\s+only)?|teen(?:s|agers?)?|grown[- ]ups?)(?![\p{L}\p{N}])/giu;

/** Whether Base Details say the same word: "prizes" there allows "prize" and "prizes", but not "cash". */
function sameWordIn(word: string, text: string): boolean {
  const stem = word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word;
  return phraseRegex(stem)?.test(text) ?? false;
}

// What a prompt tells Gemini not to do isn't a claim. A clause (to . ! ? ; : or a line break) that opens with a prohibition
// or a negation ("Do not … open play", "Never … prizes", "No hype about …", "Without …") claims nothing after it, until a
// comma, "and" or "or" starts a part with a verb or a pronoun of its own ("Never mention prizes, and kids are welcome"), or
// "but" and the like. "Don't miss", "Don't forget" and "No worries" aren't prohibitions.
const NEGATED_CLAUSE_END = new RegExp(`[.!?…]+(?=\\s|$)|[;:]|${LINE_BREAK}`, 'gu');
const CLAUSE_OPENING = /[\s\-*•#>"“‘'(\[_]*(?:\d{1,3}[.)][ \t]*)?[*_"“‘']*/uy;
const CLAUSE_NEGATION = new RegExp(
  `(?:never|do${HSPACE}+not|don['’]t|must${HSPACE}+not|mustn['’]t|should${HSPACE}+not|shouldn['’]t|avoid|no|without)(?!\\p{L})` +
    `(?!${HSPACE}+(?:forget|miss|hesitate|wait|delay|leave|worries|worry|problems?|bother|stress)(?!\\p{L}))`,
  'iuy',
);
const NEGATION_BREAK = /,|(?<!\p{L})(?:and|or|but|however|although|though|while|whereas|instead)(?!\p{L})/giu;
const NEGATION_ENDS = /^\s*(?:but|however|although|though|while|whereas|instead)(?!\p{L})/iu;
const OWN_VERB =
  /(?<![\p{L}\p{N}'’])(?:is|are|was|were|be|been|will|would|can|could|may|might|must|shall|should|do|does|did|has|have|had|it|it['’]s|they|we|you|he|she|everyone|there|here|gets?|got|welcomed?|welcomes|awaits?|waiting)(?![\p{L}\p{N}'’])/iu;
// "Do not imply paid entry or advance reservation is required": after a verb that takes a clause, an "or" part whose verb comes after
// its noun shares that verb with the part before, which has none of its own, so the negation covers both.
const CLAUSE_VERB = new RegExp(`${HSPACE}+(?:imply|suggest|say|state|claim|promise)(?!\\p{L})`, 'iuy');
const SHARED_VERB_PART = new RegExp(`^\\s*(?:or|nor)${HSPACE}+(?!${OWN_VERB.source})\\p{L}`, 'iu');
// A word straight after a negation, at most two words on: "not open play", "no cash prizes". Not after "don't miss".
const GOVERNED = new RegExp(`${NEGATIVE_WORD}(?:${GAP_WORD}){0,2}\\s+$`, 'iu');

/** The stretches of a prompt that a prohibition or negation opening their clause governs, each from the negation to where it stops. */
function negatedClauses(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  const ends = spansOf(NEGATED_CLAUSE_END, text);
  for (const [end, next] of [...ends, [text.length, text.length] as Span]) {
    CLAUSE_OPENING.lastIndex = start;
    const at = start + (CLAUSE_OPENING.exec(text)?.[0].length ?? 0);
    CLAUSE_NEGATION.lastIndex = at;
    if (at < end && CLAUSE_NEGATION.test(text)) {
      CLAUSE_VERB.lastIndex = CLAUSE_NEGATION.lastIndex;
      const verbEnd = CLAUSE_VERB.test(text) ? CLAUSE_VERB.lastIndex - at : -1;
      // The negation reaches each part until one has a verb or a pronoun of its own, or opens with "but".
      const clause = text.slice(at, end);
      // Past a comma only as a list with a joiner before its last item: "rules, age cut-offs, or activities", not "the dice, cash prizes".
      const lastComma = clause.lastIndexOf(',');
      let stop = lastComma === -1 || /^,\s*(?:or|and|nor)(?!\p{L})/iu.test(clause.slice(lastComma)) ? clause.length : clause.indexOf(',');
      const breaks = [...clause.slice(0, stop).matchAll(NEGATION_BREAK)].map(m => m.index!);
      for (const [i, b] of breaks.entries()) {
        const part = clause.slice(b, breaks[i + 1] ?? stop);
        const before = clause.slice(i === 0 ? verbEnd : breaks[i - 1]!, b);
        const shared = verbEnd !== -1 && verbEnd <= b && SHARED_VERB_PART.test(part) && !OWN_VERB.test(before);
        if (NEGATION_ENDS.test(part.replace(/^,/, '')) || (OWN_VERB.test(part) && !shared)) {
          stop = b;
          break;
        }
      }
      spans.push([at, at + stop]);
    }
    start = next;
  }
  return spans;
}

/** For a prompt: whether a keyword match is only a negated or forbidden mention, not a claim. Never for wording that says booking is needed ("not booked yet?"). */
function negatedIn(text: string): (m: RegExpMatchArray) => boolean {
  const clauses = negatedClauses(text);
  const needed = bookingNeededSpans(text);
  return m => {
    const [at, end] = [m.index!, m.index! + m[0].length];
    if (needed.some(([s, e]) => at < e && end > s)) return false;
    // The clause's own negation can't make the match it starts negated: "No booking needed" is drop in.
    if (clauses.some(([s, e]) => at > s && end <= e)) return true;
    return GOVERNED.test(text.slice(Math.max(0, at - 80), at));
  };
}

// A booking label before a drop-in value is part of it: "Booking: No need to book", "Booking Requirement: No need to book", with at
// most two capitalised label words after the booking word.
const BOOKING_LABEL_END = /^(?:[ \t]{1,3}\p{Lu}\p{Ll}{1,15}){0,2}[ \t]{0,3}[:?][ \t]{0,3}/u;
// In a prompt, "without" and a verb in -ing forbids ("without inventing booking URLs"); it isn't a drop-in claim.
const WITHOUT_DOING = /^without\s+(?:inventing|adding|including|mentioning|stating|promising)(?!\p{L})/iu;

/**
 * Every keyword-group word in the text, outside `skip`, that the event's data doesn't support, as "cash: needs a Prizes fact".
 * In a prompt (`prompt`), a negated or forbidden mention isn't a claim, and nor is a booking label before a drop-in value, nor
 * "without inventing booking …".
 */
function claimProblems(text: string, skip: Span[], t: Support, prompt = false): string[] {
  const problems: string[] = [];
  const negated = prompt ? negatedIn(text) : () => false;
  const found = (matches: RegExpMatchArray[], alsoSkip: Span[] = []) =>
    matches
      .filter(m => !within(m.index!, m.index! + m[0].length, [...skip, ...alsoSkip]) && !negated(m))
      .map(m => ({ m, word: m[0].toLowerCase().replace(/\s+/g, ' ') }));
  const booking = t.facts.Booking ?? [];

  // Drop-in words need a Booking fact saying so (or the same words in Base Details); the booking setting never supports them.
  const allDropIns = dropInMatches(text);
  const dropIns = found(prompt ? allDropIns.filter(m => !WITHOUT_DOING.test(m[0])) : allDropIns);
  const dropInFact = booking.some(v => bookingFact(v).dropIn);
  for (const { word } of dropIns) if (!dropInFact && !sameWordIn(word, t.base_details)) problems.push(`${word}: needs a Booking fact saying so`);

  // Booking said to be optional needs a Booking fact saying so, or booking set to Optional with no Booking fact saying it is essential.
  // Where it overlaps a drop-in phrase ("booking isn't required"), it is read as drop in, above.
  const dropInSpans = dropIns.map(({ m }) => [m.index!, m.index! + m[0].length] as Span);
  const overlapsDropIn = (m: RegExpMatchArray) => dropInSpans.some(([at, end]) => m.index! < end && m.index! + m[0].length > at);
  const optional = found([...text.matchAll(BOOKING_OPTIONAL)].filter(m => !overlapsDropIn(m)));
  const optionalFact = booking.some(v => OPTIONAL_VALUE.test(v));
  const essentialFact = booking.some(v => bookingFact(v).booked && !OPTIONAL_VALUE.test(v));
  for (const { word } of optional) {
    if (!optionalFact && !(t.booking_mode === 'optional' && !essentialFact)) {
      problems.push(`${word}: needs a Booking fact saying booking is optional${t.booking_mode === null ? '' : ', or booking set to Optional'}`);
    }
  }

  // Booking words ("no booking needed" is drop-in, above), and negated drop-in ("no walk-ins"), need a Booking fact that isn't only drop
  // in ("recommended, drop ins welcome" isn't), or booking set to Required or Optional.
  const bookedFact = booking.some(v => !bookingFact(v).dropIn || bookingFact(v).booked || OPTIONAL_VALUE.test(v));
  const bookingSet = t.booking_mode === 'required' || t.booking_mode === 'optional';
  const noDropIns = found([...text.matchAll(NO_DROP_IN)]);
  const dropInStarts = new Set(allDropIns.map(m => m.index!));
  const labelsDropIn = ([, end]: Span) => {
    const gap = BOOKING_LABEL_END.exec(text.slice(end, end + 50));
    return gap !== null && dropInStarts.has(end + gap[0].length);
  };
  const labels = prompt ? spansOf(BOOKING_WORDS, text).filter(labelsDropIn) : [];
  const notBooking = [
    ...labels,
    ...dropInSpans,
    ...optional.map(({ m }) => [m.index!, m.index! + m[0].length] as Span),
    ...noDropIns.map(({ m }) => [m.index!, m.index! + m[0].length] as Span),
  ];
  for (const { word } of [...noDropIns, ...found([...text.matchAll(BOOKING_WORDS)], notBooking)]) {
    if (!bookedFact && !bookingSet && !sameWordIn(word, t.base_details)) {
      problems.push(`${word}: needs a Booking fact${t.booking_mode === null ? '' : ', or booking set to Required or Optional'}`);
    }
  }

  for (const [re, key] of [
    [LEVEL_WORDS, 'Level'],
    [PRIZE_WORDS, 'Prizes'],
    [AGE_WORDS, 'Age'],
  ] as [RegExp, FactKey][]) {
    if (t.facts[key]?.length) continue;
    for (const { word } of found([...text.matchAll(re)])) {
      if (sameWordIn(word, t.base_details) || (key === 'Prizes' && /^win/.test(word) && BASE_PRIZE_WORD.test(t.base_details))) continue;
      problems.push(`${word}: needs a${key === 'Age' ? 'n' : ''} ${key} fact`);
    }
  }
  return problems;
}

// Role words, each group one role: host, DM, GM, organiser, runs, sets up ("sets it up"), leads, quizmaster, MC, caller, presenter.
const ROLE_WORDS = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(host(?:s|ed|ing|ess)?)|(dm|dungeon${HSPACE}+masters?)|(gm|game${HSPACE}+masters?)|(organi[sz](?:e|es|ed|ing|er|ers))|(run|runs|running|ran)|((?:set|sets|setting)${HSPACE}+(?:\\p{L}{1,10}${HSPACE}+)?up)|(lead|leads|leading|led)|(quiz${HSPACE}*masters?)|(mc|emcee|compere)|(callers?)|(presenters?))(?![\\p{L}\\p{N}])`,
  'giu',
);
const ROLES = ['host', 'DM', 'GM', 'organiser', 'runs', 'sets up', 'leads', 'quizmaster', 'MC', 'caller', 'presenter'];
const roleOf = (m: RegExpMatchArray): string => ROLES[m.slice(1).findIndex(g => g !== undefined)]!;
/** The roles a People & Roles entry gives, read with the same role words: "Dungeon Master" is DM, "sets up" is sets up. */
const rolesIn = (text: string): Set<string> => new Set([...text.matchAll(ROLE_WORDS)].map(roleOf));

// Words that start a sentence beside a role word without being anyone's name: "Meet our host", "We're hosting".
const NOT_A_NAME = [
  ...['we', 'were', 'well', 'weve', 'you', 'youre', 'youll', 'your', 'our', 'they', 'theyre', 'he', 'she', 'who', 'whos', 'what', 'whats', 'why', 'how'],
  ...['when', 'where', 'there', 'theres', 'here', 'heres', 'lets', 'meet', 'join', 'come', 'ask', 'say', 'grab', 'bring', 'get', 'see', 'hi', 'hello'],
  ...['thanks', 'thank', 'everyone', 'new', 'big', 'great', 'huge', 'special', 'friendly', 'expert', 'resident', 'amazing', 'brilliant', 'lovely'],
  ...['fantastic', 'wonderful', 'guess', 'tonight', 'today', 'tomorrow'],
];

// The capitalised words that are never a name beside a role word. Words from Base Details or Approved Facts aren't among them:
// "Trixie" written there could be a person.
const NOT_NAMES_BY_ROLES = new Set([...BASE_ALLOWED, ...NOT_A_NAME]);

// A clause ends at . ! ? ; or … before a space, or at a line break. A comma doesn't end one, so "Trixie, our host" is checked.
const CLAUSE_END = new RegExp(`[.!?;…]+(?=\\s|$)|${LINE_BREAK}`, 'gu');
const ROLE_REACH = 3;
// What splits a name from a role word when tracing it in the event's own text: "Bob, Trixie and Jo host" doesn't make Bob a
// host, nor does "Bob (not Jo) hosts" make Jo one, nor "Bob never hosts" Bob.
const CLAUSE_BREAK = /[,;:—–()]|\s-\s|(?<!\p{L})(?:and|but|while|not|never|no)(?!\p{L})|n['’]t(?!\p{L})/iu;
/** Whether the text between a name and a role word breaks the clause. Two names joined by "and" share the role: "Bob and Jo host", "hosted by Bob and Jo". */
function breaksClause(between: string, nameFirst: boolean): boolean {
  const joined = nameFirst ? /^\s+and\s+\p{Lu}[\p{L}\p{N}'’-]*(?=\s+$)/u : /\s\p{Lu}[\p{L}\p{N}'’-]*\s+and(?=\s+$)/u;
  return CLAUSE_BREAK.test(between.replace(joined, ''));
}

// What joins two names in a list: "Bob, Jo", "Bob and Jo", "Bob & Jo", "Jo, and Sam".
const JOINED_NAMES = /^(?:\s*,\s*(?:(?:and|&)\s+)?|\s+(?:and|&)\s+)$/iu;

/**
 * Capitalised words within three words of a role word in the same clause, a sentence-initial word
 * included, each with that role. Text in `skip` (the event's own name) is left out, and so are role
 * words themselves, hashtags and the never-a-name words. Words in `notNames` (a prompt's label words) are never names, though a
 * role word among them still counts.
 */
function roleNeighbours(text: string, skip: Span[], oneClause = false, notNames: Span[] = []): { word: string; role: string; said: string }[] {
  const found: { word: string; role: string; said: string }[] = [];
  const clauses: Span[] = [];
  let start = 0;
  for (const m of text.matchAll(CLAUSE_END)) {
    clauses.push([start, m.index!]);
    start = m.index! + m[0].length;
  }
  clauses.push([start, text.length]);
  for (const [from, to] of clauses) {
    const clause = text.slice(from, to);
    const roles = [...clause.matchAll(ROLE_WORDS)]
      .map(m => ({ said: m[0], role: roleOf(m), span: [from + m.index!, from + m.index! + m[0].length] as Span }))
      .filter(r => !within(r.span[0], r.span[1], skip));
    if (!roles.length) continue;
    const roleSpans = roles.map(r => r.span);
    const words = [...clause.matchAll(WORD)].map(m => ({ word: m[0], at: from + m.index!, end: from + m.index! + m[0].length }));
    for (const r of roles) {
      const inRole = words.map((w, i) => (w.at >= r.span[0] && w.end <= r.span[1] ? i : -1)).filter(i => i >= 0);
      const first = inRole[0]!;
      const last = inRole[inRole.length - 1]!;
      const isName = (w: { word: string; at: number; end: number }) =>
        /^\p{Lu}/u.test(w.word) && text[w.at - 1] !== '#' && !within(w.at, w.end, [...skip, ...roleSpans, ...notNames]) && !isAllowed(w.word, NOT_NAMES_BY_ROLES);
      const near = new Set<number>();
      for (let i = Math.max(0, first - ROLE_REACH); i <= Math.min(words.length - 1, last + ROLE_REACH); i++) {
        const w = words[i]!;
        if ((i >= first && i <= last) || !isName(w)) continue;
        const between = w.end <= r.span[0] ? text.slice(w.end, r.span[0]) : text.slice(r.span[1], w.at);
        if (oneClause && breaksClause(between, w.end <= r.span[0])) continue;
        near.add(i);
        found.push({ word: w.word, role: r.role, said: r.said });
      }
      if (oneClause) continue;
      // Names joined to the nearest one ("hosted by Bob, Jo and Sam", "Bob & Jo host") share the role, up to three names, however far.
      for (const step of [1, -1]) {
        let at = [...near].filter(i => (step === 1 ? i > last : i < first)).sort((a, b) => step * (a - b))[0];
        for (let named = 1; at !== undefined && named < 3; named++) {
          const and = words[at + step]?.word.toLowerCase() === 'and' ? 2 : 1;
          const next = at + step * and;
          const w = words[next];
          if (!w || !isName(w)) break;
          const gap = step === 1 ? text.slice(words[at]!.end, w.at) : text.slice(w.end, words[at]!.at);
          if (!JOINED_NAMES.test(gap)) break;
          if (!near.has(next)) found.push({ word: w.word, role: r.role, said: r.said });
          at = next;
        }
      }
    }
  }
  return found;
}

/**
 * Names beside a role word, checked against People & Roles. A listed name must have that role
 * there ("host" covers hosts, hosted and hosting), whatever else the event's text says. A name
 * that isn't listed passes only where `traced` holds its word|role pair from the event's own text.
 * Words in `notNames` aren't names.
 */
function roleProblems(text: string, skip: Span[], people: Person[], traced: Set<string> = new Set(), notNames: Span[] = []): string[] {
  const problems: string[] = [];
  for (const n of roleNeighbours(text, skip, false, notNames)) {
    const key = wordKey(n.word);
    const listed = people.filter(p => (p.name.match(WORD) ?? []).some(w => wordKey(w) === key));
    if (!listed.length) {
      if (!traced.has(`${key}|${n.role}`)) problems.push(`${n.word}: not in People & Roles`);
    } else if (!listed.some(p => rolesIn(p.role).has(n.role))) problems.push(`${n.word}: People & Roles gives the role "${listed[0]!.role}", not "${n.said}"`);
  }
  return problems;
}

/** The word|role pairs written in the event's own text, within one clause: "Trixie sets up" in Base Details pairs Trixie with sets up, and nothing else. */
function rolePairs(texts: string[]): Set<string> {
  return new Set(texts.flatMap(t => roleNeighbours(t, [], true).map(n => `${wordKey(n.word)}|${n.role}`)));
}

// What a prompt forbids without quoting it: "never add other people, prizes or levels", "no hype about prizes", "avoid words like beginners".
// A prohibition, then a list of short items (at most three words each, joined by commas, "or", "and"
// or "nor") that runs to the end of the sentence or to the next prohibition. Anything else ends it,
// and then none of its items are exempt. Posts never get this.
const LIST_PROHIBITION = new RegExp(
  `(?:${NEGATIVE}(?:${PROHIBITION_VERB}|add(?:s|ing)?|invent(?:s|ing)?|offer(?:s|ing)?|hype|assume|promote|make${HSPACE}+up|talk${HSPACE}+about)|(?<!\\p{L})no${HSPACE}+(?:hype|mention|claims?|promises?|talk)${HSPACE}+(?:about|of)|(?<!\\p{L})(?<!(?:never|not|n['’]t)\\s+)avoid)(?!\\p{L})`,
  'giu',
);
// Before the first item: an object ("it as", "words like", "other"), as for quoted items, then perhaps a colon.
const LIST_START = new RegExp(`(?:${OBJECT}(?:${HSPACE}*(?:(?:such${HSPACE}+as|like|as)(?!\\p{L})|e\\.g\\.))?)?(?:${HSPACE}*:)?${HSPACE}+`, 'iuy');
// An item word. A pronoun or a verb like "is" or "await" means a clause has started ("prizes, and kids are welcome"), so the list ends there.
const CLAUSE_WORD =
  "(?:or|and|nor|is|are|was|were|be|been|will|would|can|could|may|might|must|shall|should|do|does|did|has|have|had|it|it['’]s|they|we|you|he|she|everyone|there|here|gets?|got|welcomed?|awaits?|waiting)(?![\\p{L}\\p{N}'’])";
const LIST_WORD = new RegExp(`["“‘']?(?!${CLAUSE_WORD})[\\p{L}\\p{N}]+(?:['’-][\\p{L}\\p{N}]+)*["”’']?`, 'iuy');
const LIST_WORD_GAP = new RegExp(`${HSPACE}+`, 'uy');
const LIST_SEP = new RegExp(`${HSPACE}*,${HSPACE}*(?:(?:or|and|nor)${HSPACE}+)?|${HSPACE}+(?:or|and|nor)${HSPACE}+`, 'iuy');
const LIST_STOP = new RegExp(`${HSPACE}*(?:${ITEM_SCOPE})?(?:[.!?)]|$|${LINE_BREAK})`, 'iuy');
const LIST_NEXT = new RegExp(`${HSPACE}*[,;]?${HSPACE}*(?:(?:and|or|but)${HSPACE}+)?(?=${LIST_PROHIBITION.source})`, 'iuy');

/** The match of a sticky pattern at `at`, or null. */
function stickyAt(re: RegExp, text: string, at: number): string | null {
  re.lastIndex = at;
  return re.exec(text)?.[0] ?? null;
}

/** The stretches of a prompt that are unquoted lists of what it forbids. */
function forbiddenLists(text: string): Span[] {
  const spans: Span[] = [];
  for (const p of text.matchAll(LIST_PROHIBITION)) {
    const start = stickyAt(LIST_START, text, p.index! + p[0].length);
    if (start === null) continue;
    const first = p.index! + p[0].length + start.length;
    let pos = first;
    let words = 0;
    let items = 1;
    // Several items need "or", "and" or "nor" before the last: "people, prizes or levels", not "the dice, cash prizes".
    let joined = false;
    for (;;) {
      const word = stickyAt(LIST_WORD, text, pos);
      if (word === null) break;
      pos += word.length;
      words++;
      if (stickyAt(LIST_STOP, text, pos) !== null || stickyAt(LIST_NEXT, text, pos) !== null) {
        if (items === 1 || joined) spans.push([first, pos]);
        break;
      }
      const sep = stickyAt(LIST_SEP, text, pos);
      const gap = sep === null && words < MAX_ITEM_WORDS ? stickyAt(LIST_WORD_GAP, text, pos) : null;
      if (sep === null && gap === null) break;
      pos += (sep ?? gap)!.length;
      if (sep !== null) {
        words = 0;
        items++;
        joined = /(?<!\p{L})(?:or|and|nor)(?!\p{L})/iu.test(sep);
      }
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------------------------
// The final post (§4B)

/** One event a post is about, at its target occurrence. Date and times are London ("YYYY-MM-DD", "HH:MM"). */
export interface CheckTarget {
  event_id: string;
  name: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  price: string;
  facts: Partial<Record<FactKey, string[]>>;
  base_details: string;
  people: Person[];
  banned: string[];
  booking_mode: BookingMode;
}

interface Occurrence {
  iso: string;
  day: number;
  month: number;
  year: number;
  weekday: number;
  /** Start and end, in minutes after midnight. */
  times: number[];
}

const clockMinutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** A target's date and times, or the reasons they can't be read. */
function occurrenceOf(t: CheckTarget): { occurrence: Occurrence | null; problems: string[] } {
  const problems: string[] = [];
  const times: number[] = [];
  for (const [label, value] of [
    ['start time', t.start_time],
    ['end time', t.end_time],
  ] as const) {
    if (value === null) continue;
    const minutes = clockMinutes(value);
    if (minutes === null) problems.push(`${t.name}: its ${label} "${value}" can't be read`);
    else times.push(minutes);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date);
  const [year, month, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const at = new Date(Date.UTC(year, month - 1, day));
  if (!m || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    problems.push(`${t.name}: its date "${t.date}" can't be read`);
    return { occurrence: null, problems };
  }
  return { occurrence: { iso: t.date, day, month, year, weekday: at.getUTCDay(), times }, problems };
}

/** Why a date, weekday or relative day in a post isn't true of the occurrences, or null when it is. A weekday or "this week" must be every occurrence's. */
function dateProblem(d: DateMention, occurrences: Occurrence[], today: string, label: { any: string; every: string }): string | null {
  // "The last Friday of October" is worked out in each occurrence's year (or the year given) and must be one of them.
  if (d.nth !== undefined) {
    const on = (o: Occurrence) => nthWeekday(d.year ?? o.year, d.month!, d.weekday!, d.nth!) === o.iso;
    return occurrences.some(on) ? null : `"${d.text}": not the date of ${label.any}`;
  }
  if (d.relative && d.weekday !== undefined) {
    // "next Friday" could mean this week's or next week's; "Friday week" is checked no further.
    if (d.relative !== 'this' && d.relative !== 'coming') return `"${d.text}": a relative day that can't be checked`;
    const [first, last] = d.relative === 'this' ? [today, addDays(today, 6)] : [addDays(today, 1), addDays(today, 7)];
    const inWeek = (o: Occurrence) => o.weekday === d.weekday && o.iso >= first && o.iso <= last;
    return occurrences.length && occurrences.every(inWeek) ? null : `"${d.text}": not true of ${label.every} at the time of posting`;
  }
  if (d.relative) {
    // "Christmas" on its own is a theme: fine for an occurrence from 1 to 26 December.
    if (d.relative === 'christmas') {
      return occurrences.some(o => o.month === 12 && o.day <= 26) ? null : `"${d.text}": not true of ${label.any}`;
    }
    // So is "Halloween", for an occurrence in October.
    if (d.relative === 'halloween') return occurrences.some(o => o.month === 10) ? null : `"${d.text}": not true of ${label.any}`;
    // "This week" must be true of every event it covers.
    if (d.relative === 'this week') {
      const last = addDays(today, 6);
      return occurrences.length && occurrences.every(o => o.iso >= today && o.iso <= last)
        ? null
        : `"${d.text}": not true of ${label.every} at the time of posting`;
    }
    const days =
      d.relative === 'today' || d.relative === 'tonight' ? [today, today] : d.relative === 'tomorrow' ? [addDays(today, 1), addDays(today, 1)] : null;
    if (!days) return `"${d.text}": a relative date that can't be checked`;
    return occurrences.some(o => o.iso >= days[0]! && o.iso <= days[1]!) ? null : `"${d.text}": not true of ${label.any} at the time of posting`;
  }
  if (d.weekday !== undefined) {
    return occurrences.length && occurrences.every(o => o.weekday === d.weekday) ? null : `"${d.text}": not the weekday of ${label.every}`;
  }
  if (d.day === undefined && d.month === undefined && d.year === undefined) return `"${d.text}": a date that can't be read`;
  const matches = (o: Occurrence) =>
    (d.day === undefined || d.day === o.day) && (d.month === undefined || d.month === o.month) && (d.year === undefined || d.year === o.year);
  return occurrences.some(matches) ? null : `"${d.text}": not the date of ${label.any}`;
}

const factTexts = (t: CheckTarget): string[] => Object.values(t.facts).flatMap(v => v ?? []);

// Words that, straight after an event's name or one of its words, are part of it: "Quiz Night" for Quiz.
const NAME_SUFFIX = '(?:Night|Nights|Evening|Session|Sessions|Club|Day)';

/** The spans of such words in the text. */
function suffixSpans(name: string, text: string): Span[] {
  const words = [...new Set(name.match(WORD) ?? [])].map(w => w.replace(/['’]/g, "['’]"));
  if (!words.length) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})${SPACE}{1,3}(${NAME_SUFFIX})(?![\\p{L}\\p{N}])`, 'giu');
  return [...text.matchAll(re)].map(m => [m.index! + m[0].length - m[1]!.length, m.index! + m[0].length] as Span);
}

/** A hashtag's words: "#CashPrizes" reads "Cash Prizes", "#Over18s" "Over 18 s". */
const hashtagWords = (body: string): string =>
  body
    .replace(/_/g, ' ')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2');

// Keyword phrases as they look squashed into a hashtag of any case ("#cashprizes", "#ALLAGES"), with the words they stand for.
// Three-letter words ("win", "kid") are left out: inside a squashed tag they are too often part of something else. Each is taken
// out of the tag once found, in this order, so "#nowalkins" is a booking claim and not also "walk in".
const SQUASHED_CLAIMS: [string, string][] = [
  ['nowalkin', 'no walk ins'],
  ['nodropin', 'no drop ins'],
  ['ticketsnotneeded', 'tickets not needed'],
  ['notneeded', 'booking not needed'],
  ['noticket', 'no ticket'],
  ['justturnup', 'just turn up'],
  ['turnup', 'just turn up'],
  ['cash', 'cash'],
  ['prize', 'prize'],
  ['jackpot', 'jackpot'],
  ['troph', 'trophy'],
  ['dropin', 'drop in'],
  ['walkin', 'walk in'],
  ['nobooking', 'no booking'],
  ['noneedtobook', 'no need to book'],
  ['opentable', 'open table'],
  ['openplay', 'open play'],
  ['rockup', 'rock up'],
  ['allages', 'all ages'],
  ['kids', 'kids'],
  ['children', 'children'],
  ['family', 'family'],
  ['families', 'families'],
  ['adult', 'adults'],
  ['teen', 'teens'],
  ['grownup', 'grown ups'],
  ['beginner', 'beginners'],
  ['firsttimer', 'first timers'],
  ['newbie', 'newbies'],
  ['newcomer', 'newcomers'],
  ['novice', 'novices'],
  ['alllevels', 'all levels'],
  ['noexperience', 'no experience'],
  ['learntoplay', 'learn to play'],
];
// Booking words squashed into a hashtag ("#booknow"), only at its start (so "#notebook" isn't one), once drop-in phrases are taken out.
const SQUASHED_BOOKING: [string, string][] = [
  ['book', 'book'],
  ['reserv', 'reserve'],
];
const SQUASHED_DROP_INS = ['nobooking', 'noneedtobook', 'noreservation', 'notickets'];
// "Free" squashed into a hashtag ("#freeentry"), but not "#glutenfree", "#freeparking" and the like.
const SQUASHED_FREE = /(?<!gluten|dairy|sugar|feel|care|nut|fat|alcohol|lactose|meat|stress|hands)free(?!parking|wifi)/;
// "Free parking" and "free wifi" in a hashtag aren't a price.
const FREE_EXTRA = /(?<!\p{L})free\s*(?=(?:parking|wi[\s-]?fi)(?!\p{L}))/giu;
// Money squashed into a hashtag: "#fivepoundentry", "#twentyfivequid", "#fiverentry".
const SQUASHED_MONEY = new RegExp(`(?:(${TENS.join('|')})(${ONES.join('|')})?|(${TEENS.join('|')})|(${ONES.join('|')}))(?:pounds?|quid)|fiver|tenner`, 'g');
function squashedPence(m: RegExpMatchArray): number {
  if (m[0] === 'fiver') return 500;
  if (m[0] === 'tenner') return 1000;
  const pounds = m[1] ? (TENS.indexOf(m[1]) + 2) * 10 + (m[2] ? ONES.indexOf(m[2]) + 1 : 0) : m[3] ? TEENS.indexOf(m[3]) + 10 : ONES.indexOf(m[4]!) + 1;
  return pounds * 100;
}
// A short weekday or "nye" at the start of a squashed hashtag ("#frinight", "#nyeparty"), when no full weekday name is there. A short
// weekday counts only alone or before a word like night or fun ("#fri", "#satnight", "#fridayfun"), so "#monopoly" and "#sunshine" aren't days.
const SQUASHED_DAY_START = /^(?:(mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)(?: *(?:nights?|day|funday|fun|sessions?|vibes|plans)| *$)|(nye))/;
// Dates squashed into a hashtag, spaced out to be read: holidays, weekdays, months, relative days, numbers.
const SQUASHED_HOLIDAYS: Record<string, string> = {
  halloween: 'halloween',
  christmasday: 'christmas day',
  christmaseve: 'christmas eve',
  xmasday: 'christmas day',
  xmaseve: 'christmas eve',
  boxingday: 'boxing day',
  newyearseve: 'new years eve',
  newyearsday: 'new years day',
  bonfirenight: 'bonfire night',
  guyfawkes: 'guy fawkes',
  valentinesday: 'valentines day',
  valentines: 'valentines',
  christmas: 'christmas',
  xmas: 'christmas',
  easter: 'easter',
};
// Relative days squashed into a hashtag, anywhere in it.
const SQUASHED_RELATIVE: Record<string, string> = {
  thisweekend: 'this weekend',
  nextweekend: 'next weekend',
  thisweek: 'this week',
  nextweek: 'next week',
  lastweek: 'last week',
};
const SQUASHED_DATE_WORDS = new RegExp(
  `(${[...Object.keys(SQUASHED_RELATIVE), ...Object.keys(SQUASHED_HOLIDAYS), ...WEEKDAY_NAMES, ...MONTH_NAMES, 'today', 'tonight', 'tomorrow'].join('|')}|\\d+(?:st|nd|rd|th)?)`,
  'g',
);

/** A hashtag lower-cased and squashed, with the targets' own names and the brand names taken out: "#QuizNight30th" for Quiz reads "    night30th". */
function squashedTag(body: string, ownNames: string[]): string {
  let tag = squash(body);
  for (const own of [...ownNames, ...BRAND_NAMES].flatMap(squashed)) tag = tag.split(own).join(' '.repeat(own.length));
  return tag;
}

/**
 * One part of a post, against the targets it is about. Dates, times and names must each belong
 * to one of them; prices, weekdays and claims must be true of every one of them.
 */
function blockProblems(block: string, targets: { t: CheckTarget; occurrence: Occurrence | null }[], today: string, roundUp: boolean): string[] {
  const problems: string[] = [];
  const ts = targets.map(x => x.t);
  const occurrences = targets.flatMap(x => (x.occurrence ? [x.occurrence] : []));
  const label =
    ts.length === 1 ? { any: ts[0]!.name, every: ts[0]!.name } : { any: 'any event in this part of the post', every: 'every event in this part of the post' };
  // The events' own names are their identity, not claims: "Friday Night Magic" isn't a weekday. "Night" after Quiz is part of it.
  const suffixes = ts.flatMap(t => suffixSpans(t.name, block));
  const skip = [...ts.flatMap(t => spansOf(phraseRegex(t.name), block)), ...suffixes];
  const counts = (m: { index: number; text: string }) => !within(m.index, m.index + m.text.length, skip);

  for (const d of findDates(block)) {
    const why = counts(d) ? dateProblem(d, occurrences, today, label) : null;
    if (why) problems.push(why);
  }
  for (const time of findTimes(block)) {
    if (!counts(time)) continue;
    if (!time.readings.length) problems.push(`"${time.text}": a time that can't be checked`);
    else if (!occurrences.some(o => o.times.some(x => time.readings.includes(x)))) problems.push(`"${time.text}": not the start or end time of ${label.any}`);
  }
  for (const m of findMoney(block)) {
    if (!counts(m)) continue;
    if (Number.isNaN(m.pence)) problems.push(`"${m.text}": an amount that can't be read`);
    else if (!ts.every(t => pricesOf(t.price, t.facts.Price).includes(m.pence))) problems.push(`"${m.text}": not the price of ${label.every}`);
  }
  for (const t of ts) {
    const support = { name: t.name, base_details: t.base_details, facts: t.facts, booking_mode: t.booking_mode };
    for (const p of claimProblems(block, skip, support)) problems.push(roundUp ? `${p} (${t.name})` : p);
  }
  const people = ts.flatMap(t => t.people);
  const allowed = ts.flatMap(t => [t.name, ...t.people.map(p => p.name), ...[t.base_details, ...factTexts(t)].flatMap(capitalisedWords)]);
  // Dates ("Halloween", "Christmas Eve") are checked as dates, not names.
  const dateSpans = findDates(block).map(d => [d.index, d.index + d.text.length] as Span);
  for (const n of findNames(blank(block, [...suffixes, ...dateSpans]), allowed)) problems.push(`${n}: not in People & Roles`);
  // As in the prompt: a role beside a name as People & Roles give it, or as Base Details or Approved Facts write it.
  problems.push(...roleProblems(block, [...skip, ...dateSpans], people, rolePairs(ts.flatMap(t => [t.base_details, ...factTexts(t)]))));
  return problems;
}

// A round-up's parts are separated by blank lines; a line of nothing but hashtags is no part.
const BLANK_LINE = new RegExp(`${LINE_BREAK}(?:${HSPACE}*${LINE_BREAK})+`, 'u');
const HASHTAG_LINE = /^\s*#[\p{L}\p{N}_]+(?:\s+#[\p{L}\p{N}_]+)*\s*$/u;

/**
 * Checks a post (or poster wording) against the occurrence(s) it is about (spec §4B): every date,
 * time, price, claim and name in it must belong to them; no other event and none of their Banned
 * Phrases may appear. "Tonight", "today", "tomorrow" and "this week" are judged in London at
 * `ctx.now`. Quoted text is checked like any other. With several targets the text is checked part
 * by part: a part naming exactly one target is checked against it alone; any other part needs its
 * dates, times and names in one of the targets, and its prices, weekdays and claims in every one.
 */
export function checkPostText(text: string, targets: CheckTarget[], ctx: { now: Date; otherEventNames: string[] }): { pass: boolean; reasons: string[] } {
  if (!targets.length) return { pass: false, reasons: ['The post has no target event'] };
  const reasons: string[] = [];
  if (!text.trim()) reasons.push('The post is empty');
  const read = targets.map(t => ({ t, ...occurrenceOf(t) }));
  for (const r of read) reasons.push(...r.problems);
  const today = londonDate(ctx.now);

  // Another event counts anywhere, hashtags included, except as part of a target's own name.
  const names = targets.map(t => t.name);
  const own = names.flatMap(n => spansOf(phraseRegex(n), text));
  const targetKeys = new Set(names.map(squash));
  for (const other of ctx.otherEventNames) {
    const name = other.trim();
    if (name.length < 4 || targetKeys.has(squash(name))) continue;
    if (spansOf(phraseRegex(name), text).some(([at, end]) => !within(at, end, own)) || inHashtag(text, name, names, 4))
      reasons.push(`Names another event, "${name}"`);
  }
  // Hashtags read as words ("#CashPrizes"): their claims must be true of every target, and no Banned Phrase may be in them.
  const bodies = [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map(m => m[1]!);
  const tags = bodies.map(hashtagWords).join('\n');
  const squashedTags = bodies.map(b => squashedTag(b, names));
  const withoutSquashedDropIns = squashedTags.map(t => SQUASHED_DROP_INS.reduce((tag, d) => tag.split(d).join(' '), t));
  const claimed: string[] = [];
  for (let tag of squashedTags) {
    for (const [sq, said] of SQUASHED_CLAIMS) {
      if (!tag.includes(sq)) continue;
      claimed.push(said);
      tag = tag.split(sq).join(' ');
    }
  }
  const squashedClaims = [
    ...new Set([...claimed, ...SQUASHED_BOOKING.filter(([sq]) => withoutSquashedDropIns.some(t => t.trimStart().startsWith(sq))).map(([, said]) => said)]),
  ].join('\n');
  const tagSkip = names.flatMap(n => spansOf(phraseRegex(n), tags));
  for (const t of targets) {
    for (const phrase of t.banned) {
      if (phraseRegex(phrase)?.test(text) || phraseRegex(phrase)?.test(tags)) reasons.push(`Uses a Banned Phrase of ${t.name}, "${phrase.trim()}"`);
    }
    const support = { name: t.name, base_details: t.base_details, facts: t.facts, booking_mode: t.booking_mode };
    for (const p of [...claimProblems(tags, tagSkip, support), ...claimProblems(squashedClaims, [], support)]) {
      reasons.push(`${p} (in a hashtag${targets.length > 1 ? `, ${t.name}` : ''})`);
    }
  }
  // Dates, weekdays and prices in hashtags ("#FriNight", "#Friday30th", "#Halloween", "#FreeEntry") must be true of every target.
  const occurrences = read.flatMap(r => (r.occurrence ? [r.occurrence] : []));
  const every = targets.length === 1 ? targets[0]!.name : 'every event in the post';
  const prices = targets.map(t => pricesOf(t.price, t.facts.Price));
  const tagMoney = [
    ...findMoney(tags.replace(FREE_EXTRA, m => ' '.repeat(m.length))).filter(m => !within(m.index, m.index + m.text.length, tagSkip)),
    ...(squashedTags.some(t => SQUASHED_FREE.test(t)) ? [{ text: 'free', pence: 0 }] : []),
    ...squashedTags.flatMap(t => [...t.matchAll(SQUASHED_MONEY)].map(m => ({ text: m[0], pence: squashedPence(m) }))),
  ];
  for (const m of tagMoney) {
    if (Number.isNaN(m.pence) || !prices.every(p => p.includes(m.pence))) reasons.push(`"${m.text}": not the price of ${every} (in a hashtag)`);
  }
  const tagDates = findDates(tags).filter(d => !within(d.index, d.index + d.text.length, tagSkip));
  const squashedDates = squashedTags.flatMap(tag => findDates(tag.replace(SQUASHED_DATE_WORDS, m => ` ${SQUASHED_RELATIVE[m] ?? SQUASHED_HOLIDAYS[m] ?? m} `)));
  // "#Halloween" on its own is the day itself; "#HalloweenQuiz" is a theme.
  for (const body of bodies) if (squash(body) === 'halloween') squashedDates.push({ text: body, index: 0, day: 31, month: 10 });
  for (const tag of squashedTags) {
    const start = tag.trimStart();
    const found = SQUASHED_DAY_START.exec(start);
    const day = found?.[1] ?? found?.[2];
    if (!day || WEEKDAY_NAMES.some(d => start.startsWith(d))) continue;
    squashedDates.push(day === 'nye' ? { text: day, index: 0, day: 31, month: 12 } : { text: day, index: 0, weekday: weekdayOf(day) });
  }
  for (const d of [...tagDates, ...squashedDates]) {
    const why = dateProblem(d, occurrences, today, { any: every, every });
    if (why) reasons.push(`${why} (in a hashtag)`);
  }

  const parts =
    targets.length === 1
      ? [{ block: text, about: read }]
      : text
          .split(BLANK_LINE)
          .map(block =>
            block
              .split(LINE_BREAKS)
              .filter(line => !HASHTAG_LINE.test(line))
              .join('\n'),
          )
          .filter(block => block.trim() !== '')
          .map(block => {
            const named = read.filter(r => phraseRegex(r.t.name)?.test(block));
            return { block, about: named.length === 1 ? named : read };
          });
  for (const { block, about } of parts) reasons.push(...blockProblems(block, about, today, targets.length > 1));

  const unique = [...new Set(reasons)];
  return { pass: unique.length === 0, reasons: unique };
}
