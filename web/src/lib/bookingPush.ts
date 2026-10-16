// Telling this device about a booking (docs/RTD_BOOKINGS.md#telling-this-device): opt-in,
// for one booking, if the date is cancelled or moved. The email always goes as well, so
// nothing here can stop someone booking. Uses the app's one browser subscription
// (src/lib/push.ts), shared with event alerts and approvers' notifications.

import { hostApi } from './hostApi';
import { currentSubscription, permission, pushSupport, subscription } from './push';

/** Whether to offer it: the browser can notify, and hasn't been told never to. */
export const canTellDevice = () => pushSupport() === 'ok' && permission() !== 'denied';

/** Asks permission if needed (call it straight from a tap), then this browser's subscription; null if refused. */
export async function deviceSubscription(): Promise<PushSubscription | null> {
  try {
    if (permission() !== 'granted' && (await Notification.requestPermission()) !== 'granted') return null;
    const key = await fetch('/api/alerts/key', { headers: { Accept: 'application/json' } }).then(r => (r.ok ? (r.json() as Promise<{ public_key: string }>) : null));
    return key ? await subscription(key.public_key) : null;
  } catch {
    return null;
  }
}

/** Tell this device about this booking. Returns an error to show, or null. */
export async function tellDevice(bookingId: string, token: string, sub: PushSubscription): Promise<string | null> {
  const res = await hostApi(`/api/bookings/${encodeURIComponent(bookingId)}/device`, { token, subscription: sub.toJSON() });
  return res.ok ? null : res.error;
}

/** Stop telling this device. The browser's subscription stays: alerts may still use it. */
export async function stopTellingDevice(bookingId: string, token: string): Promise<string | null> {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return null;
  const res = await hostApi(`/api/bookings/${encodeURIComponent(bookingId)}/device/remove`, { token, endpoint: sub.endpoint });
  return res.ok ? null : res.error;
}

/** This browser's push address, if it has one, so the Manage page can say whether it's set. */
export async function thisEndpoint(): Promise<string | undefined> {
  if (pushSupport() !== 'ok') return undefined;
  return (await currentSubscription().catch(() => null))?.endpoint;
}
