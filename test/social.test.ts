// Event-specific social master prompts, Stage 1 (docs/superpowers/specs/2026-10-18-social-master-prompt-design.md).
// Task 1: the owner columns the sync reads, the facts they hold, and the fingerprint of what Gemini may see.
import { beforeEach, describe, expect, it } from 'vitest';
import { fingerprint, parseFacts, parsePeople, sourceFields, type SourceFields } from '../src/social/facts';
import { env, freshDb, indexRow, sync } from './helpers';

describe('owner columns', () => {
  beforeEach(freshDb);

  it('syncs Approved Facts, People & Roles and Banned Phrases without changing any event', async () => {
    expect((await sync({ run_id: 'r1', sources: { event_index: [indexRow(1)] } })).status).toBe(200);
    const blank = await env.DB.prepare('SELECT social_values, source_hash FROM events WHERE event_id = ?1')
      .bind('RTD-EVT-00001')
      .first<{ social_values: string; source_hash: string }>();
    expect(JSON.parse(blank!.social_values)).toEqual({ approved_facts: '', people_roles: '', banned_phrases: '' });

    const row = indexRow(1, {
      'Approved Facts': 'Booking: essential\nLevel: all levels',
      'People & Roles': 'Trixie — sets up',
      'Banned Phrases': 'open table',
    });
    const again = await (await sync({ run_id: 'r2', sources: { event_index: [row] } })).json<{ events_changed: number }>();
    expect(again.events_changed).toBe(0);

    const stored = await env.DB.prepare('SELECT social_values, source_hash FROM events WHERE event_id = ?1')
      .bind('RTD-EVT-00001')
      .first<{ social_values: string; source_hash: string }>();
    expect(stored!.source_hash).toBe(blank!.source_hash);
    expect(JSON.parse(stored!.social_values)).toEqual({
      approved_facts: 'Booking: essential\nLevel: all levels',
      people_roles: 'Trixie — sets up',
      banned_phrases: 'open table',
    });
  });

  it('reads the two owner columns on Standard Diary, which has no Banned Phrases', async () => {
    const row = {
      Group: 'Arkham',
      Notes: 'Co-op horror.',
      Frequency: 'Weekly',
      'Event ID': 'RTD-EVT-00005',
      'App Visibility': 'Public',
      'App Category': 'Club',
      Date: '12/10/2026',
      'Approved Facts': ' Level: all levels ',
      'People & Roles': 'Liv - DM',
      'Banned Phrases': 'ignored',
    };
    expect((await sync({ run_id: 'r1', sources: { standard_diary: [row] } })).status).toBe(200);
    const stored = await env.DB.prepare('SELECT social_values FROM events WHERE event_id = ?1').bind('RTD-EVT-00005').first<{ social_values: string }>();
    expect(JSON.parse(stored!.social_values)).toEqual({ approved_facts: 'Level: all levels', people_roles: 'Liv - DM', banned_phrases: '' });
  });

  it("reads facts by key, and reports lines it can't read", () => {
    const { facts, errors } = parseFacts('Booking: essential\nlevel: All levels\nPrizes: cash\nnonsense');
    expect(facts.Booking).toEqual(['essential']);
    expect(facts.Level).toEqual(['All levels']);
    expect(facts.Prizes).toEqual(['cash']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('nonsense');
  });

  it('keeps a repeated key, a colon inside a value, and reports an unknown key or an empty value', () => {
    const { facts, errors } = parseFacts('Bring: dice\n\nBring: snacks\nFormat: rounds: 3\nColour: red\nAge:  ');
    expect(facts.Bring).toEqual(['dice', 'snacks']);
    expect(facts.Format).toEqual(['rounds: 3']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Colour');
    expect(errors[1]).toContain('Age');
    expect(parseFacts('')).toEqual({ facts: {}, errors: [] });
  });

  it('reads people with any dash', () => {
    const { people, errors } = parsePeople('Trixie — sets up\nLiv - DM\nAlfie – DM');
    expect(errors).toEqual([]);
    expect(people).toEqual([
      { name: 'Trixie', role: 'sets up' },
      { name: 'Liv', role: 'DM' },
      { name: 'Alfie', role: 'DM' },
    ]);
  });

  it('keeps a hyphenated name whole, and reports a line with no role', () => {
    const { people, errors } = parsePeople('Mary-Jane — runs the table\nLiv - DM — lead\nTrixie\n');
    expect(people).toEqual([
      { name: 'Mary-Jane', role: 'runs the table' },
      { name: 'Liv', role: 'DM — lead' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Trixie');
  });

  describe('fingerprint', () => {
    const fields = (over: Partial<SourceFields> = {}): SourceFields => ({
      event_id: 'RTD-EVT-00001',
      name: 'Quiz',
      source: 'event_index',
      frequency: 'weekly',
      base_details: 'Teams of six.',
      approved_facts: 'Booking: essential',
      people_roles: 'Trixie — sets up',
      category: 'Quiz',
      visibility: 'public',
      price: '£2',
      capacity: '',
      ...over,
    });

    it('fingerprints facts but never dates', async () => {
      expect(await fingerprint(fields({ event_id: 'RTD-EVT-00002' }))).toBe(await fingerprint(fields()));
      expect(await fingerprint(fields({ approved_facts: 'Booking: walk in' }))).not.toBe(await fingerprint(fields()));
      expect(await fingerprint(fields())).toMatch(/^[0-9a-f]{64}$/);

      const row = {
        event_id: 'RTD-EVT-00001',
        display_name: 'Quiz',
        source: 'event_index',
        frequency: 'weekly',
        description: 'Teams of six.',
        category: 'Quiz',
        visibility: 'public',
        price_display: '£2',
        default_capacity: 8,
        event_date: '2026-10-15',
        start_time: '19:30',
        next_date: '2026-10-22',
        social_values: JSON.stringify({ approved_facts: 'Booking: essential', people_roles: 'Trixie — sets up', banned_phrases: 'open table' }),
      };
      const keys = Object.keys(sourceFields(row));
      expect(keys.filter(k => /date|time|when|day/i.test(k))).toEqual([]);
      expect(keys.sort()).toEqual(Object.keys(fields()).sort());
      expect(sourceFields(row)).toEqual(fields({ capacity: '8' }));
    });

    it('does not depend on the order the fields were built in', async () => {
      const shuffled = Object.fromEntries(Object.entries(fields()).reverse()) as unknown as SourceFields;
      expect(await fingerprint(shuffled)).toBe(await fingerprint(fields()));
    });

    it('reads blanks from an events row that has no social values yet', () => {
      const bare = sourceFields({
        event_id: 'RTD-EVT-00009',
        display_name: 'Arkham',
        source: 'standard_diary',
        frequency: 'weekly',
        description: null,
        category: null,
        visibility: 'hidden',
        price_display: null,
        default_capacity: null,
        social_values: null,
      });
      expect(bare).toEqual({
        event_id: 'RTD-EVT-00009',
        name: 'Arkham',
        source: 'standard_diary',
        frequency: 'weekly',
        base_details: '',
        approved_facts: '',
        people_roles: '',
        category: '',
        visibility: 'hidden',
        price: '',
        capacity: '',
      });
    });
  });
});
