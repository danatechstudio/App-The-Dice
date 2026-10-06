# RTD Host Portal

The host organiser lives at **`/organise`**. Hosts propose sessions there; the café approves or declines them on the same page.

## Status (2026-10-06)

| Part | State |
| --- | --- |
| Organiser page: dashboard, create session, your sessions, withdraw | **Built** |
| Declined or withdrawn sessions: **Edit and send again**, or **Delete** | **Built** |
| Staff section: approvals queue (approve / decline with a note), host list, add a host | **Built** |
| Sign-in | **Working**, through the existing RTD Staff Access app (see [Signing in](#signing-in)) |
| One-off or weekly sessions | **Built** |
| Open or private sessions | **Built**. Private ones show in the diary only as "Private session" and their time, and are never advertised. |
| Email the host the day after a one-off session | **Built** (n8n **RTD Host Follow-up**, see [After a one-off session](#after-a-one-off-session)) |
| Approved sessions into the Logic Engine, and so into the diary | **Built** (n8n **RTD Host Sessions To Diary**, see [From approval to the diary](#from-approval-to-the-diary)) |
| Email the café when a session is submitted | **Built** (same workflow) |
| Email the host when the café approves or declines | **Built** (n8n **RTD Team Notices**) |
| Hosts and café staff ask for access themselves, the same way | **Built**: see [RTD_ONBOARDING.md](RTD_ONBOARDING.md) |
| Bookings on open sessions, who's coming, and cancelling a date | **Built**: see [RTD_BOOKINGS.md](RTD_BOOKINGS.md) |
| Host emailed for each booking, and the numbers two days before | **Built** (n8n **RTD Outbox**) |

## The session form

| Field | Rules |
| --- | --- |
| Event name | 3–80 characters |
| How often? | **One-off** (default) or **Weekly**. Stored as `frequency`, in the Logic Engine's own Frequency words. |
| Who can come? | **Open** (default): anyone can join, and the diary shows it in full. **Private**: the host's own group; the diary shows only "Private session" and its time, so the café still looks busy. Stored as `access`. |
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
| Awaiting approval (`submitted`) | Sent by the host, or sent again after a decline or withdrawal | Host creates or sends again |
| Approved (`approved`) | The café said yes | Approver |
| Not approved (`declined`) | The café said no, optionally with a note the host sees | Approver |
| Withdrawn (`withdrawn`) | The host pulled it before it reached the diary | Host |
| Live (`published`) | It's in the Logic Engine and the diary | n8n |

**Rules:**
- **Withdrawing:** a host can only withdraw their own session, and only while it is awaiting approval or approved. Once it's live, they cancel its dates instead.
- **Sending it again:** a declined or withdrawn session has **Edit and send again**.
  - **The form:** it opens filled in, with the café's note at the top. A date that has passed is left blank.
  - **Sending:** the session goes back to Awaiting approval with the same number. The old decision is cleared (it stays in the audit log).
  - **Who's told:** the café is emailed as for a new session, and approvers get a "Session sent again" push. Approvers see a **Sent again** chip on it.
- **Deleting:** a declined or withdrawn session also has **Delete**.
  - **What it does:** it disappears from every list. The row and its audit trail are kept (`deleted_at`), so session numbers are never reused.
  - **What can't be deleted:** sessions that are waiting, approved or live (withdraw them, or cancel their dates).
- **One decision only:** two staff can't both decide the same session; the second gets "already decided".
- **Audit:** every change is written to `audit_log` (entity `host_session`, source `organiser`).

## Who can do what

| Role | Can |
| --- | --- |
| Host (everyone who joins, café staff included) | Use `/organise`; create, see and withdraw **their own** sessions, send a declined or withdrawn one again, or delete it; see who's booked; cancel a date. Nothing else. |
| Approver (role `staff`: Michelle) | Everything a host can, plus approve or decline join requests and sessions, remove hosts, and cancel any hosted date |
| Admin (Dan) | As an approver, plus choose approvers and remove them |

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
- **New hosts:** they sign in at `/organise` and ask to host, and an approver approves them under **Join requests** ([RTD_ONBOARDING.md](RTD_ONBOARDING.md)). There's no way to add someone directly.

**Optional extra layer:** you can also add `organise` and `api/host` as destinations on the same RTD Staff application. It isn't needed.

## After a one-off session

The n8n workflow **RTD Host Follow-up** (`FFy0lBTZCm4A5p08`, daily at 10:00) emails the host of each one-off session the day after it happens.

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
| POST | `/api/host/sessions/:id/resubmit` | the session's host | Declined or withdrawn only: the same fields as creating one. Back to Awaiting approval (409 otherwise). |
| POST | `/api/host/sessions/:id/delete` | the session's host | Declined or withdrawn only: hide it (409 otherwise) |
| GET | `/api/staff/host-sessions?status=` | staff, admin | Sessions by status (default `submitted`) |
| POST | `/api/staff/host-sessions/:id/decision` | staff, admin | `{ decision: "approve" \| "decline", note? }` |
| GET | `/api/staff/hosts` | approver, admin | List hosts |
| GET | `/api/staff/hosted-dates` | approver, admin | Hosted dates in the next 3 weeks, with bookings ([RTD_BOOKINGS.md](RTD_BOOKINGS.md)) |
| POST | `/api/host/occurrences/:id/cancel` | the session's host, approver, admin | Cancel one date; everyone booked is emailed |
| GET | `/api/staff/sign-in` | anyone Access lets in | Redirects to `/organise` after Access sign-in |
| GET | `/internal/host-sessions/followups` | n8n (bearer token) | One-off sessions due the follow-up email |
| POST | `/internal/host-sessions/:id/followup-sent` | n8n (bearer token) | Record that the email went out (409 if already) |
| GET | `/internal/host-sessions/new-submissions` | n8n (bearer token) | Submissions the café hasn't been emailed about |
| POST | `/internal/host-sessions/:id/cafe-notified` | n8n (bearer token) | Record the café email |
| GET | `/internal/host-sessions/to-publish` | n8n (bearer token) | Approved sessions, each with its Event Index row |
| POST | `/internal/host-sessions/:id/published` | n8n (bearer token) | Mark Live once the row is in the sheet (409 if no longer approved) |

## From approval to the diary

The Logic Engine stays the one master calendar (audit §6). n8n **RTD Host Sessions To Diary** (`rdS8LF56B9k170BY`, every 15 minutes) does the sheet work; details are in [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#rtd-host-sessions-to-diary-rds8lf56b9k170by).

1. **Submitted:** the café gets an email with the details and a link to `/organise`. Replying to that email reaches the host.
2. **Approved:**
   - **Added to the sheet:** within 15 minutes the session is added to **Event Index** as a new row:
     - **Values:** Event Name, Frequency (`One-off` or `Weekly`), Day, Event Date, Event Time, End Time, Base Details (the description), Status `Active` and Organiser Email.
     - **App columns:** App Visibility `Public` (open) or `Private`, App Category `Gaming`, **App Price**, **App Capacity** and **App Host Session** (the `RTD-HS` number).
   - **Marked Live:** the session shows as **Live** for its host.
   - **Host emailed:** within 15 minutes the host gets "Approved: …" (or "Not approved: …" with the café's note), from n8n **RTD Team Notices**.
3. **In the diary:** the next Event Sync gives the row an Event ID and links it back to the session.
   - **Open sessions** show in full, with "£5 per player, paid at the café" and "Up to 6 players" on the event page.
   - **Private sessions** show only as "Private session" and their time.
4. **Advertising:**
   - **Open sessions** appear in the evening round-up and Sunday weekly social posts, like any other event.
   - **Their own posts and posters:** they get a dedicated hourly post or a poster only if Michelle adds a prompt and a photo folder to the row.
   - **Private sessions are never advertised:** they're left out of every post, and they get no poster.
5. **Afterwards:**
   - **Weekly sessions** roll forward each week.
   - **One-offs** go Inactive after their date, without the café's "pick a new date" email: the host gets the follow-up email instead.

**To change a live session:** edit its Event Index row (for example, set Status to `Inactive` to stop it). Hosts can't withdraw a session once it's live, but they can cancel any of its dates in the organiser; people booked are emailed and the date is taken out of the Logic Engine ([RTD_BOOKINGS.md](RTD_BOOKINGS.md#for-hosts-numbers-and-cancelling)).
