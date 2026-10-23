// The list an admin opened the event editor from (Organise › Events or Social posts), so the
// editor can go back to it and step to the previous or next event in that list's order. The
// origin rides in the address (?from=social), the ordered ids in sessionStorage (a refresh keeps
// them; the app's router has no per-entry state to carry them). Pure helpers here; the
// browser storage is in eventTrailStore.ts.
export type TrailOrigin = 'events' | 'social';
export interface EventTrail {
  from: TrailOrigin;
  ids: string[];
}

export const TRAIL_KEY = 'rtd:event-trail';

export const ORIGIN: Record<TrailOrigin, { path: string; label: string }> = {
  events: { path: '/organise/events', label: 'Events' },
  social: { path: '/organise/social', label: 'Social posts' },
};

/** '?from=social' → 'social'; anything else (a direct link) → 'events'. */
export function originOf(search: string): TrailOrigin {
  return new URLSearchParams(search).get('from') === 'social' ? 'social' : 'events';
}

/** The editor's address for an event opened from a list; from Social posts it opens on the prompt. */
export function editorHref(eventId: string, from: TrailOrigin): string {
  const base = `/organise/events/${encodeURIComponent(eventId)}`;
  return from === 'social' ? `${base}?from=social#social-prompt` : `${base}?from=events`;
}

/** The events either side of this one in the list; null at either end, or when it isn't in the list. */
export function neighbours(ids: readonly string[], eventId: string): { prev: string | null; next: string | null } {
  const i = ids.indexOf(eventId);
  if (i < 0) return { prev: null, next: null };
  return { prev: i > 0 ? ids[i - 1]! : null, next: i < ids.length - 1 ? ids[i + 1]! : null };
}

/** The stored list, if it is the one this editor came from and holds this event. */
export function trailFor(stored: EventTrail | null, from: TrailOrigin, eventId: string): string[] | null {
  if (!stored || stored.from !== from || !Array.isArray(stored.ids) || !stored.ids.includes(eventId)) return null;
  return stored.ids;
}

/** Review order, then the approved ones when opened from that group; each event once. */
export function socialOrder(review: readonly string[], approved: readonly string[], fromApproved: boolean): string[] {
  return [...new Set(fromApproved ? [...review, ...approved] : review)];
}
