# Roll The Dice Companion App: Audit, Architecture & Build Specification

| | |
| --- | --- |
| **Project** | Roll The Dice Companion App |
| **Primary purpose** | Event diary and promotional companion |
| **Secondary purposes** | Random game selector, Game of the Week, event/session booking, host management, notifications, staff controls |
| **Primary event source** | RTD Logic Engine |
| **Automation platform** | Existing n8n server |
| **Target format** | Progressive Web App (PWA), with future option to wrap for native app stores |
| **Branding** | Existing Roll The Dice logos and brand identity |

---

## 1. Objective

Build a Roll The Dice companion application that works primarily as an installable web application.

The app should promote upcoming activity at Roll The Dice while also providing useful features that encourage repeat use.

The core functions are:

1. Event diary
2. Upcoming-event promotional splash screens
3. Push notifications
4. Random game selection
5. Game of the Week
6. Customer booking
7. Host portal
8. Become a Host application
9. Staff control panel
10. Integration with the existing RTD Logic Engine and n8n environment
11. Booking, event and host audit history
12. Daily booking summary email
13. Automatic handling of recurring events requiring a new date

The project must reuse the current Roll The Dice automation architecture wherever sensible rather than unnecessarily rebuilding working systems.

## 2. Mandatory First Stage: Existing-System Audit

Do not begin by rebuilding the existing system. First perform a full audit of the current Roll The Dice automation environment.

Review:

- RTD Logic Engine
- RTD Master workflows
- Existing booking system
- Existing event approval process
- Existing event creation logic
- Poster generation
- Event expiry logic
- Recurring event handling
- Google Sheets or other event stores
- Existing email nodes
- Existing host/event organiser information
- Social-media automation
- Existing event IDs, if any
- Existing logs
- Any current status fields
- Any approval history
- Any duplicated event data
- Any abandoned or obsolete workflows

Produce a concise audit before changing anything. The audit should identify:

- What currently works
- What should be retained
- What should be modified
- What should be retired
- Any duplicate workflows
- Any conflicting event sources
- Any fragile integrations
- Missing audit/logging functionality
- Missing unique identifiers
- Data quality issues
- Security concerns
- Booking-system weaknesses
- Opportunities to simplify the current n8n environment

The app must integrate into the existing RTD framework rather than creating a disconnected second event-management system.

## 3. Core Architectural Principle

The RTD Logic Engine remains the primary event source. The app should not become a second master calendar.

Target architecture:

```
RTD Logic Engine
      │
      ▼
n8n RTD Event Controller
      │
      ├──────────────► Social / Poster Automation
      │
      ├──────────────► Email / Staff Notifications
      │
      ├──────────────► Audit / Event Logging
      │
      ▼
App Database / API
      │
      ├──────────────► Customer App
      │
      ├──────────────► Host Portal
      │
      └──────────────► Staff Control
```

The customer-facing app must continue functioning even if n8n is temporarily unavailable.

Do not make n8n the live database serving every page request. Use n8n for orchestration, synchronisation, workflows, scheduled actions and reporting.

## 4. Recommended Application Structure

The public app should contain five main navigation areas:

1. Home
2. Diary
3. Roll a Game
4. Book
5. Games

Additional protected areas:

6. Host Portal
7. Staff Control

Public users do not require accounts. Host and staff areas require authentication.

## 5. PWA Requirements

Build the application as a Progressive Web App.

- Installable from supported browsers
- Mobile-first design
- Desktop-compatible
- Responsive layout
- HTTPS
- Service worker
- App manifest
- Local caching where sensible
- Push notification support
- Fast startup
- Graceful offline handling
- Cached basic game information
- Cached upcoming-event information where appropriate
- Deep links to events and booking pages

The architecture should remain compatible with future wrapping through Capacitor or similar technology if Roll The Dice later chooses Play Store or App Store distribution. Do not require native-app packaging in V1.

## 6. Branding

Use the existing Roll The Dice brand identity.

- Current RTD logo
- Existing visual identity
- Familiar typography and styling where practical
- Playful board-game feel
- Dice animations
- Game-table / board-game inspired UI
- Clear accessibility
- Strong mobile usability

Avoid making the app feel like a corporate booking system. The app should feel recognisably Roll The Dice.

## 7. Home Screen

The Home screen should focus on activity happening at the café. Suggested structure:

```
[RTD Logo]

Tonight at Roll The Dice

Upcoming Events

[Roll Me a Game]

Game of the Week

Book a Session
```

Potential sections:

- Happening Today
- Coming Up
- Game of the Week
- Random Game Selector
- Featured Event
- Bookable Sessions

The Home screen should not become overloaded. The diary remains the primary promotional content.

## 8. Event Splash Screen

Whenever the app opens, display a promotional splash for an eligible event occurring within the next 14 days. The event should be randomly selected from suitable active events.

```
QUIZ NIGHT

Friday 23 October
6:30 PM

Join us at Roll The Dice

[VIEW EVENT]
[CONTINUE]
```

Rules:

- Event must be active
- Event must have a valid upcoming date
- Event must occur within 14 days
- Event must be suitable for public promotion
- Cancelled events must never appear
- Expired events must never appear
- Private/link-only sessions must never appear
- Prefer events with promotional artwork where available
- Avoid repeatedly showing the same event if practical

The splash must be dismissible quickly. Do not trap users behind a long advertisement.

## 9. Event Data Model

Create a permanent event identity, for example `RTD-EVT-00127`. Never rely on event name or event date as the permanent identifier.

Separate the concept of an **Event** from an **Occurrence**:

```
Event:
Quiz Night

Occurrence:
Quiz Night — 23 October 2026
```

Bookings must attach to the occurrence. This separation is mandatory for recurring events.

### Event

```
event_id
event_name
event_type
description
default_image
default_duration
default_capacity
default_host_id
repeatable
requires_redating
active
created_at
updated_at
```

### Event Occurrence

```
occurrence_id
event_id
event_date
start_time
end_time
host_id
capacity
booking_enabled
booking_deadline
visibility
price_display
status
image_override
description_override
approved_at
completed_at
cancelled_at
created_at
updated_at
```

## 10. Event Visibility

Support at least three visibility levels.

### Public

Appears in:

- Diary
- Home
- Promotional splash
- Search
- Public booking area where applicable
- Social-media workflows where applicable

### App Bookable

Can appear in the app booking area. May not necessarily be promoted through general social posts. Useful for organised game sessions.

### Private / Link Only

Does not appear in public app listings. Can be accessed through a specific booking link or QR code. Useful for:

- Private groups
- Campaign sessions
- Invite-only sessions
- Limited tests
- Special events

## 11. Event Lifecycle

Audit the existing n8n process and map current statuses into a clean lifecycle. Preferred conceptual model:

```
Draft
→ Submitted
→ Awaiting Approval
→ Approved
→ Published
→ Completed

Alternative endings:
→ Cancelled
→ Needs New Date
```

Do not replace existing working status logic without reason. If the existing RTD flow already provides equivalent stages, adapt the app to it. Every status change must be auditable.

## 12. Recurring / Repeatable Events

When a repeatable event occurrence passes:

1. Mark the completed occurrence appropriately.
2. Preserve all historical booking and attendance data.
3. Do not overwrite the old occurrence.
4. Check whether the parent event is flagged `repeatable = true` and/or `requires_redating = true`.
5. If so, email the fixed café email address requesting a new date.

Suggested email:

```
Subject:
New Date Required – [Event Name]

The current occurrence of [Event Name] has now passed.

Previous date:
[Date]

Please provide the next event date so the RTD system can schedule the next occurrence.
```

Once a new date is supplied, create a new occurrence. Do not modify historical occurrences. One-off events should simply complete/archive unless specifically flagged for redating.

## 13. Event Diary

Create a clean, mobile-first event diary.

**Views:** Today, This Week, This Month, Upcoming.

**Filters:** Gaming, Quiz, Social, Club, Tournament, Market, Workshop, Other.

**Event cards show:**

- Image
- Event name
- Date
- Time
- Short description
- Booking status
- Spaces remaining if bookable
- CTA

**Event pages show:**

- Full description
- Date
- Start/end time
- Host where relevant
- Booking availability
- Remaining capacity
- Event image
- Book button
- Add to Calendar
- Share Event
- Notification/reminder option where supported

## 14. Push Notifications

Notifications are opt-in only. Do not request notification permission immediately on first app launch. Ask at a meaningful point, for example:

```
Want a reminder before Roll The Dice events begin?
```

Notification categories should be structured so the system can expand later.

### V1 notifications

- **Event Reminder:** sent approximately 4 hours before the event starts, e.g. "Quiz Night starts at Roll The Dice at 6:30 PM tonight."
- **Booking Reminder:** if a customer has booked an event, send an event reminder where possible.
- **Booking Change:** notify where appropriate if the event is cancelled, the event time changes, or the booking status changes.
- **Game of the Week:** optional promotional notification.

Do not spam users. Design notification preferences for future expansion even if V1 initially has a simple opt-in toggle.

## 15. Game Library

Create a proper game database. The initial game inventory will be collected separately. Do not require shelf-location data.

```
game_id
name
image
minimum_players
maximum_players
minimum_play_time
maximum_play_time
difficulty
category
description
available
game_of_week_eligible
guide_url
video_url
created_at
updated_at
```

Future fields (not required for V1): recommended age, complexity score, co-operative, competitive, party game, strategy game, family game, staff recommendation, customer rating.

## 16. Roll Me a Game

Create an animated random-game-selection tool. Primary CTA: **ROLL ME A GAME**.

1. User taps button.
2. Dice animate/tumble across the screen.
3. A result is selected from eligible games.
4. Game card is revealed.

```
KING OF TOKYO

2–6 Players
Approx. 30 minutes
Easy

[PLAY THIS]
[ROLL AGAIN]
```

The dice animation should feel fun and central to the feature. The actual selection must be database-driven. Do not fake the selection visually.

## 17. Filtered Game Selection

Add an optional guided selector.

- **Number of players:** 2 · 3–4 · 5–6 · 7+
- **Time available:** Under 30 minutes · 30–60 minutes · 1–2 hours · Any
- **Game style:** Strategy · Party · Co-operative · Competitive · Any

After filtering, roll randomly from the eligible results.

Also include **CHAOS ROLL**, which ignores normal preference filters and selects any eligible game.

## 18. Game of the Week

Automatically select one game each week from the eligible game library. Selection should be random.

- Only select active/available games
- Only use games flagged as Game of the Week eligible
- Avoid immediate repetition
- Record previous selections
- Store selection date
- Allow staff to override the result

Display prominently in the app:

```
GAME OF THE WEEK

Ticket to Ride

2–5 Players
45–90 Minutes

[VIEW GAME]
[HOW TO PLAY]
```

Future versions may attach an RTD-produced video, quick-start guide, rules summary and social-media content. Design the schema now so these can be added later.

## 19. Booking Principles

Customers must not be required to create an account.

Booking fields:

```
Lead name
Email address
Mobile number
Party size
Optional attendee names
Optional message / note
```

Payments are not taken online. The system is reservation-only. A booking can reserve multiple people:

```
Capacity: 10
Spaces remaining: 6

Customer requests: 4
Booking accepted

Spaces remaining: 2
```

Never treat one booking as one seat. Always calculate capacity using total reserved headcount.

## 20. Booking Validation

Before confirming a booking:

- Confirm occurrence is active
- Confirm bookings are enabled
- Confirm booking deadline has not passed
- Confirm event is not cancelled
- Confirm requested party size is valid
- Confirm enough capacity exists
- Protect against concurrent bookings
- Prevent total headcount exceeding capacity

Use database-level transaction/locking logic where possible. Do not rely only on frontend validation.

## 21. Booking Confirmation

After booking:

- Store booking
- Update available capacity
- Display confirmation
- Send confirmation email
- Generate secure cancellation link
- Include event details
- Include party size
- Include contact information if appropriate

```
You're booked.

D&D One Shot
Saturday 7:00 PM
4 places reserved

Roll The Dice
```

## 22. Customer Cancellation

Customers must be able to cancel without creating an account, using a secure tokenised **Manage / Cancel Booking** link.

On cancellation:

1. Validate secure token.
2. Confirm booking.
3. Mark booking cancelled.
4. Return capacity.
5. Trigger waitlist evaluation.
6. Log cancellation.
7. Notify relevant staff systems as appropriate.
8. Include cancellation in the daily staff digest.

Never delete the original booking record.

## 23. Waiting List

A waitlist request must include requested party size.

```
Event has 1 space remaining.
Customer wants 3 spaces.

Offer:
Join waiting list for 3 spaces.
```

A customer should not automatically receive a partial booking unless specifically supported later.

When sufficient capacity becomes available:

1. Identify first eligible waitlist entry.
2. Offer the spaces.
3. Send time-limited booking confirmation link.
4. Temporarily reserve those spaces.
5. If accepted, create booking.
6. If expired, release spaces.
7. Move to next eligible waitlist entry.

The expiry period is configurable; suggested initial value **12 hours**. Staff must be able to override the waitlist manually.

## 24. Booking Data Model

### Booking

```
booking_id
occurrence_id
lead_name
email
mobile
party_size
attendee_names
notes
status
source
created_at
updated_at
cancelled_at
cancellation_token_hash
```

Possible statuses: `confirmed`, `cancelled`, `waitlisted`, `offered`, `offer_expired`, `staff_cancelled`.

### Waitlist

```
waitlist_id
occurrence_id
lead_name
email
mobile
party_size
position
status
offer_token_hash
offer_expires_at
created_at
updated_at
```

## 25. Host Portal

Trusted game hosts receive a separate protected area.

Authentication: email/password and magic link. Host permissions must be role-controlled. Do not expose host functions to normal public users.

Suggested navigation:

```
Host Dashboard
My Events
Create Event
Bookings
Profile
Help / Rules
```

## 26. Host Ownership

Events created by a host remain associated with that host. Host users should be able to:

- View their sessions
- View attendee counts
- View approved booking information where appropriate
- Create new sessions
- Edit their events
- Cancel/request cancellation
- See event status
- See event approval state
- See previous sessions
- Duplicate a previous session into a new proposed date

Important changes made by the host must be communicated to the café, e.g. date changed, start time changed, end time changed, capacity changed, event cancelled, booking deadline changed. All changes must be logged.

## 27. Host Event Approval

Audit the current n8n approval system first. The existing process is already close to the desired model; reuse it where sensible.

```
Host creates event
      ↓
Submitted
      ↓
Existing / improved n8n approval workflow
      ↓
Staff approval
      ↓
Approved event synced to app
      ↓
Bookings become available
```

Do not create a duplicate approval engine if the existing process can be adapted. The audit must explicitly determine this.

## 28. Host Event Form

```
Event / Game name
Session type
Description
Date
Start time
End time
Capacity
Booking deadline
Experience level
Recommended age
New-player friendly
Free / paid at venue
Special requirements
Host notes
```

No online payment functionality is required. Pricing may be displayed as informational text if relevant.

## 29. Become a Host

Add a public **BECOME A HOST** CTA. This is an application only; submitting the form must not grant host access.

```
Name
Email
Mobile
Games / systems you run
Hosting experience
Preferred session types
Typical availability
Short "about me"
Why would you like to host at Roll The Dice?
Agreement to RTD host expectations
```

Creates a **Host Application** with statuses: `New`, `Under Review`, `Approved`, `Rejected`, `More Information Required`.

Staff Control displays pending applications. When approved:

- Create or invite host account
- Grant Host role
- Notify applicant
- Retain original application for audit purposes

## 30. Staff Control

Create a protected Staff Control area. Suggested main dashboard:

```
TODAY

Events Today
Bookings Today
New Bookings
Cancellations
Waitlist Activity
Host Applications
Events Awaiting Approval
Events Near Capacity
```

Sections:

```
Dashboard
Events
Bookings
Hosts
Host Applications
Approvals
Game Library
Game of the Week
Notifications
Audit Log
Settings
```

## 31. Staff Event Controls

Staff should be able to:

- View all events
- View occurrences
- Create event
- Edit event
- Cancel occurrence
- Change capacity
- Change booking status
- Change visibility
- Approve event
- Reject event
- Request host changes
- Force new occurrence
- Mark event repeatable
- Mark event as requiring redating
- View host ownership
- View change history

## 32. Staff Booking Controls

Staff should be able to:

- Search bookings
- Filter by event/date
- View party size
- View customer contact information
- Cancel booking
- Adjust party size
- Move booking to another occurrence if supported
- View waiting list
- Promote waiting-list entry
- Override capacity with explicit warning
- Export booking list
- View booking audit history

Any manual override must be logged.

## 33. Daily Staff Booking Email

Create a scheduled n8n workflow that sends one digest to one fixed café email address. The address is stored as a configurable environment/settings value. Do not hard-code an unknown email into source code.

- **New Bookings** since the previous digest: event, date/time, lead customer, party size, booking timestamp.
- **Cancellations:** event, customer, party size, cancellation time.
- **Waitlist Activity:** new waitlist entries, places offered, offers accepted, offers expired.
- **Event Changes:** newly approved events, host edits, date/time changes, capacity changes, cancellations.
- **Capacity Warnings:** sessions full, or at or above 80% capacity.
- **Tomorrow:** tomorrow's bookable sessions and current booked headcount.

Keep the email concise and operational. Do not email after every routine booking unless specifically required later.

## 34. n8n Event Audit Log

Create or improve an event audit system. Every important action should produce an audit record.

```
audit_id
entity_type
entity_id
occurrence_id
actor_type
actor_id
action
previous_value
new_value
source
timestamp
```

Examples:

```
Host submitted event
Staff approved event
Host changed time
Staff changed capacity
Customer booked 4 places
Customer cancelled booking
Waitlist offer issued
Occurrence completed
Recurring event requested new date
Game of the Week selected
```

Audit logs must be immutable from ordinary Host accounts.

## 35. App Database Synchronisation

The app database contains the operational data required by the app. n8n synchronises relevant information from the RTD Logic Engine. Use deterministic IDs and idempotent workflow design. Repeated execution must not create duplicate events.

- Unique event IDs
- Unique occurrence IDs
- Upsert logic
- Synchronisation timestamps
- Workflow run logging
- Error handling
- Retry handling

If an event is updated in the Logic Engine, update the corresponding app record rather than creating another event.

## 36. n8n Reliability

Review all relevant RTD workflows for reliability. Add where needed:

- Error workflows
- Retry logic
- Idempotency
- Execution logs
- Dead-letter/error record
- Alerting only when human intervention is actually required
- Input validation
- Duplicate protection
- Clear node names
- Workflow descriptions
- Environment variables
- Credentials stored correctly

Do not flood staff with routine technical emails. The system should attempt corrective action first.

## 37. Communications to Café

Important host/event changes must be visible to staff. At minimum communicate:

- Newly submitted event
- Approved event
- Event date change
- Event time change
- Capacity change
- Cancellation
- Expired recurring event requiring a new date
- Significant booking issue

Prefer Staff Control + daily digest for routine activity. Use immediate email only where operational action is reasonably required.

Discord integration may be added later. Design the notification layer so Discord can be added without restructuring the entire system.

## 38. Staff Email Configuration

For V1 there is one fixed destination, represented via configuration:

```
RTD_CAFE_NOTIFICATION_EMAIL
```

Do not bury the address inside multiple workflows. All workflows should reference the same configuration source.

## 39. Add to Calendar

Each public event page provides **ADD TO CALENDAR**, with appropriate calendar file/link behaviour, including:

- Event name
- Date
- Start/end time
- Roll The Dice location
- Description
- Event URL

## 40. Sharing

Each event supports native/mobile sharing where available (**SHARE EVENT**). Deep links must open directly to the event rather than only the app homepage. This is important for integration with existing RTD social posts.

## 41. Analytics

Add basic privacy-conscious analytics. Track:

- App launches
- Event views
- Booking-page views
- Completed bookings
- Booking conversion
- Game-selector usage
- Game results selected
- Game of the Week views
- Host application starts
- Host application completions
- Notification opt-ins
- Add-to-calendar clicks
- Share-event clicks

Avoid unnecessary personal-data collection. Reporting can later be connected to existing RTD reporting infrastructure.

## 42. Security

Treat booking data as personal information.

- HTTPS only
- Secure host/staff authentication
- Role-based permissions
- Server-side booking validation
- Secure cancellation tokens
- Token hashes stored rather than plain tokens where practical
- Rate limiting
- Input validation
- Output sanitisation
- Protection from forged host/staff requests
- Least-privilege database access
- Secure n8n webhook authentication
- No public access to n8n administration
- No credentials stored in frontend code

Host accounts must not gain Staff permissions. Public users must never be able to access administrative booking data.

## 43. Roles

`PUBLIC`, `HOST`, `STAFF`, `ADMIN`.

**PUBLIC** can: view public app, view diary, use game selector, view Game of the Week, book, cancel via token, join waitlist, apply to become host.

**HOST** can: access Host Portal, manage own events, view own event booking data as permitted, submit events, edit own events, view host history.

**STAFF** can: manage events, manage bookings, process host applications, approve events, view operational audit information.

**ADMIN** can: everything Staff can do, manage roles, manage settings, view deeper system configuration, override administrative constraints.

## 44. Recommended Technical Architecture

Inspect the existing infrastructure before selecting final components. Preferred conceptual stack:

```
Frontend:
React / Next.js or equivalent modern PWA framework

Database:
PostgreSQL-based backend, e.g. Supabase, or equivalent

Authentication:
Email/password + magic links for Host/Staff

Notifications:
Standards-based Web Push / suitable push service

Automation:
Existing n8n server

Master event source:
RTD Logic Engine
```

Do not select a technology simply because it is fashionable. Assess existing RTD hosting, existing technical stack, ease of maintenance, Raspberry Pi workload, security, reliability, cost and future native-wrapper compatibility.

The public application database should not rely on the Raspberry Pi being constantly reachable for ordinary page loads.

## 45. API / Integration Layer

Create documented integration boundaries, for example:

```
GET /events
GET /events/:id
GET /occurrences/:id
GET /games
GET /games/random
POST /bookings
POST /bookings/:token/cancel
POST /waitlist
POST /host-applications
POST /host/events
PATCH /host/events/:id
GET /staff/dashboard
```

Exact implementation can differ. Protect Host and Staff endpoints through authentication and role checks. Protect n8n integration endpoints with secure secrets/signatures.

## 46. n8n Workflow Set

After auditing current workflows, aim for clearly defined responsibilities. Potential logical workflows:

```
RTD – Event Sync
RTD – Event Approval
RTD – Host Event Change
RTD – Event Expiry & Redating
RTD – Booking Daily Digest
RTD – Push Reminder Scheduler
RTD – Game of the Week
RTD – Host Application Notification
RTD – Event Audit Logger
RTD – Booking Audit Logger
```

Do not blindly create these if existing workflows already cover them. Consolidate where sensible.

## 47. Event Reminder Scheduler

Identify upcoming events and schedule/send reminders approximately 4 hours before start time. Prevent duplicate notifications.

```
notification_id
occurrence_id
notification_type
scheduled_at
sent_at
status
```

Use deterministic deduplication. If event time changes, ensure an outdated scheduled reminder is not sent.

## 48. Game of the Week Automation

Scheduled weekly workflow:

1. Fetch eligible games.
2. Exclude recently selected games where possible.
3. Randomly select a game.
4. Store the selected game and week.
5. Update app.
6. Optionally send push notification to opted-in users.
7. Record selection in audit log.

Staff can override the selected game. Future integration may generate related social-media content.

## 49. Data Retention / History

Historical event and booking records are valuable. Do not delete records simply because an event has passed. Preserve:

- Event occurrences
- Booking counts
- Cancellations
- Waitlist activity
- Host ownership
- Approval history
- Event changes
- Game of the Week history

Use appropriate retention rules for personal contact information. Identify relevant UK data-protection requirements before production deployment.

## 50. Accessibility

- Adequate contrast
- Readable text
- Keyboard navigation
- Semantic elements
- Screen-reader labels
- Reduced-motion support
- Dice animation does not prevent use
- Animation can be shortened/disabled for reduced-motion users

The game selector must remain functional if animation is disabled.

## 51. Future Features to Prepare For

Do not build these now, but avoid architecture that blocks them:

- Discord event feeds
- Discord host channels
- Native Play Store/App Store versions
- Game videos
- Quick-start guides
- Rule summaries
- Customer favourites
- Favourite event categories
- My Bookings via optional customer account
- Loyalty features
- Achievements
- QR codes on tables
- QR codes around café
- Game availability
- Staff recommendations
- Ratings
- Push categories
- Direct social deep linking
- Enhanced attendance analytics

## 52. Development Phases

### Phase 0: Audit (mandatory)

- Current RTD architecture map
- Existing booking workflow review
- Existing approval workflow review
- Existing event-data review
- n8n workflow inventory
- Recommendation: reuse / modify / retire
- Risks
- Migration plan

Do not deploy destructive changes during this stage.

### Phase 1: Data Foundation

- Permanent event IDs
- Event / occurrence split
- App database
- Secure API
- Logic Engine synchronisation
- Audit framework
- Basic Staff authentication
- Basic Host authentication

### Phase 2: Public PWA / Diary

- RTD branded PWA
- Home screen
- Event diary
- Event pages
- 14-day random event splash
- Add to Calendar
- Sharing
- Deep links
- Installability
- Initial analytics

### Phase 3: Notifications

- Opt-in flow
- Push registration
- 4-hour event reminders
- Notification deduplication
- Booking-change notifications
- Notification auditing

### Phase 4: Game System

- Game inventory database
- Game library
- Roll Me a Game
- Dice animation
- Guided filters
- Chaos Roll
- Game of the Week
- Weekly automation

### Phase 5: Booking

- Multi-person bookings
- Capacity control
- Confirmation email
- Secure cancellation
- Waiting list
- Waitlist offer expiry
- Staff booking controls
- Daily booking digest

### Phase 6: Host Portal

- Host dashboard
- Host event creation
- Host event ownership
- Existing n8n approval integration
- Host event editing
- Change notifications
- Host booking visibility
- Host history

### Phase 7: Become a Host

- Public application form
- Application status
- Staff review
- Approve/reject/request-information
- Host invitation/account creation
- Audit trail

### Phase 8: Staff Control

Full operational dashboard: events, bookings, hosts, host applications, approvals, waitlists, game library, Game of the Week, audit, settings.

### Phase 9: Hardening

Before production:

- Security review
- Permission review
- Mobile testing
- Browser testing
- Push testing
- Capacity race-condition testing
- n8n failure testing
- Backup test
- Recovery test
- Accessibility review
- Performance review
- Data-protection review

## 53. Migration Rules

1. Never destroy working RTD automation without a replacement.
2. Back up workflows before modification.
3. Export n8n workflows before major refactoring.
4. Preserve existing Logic Engine data.
5. Preserve historical booking data where useful.
6. Do not delete existing event records purely to simplify migration.
7. Create migration scripts where necessary.
8. Test against copied/non-production data first.
9. Document all breaking changes.
10. Maintain rollback instructions.

## 54. Required Documentation

Create/update documentation alongside the build:

```
RTD_APP_ARCHITECTURE.md
RTD_DATABASE_SCHEMA.md
RTD_N8N_WORKFLOWS.md
RTD_BOOKING_LOGIC.md
RTD_HOST_PORTAL.md
RTD_STAFF_CONTROL.md
RTD_PUSH_NOTIFICATIONS.md
RTD_DEPLOYMENT.md
RTD_RECOVERY.md
RTD_CHANGELOG.md
```

Also maintain a concise `RTD_APP_CURRENT_STATE.md` explaining what is live, what is incomplete, known issues, next actions and required user input. Keep it brief.

## 55. Testing Scenarios

### Events

- Public upcoming event
- Private event
- App-bookable event
- Cancelled event
- Expired event
- Repeatable event
- Event needing new date
- Date changed after approval
- Time changed after notifications scheduled

### Bookings

- Booking for one person
- Booking for multiple people
- Booking exactly remaining capacity
- Booking above remaining capacity
- Two simultaneous final-space bookings
- Cancellation
- Partial-capacity return
- Waitlist entry
- Waitlist party requiring multiple spaces
- Offer accepted
- Offer expired

### Hosts

- Approved host login
- Invalid host login
- Host creates event
- Host edits own event
- Host attempts to edit another host's event
- Host cancels session
- Host account disabled

### Public

- No-account booking
- Secure cancellation
- Game selector
- Game filters
- Game of the Week
- Push permission denied
- Push permission accepted
- Offline / weak connection behaviour

### Staff

- Approve event
- Reject event
- Change capacity
- Cancel event
- Approve host
- Reject host
- Override waitlist
- Audit manual action

## 56. Operational Success Criteria

The initial production version is successful when:

- RTD Logic Engine remains authoritative
- No duplicate event-management process is introduced
- Public users can view upcoming events reliably
- App can be installed as a PWA
- Random promotional splash functions correctly
- Customers can opt into push notifications
- Event reminders are reliably sent four hours before eligible events
- Game selector works
- Game of the Week updates automatically
- Customers can book without accounts
- Multi-person bookings correctly affect capacity
- Customers can cancel securely
- Waiting list functions correctly
- Trusted hosts can create and manage sessions
- Existing n8n approval logic is reused or improved
- Staff can manage the system centrally
- Daily booking digest is sent
- Repeatable expired events trigger a request for a new date
- Significant changes are audited
- Existing RTD automation is not destabilised

## 57. Build Instructions

Begin with the audit. Do not immediately deploy a new architecture.

1. **Map the current RTD environment.** Inspect all accessible n8n workflows, RTD Logic Engine data, existing booking workflows, event approval logic, event/poster/social workflows, event storage, existing IDs, existing logs and email integrations.
2. **Produce an audit** showing `KEEP`, `MODIFY`, `REPLACE`, `RETIRE` or `NEW` for each relevant component.
3. **Compare the existing system with this specification.** Identify where the existing framework already solves a requirement. Prefer extension over duplication.
4. **Produce the target architecture and migration plan.** Do not make destructive changes until the migration path is clear.
5. **Implement Phase 1.** Prioritise event identity, event/occurrence separation, reliable sync, database, authentication and audit history.
6. **Proceed through the phases in this document.** At the completion of each phase: test it, document it, record changes, update Current State, and identify remaining user actions.

## 58. Design Principle

The app should provide a reason to remain installed.

- The event diary attracts users.
- The booking portal makes it useful.
- The random game selector makes it enjoyable.
- Game of the Week creates repeat engagement.
- Notifications bring users back.
- Host tools increase the number of organised sessions available.
- The Staff Control system prevents the additional functionality from creating more administrative work than it solves.

The final result should feel like a natural digital extension of Roll The Dice rather than a separate technology project.
