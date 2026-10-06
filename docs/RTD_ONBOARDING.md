# RTD Onboarding: hosts and café staff

People ask for access to the organiser (`/organise`) themselves, and an approver says yes or no. **Hosts and café staff join the same way, and both become hosts:** the only thing they can do is plan sessions to host. Michelle approves every session before it goes on the app.

## Status (2026-10-06)

| Part | State |
| --- | --- |
| Join screen: ask to host, see the request, withdraw it | **Built** |
| Join requests in the organiser: approve, or decline with a note | **Built** |
| Approval grants access straight away (no second step) | **Built** |
| Approvers chosen by an admin (Make approver / Stop approving) | **Built** |
| Removing access (offboarding) | **Built** |
| Emails: the approvers about each new request, the applicant about the outcome | **Built** (n8n **RTD Team Notices**) |
| Emails to hosts when a session is approved or declined | **Built** (same workflow) |

## Roles

| Role (`users.role`) | Shown as | Can |
| --- | --- | --- |
| `host` | Host | Plan sessions to host, see who's booked, and cancel a date. **Nothing else.** Everyone approved through a join request, café staff included, is a host. |
| `staff` | Approver | Everything a host can, plus approve or decline join requests and sessions, remove hosts, and cancel any hosted date. **Michelle.** |
| `admin` | Admin | Everything an approver can, plus choose approvers and remove approvers. **Dan.** |

**How roles work:**
- **Where they live:** the `users` table decides roles. Cloudflare Access only proves someone's email address.
- **Making an approver:** an admin uses **Make approver** in the Hosts table. **Stop approving** turns an approver back into a host, keeping their sessions.
- **Admins:** they're only changed in the database, so the café can't lock itself out.

## The flow

1. **Sign in.** The person opens `/organise` (or **Apply to host** on the Become a Host page) and signs in with their email through Cloudflare Access, which sends a one-time code.
2. **Ask.** Someone without access sees **Join Roll The Dice** instead of the dashboard, with one form, **Ask to host games**:
   - **Your name:** 2–60 characters.
   - **What would you like to run?:** 3–500 characters. Café staff say so here.
3. **Wait.** They see "Your request is with the café.", with a **Withdraw** button.
4. **The approvers are emailed** within 15 minutes. The email goes to the café address (`RTD_CAFE_NOTIFICATION_EMAIL` in the n8n `rtd_config` table), and replying to it reaches the applicant.
5. **Decide.** **Join requests** sits at the top of the approver section of the organiser. Approvers and admins see every request.
   - **Approve:** the person becomes a host straight away.
   - **Decline:** can include a note, which the applicant sees.
6. **Approval takes effect immediately.** The person gets a `users` row as a host, or their old row is turned back on. An approver or admin who somehow asks again keeps their role: approval never downgrades anyone.
7. **The applicant is emailed** within 15 minutes:
   - **Approved:** "You are now a Roll The Dice host", with a link to the organiser.
   - **Declined:** "Your Roll The Dice request", with the note.
   - **Replies:** go to the café.
8. **After a decline:** they see "Your last request wasn't approved." with the note, and can send another.

**Rules:**
- **One request at a time:** a second request while one is waiting gets "You already have a request waiting." (409).
- **Daily limit:** at most 3 requests per email address in 24 hours (429).
- **No duplicate access:** someone who already has access gets "You already have access." (409).
- **One decision only:** if two people decide the same request at once, the second gets "Someone else has just decided this request." (409).
- **Numbering:** requests are numbered `RTD-APP-00001` upwards.
- **No other way in:** there is no "add a host" form. Everyone comes through a join request, so every approval is recorded.

## Removing access

| Who | Can remove |
| --- | --- |
| Approver | Hosts (**Hosts** table, **Remove**) |
| Admin | Hosts and approvers |
| Nobody | Themselves, or an admin |

**What removing does:**
- **Access:** it sets `users.active = 0`. They can still sign in through Access, but they see the join screen, not the dashboard.
- **Sessions:** sessions already in the diary stay. Cancel their dates in the organiser (so anyone booked is told), or change them in the Logic Engine.
- **Coming back:** someone who was removed can ask again. Approving them turns their old `users` row back on, so the audit trail follows one person.

## Audit

Every step is written to `audit_log` with source `organiser`:

| Action | Entity | Actor |
| --- | --- | --- |
| `application.host.submitted` | `application` | the applicant (`customer`) |
| `application.withdrawn` | `application` | the applicant |
| `application.approved` / `application.declined` | `application` | the approver (`staff`); the note is kept |
| `user.granted_host` | `user` | the approver |
| `user.made_approver` / `user.approver_removed` | `user` | the admin |
| `user.removed_host` / `user.removed_staff` | `user` | whoever removed them |

Requests made before 2026-10-06 may say `application.staff.submitted` and `user.granted_staff`; that was the old "café team" request.

## Emails (n8n RTD Team Notices)

Workflow `diKojCurHeRWQjAR`, every 15 minutes. Details are in [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#rtd-team-notices-dikojcurherwqjar).

| Email | To | Reply goes to | When |
| --- | --- | --- | --- |
| New host request | The café address | The applicant | Within 15 min of the request |
| Request approved or declined | The applicant | The café address | Within 15 min of the decision |
| Session approved or not approved | The host | The café address | Within 15 min of the decision |

**How they behave:**
- **Sent once:** n8n sends each email, then marks it sent in the app (`approver_notified_at`, `applicant_notified_at`, `host_sessions.host_notified_at`). A failed send is retried on the next run.
- **Two-week window:** outcomes and session decisions older than 14 days aren't emailed, so an outage doesn't send a burst of stale emails.
- **Safe to show:** everything people typed is escaped before it goes into the HTML.
- **Booking emails** (bookings, the two-day numbers email, cancellations) are separate: see [RTD_BOOKINGS.md](RTD_BOOKINGS.md).
- **Push notifications:** approvers and admins can also get a push on their phone or computer for each join request and session to approve. See [RTD_PUSH.md](RTD_PUSH.md).

## Before anyone can apply

**Cloudflare Access must let them sign in.** The **RTD Staff** application's policy decides who can sign in at all:
- **Include → Everyone (recommended):** anyone can prove their email, and approval decides who gets in.
- **Specific emails only:** applicants can't reach the join screen until their email is added to the policy.

To change it: Cloudflare Zero Trust → Access → Applications → **RTD Staff** → Policies.

**Setting up Michelle as the approver:**
1. Michelle signs in at `/organise` and asks to host.
2. Dan approves it under **Join requests**, then uses **Make approver** next to Michelle in the Hosts table.

## API

`/api/join` needs a valid Access sign-in, but no role. `/api/staff` needs an approver or admin. Changes must be JSON from our own pages (403 for other sites, 415 for non-JSON).

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/join/me` | anyone signed in | `{ email, has_access, application }`: their latest request |
| POST | `/api/join/apply` | anyone signed in | `{ display_name, about }`. 201, or 400 / 409 / 429. |
| POST | `/api/join/withdraw` | the applicant | Withdraw a waiting request (409 if none) |
| GET | `/api/staff/applications?status=pending` | approver, admin | Join requests |
| POST | `/api/staff/applications/:id/decision` | approver, admin | `{ decision: "approve" \| "decline", note? }` |
| GET | `/api/staff/hosts` | approver, admin | Hosts |
| GET | `/api/staff/approvers` | admin | Approvers and admins |
| POST | `/api/staff/users/:id/approver` | admin | `{ approver: true \| false }`: make an approver, or back to host |
| POST | `/api/staff/users/:id/remove` | approver (hosts), admin (hosts and approvers) | Remove access |
| GET | `/internal/applications/new` | n8n (bearer token) | Requests the approvers haven't been emailed about |
| POST | `/internal/applications/:id/approver-notified` | n8n | Record that email |
| GET | `/internal/applications/decided` | n8n | Decisions the applicant hasn't been emailed about |
| POST | `/internal/applications/:id/applicant-notified` | n8n | Record that email |
| GET | `/internal/host-sessions/decided` | n8n | Session decisions the host hasn't been emailed about |
| POST | `/internal/host-sessions/:id/host-notified` | n8n | Record that email |

`GET /api/host/me` returns `can_review` (approver or admin) and `is_admin`, so the organiser knows what to show.

## Limits

- **Every approver approves everything.** Today Michelle is the only one (Dan, as admin, can too). A second approver would see the same requests and sessions.
- **Café staff have no extra powers.** By design: they host like anyone else. Anything café-wide (events, the diary) stays in the Logic Engine.
