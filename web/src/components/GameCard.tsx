// A game's facts and cover (docs/GAME_LIBRARY_AUDIT.md). Covers load lazily at
// a fixed shape; without an approved cover (or if one fails to load) the RTD
// placeholder shows instead.

import { ChessKnight, Clock, Shapes, Smile, UsersRound } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { ageLabel, playersLabel, timeLabel, type Game } from '../lib/games';

export function GameFacts({ game, category = false }: { game: Game; category?: boolean }) {
  const players = playersLabel(game);
  const time = timeLabel(game);
  const age = ageLabel(game);
  return (
    <p class="game-facts">
      {category && (
        <span>
          <Shapes size={18} aria-hidden="true" />
          {game.category}
        </span>
      )}
      {players && (
        <span>
          <UsersRound size={18} aria-hidden="true" />
          {players}
        </span>
      )}
      {time && (
        <span>
          <Clock size={18} aria-hidden="true" />
          {time}
        </span>
      )}
      {age && (
        <span>
          <Smile size={18} aria-hidden="true" />
          {age}
        </span>
      )}
    </p>
  );
}

/** The knight from the logo's motifs: the placeholder for any game without an approved cover. */
export function GameArt() {
  return (
    <div class="art art--fallback">
      <div class="art__sticker">
        <ChessKnight strokeWidth={2} aria-hidden="true" />
      </div>
    </div>
  );
}

/** The box cover (or thumbnail), lazy-loaded, falling back to the placeholder. */
export function GameCover({ game, size = 'cover', eager = false }: { game: Pick<Game, 'cover' | 'thumb' | 'cover_alt'>; size?: 'cover' | 'thumb'; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = size === 'thumb' ? game.thumb : game.cover;
  if (!src || failed) return <GameArt />;
  return (
    <div class="art game-cover">
      <img src={src} alt={game.cover_alt} loading={eager ? 'eager' : 'lazy'} decoding="async" width={size === 'thumb' ? 320 : 800} height={size === 'thumb' ? 320 : 800} onError={() => setFailed(true)} />
    </div>
  );
}
