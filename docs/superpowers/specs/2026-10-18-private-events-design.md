# Private events show as private games, with a message form — design

Date: 18 October 2026. Approved in conversation ("Looks good, build").

## What the owner asked for

> On events that aren't public - I want these to show still, not be entirely private, and the event should show up as
> happening and "Interested in Joining? Get in touch!" On the card and on the event page itself. I want the cafe to show
> as busy, not publicly inaccessible. This way, private sessions show as a private game e.g. Arkham Horror Card game,
> not just a private session.

The owner's choices: an **in-app message form**; show **name, time and description**. (Cleeples was set to Optional
in the live database the same day: no code change.)

## Design

1. **What a private event shows.** Private means `visibility = 'private'` on the event or the date; Hidden never leaves
   the database, unchanged.
   - Diary, Home and cards: the real name, time and a **Private game** tag. No booking button, price, places or photo.
   - Event page (`/event/:id`, the API `/api/occurrences/:id`, calendar links and the share preview): name, date,
     times and description, with **"Interested in joining? Get in touch!"** instead of booking. Sharing and Add to
     calendar work as for any event.
   - The server still strips price, places, photo, booking and market fields (`redactPrivate`); bookings stay refused
     server-side (they check `VISIBLE`).
2. **The message form** (`POST /api/occurrences/:id/enquiry`), only for a private date still to come.
   - Body: `name` (1–80), `email`, `message` (1–1000), `consent: true`, and a hidden trap field `website`.
   - Trap field filled: answer 200 as if sent, store and send nothing.
   - At most 3 messages an hour from one network (hashed with the day, like bookings): 429.
   - Emailed to the café's bookings inbox, and to the host for a host's session (active host only), with reply-to set
     to the sender. Nothing is emailed to the sender (the form can't be used to email strangers); the page says sent.
   - Stored in a new `enquiries` table (migration `0023_enquiries.sql`): applied to production only with the owner's
     go-ahead.
3. **Privacy.** A message is deleted 90 days after it was sent; its scrambled network address after 2 days (daily
   retention job). The privacy notice says what's collected, why, who sees it and for how long.
4. **Host wording.** The host form's Private option: "Shows in the diary with its name and description, but no booking.
   People can message you through the app to ask about joining."

## Testing

Server: private dates show name and description but never price, places, photo or booking; the event page and
calendar work for a private date; the form's checks, trap, hourly limit and recipients; erasure after 90 days.
Browser: card and event page on phone and desktop.
