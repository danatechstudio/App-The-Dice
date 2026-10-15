// Roll Me a Game (docs/GAME_LIBRARY_AUDIT.md). The server picks from the
// games that fit the filters, with the same rules it uses to count them; the
// dice only reveal the pick. Filters are remembered; games rolled this visit
// are avoided while others remain.

import { ChevronDown, Dices, Info, Minus, Plus, Sparkles } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DiceTray, type DiceTrayHandle } from '../components/Dice';
import { GameCover, GameFacts } from '../components/GameCard';
import { DiceLoader, ErrorState } from '../components/States';
import { useApi } from '../lib/api';
import {
  activeFilters,
  AGES,
  FILTER_NAMES,
  filterQuery,
  gameName,
  NO_FILTERS,
  recentRolls,
  rememberRoll,
  saveFilters,
  savedFilters,
  TIME_LIMITS,
  type Filters,
  type Game,
  type Shelf,
} from '../lib/games';
import { cue } from '../lib/sound';
import { count } from '../lib/stats';
import { useTitle } from '../lib/title';

type Pool = { count: number; total: number; relax: Partial<Record<keyof Filters, number>> };
type Rolled = { game: Game | null } & Pool;

const plural = (n: number) => `${n} ${n === 1 ? 'game' : 'games'}`;

/** "Loosen the time limit (4 games) or the category (2 games)." */
function relaxText(relax: Pool['relax']): string {
  const options = (Object.entries(relax) as [keyof Filters, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!options.length) return 'No game fits all of that. Try clearing some filters.';
  return `No game fits all of that. Loosen ${options.map(([k, n]) => `${FILTER_NAMES[k]} (${plural(n)})`).join(' or ')}.`;
}

export function Roll() {
  useTitle('Roll Me a Game');
  const shelf = useApi<Shelf>('/api/games');
  const tray = useRef<DiceTrayHandle>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const [filters, setFilters] = useState<Filters>(savedFilters);
  const [pool, setPool] = useState<Pool | null>(null);
  const [rolling, setRolling] = useState(false);
  const [result, setResult] = useState<{ game: Game; quick: boolean; n: number } | null>(null);
  const [nothing, setNothing] = useState<Pool | null>(null);

  // How many games fit: counted by the server with the rules it rolls with.
  useEffect(() => {
    saveFilters(filters);
    let live = true;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/games/pool?${filterQuery(filters)}`, { headers: { Accept: 'application/json' } }).catch(() => null);
      if (live && res?.ok) setPool((await res.json()) as Pool);
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [filters]);

  async function roll(quick: boolean) {
    if (rolling) return;
    count('roll_use');
    setRolling(true);
    setResult(null);
    setNothing(null);
    // The pick is made first; the dice only reveal it.
    const picked = fetch('/api/games/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...filters, quick, recent: recentRolls() }),
    })
      .then(r => (r.ok ? (r.json() as Promise<Rolled>) : null))
      .catch(() => null);
    const [res] = await Promise.all([picked, tray.current?.roll()]);
    setRolling(false);
    if (!res) return setNothing({ count: 0, total: pool?.total ?? 0, relax: {} });
    if (!res.game) return setNothing(res);
    rememberRoll(res.game.id);
    setResult(r => ({ game: res.game!, quick, n: (r?.n ?? 0) + 1 }));
    cue('reveal');
    requestAnimationFrame(() => {
      resultRef.current?.focus({ preventScroll: true });
      resultRef.current?.closest('article')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters(f => ({ ...f, [key]: value }));
  const toggle = (key: 'audiences' | 'categories', v: string) =>
    setFilters(f => ({ ...f, [key]: f[key].includes(v) ? f[key].filter(x => x !== v) : [...f[key], v] }));
  const active = activeFilters(filters);

  if (shelf.loading && !shelf.data) return <DiceLoader label="Fetching the games..." />;
  if (!shelf.data) return <ErrorState error={shelf.error} onRetry={shelf.reload} />;
  const { live, categories, audiences } = shelf.data;
  const total = pool?.total ?? shelf.data.games.length;
  const empty = total === 0;

  return (
    <div class="roll-page tone-navy">
      <div class="container">
        <div class="roll-stage" data-rolling={rolling}>
          <div>
            <p class="label">Can't decide?</p>
            <h1 class="hero">Roll the Dice</h1>
          </div>

          <DiceTray ref={tray} label={rolling ? 'The dice are rolling' : 'Two dice in a dice tray'} />

          {empty ? (
            <p class="roll-empty" role="status">
              The games aren't on the shelf yet. Check back soon.
            </p>
          ) : (
            <div class="roll-actions">
              <button type="button" class="btn btn--roll btn--lg btn--block" onClick={() => roll(false)} disabled={rolling}>
                <Dices class="wiggle" size={24} aria-hidden="true" /> {result ? 'Roll Again' : 'Roll Me a Game'}
              </button>
              <button type="button" class="btn btn--chaos roll-calm" onClick={() => roll(true)} disabled={rolling}>
                <Sparkles class="wiggle" size={20} aria-hidden="true" /> Chaos Roll
              </button>
            </div>
          )}

          {nothing && (
            <p class="roll-empty" role="status">
              {relaxText(nothing.relax)}
            </p>
          )}

          {result && (
            <Reveal key={result.n} game={result.game} quick={result.quick} filters={filters} headingRef={resultRef} onAgain={() => roll(result.quick)} />
          )}

          {!empty && (
            <details class="roll-filters roll-calm" open={active > 0}>
              <summary class="btn btn--outline-inverse">
                Narrow it down{active ? ` (${active})` : ''} <ChevronDown size={18} aria-hidden="true" />
              </summary>
              <fieldset>
                <legend class="label">How many are playing?</legend>
                <div class="cluster">
                  <button type="button" class="filter" aria-pressed={filters.players === null} onClick={() => set('players', null)}>
                    Any
                  </button>
                  <div class="roll-stepper">
                    <button type="button" class="filter" aria-label="One fewer player" disabled={(filters.players ?? 2) <= 1}
                      onClick={() => set('players', Math.max(1, (filters.players ?? 3) - 1))}>
                      <Minus size={18} aria-hidden="true" />
                    </button>
                    <output class="roll-stepper__value" aria-live="polite" aria-label="Players">
                      {filters.players ?? '–'}
                    </output>
                    <button type="button" class="filter" aria-label="One more player" disabled={(filters.players ?? 0) >= 20}
                      onClick={() => set('players', Math.min(20, (filters.players ?? 1) + 1))}>
                      <Plus size={18} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </fieldset>
              <fieldset>
                <legend class="label">Youngest player</legend>
                <div class="cluster">
                  <button type="button" class="filter" aria-pressed={filters.youngest === null} onClick={() => set('youngest', null)}>
                    Any age
                  </button>
                  {AGES.map(a => (
                    <button key={a} type="button" class="filter" aria-pressed={filters.youngest === a} onClick={() => set('youngest', a)}>
                      {a === 18 ? 'Adults' : `${a}`}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend class="label">Time you've got</legend>
                <div class="cluster">
                  <button type="button" class="filter" aria-pressed={filters.max_minutes === null} onClick={() => set('max_minutes', null)}>
                    Any
                  </button>
                  {TIME_LIMITS.map(t => (
                    <button key={t} type="button" class="filter" aria-pressed={filters.max_minutes === t} onClick={() => set('max_minutes', t)}>
                      {t < 60 ? `${t} min` : t === 60 ? '1 hr' : t === 90 ? '1½ hr' : '2 hr'}
                    </button>
                  ))}
                </div>
              </fieldset>
              {audiences.length > 0 && (
                <fieldset>
                  <legend class="label">Who's it for? (any)</legend>
                  <div class="cluster">
                    {audiences.map(a => (
                      <button key={a} type="button" class="filter" aria-pressed={filters.audiences.includes(a)} onClick={() => toggle('audiences', a)}>
                        {a}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              {categories.length > 0 && (
                <fieldset>
                  <legend class="label">Category (any)</legend>
                  <div class="cluster">
                    {categories.map(c => (
                      <button key={c} type="button" class="filter" aria-pressed={filters.categories.includes(c)} onClick={() => toggle('categories', c)}>
                        {c}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              <p class="meta roll-count" aria-live="polite">
                {pool ? `${plural(pool.count)} in the running, out of ${total}.` : 'Counting...'}
                {active > 0 && (
                  <button type="button" class="btn btn--text btn--sm roll-clear" onClick={() => setFilters(NO_FILTERS)}>
                    Clear filters
                  </button>
                )}
              </p>
              <p class="meta roll-count">Chaos Roll ignores the filters. A game with no age or play time on record only comes up when those filters are off.</p>
            </details>
          )}

          {!live && (
            <p class="preview-note">
              <Info size={16} aria-hidden="true" />
              Preview: rolling from a sample shelf until the café's own games are added.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Reveal({ game, quick, filters, headingRef, onAgain }: {
  game: Game;
  quick: boolean;
  filters: Filters;
  headingRef: { current: HTMLHeadingElement | null };
  onAgain: () => void;
}) {
  const query = quick ? '' : filterQuery(filters);
  const href = `/games/${game.slug}${query ? `?${query}` : ''}`;
  return (
    <article class={`card card--feature reveal${quick ? ' reveal--chaos' : ''}`} aria-live="polite">
      <p class="reveal__band">
        <Dices size={18} aria-hidden="true" /> {quick ? 'Chaos has chosen' : 'The dice have spoken'} <Dices size={18} aria-hidden="true" />
      </p>
      <GameCover game={game} eager />
      <div class="reveal__body">
        <h2 class="hero" ref={headingRef} tabIndex={-1}>
          {gameName(game)}
        </h2>
        <GameFacts game={game} category />
        <div class="reveal__blurb">
          <p>{game.synopsis}</p>
        </div>
        <div class="reveal__buttons">
          <a class="btn btn--primary" href={href} onClick={() => count('roll_pick')}>
            View details
          </a>
          <button type="button" class="btn btn--secondary" onClick={onAgain}>
            Roll Again
          </button>
          <a class="btn btn--text reveal__similar" href={`${href}#similar`}>
            Try similar
          </a>
        </div>
      </div>
    </article>
  );
}
