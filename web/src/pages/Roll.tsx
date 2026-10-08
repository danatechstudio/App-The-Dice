import { ChevronDown, Dices, Info, Sparkles } from 'lucide-preact';
import { useRef, useState } from 'preact/hooks';
import { DiceTray, type DiceTrayHandle } from '../components/Dice';
import { GameArt, GameFacts } from '../components/GameCard';
import { PLAYER_OPTIONS, PREVIEW_GAMES, STYLE_OPTIONS, TIME_OPTIONS, type Game, type Style } from '../data/preview-games';
import { cue } from '../lib/sound';
import { count } from '../lib/stats';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/title';

type Filters = { players: string | null; time: string | null; style: Style | null };

function eligible(f: Filters): Game[] {
  const players = PLAYER_OPTIONS.find(p => p.id === f.players);
  const time = TIME_OPTIONS.find(t => t.id === f.time);
  return PREVIEW_GAMES.filter(g => (!players || players.test(g)) && (!time || time.test(g)) && (!f.style || g.styles.includes(f.style)));
}

export function Roll() {
  useTitle('Roll Me a Game');
  const tray = useRef<DiceTrayHandle>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const [filters, setFilters] = useState<Filters>({ players: null, time: null, style: null });
  const [rolling, setRolling] = useState(false);
  const [result, setResult] = useState<{ game: Game; chaos: boolean; n: number } | null>(null);
  const [nothing, setNothing] = useState(false);
  const pool = eligible(filters);

  async function roll(chaos: boolean) {
    if (rolling) return;
    count('roll_use');
    const from = chaos ? PREVIEW_GAMES : pool;
    if (!from.length) {
      setNothing(true);
      return;
    }
    setNothing(false);
    // The pick is made from the data first; the dice only reveal it.
    const choices = from.length > 1 ? from.filter(g => g.id !== result?.game.id) : from;
    const game = choices[Math.floor(Math.random() * choices.length)]!;
    setRolling(true);
    setResult(null);
    await tray.current?.roll();
    setRolling(false);
    setResult(r => ({ game, chaos, n: (r?.n ?? 0) + 1 }));
    cue('reveal');
    requestAnimationFrame(() => {
      resultRef.current?.focus({ preventScroll: true });
      resultRef.current?.closest('article')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters(f => ({ ...f, [key]: f[key] === value ? null : value }));
  const active = Object.values(filters).filter(Boolean).length;

  return (
    <div class="roll-page tone-navy">
      <div class="container">
        <div class="roll-stage" data-rolling={rolling}>
          <div>
            <p class="label">Can't decide?</p>
            <h1 class="hero">Roll the Dice</h1>
          </div>

          <DiceTray ref={tray} label={rolling ? 'The dice are rolling' : 'Two dice in a dice tray'} />

          <div class="roll-actions">
            <button type="button" class="btn btn--roll btn--lg btn--block" onClick={() => roll(false)} disabled={rolling}>
              <Dices class="wiggle" size={24} aria-hidden="true" /> {result ? 'Roll Again' : 'Roll Me a Game'}
            </button>
            <button type="button" class="btn btn--chaos roll-calm" onClick={() => roll(true)} disabled={rolling}>
              <Sparkles class="wiggle" size={20} aria-hidden="true" /> Chaos Roll
            </button>
          </div>

          {nothing && (
            <p class="roll-empty" role="status">
              No game ticks every box. Loosen a filter, or let Chaos Roll decide.
            </p>
          )}

          {result && <Reveal key={result.n} game={result.game} chaos={result.chaos} headingRef={resultRef} onAgain={() => roll(result.chaos)} />}

          <details class="roll-filters roll-calm">
            <summary class="btn btn--outline-inverse">
              Narrow it down{active ? ` (${active})` : ''} <ChevronDown size={18} aria-hidden="true" />
            </summary>
            <fieldset>
              <legend class="label">Players</legend>
              <div class="cluster">
                {PLAYER_OPTIONS.map(p => (
                  <button key={p.id} type="button" class="filter" aria-pressed={filters.players === p.id} onClick={() => set('players', p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend class="label">Time you've got</legend>
              <div class="cluster">
                {TIME_OPTIONS.map(t => (
                  <button key={t.id} type="button" class="filter" aria-pressed={filters.time === t.id} onClick={() => set('time', t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend class="label">Style</legend>
              <div class="cluster">
                {STYLE_OPTIONS.map(s => (
                  <button key={s} type="button" class="filter" aria-pressed={filters.style === s} onClick={() => set('style', s)}>
                    {s}
                  </button>
                ))}
              </div>
            </fieldset>
            <p class="meta" style={{ color: 'inherit', marginTop: '12px' }}>
              {pool.length} {pool.length === 1 ? 'game' : 'games'} in the running. Chaos Roll ignores all of this.
            </p>
          </details>

          <p class="preview-note">
            <Info size={16} aria-hidden="true" />
            Preview: rolling from a sample shelf until the café's own games are added.
          </p>
        </div>
      </div>
    </div>
  );
}

function Reveal({ game, chaos, headingRef, onAgain }: { game: Game; chaos: boolean; headingRef: { current: HTMLHeadingElement | null }; onAgain: () => void }) {
  return (
    <article class={`card card--feature reveal${chaos ? ' reveal--chaos' : ''}`} aria-live="polite">
      <p class="reveal__band">
        <Dices size={18} aria-hidden="true" /> {chaos ? 'Chaos has chosen' : 'The dice have spoken'} <Dices size={18} aria-hidden="true" />
      </p>
      <GameArt />
      <div class="reveal__body">
        <h2 class="hero" ref={headingRef} tabIndex={-1}>
          {game.name}
        </h2>
        <GameFacts game={game} />
        <div class="reveal__blurb">
          {game.blurb.map(line => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div class="reveal__buttons">
          <button type="button" class="btn btn--primary" onClick={() => (count('roll_pick'), toast(`Great pick. Grab ${game.name} from the shelf, or ask the team.`))}>
            This One!
          </button>
          <button type="button" class="btn btn--secondary" onClick={onAgain}>
            Roll Again
          </button>
        </div>
      </div>
    </article>
  );
}
