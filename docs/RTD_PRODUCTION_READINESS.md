# RTD App: Feature Status and Production Readiness

_As of 6 October 2026. Live app: https://rtd-app.dan-289.workers.dev_

## Summary

- **What works today:**
  - **Public app:** an installable diary app with event pages and photos.
  - **Host organiser:** hosts propose sessions and the café approves them.
  - **Onboarding:** hosts and café staff ask for access themselves. Michelle approves hosts, and Dan approves café staff.
  - **Automations:** they put approved sessions in the diary, keep private sessions out of social posts, and follow up with hosts after one-off sessions.
- **What "production" means here.** There are two sensible milestones:
  - **Launch A, soft launch:** the public diary app and the host organiser, as they are now. This needs about a dozen jobs, mostly decisions, security tidy-ups and real-phone testing (§3.1). No big new features.
  - **Launch B, the full specification:** online booking, push reminders, the real game library, and a full staff dashboard (Phases 3–9). This is the bulk of the remaining build, and booking is the largest part.

Status words below: **Live** (built and running), **Partial** (some of it works), **Not started**.

## 1. Feature status

### Data and sync (spec Phase 1): Live

| Feature | Status | Notes |
| --- | --- | --- |
| Permanent event IDs in the Logic Engine | Live | `Event ID`, `App Visibility` and `App Category` columns, backfilled |
| Event / occurrence split, with history | Live | A date roll-forward never erases a past occurrence |
| App database (Cloudflare D1) | Live | Migrations 0001–0007 applied |
| Logic Engine sync (n8n, every 15 min) | Live | It's all-or-nothing and safe to repeat, and it refuses a snapshot that loses half the events. 36 runs OK, 0 refused |
| Audit log | Live | Every sync change, host-session change, join request, decision and change of access is recorded |
| Staff and host sign-in | Live | Cloudflare Access email code. The app's `users` table decides roles. Dan's sign-in tested on 5 Oct |

### Public app (spec Phase 2): Live, except analytics

| Feature | Status | Notes |
| --- | --- | --- |
| Branded, installable PWA | Live | Theme from the café logo; install banner with iPhone help; offline diary |
| Home | Live | Tonight / Next up, Coming Up, Roll promo, Game of the Week, Book; "Plus N private sessions today" |
| Diary | Live | Today / This week / This month, with category filters. Private sessions show as "Private session" only |
| Event pages | Live | Date, time, price and max players (when known), photo gallery, Add to Calendar (.ics / Google), Share, other dates |
| 14-day event splash | Live | At most once per visit; never a private session |
| Deep links and link previews | Live | `/event/…` and `/events/…`; previews name the event |
| Event photos from Drive | Live | 65 photos across 9 events, refreshed every 6 hours; `noapp` in a file name keeps a photo out |
| Analytics | **Not started** | Needs a Cloudflare Web Analytics token (cookieless), or our own counts |

### Host organiser (spec Phase 6): mostly live

| Feature | Status | Notes |
| --- | --- | --- |
| Host dashboard and session list | Live | `/organise`: Next session, statuses, withdraw |
| Create a session | Live | Name, one-off or weekly, open or private, date, times, cost, max players, description |
| Café email on each submission | Live | n8n RTD Host Sessions To Diary; replies go to the host |
| Staff approve or decline | Live | On the same page; a decline can include a note for the host |
| Approved session into the Logic Engine, then the diary | Live | Appended to Event Index within 15 minutes, then synced. The full path hasn't had a real approval yet |
| Private sessions never advertised | Live | Master V1 round-ups and hourly posts, and Event Guard posters, skip `App Visibility = Private` |
| Follow-up email after a one-off | Live | Daily at 10:00; test email sent to Dan on 5 Oct |
| Staff add hosts | Live | Name and sign-in email |
| Host notified of approve / decline | Live | n8n RTD Team Notices emails the host within 15 minutes, with the café's note |
| Join requests (hosts and café staff) | Live | See [RTD_ONBOARDING.md](RTD_ONBOARDING.md). Staff approve hosts; only admins approve café staff. Approver and applicant are emailed |
| Removing access | Live | Staff remove hosts; admins also remove café staff |
| Host edits a session | **Not started** | Hosts can withdraw before it goes live; after that the café edits the sheet |
| Host sees bookings | **Not started** | Needs booking (Phase 5) |

### Everything else in the specification

| Area | Status | Notes |
| --- | --- | --- |
| Notifications (Phase 3) | **Not started** | Push opt-in and 4-hour reminders. On iPhone, push only works once the app is installed to the Home Screen |
| Games (Phase 4) | **Partial** | Roll Me a Game (3D dice, filters, Chaos Roll), the game library and Game of the Week work on a labelled *preview shelf* of sample games. Needs the café's real inventory, staff editing and the weekly automation |
| Booking (Phase 5) | **Not started** | Multi-person bookings, capacity, confirmation email, secure cancellation, waiting list, daily digest. Decisions needed first (§4) |
| Become a Host (Phase 7) | **Partial** | **Apply to host** signs people in and takes their request, which the café approves in the organiser ([RTD_ONBOARDING.md](RTD_ONBOARDING.md)). Not built: a form for people without an email sign-in, and a richer host profile |
| Staff Control (Phase 8) | **Partial** | In `/organise`: approvals, join requests, hosts and the café team (admins add staff by approving their request). Sync history and audit exist as an API but have no screen. No event, booking or settings controls |
| Hardening (Phase 9) | **Partial** | See §5 for what's already covered, and §3 for what's left |

## 2. What's running where

| Part | Where | Schedule / notes |
| --- | --- | --- |
| App (Worker + static PWA) | Cloudflare Workers `rtd-app`, deployed from GitHub `main` on every push | Worker logs on |
| Database | Cloudflare D1 `rtd-app` | 24 active events, 40 upcoming dates. Time Travel restore: 7 days on the free plan |
| Photos | Cloudflare Workers KV `rtd-app-images` | About 10.6 MB |
| Sign-in | Cloudflare Access application "RTD Staff" (team `solitary-thunder-9de0`) | Protects `/api/staff`. The organiser signs in through it |
| RTD Event Sync | n8n on the Pi | Every 15 min: sheet → app |
| RTD Event Images | n8n | Every 6 hours: Drive photos → app |
| RTD Host Sessions To Diary | n8n | Every 15 min: café emails, and approved sessions → Event Index |
| RTD Host Follow-up | n8n | Daily 10:00: email to the host after a one-off |
| RTD Master V1 and Event Guard | n8n (existing) | Social posts, calendar, date roll-forward, posters, expiry. Edited 5 Oct; rollback versions in [RTD_N8N_WORKFLOWS.md](RTD_N8N_WORKFLOWS.md) |
| Config | n8n data table `rtd_config` | App URL and café email |
| Outgoing email | Dan's "ATech GMAIL" in n8n | Café notices and host follow-ups |

## 3. Going to production

Who: **You** = Dan; **Michelle** = café; **Claude** = me.

### 3.1 Must do before Launch A

| # | Job | Why | Who |
| --- | --- | --- | --- |
| 1 | **Choose and connect the app's domain** (for example `app.<café domain>`) | `workers.dev` doesn't look like the café. An installed app is tied to its address: people who install it now would have to reinstall after a move, so do this **before** promoting installs. The Access sign-in, `rtd_config` and link previews all move with it | You choose the domain and put it on Cloudflare; Claude does the rest |
| 2 | **Rotate the ImageKit key and the Meta page token** (audit S1) | Both are hard-coded in RTD Master V1, so anyone who can open or export that workflow can see them | You rotate; Claude moves them into n8n credentials |
| 3 | **Lock down or switch off the website-requests webhook** (S3) | It's public, with no checks, and it writes unescaped input into an email | Your decision; Claude makes the change |
| 4 | **Confirm the n8n editor isn't public** (S6) | Only `/webhook/*` and `/form/*` should be reachable from the internet | You (or Claude, with access to the Pi's proxy settings) |
| 5 | **Privacy notice and data retention** (S7, spec §49) | The app holds host names and emails. The sheet holds organiser emails. Photos may show customers. Add a privacy page, set retention rules, and check whether the café already pays the ICO data protection fee | You for the wording and legal checks; Claude adds the page |
| 6 | **Give café staff accounts** | Only Dan has an account today. Michelle signs in at `/organise`, asks for **Café team**, and Dan approves it under **Join requests** | Michelle, then you |
| 7 | **Let hosts and staff through sign-in** | The RTD Staff Access policy must let new people sign in so they can ask for access: **Include → Everyone**, since the app decides who gets in | You, in the Cloudflare dashboard |
| 8 | **One real host session end to end** | Sign-in and submitting are tested. Approve → sheet row → diary → follow-up hasn't run on a real session. Use a **Private** session, so nothing gets posted | You, then Claude checks each step |
| 9 | **Copy the Event Guard edits into `rtd-poster-automation`** | The next build of that project would silently undo "no posters for private sessions" and "no date request for host sessions" | You push the project to GitHub; Claude makes the change |
| 10 | **Real-phone testing** | So far only automated Chromium screenshots. Test iPhone Safari (browser and installed), Android Chrome, the Facebook/Instagram in-app browser, and host sign-in on a phone | You and Michelle, with a checklist from Claude |
| 11 | **Diary content check** | Mark private group bookings (e.g. GirlsGetOut, National Coastguard Institute, DM sessions) as `Private`, confirm categories, and confirm the Blood on the Clocktower date (it rolled to 4 Nov before the monthly fix) | Michelle |
| 12 | **Café street address** | Calendar entries show only "Roll The Dice Board Game Café, Cleethorpes" | You |

### 3.2 Should do before Launch A

| Job | Why | Who |
| --- | --- | --- |
| **Analytics** (Cloudflare Web Analytics) | Spec Phase 2; cookieless, so no consent banner needed for it | You create the token; Claude adds it |
| **Alert if the sync stops** | The n8n error handler covers failed runs, but not "the Pi is off". An uptime check on `/api/health` that also checks the last-sync time would catch it | Claude adds a "stale" flag; you pick the alert channel |
| **Weekly database export** | Time Travel only goes back 7 days on the free plan. A weekly export to Drive, or the paid plan (30 days), covers longer | Claude |
| **Send emails from the café, not Dan's Gmail** | Café notices, host follow-ups and the onboarding and decision emails currently come from ATech Gmail. A café address or a transactional provider looks right, and booking needs one anyway | Decision (§4); Claude wires it |
| **Decide on the games preview** | Roll Me a Game and Game of the Week use sample games (labelled Preview). Either keep that label or hide them until the inventory arrives | You |
| **Rate limiting** | A Cloudflare rate-limiting rule on the public API, once on the custom domain. Essential before booking | Claude |
| **Hide `/styleguide`** | It's an internal design page, reachable by anyone who knows the address | Claude |
| **Event Guard's 3-a-night limit** | If more than 3 events expire on the same night, the Guard refuses to act; host one-offs count towards that | Claude, in `rtd-poster-automation` |
| **Tidy n8n** | Archive the two "RTD One-Off" workflows | Claude |
| **Brand the sign-in page** (optional) | The one-time-code page is Cloudflare's default | You, in Zero Trust settings |

### 3.3 For Launch B (the full specification)

1. **Booking (Phase 5).** The biggest piece:
   - **The flow:** capacity-safe multi-person bookings without accounts, confirmation emails, cancellation links, a waiting list with offer expiry, staff controls and the daily booking digest.
   - **Before building:** the email provider and sending domain, how capacity and booking cut-off are set (new sheet columns or app-only), and which events to pilot.
2. **Push reminders (Phase 3):** opt-in, a reminder 4 hours before, no duplicates, and an audit trail.
3. **Games (Phase 4):** the café's inventory, staff editing, and Game of the Week rotating automatically.
4. **Become a Host (Phase 7) extras:** request and approval are built; still to come is a richer host profile (games, experience, availability).
5. **Staff Control (Phase 8):** one dashboard for events, bookings, waitlists, games, audit and settings. Approvals, join requests, hosts and the café team are already in `/organise`.
6. **Host portal extras:** editing a session, change notifications, booking lists for hosts.
7. **Hardening (Phase 9):** security and permissions review, booking race-condition tests, n8n failure tests, a backup and restore drill, an accessibility review with a screen reader, a performance review, and a data-protection review.
8. **Reliability work from the audit:**
   - Split the 178-node RTD Master V1 into smaller workflows.
   - Make the Google Calendar rebuild update events in place, rather than delete-then-create.
   - Move hard-coded recipient emails into `rtd_config` (S4).

## 4. Decisions needed from you

1. **Domain** for the app (§3.1 #1).
2. **Email:** which provider and sending address for app emails (audit decision 11). Resend, Postmark or a café Gmail.
3. **Website webhook:** switch off, or lock down (audit 6).
4. **Key rotation:** ImageKit and Meta (audit 7).
5. **Buffer account:** is posting Ninth Archive content through "RTD Buffer" intended (audit 9)?
6. **Diary contents:** which Standard Diary groups are public, private or hidden; whether inactive clubs with future dates should show (audit 10).
7. **Games:** keep the preview shelf or hide it; when the inventory can be provided.
8. **Café Google Calendar:** is "Roll The Dice Cafe" public? If so, private session names would be visible there.
9. **Street address** for calendar entries.
10. **Booking pilot:** which events, with what capacity, and when booking closes.
11. **Optional:** a vector or larger logo for sharper icons.

## 5. Already in place

- **Tests:** 157 automated tests, covering sync, the API, sign-in, host sessions, privacy redaction, calendar files, photos and colour contrast.
- **Safe sync:** each sync lands completely or not at all. The app keeps serving the last good data if the sheet or the Pi breaks, and refuses a snapshot that loses half the events.
- **Private sessions:** the server strips their details, so the name, description, photo, price and size never reach the public. They have no page, preview or calendar file.
- **Security:**
  - **Sign-in:** checked on every request by verifying Cloudflare's signed token.
  - **Roles:** come from the app's own table.
  - **Organiser changes:** must come from the app's own pages as JSON.
  - **n8n endpoints:** need a secret token, checked in constant time.
  - **Browser rules:** a strict content security policy and security headers.
- **Audit trail:** for event changes, host sessions, decisions and n8n actions.
- **Recovery steps:** in [RTD_RECOVERY.md](RTD_RECOVERY.md) for bad deploys, bad syncs, sign-in lockout and each n8n change.
- **Accessibility basics:** WCAG contrast checked in tests, reduced motion, keyboard skip link, labelled controls, tap targets of 40px or more.
- **Cost:** expected traffic fits Cloudflare's free plans.

## 6. Suggested order

1. **Decide:** domain, email sender, webhook, key rotation (§4 items 1–4).
2. **Security tidy-up:** rotate the keys, lock the webhook, confirm n8n isn't public, and push `rtd-poster-automation`.
3. **Move to the domain,** before anyone is asked to install the app.
4. **Staff and hosts:** the Access policy, then Michelle asks for a café team account and Dan approves it, then one Private trial session end to end.
5. **Polish:** privacy page, analytics, sync alert, weekly export, café sender address.
6. **Phones:** real-device test round with Michelle; fix what it finds.
7. **Soft launch (Launch A):** tell regulars and hosts; watch the sync, analytics and the café inbox for a couple of weeks.
8. **Phase 5 booking,** then push reminders, games and the staff dashboard (Launch B).
