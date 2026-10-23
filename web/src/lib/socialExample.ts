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
