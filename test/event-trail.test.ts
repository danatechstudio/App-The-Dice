// Back and Previous / Next on the organiser's event editor (web/src/lib/eventTrail.ts).
import { describe, expect, it } from 'vitest';
import { editorHref, neighbours, originOf, socialOrder, trailFor } from '../web/src/lib/eventTrail';

describe('the event editor trail', () => {
  it('knows which list it came from, defaulting to Events', () => {
    expect(originOf('?from=social')).toBe('social');
    expect(originOf('?from=events')).toBe('events');
    expect(originOf('')).toBe('events');
    expect(originOf('?from=nonsense')).toBe('events');
  });

  it('keeps the origin in the editor address, opening on the prompt from Social posts', () => {
    expect(editorHref('RTD-EVT-1', 'events')).toBe('/organise/events/RTD-EVT-1?from=events');
    expect(editorHref('RTD-EVT-1', 'social')).toBe('/organise/events/RTD-EVT-1?from=social#social-prompt');
  });

  it('finds the previous and next event, with none at either end', () => {
    const ids = ['a', 'b', 'c'];
    expect(neighbours(ids, 'a')).toEqual({ prev: null, next: 'b' });
    expect(neighbours(ids, 'b')).toEqual({ prev: 'a', next: 'c' });
    expect(neighbours(ids, 'c')).toEqual({ prev: 'b', next: null });
    expect(neighbours(ids, 'z')).toEqual({ prev: null, next: null });
    expect(neighbours(['a'], 'a')).toEqual({ prev: null, next: null });
  });

  it('uses the stored list only when it is the one this editor came from', () => {
    const stored = { from: 'social' as const, ids: ['a', 'b'] };
    expect(trailFor(stored, 'social', 'a')).toEqual(['a', 'b']);
    expect(trailFor(stored, 'events', 'a')).toBeNull();
    expect(trailFor(stored, 'social', 'z')).toBeNull();
    expect(trailFor(null, 'events', 'a')).toBeNull();
  });

  it('steps through Social posts in review order, then approved when opened from that group', () => {
    expect(socialOrder(['r1', 'r2'], ['a1', 'r2'], false)).toEqual(['r1', 'r2']);
    expect(socialOrder(['r1', 'r2'], ['a1', 'r2'], true)).toEqual(['r1', 'r2', 'a1']);
  });
});
