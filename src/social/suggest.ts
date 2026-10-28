// One-tap fact suggestions for a prompt waiting for review (Organise › Social posts). Pure: worked
// out from the version's checker errors and the event's own facts, and never applied by the app.
// The owner's rule: prompts are repaired automatically (src/social/prompts.ts), facts only ever change
// when an admin taps Apply, which sends the suggested People & Roles through the sheet-edit path
// (src/sync/edits.ts requestEdit) with every check a typed change gets. The others are links to the
// field to change, since the right wording is the admin's to write.

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
  | { kind: 'description_day'; link: 'ev-description'; text: string };

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
