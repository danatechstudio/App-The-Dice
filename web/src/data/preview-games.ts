// PREVIEW SHELF. The café's own game inventory arrives in Phase 4 (a games
// table in D1, chosen server-side). Until then the Roll and Games screens use
// these well-known titles, and say so on screen. Delete this file in Phase 4.

export type Style = 'Strategy' | 'Party' | 'Co-operative' | 'Competitive';

export interface Game {
  id: string;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  minutes: number;
  complexity: 'Easy' | 'Medium' | 'Hard';
  styles: Style[];
  tagline: string;
  blurb: string[];
  whyWePicked?: string;
}

export const PREVIEW_GAMES: Game[] = [
  {
    id: 'king-of-tokyo', name: 'King of Tokyo', minPlayers: 2, maxPlayers: 6, minutes: 30, complexity: 'Easy',
    styles: ['Party', 'Competitive'], tagline: 'Dice-rolling monster brawl',
    blurb: ['Monster battles.', 'City destruction.', 'Extremely questionable decisions.'],
  },
  {
    id: 'carcassonne', name: 'Carcassonne', minPlayers: 2, maxPlayers: 5, minutes: 35, complexity: 'Easy',
    styles: ['Strategy', 'Competitive'], tagline: 'Tile-laying strategy',
    blurb: ['Build a medieval landscape one tile at a time.', 'Claim roads, cities and fields before anyone else does.'],
    whyWePicked: 'Perfect if you want something calm to learn that still gets competitive by the last tile.',
  },
  {
    id: 'ticket-to-ride', name: 'Ticket to Ride', minPlayers: 2, maxPlayers: 5, minutes: 60, complexity: 'Easy',
    styles: ['Strategy'], tagline: 'Railway route-building',
    blurb: ['Collect cards, claim routes, connect cities.', 'Someone will block your line. It might be on purpose.'],
  },
  {
    id: 'pandemic', name: 'Pandemic', minPlayers: 2, maxPlayers: 4, minutes: 45, complexity: 'Medium',
    styles: ['Co-operative', 'Strategy'], tagline: 'Save the world together',
    blurb: ['Four diseases. One team.', 'Win together or lose together.'],
  },
  {
    id: 'codenames', name: 'Codenames', minPlayers: 4, maxPlayers: 8, minutes: 15, complexity: 'Easy',
    styles: ['Party'], tagline: 'One-word clue party game',
    blurb: ['Give one-word clues to find your agents.', 'Avoid the assassin. Avoid overthinking.'],
  },
  {
    id: 'dixit', name: 'Dixit', minPlayers: 3, maxPlayers: 8, minutes: 30, complexity: 'Easy',
    styles: ['Party'], tagline: 'Dreamlike storytelling',
    blurb: ['Beautiful cards, cryptic clues.', 'Be clear, but not too clear.'],
  },
  {
    id: 'catan', name: 'Catan', minPlayers: 3, maxPlayers: 4, minutes: 75, complexity: 'Medium',
    styles: ['Strategy', 'Competitive'], tagline: 'Trade, build, settle',
    blurb: ['Gather resources and build the island.', 'Anyone got wood for sheep?'],
  },
  {
    id: 'forbidden-island', name: 'Forbidden Island', minPlayers: 2, maxPlayers: 4, minutes: 30, complexity: 'Easy',
    styles: ['Co-operative'], tagline: 'Treasure hunt on a sinking island',
    blurb: ['Grab four treasures.', 'Get off the island before it sinks.'],
  },
  {
    id: 'sushi-go', name: 'Sushi Go!', minPlayers: 2, maxPlayers: 5, minutes: 15, complexity: 'Easy',
    styles: ['Party', 'Competitive'], tagline: 'Quick card-drafting snack',
    blurb: ['Pick a card, pass the rest.', 'Pudding matters more than you think.'],
  },
  {
    id: 'azul', name: 'Azul', minPlayers: 2, maxPlayers: 4, minutes: 40, complexity: 'Medium',
    styles: ['Strategy'], tagline: 'Tile-drafting puzzle',
    blurb: ['Draft gorgeous tiles to decorate the palace.', 'Every tile you leave is a gift to someone else.'],
  },
];

export const PREVIEW_GAME_OF_THE_WEEK = 'carcassonne';

export const PLAYER_OPTIONS = [
  { id: '2', label: '2', test: (g: Game) => g.minPlayers <= 2 && g.maxPlayers >= 2 },
  { id: '3-4', label: '3–4', test: (g: Game) => g.minPlayers <= 4 && g.maxPlayers >= 3 },
  { id: '5-6', label: '5–6', test: (g: Game) => g.minPlayers <= 6 && g.maxPlayers >= 5 },
  { id: '7+', label: '7+', test: (g: Game) => g.maxPlayers >= 7 },
] as const;

export const TIME_OPTIONS = [
  { id: 'short', label: 'Under 30 min', test: (g: Game) => g.minutes < 30 },
  { id: 'medium', label: '30–60 min', test: (g: Game) => g.minutes >= 30 && g.minutes <= 60 },
  { id: 'long', label: '1–2 hours', test: (g: Game) => g.minutes > 60 && g.minutes <= 120 },
] as const;

export const STYLE_OPTIONS: Style[] = ['Strategy', 'Party', 'Co-operative', 'Competitive'];

export const playersLabel = (g: Game) => (g.minPlayers === g.maxPlayers ? `${g.minPlayers} Players` : `${g.minPlayers}–${g.maxPlayers} Players`);
export const minutesLabel = (g: Game) => (g.minutes >= 60 && g.minutes % 60 === 0 ? `${g.minutes / 60} Hour${g.minutes > 60 ? 's' : ''}` : `${g.minutes} Minutes`);
