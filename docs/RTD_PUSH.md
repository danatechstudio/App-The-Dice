# RTD Push Notifications: approvals

Approvers (Michelle) and admins (Dan) can get a push notification on their phone or computer whenever something needs approving. It comes **as well as** the email, not instead of it. Nobody else can turn them on.

## Status (2026-10-06)

| Part | State |
| --- | --- |
| "Notifications on this device" in the organiser, for approvers and admins | **Built** |
| A push when a host sends a session for approval | **Built** |
| A push when someone asks to host (join request) | **Built** |
| "Send a test" and "Turn off" | **Built** |
| Tried on a real phone | **Not yet** |

## What arrives

| When | Notification | Tapping it opens |
| --- | --- | --- |
| A host sends a session | **Session to approve**: "Sam: D&D One Shot, Sat 24 Oct" (weekly: "every Tuesday from…"; private ones say "(private)") | `/organise`, at Sessions awaiting approval |
| A host sends a declined or withdrawn session again | **Session sent again**, worded the same | The same |
| Someone asks to host | **Join request**: "Nina Newbie has asked to host games" | `/organise`, at Join requests |

**How it behaves:**
- **Who gets it:** every approver and admin who has turned notifications on, on every device they turned them on for. Nobody is pushed about their own session.
- **When:** it's sent the moment the session or request is saved. The email follows within 15 minutes, as before.
- **If it can't be delivered** (phone off, browser closed), the push service holds it for up to a day.

## Turning them on

In the organiser, approvers and admins see **Notifications on this device** at the top of their section.

| Device | How |
| --- | --- |
| Android (Chrome, Edge, Firefox, Samsung Internet) | Open `/organise`, tap **Turn on notifications**, and allow them. Works in the browser; installing the app isn't needed. |
| Computer (Chrome, Edge, Firefox; Safari on a Mac) | Same: **Turn on notifications**, then allow. |
| iPhone or iPad (iOS 16.4 or later) | Apple only allows notifications from web apps on the Home Screen. In Safari, tap **Share**, then **Add to Home Screen**. Open Roll The Dice from the Home Screen, go to the organiser, sign in, and tap **Turn on notifications**. The card explains this on an iPhone. |

**After turning them on:**
- **Check it works:** **Send a test** sends a notification to your own devices only.
- **Other devices:** the card lists your other devices that have notifications on ("Also on: iPhone, Safari").
- **Turn off** stops them on that device.
- **Blocked by mistake:** if notifications were blocked for the site, the card says so. Allow them in the browser's site settings, then turn them on again.

## How it works

The Worker sends each push itself (`src/notify/push.ts`); there's no third-party service or n8n step.

- **Keys:**
  - **Where they come from:** the app's VAPID key pair (RFC 8292) is made by the Worker the first time it's needed, and kept in D1 (`push_keys`). Nothing has to be set up by hand.
  - **What the browser gets:** only the public key, given to the browser when notifications are turned on.
- **Encryption:** each message is encrypted for the one browser it goes to (RFC 8291, `aes128gcm`). The push service can't read it.
- **Signing:**
  - **The token:** each request carries a 12-hour token signed with the app's key.
  - **Who it names:** the app's own address, not a person's email.
- **Where pushes go:** only to the browsers' own push services (Google, Mozilla, Apple, Microsoft). Any other address is refused when a device is saved.
- **Devices that stop working:**
  - **Gone:** a device the push service reports gone (404 or 410) is forgotten.
  - **Failing:** one that fails 5 times in a row is dropped.
  - **Limit:** each person keeps at most 10 devices.
- **Never in the way:** pushes are sent after the reply to the host, so they never slow down sending a session. A failed push never stops anything; the email still goes.
- **Tapping a notification** only ever opens a page of the app. The service worker (`web/public/sw.js`) shows the notification and handles the tap.

## API

All need an approver or admin (Access sign-in), and changes must be same-origin JSON.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/staff/push/key` | The app's public key |
| GET | `/api/staff/push/devices` | Your devices with notifications on |
| POST | `/api/staff/push/subscribe` | The browser's `PushSubscription` JSON: turn on for this device |
| POST | `/api/staff/push/unsubscribe` | `{ endpoint }`: turn off for one of your devices |
| POST | `/api/staff/push/test` | Send a test to your own devices: `{ sent, failed }` |

## Data

Migration `0009_push.sql`:
- **`push_subscriptions`:** one row per device. It holds the push service address (`endpoint`), the browser's public key and secret (`p256dh`, `auth`), a label ("iPhone, Safari"), and when it was last sent to.
- **`push_keys`:** the app's key pair, one row.

## Limits and what to watch

- **iPhone sign-in inside the Home Screen app.**
  - **What to check:** signing in through Cloudflare Access from the installed app hasn't been tried yet.
  - **If it doesn't stick:** sign in to the organiser in Safari first, then open the Home Screen app. Tell Claude if that still fails.
- **Only for approvals.** Booking emails (to hosts and customers) are still email only.
- **To start the keys again,** delete the `push_keys` row and every `push_subscriptions` row. Everyone then turns notifications on again.
