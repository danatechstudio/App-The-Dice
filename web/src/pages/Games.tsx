import { ChessKnight, Dices, Info, Star } from 'lucide-preact';
import { Chip } from '../components/Chips';
import { GameArt, GameFacts } from '../components/GameCard';
import { PREVIEW_GAMES, PREVIEW_GAME_OF_THE_WEEK, minutesLabel, playersLabel } from '../data/preview-games';
import { useTitle } from '../lib/title';

export function Games() {
  useTitle('Games');
  const gotw = PREVIEW_GAMES.find(g => g.id === PREVIEW_GAME_OF_THE_WEEK)!;
  return (
    <div class="container">
      <header class="page-head">
        <p class="label">The shelf</p>
        <h1>Games</h1>
      </header>

      <article class="card card--feature gotw" aria-labelledby="gotw-title">
        <p class="gotw__band label stars">
          <Star size={16} aria-hidden="true" /> Game of the Week <Star size={16} aria-hidden="true" />
        </p>
        <div class="gotw__layout">
          <GameArt />
          <div class="gotw__body">
            <div class="cluster">
              <Chip kind="preview">Preview</Chip>
            </div>
            <h2 id="gotw-title" class="hero">
              {gotw.name}
            </h2>
            <p class="meta" style={{ fontSize: '1rem' }}>{gotw.tagline}</p>
            <GameFacts game={gotw} />
            {gotw.whyWePicked && (
              <div class="gotw__why">
                <p class="label">Why we picked it</p>
                <p>{gotw.whyWePicked}</p>
              </div>
            )}
            <a class="btn btn--roll" href="/roll">
              <Dices class="wiggle" size={20} aria-hidden="true" /> Roll for something else
            </a>
          </div>
        </div>
      </article>

      <section class="section" aria-labelledby="shelf">
        <div class="section-head">
          <h2 id="shelf">On the shelf</h2>
        </div>
        <ul class="shelf" role="list">
          {PREVIEW_GAMES.map(g => (
            <li key={g.id} class="card shelf-card">
              <span class="shelf-card__tile" aria-hidden="true">
                <ChessKnight size={30} />
              </span>
              <div>
                <h3>{g.name}</h3>
                <p class="meta">
                  {playersLabel(g)} · {minutesLabel(g)} · {g.complexity}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p class="preview-note" style={{ marginTop: '16px' }}>
          <Info size={16} aria-hidden="true" />
          Preview: these are sample games. The café's own shelf, and a weekly pick from it, are coming soon.
        </p>
      </section>
    </div>
  );
}

