// Sound-ready hooks for the dice (brief §15). Silent for now: give each cue an
// audio file later and play it here, respecting a mute setting.
export type Cue = 'roll' | 'bounce' | 'settle' | 'reveal';

export function cue(_name: Cue): void {
  /* no sounds yet */
}
