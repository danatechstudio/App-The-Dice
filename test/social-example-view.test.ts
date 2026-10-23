// How the organiser words an example post (web/src/lib/socialExample.ts).
import { describe, expect, it } from 'vitest';
import { exampleView, type SocialExample } from '../web/src/lib/socialExample';

const base: SocialExample = { state: 'waiting', post: null, passed: null, problems: [], model: null, generated_at: null, attempts: 0, error: null };

describe('an example post on the organiser', () => {
  it('is on its way until n8n writes one', () => {
    expect(exampleView(base)).toEqual({ kind: 'waiting', line: 'Example on its way' });
    expect(exampleView({ ...base, attempts: 2, error: 'quota' })).toEqual({ kind: 'waiting', line: 'Example on its way' });
  });

  it("says when n8n couldn't write one, and why", () => {
    expect(exampleView({ ...base, state: 'failed', attempts: 3, error: 'Gemini quota' })).toEqual({ kind: 'failed', line: "No example (n8n couldn't write one): Gemini quota" });
    expect(exampleView({ ...base, state: 'failed', attempts: 3 })).toEqual({ kind: 'failed', line: "No example (n8n couldn't write one)" });
  });

  it('would pass, or would be held with its reasons', () => {
    expect(exampleView({ ...base, state: 'ready', post: 'Hi', passed: true })).toEqual({ kind: 'pass', line: 'Would pass' });
    expect(exampleView({ ...base, state: 'ready', post: 'Hi', passed: false, problems: ['Quiz: "Saturday" is not its day', 'Says drop in'] })).toEqual({
      kind: 'held',
      line: 'Would be held: Quiz: "Saturday" is not its day; Says drop in',
    });
    expect(exampleView({ ...base, state: 'ready', post: 'Hi', passed: false })).toEqual({ kind: 'held', line: 'Would be held' });
  });
});
