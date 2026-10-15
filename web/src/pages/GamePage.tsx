// /games/:slug: one game, with similar games and, after a filtered roll,
// alternatives that still fit the filters (docs/GAME_LIBRARY_AUDIT.md). Only
// games on the café's shelf are ever suggested.

import { ChevronLeft, Dices, Info } from 'lucide-preact';
import { useEffect } from 'preact/hooks';
import { Chip } from '../components/Chips';
import { GameCover, GameFacts } from '../components/GameCard';
import { DiceLoader, EmptyState, ErrorState } from '../components/States';
import { useApi } from '../lib/api';
import { gameName, playersLabel, timeLabel, type Game } from '../lib/games';
import { back } from '../lib/router';
import { useTitle } from '../lib/title';

type Page = { game: Game; similar: { game: Game; label: string }[]; alternatives: Game[] };

export function GamePage({ slug }: { slug: string }) {
  const query = location.search.replace(/^\?/, '');
  const res = useApi<Page>(`/api/games/${encodeURIComponent(slug)}${query ? `?${query}` : ''}`);
  const page = res.data;
  useTitle(page ? gameName(page.game) : null);
  // "Try similar" lands on the similar games.
  useEffect(() => {
    if (page && location.hash === '#similar') requestAnimationFrame(() => document.getElementById('similar')?.scrollIntoView({ block: 'start' }));
  }, [page]);

  if (res.loading && !page) return <DiceLoader label="Finding that game..." />;
  if (res.error?.status === 404) {
    return (
      <div class="container">
        <EmptyState title="That game isn't on our shelf." text="It may have left the café, or the link is out of date.">
          <a class="btn btn--primary" href="/games">See the shelf</a>
        </EmptyState>
      </div>
    );
  }
  if (!page) return <ErrorState error={res.error} onRetry={res.reload} />;
  const g = page.game;

  return (
    <div class="container">
      <a class="back-link" href="/games" onClick={e => (e.preventDefault(), back('/games'))}>
        <ChevronLeft size={20} aria-hidden="true" /> Back
      </a>
      <article class="game-page">
        <div class="game-page__art">
          <GameCover game={g} eager />
          {g.attribution && <p class="meta game-page__credit">Cover: {g.attribution}</p>}
        </div>
        <div class="game-page__body stack" style={{ '--gap': '14px' }}>
          <div class="cluster">
            <Chip kind="category">{g.category}</Chip>
            {g.audiences.map(a => (
              <Chip key={a} kind="free">
                {a}
              </Chip>
            ))}
            {g.preview && <Chip kind="preview">Preview</Chip>}
          </div>
          <h1>{gameName(g)}</h1>
          <GameFacts game={g} />
          <p class="reading game-page__synopsis">{g.synopsis}</p>
          <div>
            <a class="btn btn--roll" href="/roll">
              <Dices class="wiggle" size={20} aria-hidden="true" /> Roll Again
            </a>
          </div>
          {g.preview && (
            <p class="preview-note">
              <Info size={16} aria-hidden="true" />
              Preview: a sample game until the café's own shelf is added.
            </p>
          )}
        </div>
      </article>

      <section class="section" id="similar" aria-labelledby="similar-title">
        <div class="section-head">
          <h2 id="similar-title">Similar games</h2>
        </div>
        {page.similar.length ? (
          <ul class="game-tiles" role="list">
            {page.similar.map(s => (
              <li key={s.game.id}>
                <GameTile game={s.game} note={s.label} />
              </li>
            ))}
          </ul>
        ) : (
          <p class="meta">Nothing else on the shelf is much like this one. Roll for something different.</p>
        )}
      </section>

      {page.alternatives.length > 0 && (
        <section class="section" aria-labelledby="alternatives-title">
          <div class="section-head">
            <h2 id="alternatives-title">Also fits your filters</h2>
          </div>
          <ul class="game-tiles" role="list">
            {page.alternatives.map(a => (
              <li key={a.id}>
                <GameTile game={a} note={[playersLabel(a), timeLabel(a)].filter(Boolean).join(' · ')} keepFilters={query} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GameTile({ game, note, keepFilters }: { game: Game; note: string; keepFilters?: string }) {
  return (
    <a class="card game-tile" href={`/games/${game.slug}${keepFilters ? `?${keepFilters}` : ''}`}>
      <GameCover game={game} size="thumb" />
      <span class="game-tile__body">
        <strong>{gameName(game)}</strong>
        <span class="meta">{note}</span>
      </span>
    </a>
  );
}
