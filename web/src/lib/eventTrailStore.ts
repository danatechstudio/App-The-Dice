// Where the event editor's trail (eventTrail.ts) is kept: this tab's sessionStorage.
import { TRAIL_KEY, type EventTrail } from './eventTrail';
import { read, write } from './storage';

export const saveTrail = (trail: EventTrail): void => write(TRAIL_KEY, trail, 'session');
export const loadTrail = (): EventTrail | null => read<EventTrail | null>(TRAIL_KEY, null, 'session');
