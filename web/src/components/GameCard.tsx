import { ChessKnight, Clock, Gauge, UsersRound } from 'lucide-preact';
import { minutesLabel, playersLabel, type Game } from '../data/preview-games';

export function GameFacts({ game }: { game: Game }) {
  return (
    <p class="game-facts">
      <span><UsersRound size={18} aria-hidden="true" />{playersLabel(game)}</span>
      <span><Clock size={18} aria-hidden="true" />{minutesLabel(game)}</span>
      <span><Gauge size={18} aria-hidden="true" />{game.complexity}</span>
    </p>
  );
}

/** Game artwork placeholder until the shelf has box art: the knight from the logo's motifs. */
export function GameArt() {
  return (
    <div class="art art--fallback">
      <div class="art__sticker">
        <ChessKnight strokeWidth={2} aria-hidden="true" />
      </div>
    </div>
  );
}
