// The editor's preset values for objective facts and roles (src/social/presets.ts): each one is read by the
// social checker as meant. Every preset goes through parseFacts, as the editor saves it, then the post checks.
import { describe, expect, it } from 'vitest';
import { parseFacts, parsePeople } from '../src/social/facts';
import {
  AGE_PRESETS,
  ageRange,
  BOOKING_PRESETS,
  BOOKING_VIA,
  FACT_PRESETS,
  FORMAT_PRESETS,
  LEVEL_PRESETS,
  PRICE_FREE,
  PRIZE_PRESETS,
  presetChoice,
  ROLE_PRESETS,
  rolePreset,
} from '../src/social/presets';
import { checkPostText, hasRoleWord, type CheckTarget } from '../src/social/validate';

const now = new Date('2026-10-20T12:00:00Z');
const base: CheckTarget = {
  event_id: 'RTD-EVT-00009',
  name: 'Board Games',
  date: '2026-10-23',
  start_time: '18:30',
  end_time: null,
  price: '£4',
  facts: {},
  base_details: '',
  people: [],
  banned: [],
  // No booking setting, so only the facts can support a booking claim.
  booking_mode: 'none',
};

/** A target whose facts are exactly what the editor saves for these rows. */
function withFacts(lines: string[], extra: Partial<CheckTarget> = {}): CheckTarget {
  const { facts, errors } = parseFacts(lines.join('\n'));
  expect(errors).toEqual([]);
  return { ...base, ...extra, facts };
}
const reasons = (text: string, t: CheckTarget) => checkPostText(text, [t], { now, otherEventNames: [] }).reasons;
const passes = (text: string, t: CheckTarget) => expect(reasons(text, t), `${text} with ${JSON.stringify(t.facts)}`).toEqual([]);
const fails = (text: string, t: CheckTarget, reason: string) => {
  const r = reasons(text, t);
  expect(
    r.some(x => x.includes(reason)),
    `${text} with ${JSON.stringify(t.facts)} → ${r.join(' | ')}`,
  ).toBe(true);
};

const BOOK_TALK = 'Book your place for Board Games.';
const DROP_IN_TALK = 'Drop-ins welcome at Board Games.';
const OPTIONAL_TALK = 'Booking is optional for Board Games.';

describe('Booking presets', () => {
  it('lists the presets', () => {
    expect([...BOOKING_PRESETS]).toEqual(['Essential', 'Recommended – drop-ins welcome', 'Preferred – drop-ins welcome', 'Optional', 'No need to book']);
  });

  it('"Essential" is booked and not drop in', () => {
    const t = withFacts(['Booking: Essential']);
    passes(BOOK_TALK, t);
    passes('Booking is essential for Board Games.', t);
    fails(DROP_IN_TALK, t, 'needs a Booking fact saying so');
    fails('No need to book for Board Games.', t, 'needs a Booking fact saying so');
    fails(OPTIONAL_TALK, t, 'needs a Booking fact saying booking is optional');
  });

  it('"Essential, book via <url>" is booked and not drop in', () => {
    const t = withFacts([`Booking: ${BOOKING_VIA}https://www.eventbrite.co.uk/o/89845223753`]);
    passes(BOOK_TALK, t);
    fails(DROP_IN_TALK, t, 'needs a Booking fact saying so');
  });

  for (const v of ['Recommended – drop-ins welcome', 'Preferred – drop-ins welcome']) {
    it(`"${v}" supports booking talk, drop-in talk and optional booking`, () => {
      const t = withFacts([`Booking: ${v}`]);
      passes(BOOK_TALK, t);
      passes(DROP_IN_TALK, t);
      passes('Just drop in at Board Games.', t);
      passes(OPTIONAL_TALK, t);
    });
  }

  it('"Optional" supports booking talk and optional booking, not drop-in talk', () => {
    const t = withFacts(['Booking: Optional']);
    passes(BOOK_TALK, t);
    passes(OPTIONAL_TALK, t);
    fails(DROP_IN_TALK, t, 'needs a Booking fact saying so');
  });

  it('"No need to book" is drop in, not booked', () => {
    const t = withFacts(['Booking: No need to book']);
    passes(DROP_IN_TALK, t);
    passes('No need to book for Board Games.', t);
    fails(BOOK_TALK, t, 'needs a Booking fact');
  });
});

describe('Level presets', () => {
  it('lists the presets', () => {
    expect([...LEVEL_PRESETS]).toEqual(['Beginners welcome', 'Beginners and experienced alike', 'Experienced players', 'All levels']);
  });

  for (const v of ['Beginners welcome', 'Beginners and experienced alike', 'All levels']) {
    it(`"${v}" supports beginner claims`, () => {
      const t = withFacts([`Level: ${v}`]);
      passes('Beginners welcome at Board Games.', t);
      passes('No experience needed for Board Games.', t);
      passes('All levels welcome at Board Games.', t);
    });
  }

  it('"Beginners and experienced alike" and "Experienced players" support experienced claims', () => {
    passes('Experienced players welcome at Board Games.', withFacts(['Level: Beginners and experienced alike']));
    passes('Experienced players welcome at Board Games.', withFacts(['Level: Experienced players']));
  });

  it('"Experienced players" does not support beginner claims', () => {
    const t = withFacts(['Level: Experienced players']);
    fails('Beginners welcome at Board Games.', t, 'beginners: needs a Level fact');
    fails('No experience needed for Board Games.', t, 'needs a Level fact');
  });

  it('an experienced-only Level beside a beginner one still supports beginner claims', () => {
    passes('Beginners welcome at Board Games.', withFacts(['Level: Experienced players', 'Level: Beginners welcome']));
  });
});

describe('Age presets', () => {
  it('lists the presets', () => {
    expect([...AGE_PRESETS]).toEqual(['All ages', 'Family friendly', 'Kids', 'Adults (18+)']);
  });

  it('each preset, and a range, supports its own age words', () => {
    passes('All ages welcome at Board Games.', withFacts(['Age: All ages']));
    passes('Family fun at Board Games.', withFacts(['Age: Family friendly']));
    passes('Kids welcome at Board Games.', withFacts(['Age: Kids']));
    passes('Adults only at Board Games.', withFacts(['Age: Adults (18+)']));
    passes('For ages 2 to 4 at Board Games.', withFacts([`Age: ${ageRange('2', '4')}`]));
    expect(ageRange(' 2', '4 ')).toBe('2-4 years');
  });
});

describe('Format presets', () => {
  it('lists the presets', () => {
    expect([...FORMAT_PRESETS]).toEqual(['Organised play', 'Open play', 'Table time', 'Tournament', 'Workshop', 'Drop-in session', 'Casual club']);
  });

  it('"Open play" supports open play; "Organised play" does not', () => {
    passes('Open play at Board Games.', withFacts(['Format: Open play']));
    fails('Open play at Board Games.', withFacts(['Format: Organised play']), 'open play: needs a Booking fact saying so');
    fails('Open play at Board Games.', withFacts([]), 'open play: needs a Booking fact saying so');
  });

  it('"Drop-in session" supports drop-in talk', () => {
    passes('A drop-in session at Board Games.', withFacts(['Format: Drop-in session']));
  });

  it('every preset can be repeated in a post on a paid event', () => {
    for (const v of FORMAT_PRESETS) passes(`${v} at Board Games.`, withFacts([`Format: ${v}`]));
  });
});

describe('Prize presets', () => {
  it('lists the presets', () => {
    expect([...PRIZE_PRESETS]).toEqual(['Cash prizes', 'Vouchers', 'Trophies', 'Prizes to be won', 'No prizes']);
  });

  for (const v of PRIZE_PRESETS.filter(p => p !== 'No prizes')) {
    it(`"${v}" supports prize claims`, () => {
      const t = withFacts([`Prizes: ${v}`]);
      passes('Prizes to be won at Board Games.', t);
      passes('Win big at Board Games.', t);
      passes(`${v} at Board Games.`, t);
    });
  }

  it('"No prizes" (and "none") supports no prize claim', () => {
    fails('Prizes to be won at Board Games.', withFacts(['Prizes: No prizes']), 'prizes: needs a Prizes fact');
    fails('Cash prizes at Board Games.', withFacts(['Prizes: none']), 'needs a Prizes fact');
  });
});

describe('Price presets', () => {
  it('"Free" supports free; the event price supports the event price', () => {
    passes('Board Games is free.', withFacts([`Price: ${PRICE_FREE}`], { price: '' }));
    passes('Board Games is £4.', withFacts(['Price: £4']));
    fails('Board Games is £5.', withFacts(['Price: £4']), 'not the price');
  });
});

describe('role presets', () => {
  it('lists the presets', () => {
    expect([...ROLE_PRESETS]).toEqual([
      'Host',
      'Dungeon Master',
      'Game Master',
      'Organiser',
      'Leads the workshop',
      'Runs the session',
      'Quizmaster',
      'Bingo caller',
      'MC',
      'Presenter',
    ]);
  });

  for (const role of ROLE_PRESETS) {
    it(`"${role}" holds a role word, and a post giving Trixie that role passes`, () => {
      expect(hasRoleWord(role)).toBe(true);
      const { people, errors } = parsePeople(`Trixie - ${role}`);
      expect(errors).toEqual([]);
      const t = { ...base, people };
      passes(`With Trixie as ${role.toLowerCase()}.`, t);
      const other = role === 'Presenter' ? 'host' : 'presenter';
      fails(`With Trixie as ${other}.`, t, 'People & Roles gives the role');
    });
  }

  it('an Other role without a role word is not one', () => {
    expect(hasRoleWord('Snack wrangler')).toBe(false);
  });
});

describe('reading saved values back', () => {
  it('a preset reads back loosely (any case, trailing full stops)', () => {
    expect(presetChoice('Booking', 'essential.')).toEqual({ kind: 'preset', value: 'Essential' });
    expect(presetChoice('Level', 'Beginners and Experienced alike.')).toEqual({ kind: 'preset', value: 'Beginners and experienced alike' });
    expect(presetChoice('Format', 'Open play')).toEqual({ kind: 'preset', value: 'Open play' });
  });

  it('anything else is Other', () => {
    expect(presetChoice('Booking', 'essential, ring Michelle')).toEqual({ kind: 'other' });
    expect(presetChoice('Format', 'free table time')).toEqual({ kind: 'other' });
    expect(presetChoice('Age', 'home-educating families.')).toEqual({ kind: 'other' });
    expect(presetChoice('Bring', 'Dice')).toEqual({ kind: 'other' });
    expect(presetChoice('Price', '£4')).toEqual({ kind: 'other' });
  });

  it('the special forms read back', () => {
    expect(presetChoice('Booking', 'essential, book via https://www.eventbrite.co.uk/o/89845223753')).toEqual({
      kind: 'link',
      url: 'https://www.eventbrite.co.uk/o/89845223753',
    });
    expect(presetChoice('Age', '2-4 years')).toEqual({ kind: 'range', from: '2', to: '4' });
    expect(presetChoice('Age', '12–16 years.')).toEqual({ kind: 'range', from: '12', to: '16' });
    expect(presetChoice('Price', '£4', '£4')).toEqual({ kind: 'event_price' });
    expect(presetChoice('Price', 'free')).toEqual({ kind: 'preset', value: 'Free' });
  });

  it('roles read back loosely', () => {
    expect(rolePreset('host')).toBe('Host');
    expect(rolePreset('Dungeon master.')).toBe('Dungeon Master');
    expect(rolePreset('sets up')).toBeUndefined();
  });

  it('only the objective keys have presets', () => {
    expect(Object.keys(FACT_PRESETS)).toEqual(['Booking', 'Level', 'Age', 'Format', 'Prizes', 'Price']);
  });
});
