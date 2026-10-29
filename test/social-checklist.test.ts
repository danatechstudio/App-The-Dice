// The Approved Facts checklist (src/social/checklist.ts): reading saved text into Not decided / Doesn't apply / Applies,
// the text a checklist saves, what stops a save, and which keys an event has decided.
import { describe, expect, it } from 'vitest';
import { CHECKLIST_KEYS, checklistProblems, checklistText, emptyChecklist, factsDecided, isNoneValue, readChecklist, type Checklist } from '../src/social/checklist';
import { parseFacts } from '../src/social/facts';

const read = (text: string): Checklist => {
  const r = readChecklist(text);
  if (!('checklist' in r)) throw new Error(r.why);
  return r.checklist;
};

describe('the facts checklist', () => {
  it('has the eight keys in order', () => {
    expect(CHECKLIST_KEYS).toEqual(['Booking', 'Level', 'Age', 'Format', 'Prizes', 'Price', 'Bring', 'Food']);
  });

  it('reads none, n/a and not applicable as Doesn’t apply, any case', () => {
    for (const v of ['none', 'None', 'NONE', 'n/a', 'N/A', 'not applicable', 'Not Applicable', 'none.']) expect(isNoneValue(v), v).toBe(true);
    for (const v of ['No prizes', 'nothing', 'Beginners welcome', '', 'none at all']) expect(isNoneValue(v), v).toBe(false);
  });

  it('reads saved text: a key line Applies with its value, a none value Doesn’t apply, a missing key Not decided', () => {
    const c = read('booking: Essential\nlevel: NONE\nAge: n/a\nFormat: Not applicable\nPrizes: Cash prizes\nOther: Bring a friend\nOther: Halloween themed');
    expect(c.rows).toEqual({
      Booking: { state: 'applies', value: 'Essential' },
      Level: { state: 'none' },
      Age: { state: 'none' },
      Format: { state: 'none' },
      Prizes: { state: 'applies', value: 'Cash prizes' },
      Price: { state: 'undecided' },
      Bring: { state: 'undecided' },
      Food: { state: 'undecided' },
    });
    expect(c.other).toEqual(['Bring a friend', 'Halloween themed']);
    expect(read('')).toEqual(emptyChecklist());
  });

  it('keeps Booking as a value: booking always applies', () => {
    expect(read('Booking: none').rows.Booking).toEqual({ state: 'applies', value: 'none' });
  });

  it('can’t read text that isn’t Key: value lines, or names a key twice', () => {
    expect(readChecklist('Booking essential')).toHaveProperty('why');
    expect(readChecklist('Colour: red')).toHaveProperty('why');
    expect(readChecklist('Level:')).toHaveProperty('why');
    expect(readChecklist('Level: All levels\nlevel: none')).toEqual({ why: 'Level is given more than once.' });
  });

  it('saves Booking, Level, Age, Format, Prizes, Price, Bring, Food, then Other; nothing for Not decided; Key: none for Doesn’t apply', () => {
    const c = emptyChecklist();
    c.rows.Food = { state: 'applies', value: ' Pizza provided ' };
    c.rows.Prizes = { state: 'none' };
    c.rows.Booking = { state: 'applies', value: 'No need to book' };
    c.rows.Level = { state: 'undecided' };
    c.rows.Bring = { state: 'none' };
    c.rows.Format = { state: 'applies', value: 'Open play' };
    c.other = ['Themed night', '  '];
    const text = checklistText(c);
    expect(text).toBe('Booking: No need to book\nFormat: Open play\nPrizes: none\nBring: none\nFood: Pizza provided\nOther: Themed night');
    // What it saves reads back the same, and is valid Approved Facts.
    expect(read(text).rows).toEqual({ ...c.rows, Food: { state: 'applies', value: 'Pizza provided' } });
    expect(parseFacts(text).errors).toEqual([]);
    expect(checklistText(emptyChecklist())).toBe('');
  });

  it('won’t save an Applies row with no value, and says which', () => {
    const c = emptyChecklist();
    expect(checklistProblems(c)).toEqual([]);
    c.rows.Age = { state: 'applies', value: '  ' };
    c.rows.Booking = { state: 'applies', value: '' };
    expect(checklistProblems(c)).toEqual([
      'Booking applies but has no value: choose one, or set it back to Not decided.',
      'Age applies but has no value: choose one, or set it back to Not decided or Doesn’t apply.',
    ]);
    expect(checklistText(c)).toBe('');
  });

  it('counts the keys decided: any line for a key decides it, none included; Other and lines that won’t read decide nothing', () => {
    expect(factsDecided('')).toEqual({ decided: [], undecided: [...CHECKLIST_KEYS] });
    expect(factsDecided('Food: none\nbooking: Essential\nOther: x\nnonsense\nLevel:\nColour: red')).toEqual({
      decided: ['Booking', 'Food'],
      undecided: ['Level', 'Age', 'Format', 'Prizes', 'Price', 'Bring'],
    });
    const all = CHECKLIST_KEYS.map(k => `${k}: none`).join('\n');
    expect(factsDecided(all)).toEqual({ decided: [...CHECKLIST_KEYS], undecided: [] });
  });
});
