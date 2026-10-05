import { forwardRef } from 'preact/compat';
import { useImperativeHandle, useRef } from 'preact/hooks';
import { duration } from '../lib/motion';
import { cue } from '../lib/sound';

// Pip positions on a 3×3 grid (row, column), standard die layout.
const PIPS: Record<number, [number, number][]> = {
  1: [[2, 2]],
  2: [[1, 3], [3, 1]],
  3: [[1, 3], [2, 2], [3, 1]],
  4: [[1, 1], [1, 3], [3, 1], [3, 3]],
  5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
  6: [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]],
};

// Cube rotation (x, y degrees) that brings each face to the front.
const FACE_TURN: Record<number, [number, number]> = { 1: [0, 0], 6: [0, 180], 3: [0, -90], 4: [0, 90], 2: [-90, 0], 5: [90, 0] };
const TILT = 'rotateX(-20deg) rotateY(24deg)'; // resting 3D view

const turn = (face: number, extraX = 0, extraY = 0) => {
  const [x, y] = FACE_TURN[face]!;
  return `${TILT} rotateX(${x + extraX}deg) rotateY(${y + extraY}deg)`;
};

function Die({ face, dieRef, slotRef, shadowRef }: {
  face: number;
  dieRef: { current: HTMLDivElement | null };
  slotRef: { current: HTMLDivElement | null };
  shadowRef: { current: HTMLDivElement | null };
}) {
  return (
    <div class="die-slot" ref={slotRef}>
      <div class="die-shadow" ref={shadowRef} />
      <div class="die" ref={dieRef} style={{ transform: turn(face) }}>
        {[1, 2, 3, 4, 5, 6].map(n => (
          <div key={n} class="die__face" data-face={n}>
            {PIPS[n]!.map(([r, c]) => (
              <span key={`${r}${c}`} class="pip" style={{ gridArea: `${r} / ${c}` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface DiceTrayHandle {
  /** Tumble both dice; resolves when they settle (at once with reduced motion). */
  roll(): Promise<void>;
}

/** Two dice in a tray. They rest on four and two, like the dice in the logo. */
export const DiceTray = forwardRef<DiceTrayHandle, { label?: string }>(function DiceTray({ label }, ref) {
  const dice = [0, 1].map(() => ({
    die: useRef<HTMLDivElement>(null),
    slot: useRef<HTMLDivElement>(null),
    shadow: useRef<HTMLDivElement>(null),
    face: useRef(0),
  }));
  dice[0]!.face.current ||= 4;
  dice[1]!.face.current ||= 2;

  useImperativeHandle(ref, () => ({
    async roll() {
      const ms = duration('dice');
      const finals = dice.map(() => 1 + Math.floor(Math.random() * 6));
      if (!ms) {
        dice.forEach((d, i) => {
          d.face.current = finals[i]!;
          d.die.current!.style.transform = turn(finals[i]!);
        });
        return;
      }
      cue('roll');
      // Bounces land at 35% and 72% of the roll: sound cues hook in there.
      setTimeout(() => cue('bounce'), ms * 0.35);
      setTimeout(() => cue('bounce'), ms * 0.72);
      const runs = dice.flatMap((d, i) => {
        const from = d.face.current;
        const to = finals[i]!;
        const spinX = 360 * (2 + Math.floor(Math.random() * 2));
        const spinY = 360 * (1 + Math.floor(Math.random() * 2));
        const dir = i === 0 ? 1 : -1;
        const drift = i === 0 ? 0 : 26; // the second die trails a little
        const hop = (x: number, y: number) => ({ transform: `translate(${x * dir}px, ${y}px)` });
        const path = [
          { ...hop(-220, -70), offset: 0 },
          { ...hop(-70 + drift, 6), offset: 0.35 },
          { ...hop(-18 + drift / 2, -30), offset: 0.55 },
          { ...hop(4, 3), offset: 0.72 },
          { ...hop(0, -5), offset: 0.84 },
          { ...hop(0, 0), offset: 1 },
        ];
        const shadow = path.map(k => {
          const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(k.transform)!;
          const lift = Math.min(1, Math.abs(Number(y)) / 80);
          return { offset: k.offset, transform: `translate(${x}px, 0) scale(${1 - lift * 0.5})`, opacity: 1 - lift * 0.6 };
        });
        d.face.current = to;
        d.die.current!.style.transform = turn(to);
        const opts = { duration: ms, easing: 'cubic-bezier(.2,.75,.3,1)' };
        return [
          d.slot.current!.animate(path, { duration: ms, easing: 'ease-out' }),
          d.shadow.current!.animate(shadow, { duration: ms, easing: 'ease-out' }),
          d.die.current!.animate([{ transform: turn(from, -spinX, -spinY) }, { transform: turn(to) }], opts),
        ];
      });
      await Promise.all(runs.map(a => a.finished.catch(() => undefined)));
      cue('settle');
    },
  }));

  return (
    <div class="dice-tray" role="img" aria-label={label ?? 'Two dice in a dice tray'}>
      {dice.map((d, i) => (
        <Die key={i} face={d.face.current} dieRef={d.die} slotRef={d.slot} shadowRef={d.shadow} />
      ))}
    </div>
  );
});
