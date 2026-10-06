// Push notifications on this device, for approvers and admins (docs/RTD_PUSH.md).
// A notification arrives whenever a session or a join request needs approving,
// as well as the email. On iPhone and iPad, web apps can only notify once
// they're added to the Home Screen and opened from there.

import { Bell, BellOff, Send } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { hostApi } from '../lib/hostApi';
import { toast } from '../lib/toast';

type Support = 'ok' | 'ios-install' | 'unsupported';
type Device = { endpoint: string; device_label: string | null };

function support(): Support {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (ios && !standalone) return 'ios-install';
  return capable ? 'ok' : 'unsupported';
}

const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)), c => c.charCodeAt(0));

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
}

export function PushCard() {
  const [can] = useState(support);
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'default'));
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await hostApi<{ devices: Device[] }>('/api/staff/push/devices');
    if (res.ok) setDevices(res.data.devices);
    if (can === 'ok') setEndpoint((await (await registration()).pushManager.getSubscription())?.endpoint ?? null);
  }, [can]);
  useEffect(() => void load(), [load]);

  // On only if this browser has a subscription the app also knows about.
  const on = !!endpoint && !!devices?.some(d => d.endpoint === endpoint);
  const elsewhere = (devices ?? []).filter(d => d.endpoint !== endpoint);

  const turnOn = async () => {
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') return;
      const key = await hostApi<{ public_key: string }>('/api/staff/push/key');
      if (!key.ok) return toast(key.error);
      await navigator.serviceWorker.ready;
      const reg = await registration();
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.data.public_key) }));
      const res = await hostApi('/api/staff/push/subscribe', sub.toJSON());
      toast(res.ok ? 'Notifications are on for this device.' : res.error);
      await load();
    } catch {
      toast("Couldn't turn notifications on. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    const sub = await (await registration()).pushManager.getSubscription();
    if (sub) {
      await hostApi('/api/staff/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe().catch(() => undefined);
    }
    setBusy(false);
    toast('Notifications are off for this device.');
    await load();
  };

  const test = async () => {
    setBusy(true);
    const res = await hostApi<{ sent: number; failed: number }>('/api/staff/push/test', {});
    setBusy(false);
    if (!res.ok) return toast(res.error);
    toast(res.data.sent ? `Test sent to ${res.data.sent === 1 ? 'your device' : `${res.data.sent} devices`}.` : "The test didn't go through. Try turning notifications off and on again.");
    await load();
  };

  return (
    <section class="card card--pad push-card" aria-labelledby="push-title">
      <div class="push-card__icon" aria-hidden="true">
        {on ? <Bell size={22} /> : <BellOff size={22} />}
      </div>
      <div class="stack" style={{ '--gap': '8px' }}>
        <h2 id="push-title" class="push-card__title">
          Notifications on this device {on && <span class="chip chip--live">On</span>}
        </h2>
        <p class="meta">Get a notification whenever a session or a join request needs approving, as well as the email.</p>
        {can === 'ios-install' && (
          <p>
            On iPhone and iPad, add Roll The Dice to your Home Screen first: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Open it from
            there, sign in to the organiser, and turn notifications on here.
          </p>
        )}
        {can === 'unsupported' && <p>This browser can't show notifications. Chrome, Edge, Firefox and Safari can.</p>}
        {can === 'ok' && permission === 'denied' && (
          <p>Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.</p>
        )}
        {elsewhere.length > 0 && (
          <p class="meta">Also on: {elsewhere.map(d => d.device_label ?? 'another device').join(' · ')}</p>
        )}
        {can === 'ok' && permission !== 'denied' && (
          <div class="cluster" style={{ '--gap': '8px' }}>
            {on ? (
              <>
                <button type="button" class="btn btn--secondary btn--sm" onClick={test} disabled={busy}>
                  <Send size={16} aria-hidden="true" /> Send a test
                </button>
                <button type="button" class="btn btn--text btn--sm" onClick={turnOff} disabled={busy}>
                  Turn off
                </button>
              </>
            ) : (
              <button type="button" class="btn btn--primary btn--sm" onClick={turnOn} disabled={busy || devices === null}>
                <Bell size={16} aria-hidden="true" /> Turn on notifications
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
