// One-tap fact suggestions for a prompt waiting for review (Organise › Social posts). Pure: worked
// out from the version's checker errors and the event's own facts, and never applied by the app.
// The owner's rule: prompts are repaired automatically (src/social/prompts.ts), facts only ever change
// when an admin taps Apply, which sends the suggested People & Roles through the sheet-edit path
// (src/sync/edits.ts requestEdit) with every check a typed change gets. The others are links to the
// field to change, since the right wording is the admin's to write.

import { CHECKLIST_KEYS, type ChecklistKey } from './checklist';
import { parseFacts, parsePeople, type SourceFields } from './facts';
import { roleNear, roleOfWord, tokens } from './validate';

export type Suggestion =
  /** A person the prompt names, given a role in Base Details but not in People & Roles: add their line. */
  | { kind: 'people_add'; name: string; column: 'People & Roles'; from: string; to: string; text: string }
  /** A listed person the prompt gives a role Base Details also gives them: add it to their line. */
  | { kind: 'people_role'; name: string; column: 'People & Roles'; from: string; to: string; text: string }
  /** A booking word with no Booking fact at all: a link to Social facts. */
  | { kind: 'booking_missing'; link: 'social-facts'; text: string }
  /** A day the prompt states that Base Details also states: a link to the description. */
  | { kind: 'description_day'; link: 'ev-description'; text: string }
  /** An example post claims something a fact key would have to say: a link to that checklist row. */
  | { kind: 'fact_missing'; key: ChecklistKey; link: `ev-fact-${string}`; text: string }
  /** Michelle's Standard Prompt and People & Roles call someone by different names: links to both, the owner picks one. */
  | { kind: 'name_mismatch'; prompt_name: string; people_name: string; links: { link: 'ev-col-people-roles' | 'ev-voice'; text: string }[]; text: string };

// The checker's wording (src/social/validate.ts), with or without "In the prompt, " before it.
const NOT_LISTED = /^(?:In the prompt, )?(.+?): not in People & Roles$/u;
const NAMED = /^The prompt names "(.+?)", which isn't in People & Roles/u;
const OTHER_ROLE = /^(?:In the prompt, )?(.+?): People & Roles gives the role "(.+)", not "(.+)"$/u;
const NEEDS_BOOKING = /: needs a Booking fact/u;
const STATES_DAY = /^The prompt states a date or day, "(.+?)";/u;

const sameWords = (a: string, b: string) => tokens(a).join(' ') === tokens(b).join(' ');

/** What an admin could change in the event's facts so the checks pass, from one version's errors. */
export function suggestFixes(f: SourceFields, errors: string[]): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (key: string, s: Suggestion) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  const people = parsePeople(f.people_roles).people;
  const listedAs = (name: string) => people.filter(p => tokens(p.name).some(w => sameWords(w, name)));
  const peopleText = f.people_roles.trim();

  for (const error of errors) {
    const unlisted = NOT_LISTED.exec(error)?.[1] ?? NAMED.exec(error)?.[1];
    if (unlisted && !listedAs(unlisted).length) {
      // Only a person the event's own Base Details gives a role: one the prompt made up is the repair's to drop.
      const near = roleNear(f.base_details, unlisted);
      if (!near) continue;
      const line = `${unlisted} - ${near.word}`;
      add(`person:${unlisted.toLowerCase()}`, {
        kind: 'people_add',
        name: unlisted,
        column: 'People & Roles',
        from: f.people_roles,
        to: peopleText ? `${peopleText}\n${line}` : line,
        text: `Add "${line}" to People & Roles? Base Details says so.`,
      });
      continue;
    }

    const other = OTHER_ROLE.exec(error);
    if (other) {
      const [, name, , said] = other as unknown as [string, string, string, string];
      const wanted = roleOfWord(said);
      const near = roleNear(f.base_details, name);
      const person = listedAs(name)[0];
      if (!wanted || !person || near?.role !== wanted) continue;
      const line = `${person.name} - ${person.role}, ${near.word}`;
      const lines = f.people_roles.split(/\r?\n/);
      const at = lines.findIndex(l => parsePeople(l).people[0]?.name === person.name);
      if (at < 0) continue;
      lines[at] = line;
      add(`person:${name.toLowerCase()}`, {
        kind: 'people_role',
        name,
        column: 'People & Roles',
        from: f.people_roles,
        to: lines.join('\n'),
        text: `Give ${name} both roles, "${line}"? Base Details says so.`,
      });
      continue;
    }

    if (NEEDS_BOOKING.test(error) && !parseFacts(f.approved_facts).facts.Booking?.length) {
      add('booking', { kind: 'booking_missing', link: 'social-facts', text: 'Add a Booking fact' });
      continue;
    }

    const day = STATES_DAY.exec(error)?.[1];
    if (day && tokens(f.base_details).some((_, i, all) => sameWords(all.slice(i, i + tokens(day).length).join(' '), day))) {
      add(`day:${day.toLowerCase()}`, {
        kind: 'description_day',
        link: 'ev-description',
        text: `Your description mentions '${day}'; dates come from the schedule. Reword it?`,
      });
    }
  }
  return out;
}

// ---- Example posts that would be held ----

const NEEDS_FACT = new RegExp(`^.+?: needs an? (${CHECKLIST_KEYS.join('|')}) fact`, 'u');

/** Edits between two short words (case ignored), for "Milly" and "Millie". */
function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[y.length]!;
}

/** A People & Roles name that is the same person as `word` written another way: a prefix of it (Millie, MillieMoo) or a close spelling. */
function nearName(word: string, names: string[]): string | null {
  const w = word.toLowerCase();
  for (const name of names) {
    for (const part of name.match(/[\p{L}\p{N}]+/gu) ?? []) {
      const p = part.toLowerCase();
      if (p === w || p.length < 3) continue;
      if (w.startsWith(p) || p.startsWith(w) || (Math.min(p.length, w.length) >= 4 && distance(p, w) <= 2)) return part;
    }
  }
  return null;
}

/**
 * What an admin could change so an example post would pass, from its check's problems: a missing fact links to its
 * checklist row; a name Michelle's Standard Prompt (`toneGuidance`) uses for someone People & Roles names differently
 * says so, with links to both (no one-tap: the owner picks the name); otherwise the People & Roles line Base Details supports.
 */
export function suggestExampleFixes(f: SourceFields, toneGuidance: string, problems: string[]): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (key: string, s: Suggestion) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  const names = parsePeople(f.people_roles).people.map(p => p.name);
  const toneWords = new Set(tokens(toneGuidance).map(w => w.toLowerCase()));

  for (const problem of problems) {
    const key = NEEDS_FACT.exec(problem)?.[1] as ChecklistKey | undefined;
    if (key) {
      add(`fact:${key}`, { kind: 'fact_missing', key, link: `ev-fact-${key.toLowerCase()}`, text: `Set ${key} in the facts checklist` });
      continue;
    }
    const unlisted = NOT_LISTED.exec(problem)?.[1];
    if (!unlisted) continue;
    const near = toneWords.has(unlisted.toLowerCase()) ? nearName(unlisted, names) : null;
    if (near) {
      add(`person:${unlisted.toLowerCase()}`, {
        kind: 'name_mismatch',
        prompt_name: unlisted,
        people_name: near,
        links: [
          { link: 'ev-col-people-roles', text: 'People & Roles' },
          { link: 'ev-voice', text: 'Michelle’s voice' },
        ],
        text: `Michelle's prompt calls them '${unlisted}' but People & Roles says '${near}'. Use one name in both`,
      });
      continue;
    }
    for (const s of suggestFixes(f, [problem])) add(`person:${unlisted.toLowerCase()}`, s);
  }
  return out;
}
