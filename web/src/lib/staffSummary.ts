// What's waiting in each organiser section (GET /api/staff/summary): one copy
// shared by the hub and the section pages, fetched again after any change made
// through hostApi, so every count follows approvals and fixes without a reload.

import { useEffect, useState } from 'preact/hooks';
import { hostApi, setAfterChange } from './hostApi';

export type SectionKey = 'approve' | 'attention' | 'events' | 'bookings' | 'people' | 'content' | 'stats';

export interface SectionSummary {
  count: number;
  parts?: Record<string, number>;
  info?: Record<string, number>;
}

export interface StaffSummary {
  sections: Partial<Record<SectionKey, SectionSummary>>;
}

interface State {
  data: StaffSummary | null;
  error: boolean;
}

let state: State = { data: null, error: false };
let inFlight: Promise<void> | null = null;
const listeners = new Set<(s: State) => void>();

function publish(next: State) {
  state = next;
  listeners.forEach(l => l(state));
}

function load(): Promise<void> {
  inFlight ??= hostApi<StaffSummary>('/api/staff/summary')
    .then(res => publish(res.ok ? { data: res.data, error: false } : { data: state.data, error: !state.data }))
    .finally(() => (inFlight = null));
  return inFlight;
}

/** Ask again; only while a hub or section is on screen (hosts never ask). */
export function refreshStaffSummary(): void {
  if (listeners.size) void load();
}

setAfterChange(refreshStaffSummary);

export function useStaffSummary(): State & { reload: () => void } {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    void load();
    return () => void listeners.delete(setS);
  }, []);
  return { ...s, reload: () => void load() };
}
