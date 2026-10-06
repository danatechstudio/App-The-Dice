# RTD Onboarding: hosts and café staff

People ask for access to the organiser (`/organise`) themselves, and someone approves them. It's the same flow for game hosts and café staff; only the approver differs.

## Status (2026-10-06)

| Part | State |
| --- | --- |
| Join screen: ask to host games or join the café team, see the request, withdraw it | **Built** |
| Join requests in the organiser: approve, or decline with a note | **Built** |
| Approval grants access straight away (no second step) | **Built** |
| Removing access (offboarding) | **Built** |
| Emails: the approver about each new request, the applicant about the outcome | **Built** (n8n **RTD Team Notices**) |
| Emails to hosts when the café approves or declines a session | **Built** (same workflow) |
| An existing host asking to join the café team | Not yet: see [Limits](#limits) |

## Who approves what

| Request | Approved by | In practice |
| --- | --- | --- |
| **Host games** | Café team (staff) or an admin | Michelle |
| **Café team** | An admin only | Dan |
| **Host sessions** (bookings of a table by a host) | Café team (staff) or an admin | Michelle. See [RTD_HOST_PORTAL.md](RTD_HOST_PORTAL.md). |

**Who sees what:**
- **Staff** see only host requests under **Join requests**. A café team request never appears for them, and the API refuses it (403) if they try.
- **Admins** see both kinds.

**Roles:**
- **Where they live:** the `users` table: `host`, `staff` or `admin`.
- **Cloudflare Access:** only proves someone's email address. It doesn't decide what they can do.

## The flow

1. **Sign in.** The person opens `/organise` (or **Apply to host** on the Become a Host page) and signs in with their email through Cloudflare Access, which sends a one-time code.
2. **Ask.** Someone without access sees **Join Roll The Dice** instead of the dashboard:
   - **I would like to:** **Host games** or **Café team**.
   - **Your name:** 2–60 characters.
   - **About:** 3–500 characters. Hosts answer "What would you like to run?"; café team requests answer "Your role at the café".
3. **Wait.** They see "Your request to host is with the café team." or "Your café team request is with an admin.", with a **Withdraw** button.
4. **The approver is emailed** within 15 minutes:
   - **Where it goes:** host requests go to the café address (`RTD_CAFE_NOTIFICATION_EMAIL` in the n8n `rtd_config` table); café team requests go to every active admin.
   - **Replying:** replying to the email reaches the applicant.
5. **Decide.** In the organiser, **Join requests** sits at the top of the café team section. Each card shows the name, email, role asked for and what they wrote:
   - **Approve:** **Approve host** or **Approve for café team**.
   - **Decline:** with an optional note, which the applicant sees.
6. **Approval takes effect immediately.**
   - **Their account:** the person gets a `users` row with the role they asked for, or their old row is turned back on.
   - **Next sign-in:** the next time they open `/organise`, they get the dashboard.
   - **Higher roles are kept:** approving a host request never downgrades someone who is already staff or an admin.
7. **The applicant is emailed** within 15 minutes:
   - **Approved:** "You are now a Roll The Dice host" or "Welcome to the Roll The Dice café team", with a link to the organiser.
   - **Declined:** "Your Roll The Dice request", with the note.
   - **Replying:** replies go to the café.
8. **After a decline:** they see "Your last request wasn't approved." with the note, and can send another.

**Rules:**
- **One request at a time:** a second request while one is waiting gets "You already have a request waiting." (409).
- **Daily limit:** at most 3 requests per email address in 24 hours (429), so nobody can flood the approver with emails.
- **No duplicate access:** someone who already has access gets "You already have access." (409).
- **One decision only:** if two people decide the same request at once, the second gets "Someone else has just decided this request." (409).
- **Numbering:** requests are numbered `RTD-APP-00001` upwards.

## Removing access

| Who | Can remove |
| --- | --- |
| Staff | Hosts (**Hosts** table, **Remove**) |
| Admin | Hosts, and café team members (**Café team** table, admins only) |
| Nobody | Themselves, or an admin. Admins are changed in the database, so the café can't lock itself out. |

**What removing does:**
- **Access:** it sets `users.active = 0`. They can still sign in through Access, but they see the join screen, not the dashboard.
- **Sessions:** sessions already in the diary stay. Change those in the Logic Engine.
- **Coming back:** someone who was removed can ask again. Approving them turns their old `users` row back on, so the audit trail follows one person.

## Audit

Every step is written to `audit_log` with source `organiser`:

| Action | Entity | Actor |
| --- | --- | --- |
| `application.host.submitted` / `application.staff.submitted` | `application` | the applicant (`customer`) |
| `application.withdrawn` | `application` | the applicant |
| `application.approved` / `application.declined` | `application` | the approver (`staff`); the note is kept |
| `user.granted_host` / `user.granted_staff` | `user` | the approver |
| `user.removed_host` / `user.removed_staff` | `user` | whoever removed them |

## Emails (n8n RTD Team Notices)

Workflow `diKojCurHeRWQjAR`, every 15 minutes. Details are in [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md#rtd-team-notices-dikojcurherwqjar).

| Email | To | Reply goes to | When |
| --- | --- | --- | --- |
| New host request | The café address | The applicant | Within 15 min of the request |
| New café team request | Every active admin | The applicant | Within 15 min of the request |
| Request approved or declined | The applicant | The café address | Within 15 min of the decision |
| Session approved or not approved | The host | The café address | Within 15 min of the decision |

**How they behave:**
- **Sent once:** n8n sends each email, then marks it sent in the app (`approver_notified_at`, `applicant_notified_at`, `host_sessions.host_notified_at`). A failed send is retried on the next run.
- **Two-week window:** outcomes and session decisions older than 14 days aren't emailed, so an outage doesn't send a burst of stale emails.
- **Session emails:**
  - **Private sessions:** the email says they show only as "Private session" and won't be advertised.
  - **Open sessions:** it says they'll be in the diary within 15 minutes.
- **Safe to show:** everything people typed (names, notes, descriptions) is escaped before it goes into the HTML.
- **Other workflows:** the café's "new session to approve" email is unchanged (**RTD Host Sessions To Diary**).

## Before anyone can apply

**Cloudflare Access must let them sign in.** The **RTD Staff** application's policy decides who can sign in at all:
- **Include → Everyone (recommended):** anyone can prove their email, and approval decides who gets in.
- **Specific emails only:** applicants can't reach the join screen until their email is added to the policy.

To change it: Cloudflare Zero Trust → Access → Applications → **RTD Staff** → Policies.

**Setting up Michelle as café staff:**
1. Michelle signs in at `/organise` and asks for **Café team**.
2. Dan approves it under **Join requests**.

## API

`/api/join` needs a valid Access sign-in, but no role. `/api/staff` needs staff or admin. Changes must be JSON from our own pages (403 for other sites, 415 for non-JSON).

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/join/me` | anyone signed in | `{ email, has_access, application }`: their latest request |
| POST | `/api/join/apply` | anyone signed in | `{ role: "host" \| "staff", display_name, about }`. 201, or 400 / 409 / 429. |
| POST | `/api/join/withdraw` | the applicant | Withdraw a waiting request (409 if none) |
| GET | `/api/staff/applications?status=pending` | staff, admin | Requests this person may decide |
| POST | `/api/staff/applications/:id/decision` | staff (hosts), admin (both) | `{ decision: "approve" \| "decline", note? }` |
| GET | `/api/staff/team` | admin | Active staff and admins |
| POST | `/api/staff/users/:id/remove` | staff (hosts), admin (hosts and staff) | Remove access |
| GET | `/internal/applications/new` | n8n (bearer token) | Requests the approver hasn't been emailed about, with who to email |
| POST | `/internal/applications/:id/approver-notified` | n8n | Record that email |
| GET | `/internal/applications/decided` | n8n | Decisions the applicant hasn't been emailed about |
| POST | `/internal/applications/:id/applicant-notified` | n8n | Record that email |
| GET | `/internal/host-sessions/decided` | n8n | Session decisions the host hasn't been emailed about |
| POST | `/internal/host-sessions/:id/host-notified` | n8n | Record that email |

`GET /api/host/me` also returns `is_admin`, so the organiser knows to show café team requests and the **Café team** table.

## Limits

- **An existing host can't ask to join the café team.** They already have access, so they see the dashboard, not the join screen. For now, an admin changes their role in the database (`UPDATE users SET role = 'staff' …`).
- **Who counts as an approver:**
  - **Host requests and sessions:** any staff account can approve them, not only Michelle. To make Michelle the only approver, keep Michelle as the only staff account, or ask for a per-person rule.
  - **Café team requests:** any admin can approve them. Dan is the only admin today.
- **Customer booking requests:** these are Phase 5 (bookings), not built yet. When they are, they go to the same café address, so Michelle.
