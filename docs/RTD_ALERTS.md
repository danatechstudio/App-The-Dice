# RTD Event Alerts and Reminders

Anyone can turn on **event alerts** in the app, with no account. People with alerts on get two kinds of reminder about events at the café:

- **An admin's reminder:** an admin picks an event in the organiser and sends a reminder whenever they like. The same words go on the café's Facebook page.
- **The automatic reminder:** at 8pm, about a random event in the next three days, at most once every 48 hours.

Approvers' notifications about things to approve are separate: see [RTD_PUSH.md](RTD_PUSH.md).

## Status (2026-10-08)

| Part | State |
| --- | --- |
| **Get event alerts** on the home page and on every event page | **Built** |
| **Event reminders** in the organiser, for admins | **Built** |
| Warning and confirmation for a second reminder about an event within 24 hours | **Built** |
| Facebook post with each admin reminder (n8n **RTD Event Reminders To Facebook**, via Buffer) | **Built** |
| Automatic reminder at 8pm, at most every 48 hours | **Built** |
| Tried on a real phone | **Not yet** |

## Turning alerts on

| Device | How |
| --- | --- |
| Android, or a computer (Chrome, Edge, Firefox; Safari on a Mac) | On the home page, **Get event alerts**, then allow notifications. Or the **Get event alerts** link on any event page. |
| iPhone or iPad (iOS 16.4 or later) | Apple only allows notifications from web apps on the Home Screen. The card says so and has **How to add it**. Once the app is on the Home Screen and opened from there, **Get event alerts** works. |

**Once they're on:**
- **The home page card** says "Event alerts are on", with **Turn off**.
- **Event pages** say "Event alerts are on for this device."
- **Blocked by mistake:** if notifications are blocked for the site, the card says how to allow them.

**One switch:** there's nothing to choose. Alerts are on or off for the device, and cover both kinds of reminder.

## Sending a reminder (admins)

In the organiser, admins see **Event reminders**:

1. **Pick the event.** The list shows the next date of every public event in the next fortnight, and when each last had a reminder. One sent in the last 24 hours is highlighted.
2. **Check the words.** **Remind** opens a form with a suggested title (the event's name) and message ("Fri 9 Oct, 6:30pm–10pm. Book your place in the app."). Change them as you like:
   - **Title:** up to 60 characters.
   - **Message:** up to 180 characters.
3. **Facebook:** **Post on Facebook too?** is **Yes** unless you change it. The post is the title, the message and a link to the event in the app, with the event's photo if it has one.
4. **Preview, then send.** The preview shows how the notification looks, and how many devices it goes to.

**A second reminder within 24 hours:** if the event had a reminder (from an admin, or the automatic one) in the last 24 hours, the app doesn't send straight away. It shows when the last one went out, what it said and who sent it, with **Send another anyway** and **Don't send**.

**Afterwards:** **Latest reminders** shows each one with how many devices it reached, and whether the Facebook post went (or why it didn't).

**Who can:** admins only. Approvers and hosts don't see the section, and the server refuses them.

## The automatic reminder

- **When:** 8pm London time.
- **How often:** at most once every 48 hours. Admins' reminders don't count towards this: it keeps its own clock.
- **Which event:** a random public event from tomorrow to three days ahead. Each event is equally likely, however many dates it has. An event that had any reminder in the last 48 hours is skipped.
- **What it says:** the same as the suggested reminder: the event's name, its date and time, and "Book your place in the app." (or "Tap to see the details.").
- **No Facebook post.**
- **Nothing to send:** no reminder if nobody has alerts on, or no event fits. It tries again at 8pm the next evening.

## How it works

**Sending (`src/notify/alerts.ts`):**
- **The same Web Push** as approvers' notifications ([RTD_PUSH.md](RTD_PUSH.md#how-it-works)): encrypted for each device, signed with the app's key, sent only to the browsers' own push services.
- **Queued per device:** a reminder is saved in `push_sends`, and one row per device goes in `push_deliveries`, in one transaction.
- **In batches:** Workers on the free plan can make 50 outgoing requests and use 10ms of CPU per run, so each run sends 20:
  - **An admin's reminder:** the first 20 go straight after **Send**.
  - **Everything else:** the Worker's every-minute Cron Trigger sends the next 20. That's 1,200 an hour.
  - **No double sends:** each run claims its batch first. A batch claimed by a run that stopped is picked up again after 5 minutes.
- **On the device:** tapping the notification opens the event page. A newer reminder about the same event replaces an older one (tag `event-<Event ID>`).
- **Phones that are off:** the push service holds a reminder for 12 hours.
- **Devices that stop working:** forgotten when the push service says they're gone (404 or 410), or after 5 failures in a row.
- **Turned off since:** a device that turned alerts off after a reminder was queued is skipped.

**The Facebook post:**
- **Queued:** an admin's reminder with **Post on Facebook too?** set to **Yes** is marked `social = 'pending'`, with the text and the photo's address.
- **Posted:** n8n **RTD Event Reminders To Facebook** collects it within a minute and posts it through Buffer to the café's Facebook page. The photo address is the app's own `/images/<id>` (or a web address set on the sheet).
- **Reported back:** n8n tells the app it's posted (with Buffer's post ID) or failed (with Buffer's reason). Admins see this under **Latest reminders**.
- **If it fails:** it isn't tried again. Post it on Facebook by hand if it matters.

**The browser side:**
- **One subscription per browser:** an approver's notifications and event alerts share it. So **Turn off** for alerts only tells the app to stop; it never unsubscribes the browser. The approver card unsubscribes the browser only if alerts are off too.
- **Renewed subscriptions:** when a browser renews its subscription, the service worker moves alerts to the new one (`/api/alerts/renew`). If the browser doesn't say which was the old one, the app puts it back quietly the next time it's opened.

## API

**Public, same-origin JSON, no account** (`src/routes/alerts.ts`):

| Endpoint | Does |
| --- | --- |
| `GET /api/alerts/key` | The app's public key, for `pushManager.subscribe()` |
| `POST /api/alerts/subscribe` | Turn alerts on. Body: the browser's `PushSubscription`. 20 new devices per network an hour (`429` beyond). |
| `POST /api/alerts/unsubscribe` | Turn them off. Body: `{ endpoint }` |
| `POST /api/alerts/status` | `{ on }` for this device. Body: `{ endpoint }` |
| `POST /api/alerts/renew` | Body: `{ old_endpoint, subscription }`, from the service worker |

**Admins** (`src/routes/staff.ts`):

| Endpoint | Does |
| --- | --- |
| `GET /api/staff/reminders` | Devices with alerts on, the last automatic reminder, the latest 10 reminders, and the next date of each public event in the next 14 days |
| `POST /api/staff/reminders` | Send one. Body: `{ occurrence_id, title, body, social, confirm }`. `409 { warning }` if the event had a reminder in the last 24 hours and `confirm` isn't `true`; `409 { error }` if the date has passed. |

**n8n** (`/internal`, bearer token):

| Endpoint | Does |
| --- | --- |
| `GET /internal/social-posts` | Up to 5 posts waiting: `{ send_id, text, image_url }` |
| `POST /internal/social-posts/:id/done` | Body: `{ post_id }` |
| `POST /internal/social-posts/:id/failed` | Body: `{ error }` |

## Data and privacy

Migration `0014_event_alerts.sql` (see [RTD_DATABASE_SCHEMA.md](RTD_DATABASE_SCHEMA.md#event-alerts)):

| Table | Holds | Kept |
| --- | --- | --- |
| `alert_subscriptions` | Each device's push address and keys, a device label ("Android, Chrome"), and a scrambled network code | Until alerts are turned off, or the device stops working. The network code is erased after 2 days. |
| `push_sends` | Each reminder: what it said, the event, who sent it (an admin's email, or `auto`), counts, and the Facebook post's outcome | For good, like the audit log. No customer details. |
| `push_deliveries` | A reminder waiting for each device | Deleted once sent. Anything still unsent after a day is dropped by the daily job. |

**No personal details:** a push address doesn't say who someone is. The privacy notice covers event alerts (what's kept, the push services, turning them off).

**The audit log:** each admin reminder is recorded as `push.reminder_sent`, with the device count, whether it went to Facebook, and whether it was sent after a warning.

## Checks

```sql
-- Devices with alerts on
SELECT COUNT(*) FROM alert_subscriptions;
-- Latest reminders, with delivery and Facebook outcome
SELECT send_id, kind, title, sent_by, devices, delivered, failed, social, social_error, created_at FROM push_sends ORDER BY send_id DESC LIMIT 10;
-- Still sending
SELECT send_id, COUNT(*) FROM push_deliveries GROUP BY send_id;
```

**Workers Logs:** `alerts: sent {...}` after each batch from the Cron Trigger; `alerts: automatic reminder {...}` when one is queued.
