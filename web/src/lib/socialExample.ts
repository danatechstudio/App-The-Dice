// How the organiser words a prompt's example post (src/social/examples.ts): a sample Facebook post n8n
// writes the way a live post would be written, checked like one. It is never posted.

/** A prompt version's example post: written by n8n the way a live post would be, and checked like one. Never posted. */
export interface SocialExample {
  /** waiting: none yet; ready: written and checked; failed: n8n tried three times and couldn't write one. */
  state: 'waiting' | 'ready' | 'failed';
  post: string | null;
  passed: boolean | null;
  problems: string[];
  model: string | null;
  generated_at: string | null;
  attempts: number;
  error: string | null;
}

export interface ExampleView {
  kind: 'waiting' | 'failed' | 'pass' | 'held';
  /** "Would pass", "Would be held: …", "Example on its way" or "No example (n8n couldn't write one): …". */
  line: string;
}

export function exampleView(e: SocialExample): ExampleView {
  if (e.state === 'failed') return { kind: 'failed', line: `No example (n8n couldn't write one)${e.error ? `: ${e.error}` : ''}` };
  if (e.state !== 'ready') return { kind: 'waiting', line: 'Example on its way' };
  if (e.passed) return { kind: 'pass', line: 'Would pass' };
  return { kind: 'held', line: `Would be held${e.problems.length ? `: ${e.problems.join('; ')}` : ''}` };
}

/** An example that is written and would be held: the "Posts that would be held" group, which Fix and Fix all cover. */
export const isHeldExample = (e: SocialExample): boolean => e.state === 'ready' && e.passed === false;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Fix all's toast, from what it did: prompts sent back, held examples that pass now, and ones being written again. */
export function fixAllMessage(r: { prompts: number; rechecked: number; rewriting: number }): string {
  const parts: string[] = [];
  if (r.prompts) parts.push(`Fixing ${plural(r.prompts, 'prompt', 'prompts')}: ${r.prompts === 1 ? 'it’ll' : 'they’ll'} be back within a couple of minutes.`);
  if (r.rechecked) parts.push(`Re-checked ${plural(r.rechecked, 'example', 'examples')}: ${r.rechecked === 1 ? 'it passes' : 'they pass'} now.`);
  if (r.rewriting) parts.push(`Writing ${plural(r.rewriting, 'new example', 'new examples')}.`);
  return parts.length ? parts.join(' ') : 'Nothing to fix just now.';
}

/** Fix's toast on a card whose example would be held. */
export const fixExampleMessage = (name: string, example: 'passes' | 'rewriting'): string =>
  example === 'passes' ? `${name}: re-checked, the example passes now.` : `${name}: writing a new example post, usually within a couple of minutes.`;
