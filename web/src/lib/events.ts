import { useApi, type Occurrence } from './api';
import { addDays, nowLondonTime, todayLondon } from './dates';

export const DIARY_DAYS = 60;

/** The upcoming diary, shared by Home, Diary and Book (one cached request). */
export function useUpcoming() {
  const today = todayLondon();
  const res = useApi<{ occurrences: Occurrence[] }>(`/api/events?from=${today}&to=${addDays(today, DIARY_DAYS)}`);
  return { ...res, today, occurrences: res.data?.occurrences };
}

/** Still to come (or still running) today. */
export function notOver(o: Occurrence, today: string, now = nowLondonTime()): boolean {
  if (o.date !== today) return o.date > today;
  const end = o.end_time ?? o.start_time;
  return !end || end > now;
}

/**
 * First occurrence of each event, in date order: stops weekly clubs flooding
 * a rail. Matches on name too, since one club can be two sheet rows (e.g.
 * Monday and Thursday sessions). `skip` drops events already shown above.
 */
export function firstPerEvent(list: Occurrence[], skip: Occurrence[] = []): Occurrence[] {
  const seen = new Set(skip.flatMap(o => [o.event_id, o.name]));
  return list.filter(o => {
    if (seen.has(o.event_id) || seen.has(o.name)) return false;
    seen.add(o.event_id).add(o.name);
    return true;
  });
}

export function groupByDate(list: Occurrence[]): [string, Occurrence[]][] {
  const groups = new Map<string, Occurrence[]>();
  for (const o of list) groups.set(o.date, [...(groups.get(o.date) ?? []), o]);
  return [...groups];
}
