import { describe, expect, it } from 'vitest';
import { displayNameOf, frequencyOf, normaliseRows, visibilityOf } from '../src/sync/normalise';
import { diaryRow, indexRow } from './helpers';

describe('normaliseRows (Event Index)', () => {
  it('normalises a full row', () => {
    const { events, warnings } = normaliseRows('event_index', [
      indexRow(1, { 'Event Name': 'Quiz', Frequency: 'Monthly', 'Photo Folder ID': 'abc123' }),
    ]);
    expect(warnings).toEqual([]);
    expect(events).toEqual([
      {
        event_id: 'RTD-EVT-00001',
        source: 'event_index',
        source_row: 2,
        event_name: 'Quiz',
        display_name: 'Quiz',
        category: 'Quiz',
        description: 'Details for event 1',
        frequency: 'monthly',
        repeatable: true,
        requires_redating: true,
        visibility: 'public',
        sheet_status: 'Active',
        active: true,
        photo_folder_id: 'abc123',
        price_display: null,
        default_capacity: null,
        host_session_id: null,
        market_id: null,
        next: { date: '2026-10-23', start_time: '18:30', end_time: '22:00', all_day: false },
        sheet_date_raw: '23/10/2026',
        sheet_values: {
          'Event Name': 'Quiz', 'Base Details': 'Details for event 1', 'Event Date': '2026-10-23', 'Event Time': '18:30', 'End Time': '22:00',
          Status: 'Active', 'App Visibility': 'public', 'App Category': 'Quiz', 'App Price': '',
        },
        social_values: { approved_facts: '', people_roles: '', banned_phrases: '' },
      },
    ]);
  });

  it('keeps the date cell as written, for Needs attention', () => {
    const { events } = normaliseRows('event_index', [
      indexRow(1, { 'Event Date': 'Every Thursday' }),
      indexRow(2, { 'Event Date': '' }),
    ]);
    expect(events.map(e => [e.next, e.sheet_date_raw])).toEqual([[null, 'Every Thursday'], [null, null]]);
  });

  it('reads the host session columns: App Price, App Capacity, App Host Session', () => {
    const { events } = normaliseRows('event_index', [
      indexRow(1, { 'App Price': ' £5 ', 'App Capacity': '6', 'App Host Session': 'RTD-HS-00012' }),
      indexRow(2, { 'App Price': '', 'App Capacity': 'lots', 'App Host Session': 'not-a-session' }),
      indexRow(3, { 'App Capacity': '0' }),
      indexRow(4, { 'App Host Session': 'RTD-MKT-00003' }),
    ]);
    expect(events.map(e => [e.price_display, e.default_capacity, e.host_session_id, e.market_id])).toEqual([
      ['£5', 6, 'RTD-HS-00012', null],
      [null, null, null, null],
      [null, null, null, null],
      // The same column links a market set up in the organiser.
      [null, null, null, 'RTD-MKT-00003'],
    ]);
  });

  it('shows an App Price that is only a number in pounds, and keeps any other price as written', () => {
    const prices = [2, '5', ' 3 ', '2.5', 2.5, '12.00', '0.5', '£8', 'Free', 'FREE', 'Pay what you can', '2 per person', '£2.50'];
    const { events } = normaliseRows('event_index', prices.map((p, i) => indexRow(i + 1, { 'App Price': p })));
    expect(events.map(e => e.price_display)).toEqual(['£2', '£5', '£3', '£2.50', '£2.50', '£12', '£0.50', '£8', 'Free', 'FREE', 'Pay what you can', '2 per person', '£2.50']);
  });

  it('skips blank rows silently', () => {
    const { events, warnings } = normaliseRows('event_index', [{ row_number: 9, 'Event Name': '  ', Frequency: 'x' }]);
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('skips and reports rows without a valid Event ID', () => {
    const { events, warnings } = normaliseRows('event_index', [
      indexRow(1, { 'Event ID': '' }),
      indexRow(2, { 'Event ID': 'Quiz' }),
    ]);
    expect(events).toEqual([]);
    expect(warnings.map(w => w.code)).toEqual(['missing_event_id', 'missing_event_id']);
  });

  it('skips every row sharing a duplicated Event ID', () => {
    const { events, warnings, skippedIds } = normaliseRows('event_index', [
      indexRow(1),
      indexRow(2, { 'Event ID': 'RTD-EVT-00001' }),
      indexRow(3),
    ]);
    expect(events.map(e => e.event_id)).toEqual(['RTD-EVT-00003']);
    expect(skippedIds).toEqual(['RTD-EVT-00001']);
    expect(warnings.filter(w => w.code === 'duplicate_event_id')).toHaveLength(2);
  });

  it('only treats an explicit Active status as active', () => {
    const { events } = normaliseRows('event_index', [
      indexRow(1, { Status: 'Inactive' }),
      indexRow(2, { Status: '' }),
      indexRow(3, { Status: ' active ' }),
    ]);
    expect(events.map(e => e.active)).toEqual([false, false, true]);
  });

  it('keeps free-text dates out of the diary and reports them', () => {
    const { events, warnings } = normaliseRows('event_index', [
      indexRow(1, { 'Event Name': 'Cleeples', 'Event Date': 'Every Thursday' }),
      indexRow(2, { 'Event Date': '' }),
    ]);
    expect(events.map(e => e.next)).toEqual([null, null]);
    expect(warnings).toMatchObject([{ code: 'invalid_date', event_name: 'Cleeples' }]);
  });

  it('treats unknown visibility as hidden and unknown category as Other', () => {
    const { events, warnings } = normaliseRows('event_index', [
      indexRow(1, { 'App Visibility': 'Sometimes', 'App Category': 'Karaoke' }),
      indexRow(2, { 'App Visibility': '', 'App Category': '' }),
    ]);
    expect(events.map(e => [e.visibility, e.category])).toEqual([
      ['hidden', 'Other'],
      ['hidden', null],
    ]);
    expect(warnings.map(w => w.code)).toEqual(['unknown_visibility', 'unknown_category']);
  });

  it('makes a timeless row all-day', () => {
    const { events } = normaliseRows('event_index', [indexRow(1, { 'Event Time': '', 'End Time': '22:00' })]);
    expect(events[0]?.next).toEqual({ date: '2026-10-23', start_time: null, end_time: null, all_day: true });
  });
});

describe('normaliseRows (Standard Diary)', () => {
  it('reads groups as all-day, active, non-redating events', () => {
    const { events } = normaliseRows('standard_diary', [diaryRow(24, { Group: 'Arkham Horror Card Game' })]);
    expect(events[0]).toMatchObject({
      event_id: 'RTD-EVT-00024',
      source: 'standard_diary',
      display_name: 'Arkham Horror Card Game',
      description: 'Notes for group 24',
      frequency: 'weekly',
      requires_redating: false,
      active: true,
      category: 'Club',
      next: { date: '2026-10-12', start_time: null, end_time: null, all_day: true },
    });
  });
});

describe('field helpers', () => {
  it.each([
    ['Public', 'public'],
    ['App Bookable', 'app_bookable'],
    ['app_bookable', 'app_bookable'],
    ['Private', 'private'],
    ['Link Only', 'private'],
    ['Hidden', 'hidden'],
    ['', 'hidden'],
    ['Nope', undefined],
  ])('visibility %s -> %s', (raw, expected) => {
    expect(visibilityOf(raw)).toBe(expected);
  });

  it.each([
    ['Weekly', 'weekly'],
    ['Bi-Weekly', 'fortnightly'],
    ['Two-Weekly', 'fortnightly'],
    ['Monthly', 'monthly'],
    ['One Off', 'one-off'],
    ['', 'one-off'],
  ])('frequency %s -> %s', (raw, expected) => {
    expect(frequencyOf(raw)).toBe(expected);
  });

  it('removes the weekday suffix workaround from display names', () => {
    expect(displayNameOf('Home Education Support ClubM')).toBe('Home Education Support Club');
    expect(displayNameOf('Home Education Support ClubT')).toBe('Home Education Support Club');
    expect(displayNameOf('BookClub')).toBe('BookClub');
    expect(displayNameOf("DM Alfie's DnD")).toBe("DM Alfie's DnD");
    expect(displayNameOf('DM Liv\'s DND')).toBe('DM Liv\'s DND');
  });
});
