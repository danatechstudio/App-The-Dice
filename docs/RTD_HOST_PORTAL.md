# RTD Host Portal

The host organiser lives at **`/organise`**. Hosts propose sessions there; the café approves or declines them on the same page.

## Status (2026-10-05)

| Part | State |
| --- | --- |
| Organiser page: dashboard, create session, your sessions, withdraw | **Built** |
| Staff section: approvals queue (approve / decline with a note), host list, add a host | **Built** |
| Sign-in | **Needs one Access change** (see [Turning sign-in on](#turning-sign-in-on)) |
| Approved sessions into the Logic Engine, and so into the diary | **Next step** (n8n) |
| Email the café when a session is submitted | **Next step** (n8n) |
| Bookings and attendee lists for hosts | Phase 5 (bookings) |

## The session form

| Field | Rules |
| --- | --- |
| Event name | 3–80 characters |
| Date | From tomorrow, up to a year ahead |
| Start time | Required |
| End time | Optional; must be after the start |
| Cost per player | Free, or a price up to £100, paid at the café (no online payment) |
| Max players | 1–100 |
| Description | Optional, up to 500 characters |

**Validation and numbering:**
- **Validation:** the server checks every field and returns a message per field; the form shows each message next to its field.
- **Numbering:** sessions are numbered `RTD-HS-00001` upwards.

## Statuses

| Status | Meaning | Who moves it |
| --- | --- | --- |
| Awaiting approval (`submitted`) | Sent by the host | Host creates |
| Approved (`approved`) | The café said yes | Staff |
| Not approved (`declined`) | The café said no, optionally with a note the host sees | Staff |
| Withdrawn (`withdrawn`) | The host pulled it before it reached the diary | Host |
| Live (`published`) | It's in the Logic Engine and the diary | n8n (next step) |

**Rules:**
- **Withdrawing:** a host can only withdraw their own session, and only while it is awaiting approval or approved. Once it's live, they ask the café.
- **One decision only:** two staff can't both decide the same session; the second gets "already decided".
- **Audit:** every change is written to `audit_log` (entity `host_session`, source `organiser`).

## Who can do what

| Role | Can |
| --- | --- |
| Host | Use `/organise`; create, see and withdraw **their own** sessions |
| Staff | Everything a host can, plus approve or decline any session, and add hosts |
| Admin | As staff |

The `users` table decides roles. Cloudflare Access only proves the email address.

## Turning sign-in on

This needs a one-off change in the Cloudflare dashboard, and the connector can't make it. Go to **Zero Trust → Access → Applications → RTD Staff → Configure**, and add two more destinations to the same application, so the existing AUD tag keeps working:

1. `rtd-app.dan-289.workers.dev`, path **`organise`**
2. `rtd-app.dan-289.workers.dev`, path **`api/host`**

**The application's policy must let hosts in:**
- **Include → Everyone** (recommended): Access proves the email, and the app's `users` table decides who is a host.
- **Include → specific emails:** add each host's email to the policy as well.

**Adding hosts:** sign in at `/organise` as staff and use **Add a host** (their name, and the email they'll sign in with). They can sign in straight away with a one-time PIN.

## API

All under Cloudflare Access. Changes must be JSON from our own pages: requests from other sites are refused (403), and non-JSON bodies get 415.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/host/me` | host, staff, admin | Who am I; `can_review` for staff |
| GET | `/api/host/sessions` | host, staff, admin | My sessions |
| POST | `/api/host/sessions` | host, staff, admin | Create. Returns 201, or 400 with `errors` per field. |
| POST | `/api/host/sessions/:id/withdraw` | the session's host | Withdraw before it's live |
| GET | `/api/staff/host-sessions?status=` | staff, admin | Sessions by status (default `submitted`) |
| POST | `/api/staff/host-sessions/:id/decision` | staff, admin | `{ decision: "approve" \| "decline", note? }` |
| GET / POST | `/api/staff/hosts` | staff, admin | List hosts / add a host `{ email, display_name }` |

## Next step: approved sessions into the diary

This is the plan from the audit (§6): the Logic Engine stays the one master calendar.
1. **Append to the sheet:** an n8n workflow picks up approved sessions and appends each to **Event Index**:
   - Event Name, Date, Event Time, End Time, Status `Active`, Base Details, App Visibility `Public`.
   - Three new columns: **App Price**, **App Capacity** and **App Host Session** (the `RTD-HS` number).
2. **Into the app:** the next Event Sync gives the row an Event ID. The app reads the new columns, shows the price and max players on the event page, and marks the session **Live** for its host.
3. **Notify the café:** the same workflow emails the café about each new submission (address from `rtd_config`), with a link to `/organise`.

**Before switching this on:** once a session is in Event Index, RTD Master V1's poster and social automation will promote it like any other event.
