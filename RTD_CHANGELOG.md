# RTD App Changelog

## 2026-10-19 (Event social prompts, Stage 1: the app side)
- **What it's for:** each event gets its own social media master prompt, built only from the facts the café wrote down. Every post is checked against that event's facts and its real date before it goes out, so posts stop inventing things: cash prizes that don't exist, "drop in" for a booked game, the wrong night, someone in the wrong role.
- **Switched Off, so nothing posts differently.** This is Stage 1, the app side. The n8n side (the prompt builder, and the changes to RTD Master V1 and posters) is Stage 2, and each step needs the owner's go-ahead.
- **Two new Logic Engine columns, for Dan and Michelle to fill in** (they're added in Stage 2, after a backup):
  - **Approved Facts:** one fact per line, `Key: value`. The keys are Booking, Level, Age, Prizes, Format, Price, Bring, Food and Other. For example `Booking: essential`, `Prizes: cash`.
  - **People & Roles:** one person per line, `Name — role`, for example `Trixie — sets up`. A plain `-` works too. Posts may name only these people, in these roles.
  - The app now reads both, plus **Banned Phrases**, on every sync.
- **The master prompt:**
  - Gemini writes it from Base Details (Notes on Standard Diary), Approved Facts, People & Roles, the name, category, visibility, price and places. Nothing else.
  - It never sees dates, times, other events, emails, posting history or the hand-written prompts in the sheet. The prompt never contains a date; the date comes fresh from the app each time a post is made.
  - The app checks each prompt with fixed rules (no dates, no other prices, no other events, no unknown names, every fact traced to the column it came from). It approves it only when every check passes. Anything unclear goes to an admin with the question.
  - Every version is kept. A prompt is remade when the facts change, not when the date changes.
- **The check before every post:**
  - The event must be running and public, the date real and still to come, and the prompt current.
  - Every date, weekday, time and price must be that date's own.
  - Booking, drop-in, level, prize and age words need a matching Approved Fact (or the same word in Base Details).
  - Every name must be in People & Roles, in their role. No other event's name may appear, and none of the Banned Phrases.
- **The switch** (Organise › Events & dates › **Social prompts**, admins only):
  - **Off** (now): nothing checked, nothing recorded.
  - **Shadow:** every post is checked and recorded, none is held. Admins see what would have been held.
  - **Enforce:** a post that fails is held, and listed with the reasons.
  - Every change is in the audit log.
- **Admin screens:**
  - Each event's edit page has a **Social prompt** section: the facts as last synced (with any lines that don't read), the prompt and its versions, questions, the last 10 checks, **Regenerate**, and **Approve with a note**. An admin's own text gets the same checks as Gemini's. Markets have it too.
  - The organiser hub counts **social prompts to review** and **posts held this week** (only when the switch isn't Off).
  - Hosts never see prompts.
- **A safety net, not a guarantee.** The check works from fixed rules and fails safe, so it will sometimes hold a good post. It can also miss a few unusual wordings. The list is in [RTD_N8N_WORKFLOWS.md](docs/RTD_N8N_WORKFLOWS.md#known-limits). That's why it runs in Shadow for about a week first.
- **Privacy:** the text of each checked post is deleted after 90 days; the result is kept.
- **Database:** migration `0024_social_prompts.sql` adds one column, two tables and the switch (Off). **Not applied to production yet.** It goes after `0023` (also waiting), each with the owner's go-ahead ([RTD_EVENT_CONTROL_MIGRATION.md](docs/RTD_EVENT_CONTROL_MIGRATION.md#0024_social_promptssql-event-social-prompts-stage-1)).
- **The owner's steps (spec §6), each with a go-ahead:**
  - **G1:** apply **0023**, then **0024**, to production (each with the owner's go-ahead), check them, and only then merge the app code (switch Off). Merging first would break the live app: the sync, the organiser hub and the daily privacy clean-up all need 0024's tables.
  - **G2:** back up the Logic Engine, and add the 4 columns (Approved Facts, People & Roles, Social Prompt, Social Prompt Status) to both tabs, on the staging copy first. RTD Event Sync then needs to send the new columns to the app.
  - **G3:** Dan and Michelle fill in Approved Facts and People & Roles. Suggested wording from Base Details comes in a doc for them to confirm; nothing is written to the sheet for them.
  - **G4:** run the builder by hand for 3 events (a dry run that writes no cells), review them on the screen, then publish it.
  - **G5:** publish the Master V1 and poster changes with the switch Off, then Shadow for about a week.
  - **G6:** the owner reviews the Shadow results, then switches to Enforce.
- **Tests:** 659 in all, all passing.

## 2026-10-18 (Private games)
- **Private events now show as private games, not "Private session".**
  - The diary, Home ("Coming up" and "Also on today") and the event cards show the real name, such as **Arkham Horror Card Game**, with its time, description and a **Private game** tag.
  - There's no booking button, price, places or photo.
- **Each private game has its own page** with **"Interested in joining? Get in touch!"** instead of booking. Share and Add to calendar work as on any event.
- **The message form:**
  - People enter their name, email and a message (up to 1,000 characters), and tick to agree their details go to the organiser.
  - It goes to the café's bookings inbox, and to the host for a hosted game. Reply-to is the person asking, so the organiser just replies.
  - Nothing is emailed to the person asking, so the form can't be used to email strangers.
  - **Spam:** a hidden trap field, and at most 3 messages an hour from one network.
- **Privacy:**
  - Messages are deleted after 90 days, and the scrambled network code after 2 days.
  - The privacy notice covers the form, and is dated 18 October.
- **Hosts:** the Private option on the session form now explains what shows. The admin editor calls it **Private game**.
- **Cleeples** is set to booking **Optional** in the live database (set directly, recorded in the audit log).
- **Database:** migration `0023_enquiries.sql` adds one table. **Not applied to production yet: it needs the owner's go-ahead.** Until it is applied, the form answers "Something went wrong" and sends nothing.

## 2026-10-18 (Admin event editor)
- **Admins can change or cancel every event from one place:** Organise › Events & dates › **All events**. This covers café events from both sheet tabs, hosts' sessions and markets, whether public, app-bookable, private or hidden, running or stopped. Search, and filters for Café, Host sessions, Markets, Stopped, and Hidden or private.
- **Each event opens one form:**
  - name, description, date, start and end time, price, category
  - **who can see it** (Public, App Bookable, Private or Hidden)
  - **places** and **whether people need to book**
  - each date to come: **Cancel this date**, **Hide this date** and its own **Places**
- **Saving sends only what changed, each part through the route that already owns it:**
  - **Café events:**
    - Details go to the Logic Engine first, through RTD Sheet Writer. Nothing is overwritten if the sheet changed in the meantime.
    - Places and booking change at once.
  - **Hosts' sessions:**
    - An admin's change is approved on the spot and takes the same path as an approved host request.
    - The host is emailed what changed.
    - If the host has a request waiting, the admin decides that first.
    - Admins can now also set a session's places and whether people need to book.
  - **Markets** keep their own editor; the form links to it.
- **Stop running this event:**
  - It first shows how many people are booked.
  - It cancels each booked date, emailing everyone booked, then sets Status to Inactive.
  - A Standard Diary group is hidden instead, because that tab has no Status column.
  - Nothing is cancelled while another change to the event is still on its way.
- **Start running again:** a stopped café event or host session has a **Start running again** button, which sets Status back to Active. A hidden Standard Diary group comes back by choosing who can see it.
- **Safeguards:**
  - Nothing is applied until every part of a save has passed its checks, so a warning or a refused part never sends emails twice.
  - A host session can't be changed again while an earlier admin change is still on its way to the sheet.
  - Stop running checks the event can be stopped before cancelling any date.
  - A booked date can't be moved: cancel it first.
  - People booked are emailed a new time once it's in the Logic Engine. This applies to café events too now, not just hosts' sessions.
  - Places never go below what's booked.
  - Every change is in the audit log.
- **Hosts and approvers are unchanged.** Hosts still change only their own sessions, and only with approval. New tests prove a host is refused on anyone else's session, date or places.
- **Needs the owner's go-ahead:** café details reach the sheet only once **RTD Sheet Writer is published in n8n**. It isn't yet, although Logic Engine changes have been set to Live since 17 Oct. Until then, café detail changes wait in the queue. Places, booking, cancelling and host sessions all work without it.
- **No database change.** **Tests:** 487 (was 448).

## 2026-10-18 (Share menu)
- **Share an event to WhatsApp, Facebook, Instagram, Discord, X, email, text message, or copy the link.** It works from the event page's **Share** button, and from a share icon on every diary row and every Home card ("Next up" and "Coming up").
  - **WhatsApp, X, email and text** open with the event's name, date and link filled in.
  - **Facebook** gets the link, so it shows the event's own preview card.
  - **Instagram and Discord** have no way for a website to share straight in. They open the phone's own share menu, where both appear if installed, or copy the link with a note saying where to paste it.
  - **More…** opens the phone's full share menu, on phones that have one.
- **No share icon** on private group bookings or cancelled dates: there's nothing public to share.
- **Phones and computers:** on phones the menu slides up from the bottom; on computers it opens in the middle of the screen. Esc, the backdrop or a choice closes it, and focus returns to the button.
- **Stats:** every share counts as a share tap, as before.
- **No database change.** **Tests:** 448 (was 440).

## 2026-10-17 (Business details and credit)
- **Privacy notice:** names **Roll The Dice Cafe Ltd, Meridian Point, Cleethorpes** as the data controller, says the company is registered with the ICO, and names the app developer, ATech Studio (atechstudio.co.uk). Dated 17 October 2026.
- **Calendar entries** (Add to Calendar and Google) give the location as **Roll The Dice Board Game Café, Meridian Point, Cleethorpes**.
- **Footer:** "App designed and built by atechstudio.co.uk". On phones, the footer now keeps clear of the bottom bar, which used to cover its last line.
- **No database change.** The data controller's name is the live setting `privacy_controller`, updated directly. **Tests:** 440.

## 2026-10-17 (Gold dice)
- **The app icon's dice are gold** on the navy square: home screen (Android and iPhone), Android's shaped icon, the browser tab and the shortcuts. The two dice keep the small notch between them from the logo.
- **Notifications show a dice** as their small icon in Android's status bar. The phone draws it in one colour; the notification's larger picture is the gold-dice icon.
- **The app's pop-up messages** (after approving, saving and so on) are gold text on navy, with a small dice.
- **Gold** is a new colour token (`--rtd-gold`, #F2C14E), checked for contrast on navy (8:1 or better).
- **Phones pick up the new icons:** the service worker's caches are renamed, so the old icons are cleared once. An installed app's home-screen icon may take a day or a reinstall to change, as the phone decides.
- **Not possible:** colouring the text of the phone's own notifications. Android and iPhone always draw it themselves.
- **No database change.** **Tests:** 440 (was 438).

## 2026-10-17 (Organiser hub)
- **The organiser for approvers and admins is now a hub, not one long page.** It shows a card per section, with what's waiting and how much: "2 join requests · 1 session", or **All clear**. Sections with work come first; each card opens the section's own page.
  - **Sections:** To approve, Needs attention, Events & dates, Bookings, People, and for admins, Café content and Stats.
  - **Counts** come from one read-only call, `GET /api/staff/summary`, show only what the person's role can open, and update after every approval or fix.
  - **Links:** emails and pushes link straight to sections; older links still work.
  - **On a phone,** approvers and admins with no sessions of their own now start on the hub, not an open session form.
- **Hosts:** nothing changes.
- **No database change.** **Tests:** 438 (was 428).

## 2026-10-16 (Changing events from the organiser: built, not yet live)
- **New in the organiser, for admins: Logic Engine changes.** Change an event's name, details, next date, times, Status, who can see it, category or price, and it's written to its row in the Logic Engine, found by **Event ID**. Host sessions (their hosts ask for changes) and markets are left out; so are Frequency and App Capacity.
- **The sheet stays the master.** Nothing changes in the app straight away: n8n writes just the changed cells, reads them back, and the next sync brings them into the diary, like an edit typed into the sheet. So a change can't echo back and forth.
- **Nothing is overwritten silently.** Before writing, the app checks the row still holds what you saw. If the sheet changed since, nothing is written and you choose: **keep the sheet's** or **write mine over it**. You're emailed when that happens, or when a change can't be written after five tries (5 m, 15 m, 1 h, 4 h, 12 h).
- **Moving a booked date or switching an event off asks first,** and says what happens to the bookings (Needs attention picks them up, as for an edit in the sheet).
- **Where changes go, set by an admin:** **Off** (the start), **Test copy** (the staging copy of the sheet only), **Trial** (checked against the real sheet and shows what it would write, but writes nothing) and **Live**. The plan: test copy, then at least a week's trial, then Live with the owner's go-ahead.
- **The sync now keeps each event's sheet values** (canonical: dates, times, visibility), so a change records exactly what it changes from. It doesn't change any event's hash.
- **New n8n workflow RTD Sheet Writer** (every 5 minutes once published; not published yet).
- **Database:** migration `0022_sheet_edits.sql` (one column, one table, one setting, off), applied to production on 17 Oct at 08:38 UTC. **Tests:** 400 (was 382).

## 2026-10-16 (Food & Drinks menu)
- **New page: Food & Drinks** (`/menu`), the café's menu to browse. There's nothing to order or pay.
  - **Contents:** eight sections, from Hot food to Wine & prosecco, with every price from the photographed menu.
  - **The café keeps it up to date in a Google Sheet,** RTD Food Menu (Atechstudio Drive › Roll The Dice › Business): prices, new lines, sold out, hidden. The app copies it every 15 minutes (n8n **RTD Menu Sync**). A copy with a mistake in any row is refused whole, the app keeps its last good menu, and the organiser lists the rows to fix. Every change is in the audit log.
  - **Spirits** show Single £4.00 and Double £6.00.
  - **Lines with no single price** say "Individually priced"; no price is guessed.
  - **Alcohol:** alcoholic drinks are marked **18+**, and their sections say they're for over-18s only.
  - **Allergies:** a note asks people to speak to the team before ordering. Nothing is labelled allergen-free.
  - **Photos:** every line has a photo slot, with a neutral placeholder for now. No made-up food photos.
  - **Getting around:** section links stay in reach while scrolling, and `/menu#spirits` opens at that section.
  - **Offline:** the page works offline from the last copy, which says how old it is.
- **Where it's linked:** a **Food & Drinks** button in the top bar (phones) and the top menu (computers), a card on Home, the footer, and the installed app's shortcuts. The bottom bar is unchanged.
- **It starts Off.** In the organiser, admins switch it **Off**, **Preview** (shown, with a note that the menu is still being checked and the café's price applies) or **Live** (audited), see how the latest sheet copy went, and can check every line against its wording on the board. **Before Live:**
  - the café checks the prices;
  - adds the measures the law requires for spirits, wine and draught;
  - confirms "gluten-free" ([RTD_FOOD_MENU_AUDIT.md §6](docs/RTD_FOOD_MENU_AUDIT.md#6-before-launch-for-the-café)).
- **Stats:** Food & Drinks page views.
- **Audit and plan for offers:** [docs/RTD_FOOD_MENU_AUDIT.md](docs/RTD_FOOD_MENU_AUDIT.md). It covers roles and a per-person `offers.manage` permission for Michelle and Dan only, and how offer notifications will be opt-in and separate from event alerts. Offers are Stage 3; nothing about them is built yet.
- **Unchanged:** events, bookings, hosts, notifications and the Logic Engine sync.
- **No database change:** the menu is kept in `settings`, so it can be merged at any time. **Tests:** 407 (was 382).

## 2026-10-16 (Dates in the app)
- **New in the organiser, for approvers and admins: Dates in the app.** It lists the next four weeks; each date can be changed without touching the Logic Engine:
  - **Hide this date in the app,** or show it again. It leaves the diary and its page. Hiding a date people have booked asks first, and their bookings stand.
  - **A description for this date** (for example, "Halloween special"), and **a price for this date**. Empty means the event's own.
- **It never makes public what the sheet hides,** and the sheet sync never undoes these. Every change is in the audit log with the before and after.
- Dates, times and names are still changed in the Logic Engine; to stop a date being advertised, cancel it.
- **A hidden last date** still raises Needs attention when it ends.
- Also live today: **hosts' change requests** reach Event Index through a new n8n branch.
- **No database change.** **Tests:** 382 (was 376).

## 2026-10-16 (Hosts' changes need approval)
- **Hosts can ask to change a live session** in the organiser: its name, description, date, times, cost, or open or private. The form starts from what the diary shows now.
- **Nothing public changes until an approver or admin approves it.** **Changes to approve** shows each change side by side with what's public now, and how many people are booked. Approvers get a push, and the approvers' inbox an email.
- **Declining needs a reason,** which the host is emailed. Approving emails the host too.
- **Once approved,** just the changed cells are written to the session's Event Index row, and the diary follows within about half an hour. This needs a new n8n branch, which waits for the owner's go-ahead.
  - **A new time** is emailed to everyone booked on dates to come.
  - **A new date** for a booked date is held under Needs attention, as for any moved date.
- **Hosts see how their request is going** on the session's card, and can withdraw one still waiting. Asking again replaces it.
- **Still straight away, with no approval:** changing places, and cancelling a date.
- **Database:** migration `0021_change_requests.sql` (one table). **Tests:** 376 (was 371).

## 2026-10-16 (Cancelled dates leave the sheet)
- **A cancelled monthly date is no longer advertised:** its Event Index row is switched off within 15 minutes (n8n RTD Host Sessions To Diary, as for one-offs), with its date left as it was.
  - **Needs attention** then asks for its next date. Setting it there makes the row Active again with that date; **Archive** keeps it off.
- **A cancelled Standard Diary date:** the app can't change that tab, so **Needs attention** asks the café to change the Date there (move it on, or clear it), and so does the cancellation notice. It clears itself when the sheet changes, or once the date has passed.
- Both are in the attention emails: a notice, then the morning reminder.
- **Fewer false alarms:** an event whose date was cancelled is no longer also listed as "no date" or "date passed" while the sheet catches up.
- **No database change.** **Tests:** 371 (was 363).

## 2026-10-16 (Telling people booked, and email delivery)
- **People booking can ask to be told on their device** if the date is cancelled or moved: "Tell this device if it's cancelled or moved" on the booking form, and on the booking's page. It's optional, for that one booking, and the email always goes too.
- **Cancelling a booked date** now also notifies each device people asked for, within a minute. A device that has gone is never tried again; one that fails is retried, then given up on. Neither ever holds up an email.
- **A booked date moved in the Logic Engine is held under Needs attention.** Nobody booked is told until an approver chooses:
  - **Tell them it has moved:** their bookings for the old date are cancelled, and they get a link to book the new one;
  - **Cancel their bookings;**
  - **Leave it.**

  Bookings are never moved to another date. If the date comes back in the sheet, it settles itself and the bookings stand.
- **Emails that fail are retried and then given up on visibly**, instead of failing RTD Outbox every 5 minutes. They're retried after 5 minutes, 15 minutes, 1 hour, 4 hours and 12 hours.
  - A customer's email that fails opens a Needs attention item at once, with their details.
  - **Delivery** in the organiser shows how the last 7 days' emails and notifications went, with **Try again now**.
  - n8n RTD Outbox now reports each failure to the app (published 17:23); Dan is emailed only when one is given up on.
- **Moved dates and failed customer emails** are in the attention emails too: a notice, then the morning reminder.
- **Privacy:** a booking device's address is deleted the day after the date. The privacy notice says so.
- **Database:** migration `0020_delivery.sql` (outbox columns, two new tables). **Tests:** 363 (was 351).

## 2026-10-16 (Booking modes)
- **Each event now says whether people need to book:** **Not required**, **Optional** or **Required**. Approvers and admins set it under **Booking for café events** in the organiser (it was **Places for café events**).
  - **Not required:** "No booking needed: just come along." No booking form, and it's not on the Book page.
  - **Optional:** **Reserve a place**, "you can also just turn up". When the places run out: "you can still come along on the day".
  - **Required:** **Book a place**, with a **Booking required** chip. When the places run out, it's full.
- **Defaults:** the café's own events Optional; Standard Diary groups Not required (they no longer show a booking form); hosts' sessions Required; markets Not required.
- **Bookings already made always stand.** Switching to Not required while people are booked asks first, and their Manage / Cancel links keep working.
- **The sheet sync never changes it.** Every change is in the audit log.
- **Database:** migration `0019_booking_mode.sql` (one column). **Tests:** 351 (was 346).

## 2026-10-16 (Needs attention emails)
- **Emails about events that need attention,** to the addresses an admin sets under **Needs attention → Email reminders**. It's off until switched on. They go out through the usual outbox (n8n RTD Outbox, Gmail).
  - **A notice when a date passes with nothing after it:** the event, when it finished, and what to do. One per event per address, however often the check runs.
  - **A reminder every morning at about 9am,** listing every such event still waiting and how long it has waited. At most one a day per address. It stops when nothing is waiting.
  - **Opening an email never sorts anything:** only a decision in the organiser does.
- **Events with no usable date aren't emailed:** the morning reminder just mentions how many there are.
- **What was already waiting when emails are switched on** goes into the next morning's reminder, rather than each getting its own notice.
- **Never a flood:** at most 5 notices per hourly run.
- **Admins see how each email went:** queued; "sent" (Gmail accepted it; there's no proof it was read); or "not sent yet after 30 minutes", which means check RTD Outbox. There's also **Send a test**.
- **Database:** migration `0018_attention_emails.sql` (three columns, two settings). **Tests:** 346 (was 339).
- **n8n:** the Event Guard no longer emails its date-picker form when a one-off or monthly event passes; Needs attention covers it. It still sets the event Inactive and makes posters. See [docs/RTD_N8N_WORKFLOWS.md](docs/RTD_N8N_WORKFLOWS.md).

## 2026-10-16 (Needs attention)
- **New in the organiser, for approvers and admins: Needs attention.** It's switched off until an admin presses **Switch on**. It lists:
  - **events whose date has passed with nothing after it**, such as a one-off or a monthly event. Weekly clubs never appear, because their next date is already there;
  - **events with no usable date in the Logic Engine** (blank, text like "Every Thursday", or a date that has passed), which is why they aren't in the diary.
- **Each one stays until someone decides:**
  - **Set a new date:** it's written to Event Index within 15 minutes and then appears in the diary.
  - **Archive:** an active Event Index row is switched off in the sheet.
  - **Finished, no new date**, for a one-off.
  - **Leave as it is**, for a missing date.

  Looking at an item never resolves it. Standard Diary dates are changed in the sheet by hand.
- **It clears itself when the Logic Engine answers it:** a new date arrives, or a no-date event is switched off. One-off host sessions and markets are closed straight away, because the host is already invited to run it again.
- **Also listed:** dates with no end time, which only show for an hour after they start.
- **History:** "Sorted in the last 30 days" shows who decided what, and whether a new date is still waiting for the Logic Engine. Every step is in the audit log.
- **Live data when switched on:** Bingo (date passed; you've decided to archive it), plus 7 events with no usable date: Dungeons & Dragons, Magic: The Gathering, Cleeples, Wednesdays, DM Alfie, MoreThanABitDicey, Brownies & Guides.
- **No emails yet:** the expiry emails and daily reminders to info@ and Dan come in Stage 3c.
- **Database:** migration `0017_attention.sql` (one new column, one new table). **Tests:** 339 (was 326).

## 2026-10-16 (finished events leave the app when they end)
- **A date disappears from the public app the moment it ends,** not at midnight and not when n8n next syncs: the diary, Home, Book, event pages, Add to Calendar, link previews, the splash and markets. All-day dates (the Standard Diary) last until midnight. This is Stage 3a of the event control plan; see [docs/RTD_EVENT_CONTROL_AUDIT.md](docs/RTD_EVENT_CONTROL_AUDIT.md).
- **Old links to a finished, cancelled or moved date** now say only that ("Quiz has finished", "… was cancelled", "… has moved"), with a button to the next date if there is one. They no longer show the description, photo, price or booking panel. Shared links to them get the plain café preview.
- **Caching:** public lists are cached only until the first date in them ends (at most 60 seconds, as before).
- **Fixed:** an event running past midnight (say 19:00–01:00) was hidden from the diary all evening on its own date. One with no end time was hidden from its start time.
- **Admins:** an event that has ended can't be chosen for a reminder.
- **No database change.** **Tests:** 326 (was 313); evidence in [docs/RTD_EVENT_CONTROL_TESTS.md](docs/RTD_EVENT_CONTROL_TESTS.md).

## 2026-10-15 (template covers)
- **Every game has a cover now:** a game without a box image shows a template cover with its title, in its category's colour and icon (for example green with blocks for Children's & Educational, orange with a party popper for Party, Trivia & Social). The catalogue had no images, only search links, so all 124 games use it until a real cover is added under **Library → Cover**.
- **No rights to clear:** the app draws the template itself; there's no image file.

## 2026-10-15 (the café's game catalogue)
- **The catalogue is in the app's import:** 127 games from the café's shelf photos, each with category, audience, age, players, play time and a synopsis, plus 36 titles the photos couldn't identify for sure. The catalogue marks all of them provisional, so **none is confirmed yet**, and the public app is unchanged.
- **Confirming many at once:** under **Review**, tick the titles you can see on the shelf and press **Confirm ticked**, with one note ("Stocktake, 16 Oct"). Search the list, or **Tick all**. Titles that need details filled in (3 with an open-ended player count, and the 36 uncertain ones) are confirmed one at a time.
- **Review list:** each title shows its category, players, play time and age. The confirm form now scrolls into view.
- **Category names:** an apostrophe no longer starts a new word ("Children's", not "Children'S").
- **Next:** an admin runs **Game library → Import** (dry run, then apply), then works through **Review**. See [docs/GAME_LIBRARY_DEPLOYMENT.md](docs/GAME_LIBRARY_DEPLOYMENT.md#2-load-the-catalogue).
- **Tests:** 312 (was 308).

## 2026-10-15 (game library, switched off)
- **The game library's code is live, switched off,** so customers see no change yet: Roll Me a Game, the Games page and Game of the Week still use the 10 preview games, now served by the app's API.
  - **Ready for the café's games:** game pages with similar games and alternatives; Roll Me a Game filters for party size, youngest age, time, audience and category; a searchable shelf; Game of the Week picked each Monday (London time), avoiding the last 12 weeks.
  - **Admins:** **Game library** in the organiser: add, edit, retire and restore games; covers with their source and rights; **Review** for titles to confirm; **Import**; the live switch.
- **Waiting on:** the café's catalogue files and shelf photos. After the import and review, turning the library on needs your approval. See [docs/GAME_LIBRARY_DEPLOYMENT.md](docs/GAME_LIBRARY_DEPLOYMENT.md).
- **Database:** migration `0016_game_library.sql`, applied to the live database. Other tables unchanged.
- **Tests:** 308 (was 279).
- **Docs:** new [`docs/GAME_LIBRARY_AUDIT.md`](docs/GAME_LIBRARY_AUDIT.md), [`GAME_LIBRARY_DEPLOYMENT.md`](docs/GAME_LIBRARY_DEPLOYMENT.md), [`GAME_LIBRARY_IMAGE_AUDIT.md`](docs/GAME_LIBRARY_IMAGE_AUDIT.md) and [`GAME_LIBRARY_COMPLETION.md`](docs/GAME_LIBRARY_COMPLETION.md).

## 2026-10-15 (forced updates)
- **The app makes sure people run the newest version:**
  - **When it checks:** when it opens, when it comes back on screen, and between pages.
  - **What people see:** if a newer build is live, a screen asks them to **Update now**, with no way past it, and reloads into the new version.
  - **Offline:** nothing happens.
- **Version file:** each build writes `/version.json` with its ID. See [docs/RTD_APP_ARCHITECTURE.md](docs/RTD_APP_ARCHITECTURE.md#updates).

## 2026-10-12 (join request emails and the admin's name)
- **Join request emails** now go to info@rollthedicecafe.co.uk and dan@atechstudio.co.uk (was the café address in `rtd_config`). No n8n change: RTD Team Notices already sends to the app's `notify` list.
- **Names in the organiser:** Dan's admin account (dan@atechstudio.co.uk) always shows as **Dan (Admin)**, and everyone who isn't an admin (hosts and approvers) as **Name (Host)**: in the welcome, the Hosts and Approvers tables, sessions to approve and the dates list. Only the display changes: the stored names in emails and the diary stay as they are. See `web/src/lib/names.ts`.
- **Tests:** 282 (was 279).

## 2026-10-08 (stats for admins)
- **The app counts how it's used:** event page views; book, Add to calendar and Share taps; taps on event reminders; installs and opens from the Home Screen; visits in a browser; and views of the diary, Book, Games, Become a host and Markets pages, Roll Me a Game rolls and picks, and Apply to host taps.
  - **Daily totals only:** no network address, device ID or cookie, so a count says how many, never who.
  - **Not counted:** the café team and hosts (signed in to the organiser), robots, and floods (10 counts a request, 60 a minute from one address).
- **Stats** in the organiser, for admins: 7, 30 or 90 days against the period before, with headline numbers, event page views per day (with a table), the most viewed, most booked and most tapped events, every event (with bookings per view), and other counts around the app. Bookings, join requests, stall applications and reminders come from their own records.
- **Latest reminders** now shows how many people tapped each one.
- **Privacy notice:** a new **Counting visits** section.
- **Database:** migration `0015_stats.sql`, applied to the live database.
- **Tests:** 279 (was 270).
- **Docs:** new [`docs/RTD_STATS.md`](docs/RTD_STATS.md).

## 2026-10-08 (event alerts and reminders)
- **Get event alerts:** anyone can turn them on, with no account, from the home page or any event page. One switch covers everything. On iPhone, the card explains adding the app to the Home Screen first.
- **Admins send reminders** in the organiser (**Event reminders**):
  - **Pick an event:** the next date of every public event in the next fortnight, with when each last had a reminder.
  - **The words:** a suggested title and message to change as you like, with a preview.
  - **Facebook:** the same words, a link to the event and its photo go on the café's Facebook page through Buffer, unless you choose **No**.
  - **A second reminder within 24 hours** about the same event shows a warning (when, what and who), and needs **Send another anyway**.
  - **Latest reminders:** how many devices each reached, and whether the Facebook post went.
- **The automatic reminder:** at 8pm, about a random public event in the next three days, at most once every 48 hours. Admins' reminders don't count towards the 48 hours. No Facebook post.
- **Sending:** queued per device and sent 20 at a time by a new every-minute Cron Trigger (the free plan's limits). The daily erasing job now runs from the same trigger, at 03:23 UTC.
- **Approvers:** turning approval notifications off no longer unsubscribes a browser that has event alerts on.
- **Privacy:** the notice covers event alerts; the scrambled network code is erased after 2 days.
- **n8n:** new workflow **RTD Event Reminders To Facebook**.
- **Database:** migration `0014_event_alerts.sql`, applied to the live database.
- **Tests:** 270 (was 248).
- **Docs:** new [`docs/RTD_ALERTS.md`](docs/RTD_ALERTS.md).

## 2026-10-08 (markets: vendors apply for pitches)
- **Admins set up markets** in the organiser (**Markets** → **New market**):
  - **The details:** name, date and times, description, pitches, pitch fee, closing date, and how approved vendors pay.
  - **Into the diary:** it reaches the Logic Engine within 15 minutes, through the same n8n branch as host sessions (App Host Session `RTD-MKT-…`).
- **Vendors apply at `/markets`** without an account:
  - **The form:** stall, contact, what they sell, links, public liability insurance, and up to 3 photos (shrunk in the browser, kept privately, seen only by approvers).
  - **Waiting list:** once every pitch is approved, new applicants join a waiting list.
- **Approvers decide** under **Market applications**:
  - **Approve:** needs a free pitch, and emails the vendor the pitch fee, the payment details and their reference.
  - **Decline:** emails the vendor, with an optional note.
  - **Mark as dropped out:** frees the pitch.
  - **Alerts:** every application emails the approvers' inbox (info@) and sends a push.
- **The RTD Market Vendors spreadsheet** holds every application, kept up to date by the new n8n workflow **RTD Market Vendors To Sheet**.
- **Privacy:**
  - **Erasing:** applications are erased 12 months after the market, photos included, and the sheet row with them.
  - **The notice:** the privacy notice now covers vendors.
- **Markets set up in the app aren't booked by customers;** their diary page links vendors to the form.
- **n8n:**
  - **RTD Outbox:** fills in `@approvals`.
  - **RTD Host Sessions To Diary:** adds the year when a market's name clashes.
  - **New workflows:** the spreadsheet workflow, and a one-off that created the sheet.
- **Database:** migration `0013_markets.sql`, applied to the live database.
- **Tests:** 248 (was 235).
- **Docs:** new [`docs/RTD_MARKETS.md`](docs/RTD_MARKETS.md).

## 2026-10-07 (privacy notice; places for hosts and approvers)
- **Privacy notice** at `/privacy`:
  - **Where it's linked:** the booking form, the join form, the booking page, the footer and the booking confirmation email.
  - **What it says:** what is collected and why, who sees it, how long it's kept, people's rights, and how to complain to the ICO.
  - **Settings, not code:** the business name and contact address come from the app's settings, so they change without a release. The contact is the café's info@.
- **Erasing old details:** a daily job (Cron Trigger, 03:23 UTC):
  - **Bookings:** erases the name, email, mobile and note 12 months after the event.
  - **Network codes:** erases the scrambled code after 2 days.
  - **Join requests:** erases declined or withdrawn ones after 12 months.
  - **The audit log:** it can't be erased, so it now records bookings and requests by number, not by person.
- **Places:**
  - **Hosts:** **Change places** on their live session, for every date or one date, with no new approval.
  - **Approvers:** a new **Places for café events** section sets each café event's places instead of App Capacity in the sheet. **Change places** sets any single date in **Bookings coming up**.
  - **Rules:** never below what's already booked. A number set in the app holds until App Capacity changes in the sheet.
- **Bookings check the places as they're saved,** so lowering the places can't let a booking through on the old number.
- **Database:** migration `0012_places_privacy.sql`, applied to the live database.
- **Tests:** 235 (was 215).
- **Docs:** new [`docs/RTD_PRIVACY.md`](docs/RTD_PRIVACY.md).

## 2026-10-07 (customers book café events; every booking copied to info@)
- **Every public event can be booked:**
  - **Which ones:** the café's own events (Event Index and Standard Diary rows with App Visibility Public or App Bookable), as well as open host sessions.
  - **Limit:** App Capacity on the row; blank means no limit.
  - **Booking closes:** when the event starts.
  - **Where:** the booking form is on every event page. The Book page lists the next date of each bookable event, and Home now says booking is open.
- **The café's info@ address gets:**
  - **Each booking:** a copy of every booking, with contact details. Replying reaches the customer.
  - **Each cancellation:** a copy of every cancellation.
  - **Numbers:** two days before each booked café event.
  - **Warnings:** a "Check bookings" warning when a booked date disappears from the Logic Engine.
  - **Customer replies:** customers' replies to their confirmation go there too.
- **Approvers can cancel any date,** café events included, from **Bookings coming up** in the organiser (it was "Hosted sessions coming up"). Everyone booked is emailed.
- **Cancelled dates leave the Logic Engine** for café events too. A one-off goes Inactive, and a weekly or fortnightly row moves on. Monthly and Standard Diary dates are left to the café, and the email says so. n8n now matches rows on **Event ID**.
- **n8n:**
  - **`rtd_config`:** new key `RTD_BOOKINGS_EMAIL`.
  - **RTD Outbox:** fills in the app's `@bookings` placeholder.
  - **RTD Host Sessions To Diary:** branch C uses `/internal/sheet-fixes`.
- **Database:** migration `0011_cafe_bookings.sql` (`sheet_fixes`), applied to the live database.
- **Tests:** 215 (was 208).

## 2026-10-06 (approval alerts to info@)
- **Where they go:** the "new host session to approve" email now goes to the café's info@ address (`RTD_APPROVAL_ALERT_EMAIL` in `rtd_config`, read by n8n RTD Host Sessions To Diary).
- **Unchanged:** other café emails still use `RTD_CAFE_NOTIFICATION_EMAIL`.

## 2026-10-06 (send again or delete a declined session)
- **Hosts can re-propose a declined or withdrawn session:**
  - **The button:** **Edit and send again** opens the form filled in, with the café's note at the top.
  - **What happens:** the session goes back for approval with the same number. The café is emailed again, approvers get a "Session sent again" push, and Michelle sees a **Sent again** chip.
- **Hosts can delete a declined or withdrawn session.** It disappears from every list. The record and audit trail are kept, and session numbers are never reused.
- **Database:** migration `0010_resubmit.sql` (`host_sessions.deleted_at`, `resubmissions`), applied to the live database.
- **Tests:** 208 (was 203).

## 2026-10-06 (push notifications for approvals)
- **Approvers and admins can get push notifications** on their phone or computer, as well as the email:
  - **What triggers one:** a host sending a session to approve, or someone asking to host.
  - **Where to turn them on:** **Notifications on this device** in the organiser, with **Send a test** and **Turn off**.
  - **On iPhone:** the card explains adding the app to the Home Screen first.
- **Sent by the Worker itself:**
  - **Security:** each message is encrypted for its device (RFC 8291) and signed with the app's own key (RFC 8292), made on first use and kept in D1.
  - **No setup:** there's no third-party service and no secret to set.
- **Service worker:** shows the notification, and opens the organiser at the right place when it's tapped.
- **Database:** migration `0009_push.sql` (`push_subscriptions`, `push_keys`), applied to the live database.
- **Tests:** 203 (was 192), including decrypting each push the way a browser does.
- **Docs:** new [`docs/RTD_PUSH.md`](docs/RTD_PUSH.md).

## 2026-10-06 (bookings for hosted sessions; one way in)
- **Hosts and café staff join the same way.**
  - **What they can do:** one form, "Ask to host games". Everyone approved is a host, so they can only plan sessions.
  - **Approvers:** Michelle (an "approver") approves join requests and every session. Dan, as admin, chooses approvers (**Make approver** / **Stop approving**).
  - **No direct adding:** the "Add a host" form is gone.
- **Booking open host sessions** on their event page, without an account:
  - **The form:** name, email, optional mobile, how many places, and a note for the host.
  - **Capacity:** counted in people, checked inside the database insert, so the last places can't be double-booked. There are per-email and per-network limits.
  - **Confirmation email:** includes a Manage / Cancel link (`/booking/:id`). Only a hash of its secret is stored.
  - **Where it shows:** a **Book in the app** chip on cards. The Book page now lists hosted sessions to book.
- **Hosts:**
  - **In the organiser:** they see who's booked on each upcoming date.
  - **Emails:** one for every booking and cancellation, plus "N of M places booked" **two days before** each date.
  - **Cancelling a date:** a host can cancel one date, with a message. Everyone booked is emailed, and so is the café.
  - **Approvers:** they see every hosted date for the next three weeks, with contact details, and can cancel too.
- **Cancelled dates:**
  - **In the app:** they leave the diary, stay cancelled through syncs, and are taken out of the Logic Engine (one-off → Inactive; weekly → its next date), so they're never advertised.
- **Emails:**
  - **How they're sent:** the app writes booking emails to an outbox in the same transaction as the change. The new n8n **RTD Outbox** sends them every 5 minutes.
  - **The sheet:** **RTD Host Sessions To Diary** gained the sheet branch for cancelled dates.
- **Database:** migration `0008_bookings.sql` (`bookings`, `outbox`, `occurrences.cancelled_by`, `host_sessions.sheet_fix_*`), applied to the live database.
- **Tests:** 192 (was 171).
- **Docs:** new [`docs/RTD_BOOKINGS.md`](docs/RTD_BOOKINGS.md); [`docs/RTD_ONBOARDING.md`](docs/RTD_ONBOARDING.md) rewritten.

## 2026-10-06 (onboarding for hosts and café staff)
- **People ask for access themselves:** anyone who signs in at `/organise` without access sees **Join Roll The Dice**, where they ask to **Host games** or join the **Café team**. They can see where their request is, and withdraw it.
- **Approvals, in the organiser under Join requests:**
  - **Host requests:** staff (Michelle) or an admin.
  - **Café team requests:** admins only (Dan). Staff never see them.
  - **What approval does:** it gives access immediately. Declining can include a note the applicant sees.
- **Removing access:**
  - **Hosts:** staff remove them from the Hosts table.
  - **Café team:** admins remove them from the new Café team table.
  - **Limits:** nobody can remove themselves or an admin.
  - **Coming back:** someone removed can ask again, and keeps the same user record.
- **Emails,** by the new n8n **RTD Team Notices** (every 15 minutes):
  - **To the approver:** about each new request (host requests to the café address, café team requests to the admins).
  - **To the applicant:** the outcome.
  - **To hosts:** whether the café approved their session.
- **Become a Host page:** now has **Apply to host** and **Open the organiser**.
- **Audit:** requests, decisions, access granted and access removed are all in `audit_log`.
- **Database:** migration `0007_onboarding.sql` (`applications`, `host_sessions.host_notified_at`), applied to the live database.
- **Tests:** 171 (was 157).
- **Docs:** new [`docs/RTD_ONBOARDING.md`](docs/RTD_ONBOARDING.md).

## 2026-10-05 (host sessions into the diary)
- **Approved host sessions reach the diary:**
  - **How:** n8n **RTD Host Sessions To Diary** (every 15 minutes) adds them to Event Index, and the sync links each row back to its session, which then shows as Live.
  - **The rows:** open sessions are Public, private ones Private. New columns App Price, App Capacity and App Host Session were added, after a backup of the sheet.
- **The café is emailed about each new submission,** with a link to `/organise`. Replies go to the host.
- **Event pages** show "£5 per player, paid at the café" and "Up to N players" when known.
- **Private sessions are never advertised:**
  - **RTD Master V1:** the evening round-up, Sunday weekly post and hourly event post skip `App Visibility = Private`.
  - **Event Guard:** it makes no posters for Private rows, and doesn't ask the café for a new date when a host one-off passes.
  - Rollback versions are in `docs/RTD_N8N_WORKFLOWS.md`.
- **Database:** migration `0006_host_publishing.sql`, applied to the live database.
- **Tests:** 157 (was 152).
- **Follow-up email:** a test email went to Dan using a dummy session, which was then removed.

## 2026-10-05 (open or private sessions; private sessions in the diary)
- **Organiser:** a new "Who can come?" choice on the session form. **Open** is the default; **Private** is for a host's own group. Cards and the staff queue show "Private".
- **Diary:**
  - **Private events now show as busy:** Logic Engine rows with App Visibility `Private` appear as "Private session" with their time, on a purple, striped ticket you can't open. Before, they didn't appear at all.
  - **Their details never leave the server:** not the name, description, photo or price.
  - **Never promoted:** they have no event page, link preview or calendar file, and are never featured on Home, Coming Up, Book or the splash screen.
- **Home:** a "Plus 2 private sessions today" line under the main event.
- **Database:** migration `0005_host_session_access.sql` (`access`), applied to the live database.
- **Tests:** 152 (was 150).

## 2026-10-05 (organiser sign-in, weekly sessions, host follow-up)
- **Sign-in fixed:** the organiser's Sign in button looped, because `/organise` and `/api/host` weren't behind Access. It now goes through `/api/staff/sign-in`, which is behind the RTD Staff application; Access's cookie then covers the organiser. No dashboard change is needed.
  - **Failed sign-ins are explained:** if a sign-in still doesn't stick, the page explains, with a reason (`missing` or `invalid`), instead of looping.
  - **Sign out fixed:** the Sign out link opened the app's not-found page. It now reaches Cloudflare.
- **One-off or weekly:** a new "How often?" choice on the session form. Weekly sessions show "Every Tuesday" and their next date.
- **After a one-off:** n8n **RTD Host Follow-up** emails the host the day after an approved one-off session. Endpoints: `/internal/host-sessions/followups` and `/internal/host-sessions/:id/followup-sent`.
- **Database:** migration `0004_host_session_frequency.sql` (`frequency`, `followup_sent_at`), applied to the live database.
- **Tests:** 150 (was 145).

## 2026-10-05 (host organiser)
- **`/organise`, the host organiser, is built** (behind Cloudflare Access; the `users` table decides roles).
  - **Hosts** create sessions (event name, date, start and end time, cost per player, max players, description), see their status, and withdraw them.
  - **Staff** approve or decline (with a note for the host) and add hosts.
- **API:** `/api/host/*` and `/api/staff/host-sessions`, `/api/staff/hosts`. Changes must be same-origin JSON.
- **Database:** migration `0003_host_sessions.sql`, applied to the live database. Sessions are numbered `RTD-HS-00001`, and every change is audited.
- **Docs:** `docs/RTD_HOST_PORTAL.md`.
- **Tests:** 145 (was 137).

## 2026-10-05 (event photos)
- **Event photos from Drive:** the new n8n workflow **RTD Event Images** (`GeafnErtRe5ZMbiD`, every 6 hours) copies the newest 8 photos from each visible event's Photo Folder ID into the app.
  - Google resizes them to 1400px WebP first.
  - Files with `noapp` or `private` in their name are skipped.
- **App:**
  - **New endpoints:** `/internal/images/plan`, `/sync` and `PUT /internal/images/:event/:file` (bearer token); `/images/:id` serves the photos.
  - **Storage:** photos are kept in Workers KV (`rtd-app-images`). Migration `0002_event_images.sql` adds the `event_images` table.
  - **Where photos appear:** event cards, event pages (new "From past sessions" gallery with a full-screen viewer), the splash and link previews.
  - **Variety:** each date of a weekly event shows a different photo.
- **Tests:** 136 (was 125).

## 2026-10-05 (install banner)
- **"Install the app" now sits at the top of every page.**
  - It opens the install dialog on Android/Chrome.
  - It shows Add to Home Screen steps on iPhone.
  - In Facebook/Instagram's built-in browser, it says to open the page in a real browser.
- **When it hides:** once installed, and for 14 days after "Not now". The footer keeps an Install button.
- **Home's install card removed:** the banner replaces it.
- **Tests:** 125 (was 120).

## 2026-10-05 (theme and Phase 2 app)
- **Visual theme from the café's logo:** extracted from `RTDLogo.jpg`, documented in `docs/RTD_APP_THEME.md`.
  - Navy `#123F68` measured from the image; orange accent from existing RTD posters.
  - Arvo display type, Figtree interface type, sticker-outline shapes.
  - Central tokens in `web/src/theme/`, with customer, host and staff intensities.
- **Branded PWA (Phase 2) served by the Worker:**
  - **Screens:** Home, Diary, Event pages, splash, Roll Me a Game (3D dice, Chaos Roll), Games, Book, Become a Host, and a `/styleguide` page.
  - **App features:** installable, offline diary, Add to Calendar (`.ics` and Google), Share, and event-specific link previews.
- **New API:**
  - `GET /api/occurrences/:id/calendar.ics`
  - `GET /api/occurrences/:id/google-calendar`
- **New config:** `VENUE_LOCATION` var.
- **Logo assets:**
  - Logo cut-out, dice mark, PWA/maskable/Apple icons, favicon and share image, generated by `scripts/brand-assets.py`.
  - The logo is not redrawn.
- **Tests:** 120 (was 84). New tests cover calendar files, link previews and theme contrast.

## 2026-10-05 (Cloudflare)
- **RTD Event Sync is live** (every 15 min).
  - First sync: 31 events, 40 occurrences. A repeat sync makes no changes.
- **Sync refusals now name their cause:** no secret (503), missing or non-Bearer header, or wrong token (401). `keep_vars` stops Git deploys deleting dashboard variables.
- **App deployed** at https://rtd-app.dan-289.workers.dev from GitHub (Workers Builds). Staff Access is on `/api/staff`.
- **RTD Event Sync** n8n workflow built (switched off until its credential exists). `rtd_config` gained `RTD_APP_BASE_URL`.
- **Fix:** a retried run of a refused sync now stays refused (`409`), instead of coming back as a "duplicate" success.
- **D1 database `rtd-app` created** (WEUR) through the Cloudflare connector.
  - `0001_foundation.sql` applied and recorded in `d1_migrations`.
  - First admin user added.
- **`wrangler.jsonc`** now points at the real database id.
- **Added `scripts/cloudflare-setup.sh`,** a one-command setup for running it from your own machine.

## 2026-10-05 (later)

### n8n / Logic Engine (live)
- **Logic Engine backup** taken: "Logic Engine_RTD BACKUP 2026-10-05 1200 (before app ID columns)".
- **New sheet columns** `Event ID`, `App Visibility` and `App Category` added at the end of Event Index and Standard Diary.
  - IDs backfilled: `RTD-EVT-00001`–`00031`.
  - One-off workflow: `RTD One-Off: Add App ID Columns`.
- **RTD Master V1:** `Calculate next dates` no longer auto-rolls Monthly events.
- **RTD Event Guard (sub):** new node `Monthly: Ask For Next Date`, so a passed Monthly event expires and the date-picker email goes to Michelle. Published; two dry runs passed.
- **`rtd_config`** data table created, holding `RTD_CAFE_NOTIFICATION_EMAIL`.

### App (repo)
- **Phase 1 data foundation** on Cloudflare Workers + D1: schema migration, Logic Engine sync with occurrence history, public diary API, staff API behind Cloudflare Access, append-only audit log, 82 tests.
- **Docs added:**
  - `RTD_APP_ARCHITECTURE.md`
  - `RTD_DATABASE_SCHEMA.md`
  - `RTD_N8N_WORKFLOWS.md`
  - `RTD_DEPLOYMENT.md`
  - `RTD_RECOVERY.md`
- **Audit updated** with your decisions, the hard-coded Meta token (S1), and the poster title rule bug.

## 2026-10-05
- Repository created with the build specification.
- Phase 0 audit completed (read-only): `docs/RTD_AUDIT.md`. No changes made to n8n, Google Sheets or Drive.
