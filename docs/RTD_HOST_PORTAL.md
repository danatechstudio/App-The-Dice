# RTD Host Portal

The host organiser lives at **`/organise`**. Hosts propose sessions there; the café approves or declines them on the same page.

## Status (2026-10-05)

| Part | State |
| --- | --- |
| Organiser page: dashboard, create session, your sessions, withdraw | **Built** |
| Staff section: approvals queue (approve / decline with a note), host list, add a host | **Built** |
| Sign-in | **Working**, through the existing RTD Staff Access app (see [Signing in](#signing-in)) |
| One-off or weekly sessions | **Built** |
| Email the host the day after a one-off session | **Built** (n8n **RTD Host Follow-up**, see [After a one-off session](#after-a-one-off-session)) |
| Approved sessions into the Logic Engine, and so into the diary | **Next step** (n8n) |
| Email the café when a session is submitted | **Next step** (n8n) |
| Bookings and attendee lists for hosts | Phase 5 (bookings) |

## The session form

| Field | Rules |
| --- | --- |
| Event name | 3–80 characters |
| How often? | **One-off** (default) or **Weekly**. Stored as `frequency`, in the Logic Engine's own Frequency words. |
| Date (First date, if weekly) | From tomorrow, up to a year ahead. A weekly session runs on that weekday every week until the host withdraws it or the café stops it. |
| Start time | Required |
| End time | Optional; must be after the start |
| Cost per player | Free, or a price up to £100, paid at the café (no online payment) |
| Max players | 1–100 |
| Description | Optional, up to 500 characters |

**Validation and numbering:**
- **Validation:** the server checks every field and returns a message per field; the form shows each message next to its field.
- **Numbering:** sessions are numbered `RTD-HS-00001` upwards.

**Weekly sessions in the organiser:**
- **Cards:** they show "Every Tuesday" and the next date ("Next 6 Oct"), or "From 12 Oct" before the first one.
- **Ordering:** they stay in the upcoming list, ordered by their next date.
- **Withdrawing:** withdrawing one stops every week of it.

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

## Signing in

The organiser's **Sign in** button goes to `/api/staff/sign-in`. That path is behind the existing **RTD Staff** Access application, so Access asks for the email address and sends a one-time code. Afterwards the Worker sends the person back to `/organise`.

**Why this works without more Access paths:**
- **One cookie for the whole site:** Access's sign-in cookie (`CF_Authorization`) covers all of `rtd-app.dan-289.workers.dev`, so the organiser's `/api/host` calls carry it too.
- **The Worker checks it every time:** every call verifies the cookie's signature and application (the `ACCESS_AUD` tag), then looks the email up in `users`.

**If sign-in doesn't stick:** the page says "We couldn't finish signing you in", with a short reason, instead of looping:
- **`missing`:** no cookie arrived. Check that **Cookie Path Attribute** is off in the RTD Staff application's settings.
- **`invalid`:** the cookie came from a different Access application.

**Who can sign in:**
- **The RTD Staff application's policy decides who may sign in at all.** For hosts to get in, it must include them:
  - **Include → Everyone** (recommended): Access proves the email, and the app's `users` table decides who is a host.
  - **Include → specific emails:** add each host's email to the policy as well.
- **Adding hosts:** sign in at `/organise` as staff and use **Add a host** (their name, and the email they'll sign in with).

**Optional extra layer:** you can also add `organise` and `api/host` as destinations on the same RTD Staff application. It isn't needed.

## After a one-off session

The n8n workflow **RTD Host Follow-up** emails the host of each one-off session the day after it happens.

**Which sessions get the email:**
- **Eligible:** one-off sessions that were approved (or live) and whose date has passed.
- **Not emailed:** weekly sessions, and sessions that were declined, withdrawn or never decided.
- **Fortnight limit:** it only looks back 14 days.

**What the email says:** it thanks the host and links to the organiser to run it again. Each host gets it once: n8n marks the session (`followup_sent_at`) after sending.

## API

`/api/host` and `/api/staff` need an Access sign-in. Changes must be JSON from our own pages: requests from other sites are refused (403), and non-JSON bodies get 415.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/host/me` | host, staff, admin | Who am I; `can_review` for staff |
| GET | `/api/host/sessions` | host, staff, admin | My sessions |
| POST | `/api/host/sessions` | host, staff, admin | Create. Returns 201, or 400 with `errors` per field. |
| POST | `/api/host/sessions/:id/withdraw` | the session's host | Withdraw before it's live |
| GET | `/api/staff/host-sessions?status=` | staff, admin | Sessions by status (default `submitted`) |
| POST | `/api/staff/host-sessions/:id/decision` | staff, admin | `{ decision: "approve" \| "decline", note? }` |
| GET / POST | `/api/staff/hosts` | staff, admin | List hosts / add a host `{ email, display_name }` |
| GET | `/api/staff/sign-in` | anyone Access lets in | Redirects to `/organise` after Access sign-in |
| GET | `/internal/host-sessions/followups` | n8n (bearer token) | One-off sessions due the follow-up email |
| POST | `/internal/host-sessions/:id/followup-sent` | n8n (bearer token) | Record that the email went out (409 if already) |

## Next step: approved sessions into the diary

This is the plan from the audit (§6): the Logic Engine stays the one master calendar.
1. **Append to the sheet:** an n8n workflow picks up approved sessions and appends each to **Event Index**:
   - Event Name, Frequency (`One-off` or `Weekly`), Date, Event Time, End Time, Status `Active`, Base Details, App Visibility `Public`.
   - Three new columns: **App Price**, **App Capacity** and **App Host Session** (the `RTD-HS` number).
2. **Into the app:** the next Event Sync gives the row an Event ID. The app reads the new columns, shows the price and max players on the event page, and marks the session **Live** for its host.
3. **Notify the café:** the same workflow emails the café about each new submission (address from `rtd_config`), with a link to `/organise`.

**Before switching this on:** once a session is in Event Index, RTD Master V1's poster and social automation will promote it like any other event.
