import { ChessKnight, Dices, Lightbulb, PartyPopper, Store, Trophy, UsersRound, Palette, Sparkles, type LucideIcon } from 'lucide-preact';
import type { Category } from './api';

export const CATEGORY: Record<Category, { label: string; icon: LucideIcon }> = {
  Gaming: { label: 'Gaming', icon: Dices },
  Quiz: { label: 'Quiz', icon: Lightbulb },
  Social: { label: 'Social', icon: PartyPopper },
  Club: { label: 'Club', icon: UsersRound },
  Tournament: { label: 'Tournament', icon: Trophy },
  Market: { label: 'Market', icon: Store },
  Workshop: { label: 'Workshop', icon: Palette },
  Other: { label: 'At the café', icon: Sparkles },
};

export const GAME_ICON = ChessKnight;
