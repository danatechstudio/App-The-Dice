// What this browser can do with push notifications, shared by event alerts
// (customers, docs/RTD_ALERTS.md) and approvers' notifications (docs/RTD_PUSH.md).
// Both use the one browser subscription, so turning one off never unsubscribes the browser
// while the other might still need it.

export type PushSupport = 'ok' | 'ios-install' | 'unsupported';

/** On iPhone and iPad, web apps can only notify once they're added to the Home Screen and opened from there. */
export function pushSupport(): PushSupport {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (ios && !standalone) return 'ios-install';
  return capable ? 'ok' : 'unsupported';
}

export const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)), c => c.charCodeAt(0));

export async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
}

/** This browser's subscription, made with the app's key if there isn't one yet. Ask permission first. */
export async function subscription(publicKey: string): Promise<PushSubscription> {
  await navigator.serviceWorker.ready;
  const reg = await registration();
  return (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  return (await registration()).pushManager.getSubscription();
}

export const permission = (): NotificationPermission => ('Notification' in window ? Notification.permission : 'default');
