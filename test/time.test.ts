import { describe, expect, it } from 'vitest';
import { addDays, londonDate, londonToUtc, occurrenceInstants, parseClock, parseSheetDate } from '../src/lib/time';

describe('parseSheetDate', () => {
  it.each([
    ['23/10/2026', '2026-10-23'],
    ['5/1/2027', '2027-01-05'],
    ['05.01.27', '2027-01-05'],
    ['2026-11-04', '2026-11-04'],
    [46318, '2026-10-23'], // Google serial number
  ])('reads %s', (raw, expected) => {
    expect(parseSheetDate(raw)).toBe(expected);
  });

  it.each(['Every Thursday', 'Open Wednesdays!', '', '31/02/2026', '13/13/2026', null, undefined, 12])(
    'rejects %s',
    raw => {
      expect(parseSheetDate(raw)).toBeNull();
    },
  );
});

describe('parseClock', () => {
  it.each([
    ['18:30', '18:30'],
    ['6:30 PM', '18:30'],
    ['6pm', '18:00'],
    ['12:00 am', '00:00'],
    ['12 pm', '12:00'],
    ['9.15', '09:15'],
    [0.770833333, '18:30'], // sheet time fraction
  ])('reads %s', (raw, expected) => {
    expect(parseClock(raw)).toBe(expected);
  });

  it.each(['18', '25:00', '13pm', 'evening', '', null])('rejects %s', raw => {
    expect(parseClock(raw)).toBeNull();
  });
});

describe('London time', () => {
  it('converts BST and GMT wall times to UTC', () => {
    expect(londonToUtc('2026-10-23', '18:30')).toBe('2026-10-23T17:30:00.000Z'); // BST
    expect(londonToUtc('2026-11-04', '11:00')).toBe('2026-11-04T11:00:00.000Z'); // GMT
    expect(londonToUtc('2026-10-25', '18:00')).toBe('2026-10-25T18:00:00.000Z'); // clocks went back that morning
  });

  it('dates instants in London, not UTC', () => {
    expect(londonDate(new Date('2026-10-04T23:30:00Z'))).toBe('2026-10-05'); // 00:30 BST
    expect(londonDate(new Date('2026-12-31T23:30:00Z'))).toBe('2026-12-31'); // GMT
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('builds occurrence instants', () => {
    expect(occurrenceInstants('2026-10-23', '18:30', '22:00')).toEqual({
      startsAt: '2026-10-23T17:30:00.000Z',
      endsAt: '2026-10-23T21:00:00.000Z',
    });
    // Ends after midnight
    expect(occurrenceInstants('2026-10-23', '20:00', '01:00').endsAt).toBe('2026-10-24T00:00:00.000Z');
    // No end time: one hour
    expect(occurrenceInstants('2026-11-04', '11:00', null).endsAt).toBe('2026-11-04T12:00:00.000Z');
    // No start: all day
    expect(occurrenceInstants('2026-11-04', null, null)).toEqual({ startsAt: null, endsAt: null });
  });
});
