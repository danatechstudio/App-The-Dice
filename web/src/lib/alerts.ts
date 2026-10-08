// Event alerts on this device (docs/RTD_ALERTS.md): one switch, no account.
// Shared state, so the switch on the home page and on an event page agree.

import { useEffect, useState } from 'preact/hooks';
import { currentSubscription, permission, pushSupport, subscription } from './push';
import { read, write } from './storage';

export type AlertsState = 'checking' | 'off' | 'on' | 'blocked' | 'ios-install' | 'unsupported';

/** Set when someone turns alerts on here, so they can be quietly put back if the browser renews its subscription. */
const WANTED_KEY = 'rtd.alerts.on';

async function post<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { ok: true, data } : { ok: false, error: data.error ?? "That didn't go through. Please try again." };
  } catch {
    return { ok: false, error: "That didn't go through. Check your connection and try again." };
  }
}

/** Does the app send event alerts to this subscription? */
export async function alertsOn(endpoint: string): Promise<boolean> {
  const res = await post<{ on: boolean }>('/api/alerts/status', { endpoint });
  return res.ok && res.data.on;
}

let state: AlertsState = 'checking';
let started = false;
const listeners = new Set<() => void>();
const set = (s: AlertsState) => {
  state = s;
  listeners.forEach(l => l());
};

async function check() {
  const can = pushSupport();
  if (can !== 'ok') return set(can);
  if (permission() === 'denied') return set('blocked');
  const sub = await currentSubscription().catch(() => null);
  if (sub && (await alertsOn(sub.endpoint))) return set('on');
  // Turned on here before, but the app no longer knows this subscription (the
  // browser renewed it): send it again, without asking.
  if (sub && permission() === 'granted' && read(WANTED_KEY, false)) {
    const res = await post('/api/alerts/subscribe', sub.toJSON());
    return set(res.ok ? 'on' : 'off');
  }
  set('off');
}

export function useAlerts() {
  const [, tick] = useState(0);
  useEffect(() => {
    const update = () => tick(n => n + 1);
    listeners.add(update);
    if (!started) {
      started = true;
      void check();
    }
    return () => void listeners.delete(update);
  }, []);

  return {
    state,
    /** Asks permission, then turns alerts on. Returns an error to show, or null. */
    async turnOn(): Promise<string | null> {
      try {
        const result = await Notification.requestPermission();
        if (result !== 'granted') {
          set(result === 'denied' ? 'blocked' : 'off');
          return result === 'denied' ? null : 'Alerts need your permission to show notifications.';
        }
        const key = await fetch('/api/alerts/key', { headers: { Accept: 'application/json' } }).then(r => (r.ok ? (r.json() as Promise<{ public_key: string }>) : null));
        if (!key) return "Couldn't turn alerts on. Please try again.";
        const sub = await subscription(key.public_key);
        const res = await post('/api/alerts/subscribe', sub.toJSON());
        if (!res.ok) return res.error;
        write(WANTED_KEY, true);
        set('on');
        return null;
      } catch {
        return "Couldn't turn alerts on. Please try again.";
      }
    },
    /** The app stops sending them. The browser's subscription stays: an approver's notifications may use it. */
    async turnOff(): Promise<string | null> {
      const sub = await currentSubscription().catch(() => null);
      if (sub) {
        const res = await post('/api/alerts/unsubscribe', { endpoint: sub.endpoint });
        if (!res.ok) return res.error;
      }
      write(WANTED_KEY, false);
      set('off');
      return null;
    },
  };
}
