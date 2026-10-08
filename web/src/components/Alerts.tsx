// "Get event alerts": one switch for reminders about events (docs/RTD_ALERTS.md).

import { Bell, BellOff, BellRing, Download } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { useAlerts } from '../lib/alerts';
import { useInstall } from '../lib/install';
import { toast } from '../lib/toast';

const PROMISE = "Reminders now and then from the café team, plus at most one other every two days. Turn them off here at any time.";

function useSwitch() {
  const alerts = useAlerts();
  const [busy, setBusy] = useState(false);
  const run = async (on: boolean) => {
    setBusy(true);
    const error = await (on ? alerts.turnOn() : alerts.turnOff());
    setBusy(false);
    if (error) toast(error);
    else toast(on ? "Event alerts are on. We'll remind you about what's coming up." : 'Event alerts are off.');
  };
  return { state: alerts.state, busy, on: () => run(true), off: () => run(false) };
}

/** Home page card. Hidden where the browser can't show notifications at all. */
export function AlertsPromo() {
  const { state, busy, on, off } = useSwitch();
  const { install } = useInstall();
  if (state === 'checking' || state === 'unsupported') return null;
  return (
    <section class="section card promo alerts-promo" aria-labelledby="alerts-promo">
      <p class="label">Never miss a game night</p>
      <h2 id="alerts-promo" class="display" style={{ fontSize: 'var(--rtd-size-h3)' }}>
        {state === 'on' ? 'Event alerts are on' : 'Get event alerts'}
      </h2>
      <p class="meta">{state === 'on' ? "We'll remind you about events at the café on this device." : PROMISE}</p>
      {state === 'off' && (
        <button type="button" class="btn btn--secondary" onClick={on} disabled={busy}>
          <BellRing size={18} aria-hidden="true" /> Get event alerts
        </button>
      )}
      {state === 'on' && (
        <div>
          <button type="button" class="btn btn--text btn--sm" onClick={off} disabled={busy}>
            <BellOff size={16} aria-hidden="true" /> Turn off
          </button>
        </div>
      )}
      {state === 'ios-install' && (
        <>
          <p class="meta">On iPhone and iPad, add the app to your Home Screen first, open it from there, and turn alerts on.</p>
          <button type="button" class="btn btn--secondary" onClick={install}>
            <Download size={18} aria-hidden="true" /> How to add it
          </button>
        </>
      )}
      {state === 'blocked' && <p class="meta">Notifications are blocked for this site. Allow them in your browser's settings, then come back here.</p>}
    </section>
  );
}

/** One line on an event page: a button while alerts are off, a quiet note once they're on. */
export function AlertsInline() {
  const { state, busy, on } = useSwitch();
  if (state === 'on') {
    return (
      <p class="meta alerts-inline">
        <Bell size={16} aria-hidden="true" /> Event alerts are on for this device.
      </p>
    );
  }
  if (state !== 'off') return null;
  return (
    <div class="alerts-inline">
      <button type="button" class="btn btn--text btn--sm" onClick={on} disabled={busy}>
        <BellRing size={16} aria-hidden="true" /> Get event alerts
      </button>
      <span class="meta">Reminders about what's coming up. Turn them off at any time.</span>
    </div>
  );
}
