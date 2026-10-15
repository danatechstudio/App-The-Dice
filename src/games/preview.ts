// The sample shelf the public app shows until the café's library goes live
// (settings game_library_live = 'off'). Well-known titles, labelled Preview on
// screen; no ages are given because none were checked. Delete after cutover.

import type { PublicGame } from './model';

const g = (
  slug: string,
  title: string,
  category: string,
  audiences: string[],
  players: [number, number],
  minutes: number,
  synopsis: string,
): PublicGame => ({
  id: `preview-${slug}`,
  slug,
  title,
  edition: null,
  category,
  audiences,
  min_age: null,
  min_players: players[0],
  max_players: players[1],
  play_time_min: null,
  play_time_max: minutes,
  synopsis,
  cover: null,
  thumb: null,
  cover_alt: `Box cover of ${title}`,
  attribution: null,
  preview: true,
});

export const PREVIEW_GAMES: PublicGame[] = [
  g('king-of-tokyo', 'King of Tokyo', 'Party', ['Party', 'Family'], [2, 6], 30, 'Monster battles, city destruction and extremely questionable decisions. Roll dice to smash rivals and take Tokyo.'),
  g('carcassonne', 'Carcassonne', 'Strategy', ['Family', 'Strategy'], [2, 5], 35, 'Build a medieval landscape one tile at a time. Claim roads, cities and fields before anyone else does.'),
  g('ticket-to-ride', 'Ticket to Ride', 'Strategy', ['Family', 'Strategy'], [2, 5], 60, 'Collect cards, claim routes and connect cities. Someone will block your line, and it might be on purpose.'),
  g('pandemic', 'Pandemic', 'Co-operative', ['Strategy'], [2, 4], 45, 'Four diseases, one team. Win together or lose together as you race to find the cures.'),
  g('codenames', 'Codenames', 'Party', ['Party'], [4, 8], 15, 'Give one-word clues to find your agents. Avoid the assassin, and avoid overthinking.'),
  g('dixit', 'Dixit', 'Party', ['Party', 'Family'], [3, 8], 30, 'Beautiful cards and cryptic clues. Be clear, but not too clear.'),
  g('catan', 'Catan', 'Strategy', ['Strategy'], [3, 4], 75, 'Gather resources, trade with friends and build the island. Anyone got wood for sheep?'),
  g('forbidden-island', 'Forbidden Island', 'Co-operative', ['Family'], [2, 4], 30, 'Grab four treasures together. Get off the island before it sinks beneath you.'),
  g('sushi-go', 'Sushi Go!', 'Party', ['Party', 'Family'], [2, 5], 15, 'Pick a card, pass the rest, and build the best sushi meal. Pudding matters more than you think.'),
  g('azul', 'Azul', 'Strategy', ['Strategy', 'Family'], [2, 4], 40, 'Draft gorgeous tiles to decorate the palace walls. Every tile you leave is a gift to someone else.'),
];

export const PREVIEW_GOTW = 'carcassonne';
