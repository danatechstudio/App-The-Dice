// One-tap fact suggestions for a prompt waiting for review (src/social/suggest.ts). Pure: they are
// worked out from the version's checker errors and the event's own facts, and nothing changes until
// an admin taps Apply, which goes through the sheet-edit path like any other change.
import { describe, expect, it } from 'vitest';
import type { SourceFields } from '../src/social/facts';
import { suggestExampleFixes, suggestFixes } from '../src/social/suggest';
import { promptTextErrors } from '../src/social/validate';

const olivia: SourceFields = {
  event_id: 'RTD-EVT-00012',
  name: 'Curse of Strahd',
  source: 'event_index',
  frequency: 'weekly',
  base_details: 'Olivia is one mean Dungeon Master, leading her band of adventurers through the mists of Barovia.',
  approved_facts: 'Booking: essential',
  people_roles: 'Trixie - host',
  category: 'Gaming',
  visibility: 'public',
  price: '£5',
  capacity: '6',
};

describe('suggestFixes', () => {
  it('suggests adding a person the prompt names when Base Details gives them a role', () => {
    expect(suggestFixes(olivia, ['In the prompt, Olivia: not in People & Roles'])).toEqual([
      {
        kind: 'people_add',
        name: 'Olivia',
        column: 'People & Roles',
        from: 'Trixie - host',
        to: 'Trixie - host\nOlivia - Dungeon Master',
        text: 'Add "Olivia - Dungeon Master" to People & Roles? Base Details says so.',
      },
    ]);
    // The same from the name check's wording, and with no one listed yet.
    expect(suggestFixes({ ...olivia, people_roles: '' }, ['The prompt names "Olivia", which isn\'t in People & Roles or the event\'s own fields'])).toMatchObject([
      { kind: 'people_add', from: '', to: 'Olivia - Dungeon Master' },
    ]);
  });

  it("reads a role from Base Details that the prompt's own check doesn't trace", () => {
    // "Olivia is one mean Dungeon Master" is too far apart for the check, so the prompt fails; the suggestion still reads it.
    const prompt = 'Write about Curse of Strahd at Roll The Dice. Olivia is the Dungeon Master. Booking is essential.';
    const errors = promptTextErrors(prompt, olivia, []);
    expect(errors).toContain('In the prompt, Olivia: not in People & Roles');
    expect(suggestFixes(olivia, errors)).toMatchObject([{ kind: 'people_add', to: 'Trixie - host\nOlivia - Dungeon Master' }]);
  });

  it('gives the plain role word for a verb in Base Details', () => {
    const f = { ...olivia, base_details: 'Every week Bob hosts a quiz for teams of six.', people_roles: '' };
    expect(suggestFixes(f, ['In the prompt, Bob: not in People & Roles'])).toMatchObject([{ kind: 'people_add', to: 'Bob - host' }]);
  });

  it('suggests nothing when the name is not in Base Details: the prompt made them up', () => {
    expect(suggestFixes(olivia, ['In the prompt, Gandalf: not in People & Roles'])).toEqual([]);
    expect(suggestFixes(olivia, ['The prompt names "Gandalf", which isn\'t in People & Roles or the event\'s own fields'])).toEqual([]);
    // Named in Base Details but with no role word near them: nothing to add either.
    const f = { ...olivia, base_details: 'Olivia loves dice. We play every week in the back room with snacks and maps.' };
    expect(suggestFixes(f, ['In the prompt, Olivia: not in People & Roles'])).toEqual([]);
  });

  it("suggests a second role when Base Details gives the person the role the prompt used", () => {
    const f = { ...olivia, base_details: 'Trixie organises the night and keeps score.', people_roles: 'Trixie - host\nBob - DM' };
    expect(suggestFixes(f, ['In the prompt, Trixie: People & Roles gives the role "host", not "organiser"'])).toEqual([
      {
        kind: 'people_role',
        name: 'Trixie',
        column: 'People & Roles',
        from: 'Trixie - host\nBob - DM',
        to: 'Trixie - host, organiser\nBob - DM',
        text: 'Give Trixie both roles, "Trixie - host, organiser"? Base Details says so.',
      },
    ]);
    // Base Details doesn't say it: nothing.
    expect(suggestFixes({ ...f, base_details: 'Trixie keeps score.' }, ['In the prompt, Trixie: People & Roles gives the role "host", not "organiser"'])).toEqual([]);
  });

  it('links to Social facts when a booking word needs a Booking fact and there is none', () => {
    const f = { ...olivia, approved_facts: 'Level: all levels' };
    expect(suggestFixes(f, ['In the prompt, booking essential: needs a Booking fact', 'In the prompt, book now: needs a Booking fact'])).toEqual([
      { kind: 'booking_missing', link: 'social-facts', text: 'Add a Booking fact' },
    ]);
    // There is a Booking fact: the prompt is what's wrong.
    expect(suggestFixes(olivia, ['In the prompt, drop in: needs a Booking fact saying so'])).toEqual([]);
  });

  it('links to the description when the day the prompt states is in Base Details', () => {
    const f = { ...olivia, base_details: 'We meet on Wednesdays in the back room. Olivia is our DM.' };
    const error = 'The prompt states a date or day, "Wednesdays"; the date comes only from the schedule at posting time';
    expect(suggestFixes(f, [error])).toEqual([
      { kind: 'description_day', link: 'ev-description', text: "Your description mentions 'Wednesdays'; dates come from the schedule. Reword it?" },
    ]);
    expect(suggestFixes(olivia, [error])).toEqual([]);
  });

  it('suggests nothing for anything else, and once per person', () => {
    expect(suggestFixes(olivia, ['The prompt names another event, "Quiz Night"', 'Claim 2 has no text'])).toEqual([]);
    expect(suggestFixes(olivia, ['In the prompt, Olivia: not in People & Roles', 'In the prompt, Olivia: not in People & Roles'])).toHaveLength(1);
  });
});

// Example posts that would be held (Organise › Social posts, "Posts that would be held"): what an admin could change.
describe('suggestExampleFixes', () => {
  const cleeples: SourceFields = {
    ...olivia,
    event_id: 'RTD-EVT-00021',
    name: 'Cleeples',
    base_details: 'A friendly board game meet-up.',
    people_roles: 'Millie - host',
  };
  const tone = 'Write like Michelle: warm and chatty. MillieMoo runs the show, so give her a shout-out.';

  it('links a missing fact to its checklist row', () => {
    const sazlou = { ...olivia, name: 'SazLou', approved_facts: 'Booking: essential' };
    expect(suggestExampleFixes(sazlou, '', ['family: needs an Age fact', 'all ages: needs an Age fact', 'cash: needs a Prizes fact'])).toEqual([
      { kind: 'fact_missing', key: 'Age', link: 'ev-fact-age', text: 'Set Age in the facts checklist' },
      { kind: 'fact_missing', key: 'Prizes', link: 'ev-fact-prizes', text: 'Set Prizes in the facts checklist' },
    ]);
    // A fact set to none that the post claims anyway: the same row.
    expect(suggestExampleFixes(sazlou, '', ["kids: needs an Age fact, but Age is set to none, so it can't be claimed"])).toMatchObject([
      { kind: 'fact_missing', key: 'Age' },
    ]);
  });

  it("says when Michelle's prompt and People & Roles use different names for someone, with no one-tap", () => {
    expect(suggestExampleFixes(cleeples, tone, ['MillieMoo: not in People & Roles'])).toEqual([
      {
        kind: 'name_mismatch',
        prompt_name: 'MillieMoo',
        people_name: 'Millie',
        links: [
          { link: 'ev-col-people-roles', text: 'People & Roles' },
          { link: 'ev-voice', text: 'Michelle’s voice' },
        ],
        text: "Michelle's prompt calls them 'MillieMoo' but People & Roles says 'Millie'. Use one name in both",
      },
    ]);
    // A close spelling counts too.
    expect(suggestExampleFixes({ ...cleeples, people_roles: 'Milly - host' }, 'Millie hosts it.', ['Millie: not in People & Roles'])).toMatchObject([
      { kind: 'name_mismatch', prompt_name: 'Millie', people_name: 'Milly' },
    ]);
  });

  it("suggests nothing for a name Michelle's prompt doesn't use, or no one in People & Roles is near", () => {
    expect(suggestExampleFixes(cleeples, '', ['MillieMoo: not in People & Roles'])).toEqual([]);
    expect(suggestExampleFixes(cleeples, 'Trixie runs it.', ['Trixie: not in People & Roles'])).toEqual([]);
  });

  it('offers the one-tap People & Roles line when Base Details gives the name a role', () => {
    expect(suggestExampleFixes(olivia, '', ['Olivia: not in People & Roles'])).toMatchObject([
      { kind: 'people_add', name: 'Olivia', to: 'Trixie - host\nOlivia - Dungeon Master' },
    ]);
  });
});
