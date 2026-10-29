// How the organiser words an example post (web/src/lib/socialExample.ts).
import { describe, expect, it } from 'vitest';
import { exampleView, fixAllMessage, fixExampleMessage, isHeldExample, type SocialExample } from '../web/src/lib/socialExample';

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

describe('Fix and Fix all on the organiser', () => {
  it('words the combined count plainly', () => {
    expect(fixAllMessage({ prompts: 0, rechecked: 2, rewriting: 1 })).toBe('Re-checked 2 examples: they pass now. Writing 1 new example.');
    expect(fixAllMessage({ prompts: 1, rechecked: 1, rewriting: 0 })).toBe('Fixing 1 prompt: it’ll be back within a couple of minutes. Re-checked 1 example: it passes now.');
    expect(fixAllMessage({ prompts: 3, rechecked: 0, rewriting: 2 })).toBe('Fixing 3 prompts: they’ll be back within a couple of minutes. Writing 2 new examples.');
    expect(fixAllMessage({ prompts: 0, rechecked: 0, rewriting: 0 })).toBe('Nothing to fix just now.');
  });

  it('words one card', () => {
    expect(fixExampleMessage('Bingo', 'passes')).toBe('Bingo: re-checked, the example passes now.');
    expect(fixExampleMessage('Bingo', 'rewriting')).toBe('Bingo: writing a new example post, usually within a couple of minutes.');
  });

  it('knows a held example', () => {
    expect(isHeldExample({ ...base, state: 'ready', post: 'Hi', passed: false })).toBe(true);
    expect(isHeldExample({ ...base, state: 'ready', post: 'Hi', passed: true })).toBe(false);
    expect(isHeldExample(base)).toBe(false);
  });
});
