// A game's facts and cover (docs/GAME_LIBRARY_AUDIT.md). Covers load lazily at
// a fixed shape; without an approved cover (or if one fails to load) a
// template cover shows instead: the game's title on its category's colour
// and icon, in the RTD style.

import { Blocks, Castle, ChessKnight, Clock, Dices, Handshake, PartyPopper, Puzzle, Shapes, Smile, UsersRound, WandSparkles, type LucideIcon } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { ageLabel, playersLabel, timeLabel, type Game } from '../lib/games';

type Look = { colour: string; Icon: LucideIcon };

// Matched on words in the category, so the catalogue's "Party, Trivia & Social"
// and an admin's "Party" look the same. Each colour reads with white text (test/theme.test.ts).
const LOOKS: [RegExp, Look][] = [
  [/child|educat|kid/i, { colour: 'var(--rtd-success)', Icon: Blocks }],
  [/party|trivia|social/i, { colour: 'var(--rtd-game)', Icon: PartyPopper }],
  [/word|dexterity|quick/i, { colour: 'var(--rtd-host)', Icon: Puzzle }],
  [/fantasy|licen[cs]ed|specialist/i, { colour: 'var(--rtd-danger)', Icon: WandSparkles }],
  [/co-?op/i, { colour: 'var(--rtd-primary-dark)', Icon: Handshake }],
  [/strategy|hobby/i, { colour: 'var(--rtd-secondary)', Icon: Castle }],
  [/classic|family/i, { colour: 'var(--rtd-primary)', Icon: Dices }],
];
const PLAIN: Look = { colour: 'var(--rtd-primary)', Icon: ChessKnight };

export const lookFor = (category: string | null | undefined): Look => LOOKS.find(([re]) => re.test(category ?? ''))?.[1] ?? PLAIN;

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

/**
 * The template cover for a game without an approved one: its category's colour
 * and icon as a sticker, with the title (thumbnails show the sticker only).
 * Decorative: the title is always in the page's own text too.
 */
export function GameArt({ game, compact = false }: { game?: { title?: string; category?: string | null }; compact?: boolean }) {
  const { colour, Icon } = lookFor(game?.category);
  return (
    <div class={`art art--fallback art--template${compact ? ' art--compact' : ''}`} style={{ '--art-bg': colour }} aria-hidden="true">
      <div class="art__sticker">
        <Icon strokeWidth={2} />
      </div>
      {!compact && game?.title && <p class="art__title">{game.title}</p>}
    </div>
  );
}

type CoverGame = Pick<Game, 'cover' | 'thumb' | 'cover_alt'> & Partial<Pick<Game, 'title' | 'category'>>;

/** The box cover (or thumbnail), lazy-loaded, falling back to the template cover. */
export function GameCover({ game, size = 'cover', eager = false }: { game: CoverGame; size?: 'cover' | 'thumb'; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = size === 'thumb' ? game.thumb : game.cover;
  if (!src || failed) return <GameArt game={game} compact={size === 'thumb'} />;
  return (
    <div class="art game-cover">
      <img src={src} alt={game.cover_alt} loading={eager ? 'eager' : 'lazy'} decoding="async" width={size === 'thumb' ? 320 : 800} height={size === 'thumb' ? 320 : 800} onError={() => setFailed(true)} />
    </div>
  );
}
