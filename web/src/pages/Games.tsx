// The Games page: Game of the Week and the shelf (docs/GAME_LIBRARY_AUDIT.md).
// The shelf lists covers as small thumbnails, loaded lazily.

import { Dices, Info, Search, Star } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { GameCover, GameFacts } from '../components/GameCard';
import { DiceLoader, EmptyState, ErrorState } from '../components/States';
import { useApi } from '../lib/api';
import { gameName, playersLabel, timeLabel, type Gotw, type Shelf } from '../lib/games';
import { useCount } from '../lib/stats';
import { useTitle } from '../lib/title';

export function Games() {
  useTitle('Games');
  useCount('gotw_view');
  const shelf = useApi<Shelf>('/api/games');
  const gotw = useApi<{ gotw: Gotw | null }>('/api/games/gotw');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  if (shelf.loading && !shelf.data) return <DiceLoader label="Fetching the shelf..." />;
  if (!shelf.data) return <ErrorState error={shelf.error} onRetry={shelf.reload} />;
  const { live, games } = shelf.data;
  const categories = [...new Set(games.map(g => g.category))].sort((a, b) => a.localeCompare(b));
  const needle = q.trim().toLowerCase();
  const shown = games.filter(g => (!category || g.category === category) && (!needle || gameName(g).toLowerCase().includes(needle)));

  return (
    <div class="container">
      <header class="page-head">
        <p class="label">The shelf</p>
        <h1>Games</h1>
      </header>

      {gotw.data?.gotw && <GameOfTheWeek gotw={gotw.data.gotw} />}

      <section class="section" aria-labelledby="shelf">
        <div class="section-head">
          <h2 id="shelf">On the shelf {games.length > 0 && <span class="count-badge">{games.length}</span>}</h2>
        </div>
        {games.length === 0 ? (
          <EmptyState title="The games are on their way." text="The café's shelf is being added. Check back soon." />
        ) : (
          <>
            <div class="shelf-tools">
              <label class="shelf-search">
                <Search size={18} aria-hidden="true" />
                <span class="visually-hidden">Search the games</span>
                <input class="input" type="search" placeholder="Search the games" value={q} onInput={e => setQ(e.currentTarget.value)} />
              </label>
              {categories.length > 1 && (
                <div class="filters-scroll" role="group" aria-label="Category">
                  <button type="button" class="filter" aria-pressed={category === null} onClick={() => setCategory(null)}>
                    All
                  </button>
                  {categories.map(c => (
                    <button key={c} type="button" class="filter" aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {shown.length === 0 && <p class="meta">No games match that. Try another search.</p>}
            <ul class="shelf" role="list">
              {shown.map(g => (
                <li key={g.id}>
                  <a class="card shelf-card" href={`/games/${g.slug}`}>
                    <span class="shelf-card__tile">
                      <GameCover game={g} size="thumb" />
                    </span>
                    <span class="shelf-card__text">
                      <span class="shelf-card__title">{gameName(g)}</span>
                      <span class="meta">{[g.category, playersLabel(g), timeLabel(g)].filter(Boolean).join(' · ')}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
        {!live && (
          <p class="preview-note" style={{ marginTop: '16px' }}>
            <Info size={16} aria-hidden="true" />
            Preview: these are sample games. The café's own shelf, and a weekly pick from it, are coming soon.
          </p>
        )}
      </section>
    </div>
  );
}

function GameOfTheWeek({ gotw }: { gotw: Gotw }) {
  const g = gotw.game;
  return (
    <article class="card card--feature gotw" aria-labelledby="gotw-title">
      <p class="gotw__band label stars">
        <Star size={16} aria-hidden="true" /> Game of the Week <Star size={16} aria-hidden="true" />
      </p>
      <div class="gotw__layout">
        {g ? <GameCover game={g} eager /> : <GameCover game={{ cover: gotw.snapshot.cover, thumb: null, cover_alt: `Box cover of ${gotw.snapshot.title}` }} />}
        <div class="gotw__body">
          {gotw.preview && (
            <div class="cluster">
              <Chip kind="preview">Preview</Chip>
            </div>
          )}
          <h2 id="gotw-title" class="hero">
            {g ? gameName(g) : gotw.snapshot.title}
          </h2>
          {g ? (
            <>
              <GameFacts game={g} category />
              <p>{g.synopsis}</p>
              <div class="cluster">
                <a class="btn btn--primary" href={`/games/${g.slug}`}>
                  View game
                </a>
                <a class="btn btn--roll" href="/roll">
                  <Dices class="wiggle" size={20} aria-hidden="true" /> Roll for something else
                </a>
              </div>
            </>
          ) : (
            <p class="meta">This game has left the shelf.</p>
          )}
        </div>
      </div>
    </article>
  );
}
