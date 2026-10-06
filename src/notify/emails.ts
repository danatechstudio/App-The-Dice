// Booking emails (docs/RTD_BOOKINGS.md). The app writes each email into the
// outbox; n8n (RTD Outbox) only sends it. Everything a person typed is escaped.

import { esc, firstName, longDate, places, shortDate, timeLabel } from '../lib/format';

/** One email for the outbox. to / reply_to null = the café address (rtd_config in n8n). */
export interface Email {
  dedupe_key: string;
  kind: string;
  to: string | null;
  reply_to: string | null;
  subject: string;
  html: string;
}

/** One date of a hosted session, as the emails describe it. */
export interface Slot {
  occurrence_id: string;
  name: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  price_display: string | null;
  capacity: number;
  host_name: string | null;
}

export interface Links {
  origin: string;
}

const p = (html: string) => `<p>${html}</p>`;
const fact = (label: string, value: string) => `<p style="margin:4px 0"><strong>${label}:</strong> ${value}</p>`;
const link = (href: string, text: string) => `<a href="${esc(href)}">${esc(text)}</a>`;
const SIGN_OFF = p('Thanks,<br>The Roll The Dice team');
const when = (s: Slot) => `${longDate(s.event_date)}, ${timeLabel(s.start_time, s.end_time)}`;
const cost = (price: string | null) =>
  !price || /^free$/i.test(price.trim()) ? 'Free' : `${esc(price)} per player, paid at the café`;
const join = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join('\n');

/** To the person who booked. `{{booking_id}}` is filled in by the database when the booking is saved. */
export function bookingConfirmed(s: Slot, b: { lead_name: string; email: string; party_size: number }, manageUrl: string, l: Links): Email {
  return {
    dedupe_key: 'booking-confirmed:{{booking_id}}',
    kind: 'booking_confirmed',
    to: b.email,
    reply_to: null,
    subject: `You're booked: ${s.name}, ${shortDate(s.event_date)}`,
    html: join([
      p(`Hi ${esc(firstName(b.lead_name))},`),
      p(`You're booked on <strong>${esc(s.name)}</strong>.`),
      fact('When', when(s)),
      fact('Places', `${places(b.party_size)}, under ${esc(b.lead_name)}`),
      fact('Cost', cost(s.price_display)),
      s.host_name && fact('Hosted by', esc(firstName(s.host_name))),
      fact('Where', 'Roll The Dice Board Game Café'),
      fact('Booking', '{{booking_id}}'),
      p(link(`${l.origin}/event/${s.occurrence_id}`, 'See the session')),
      p(`Can't make it any more? ${link(manageUrl, 'Cancel your booking')}, so someone else can have your place.`),
      p('Any questions? Just reply to this email.'),
      p('See you there,<br>The Roll The Dice team'),
    ]),
  };
}

/** To the host, each time someone books. */
export function hostNewBooking(s: Slot, b: { lead_name: string; party_size: number; notes: string | null }, booked: number, hostEmail: string | null, l: Links): Email {
  return {
    dedupe_key: 'booking-new-host:{{booking_id}}',
    kind: 'host_new_booking',
    to: hostEmail,
    reply_to: null,
    subject: `New booking: ${s.name}, ${shortDate(s.event_date)}`,
    html: join([
      p(`Hi ${esc(firstName(s.host_name))},`),
      p(`<strong>${esc(b.lead_name)}</strong> has booked ${places(b.party_size)} on <strong>${esc(s.name)}</strong> (${when(s)}).`),
      p(`${booked} of ${s.capacity} places are now taken.`),
      b.notes && p(`Their note: "${esc(b.notes)}"`),
      p(link(`${l.origin}/organise`, 'See everyone booked in the organiser')),
      SIGN_OFF,
    ]),
  };
}

/** To the host, when someone cancels their own booking. */
export function hostBookingCancelled(s: Slot, b: { booking_id: string; lead_name: string; party_size: number }, booked: number, hostEmail: string | null, l: Links): Email {
  return {
    dedupe_key: `booking-cancelled-host:${b.booking_id}`,
    kind: 'host_booking_cancelled',
    to: hostEmail,
    reply_to: null,
    subject: `Booking cancelled: ${s.name}, ${shortDate(s.event_date)}`,
    html: join([
      p(`Hi ${esc(firstName(s.host_name))},`),
      p(`${esc(b.lead_name)} has cancelled their booking (${places(b.party_size)}) on <strong>${esc(s.name)}</strong> (${when(s)}).`),
      p(`${booked} of ${s.capacity} places are now taken.`),
      p(link(`${l.origin}/organise`, 'Open the organiser')),
      SIGN_OFF,
    ]),
  };
}

/** To the host two days before: the numbers, and the option to cancel. */
export function hostNumbers(s: Slot, bookings: { lead_name: string; party_size: number }[], hostEmail: string | null, tomorrow: string, l: Links): Email {
  const booked = bookings.reduce((n, b) => n + b.party_size, 0);
  const day = s.event_date === tomorrow ? `tomorrow, ${when(s)}` : when(s);
  return {
    dedupe_key: `host-numbers:${s.occurrence_id}`,
    kind: 'host_numbers',
    to: hostEmail,
    reply_to: null,
    subject: `${s.name}, ${shortDate(s.event_date)}: ${booked} of ${s.capacity} places booked`,
    html: join([
      p(`Hi ${esc(firstName(s.host_name))},`),
      p(`<strong>${esc(s.name)}</strong> is on ${day}. ${booked ? `${booked} of ${s.capacity} places are booked:` : 'Nobody has booked a place yet.'}`),
      bookings.length > 0 && `<ul>${bookings.map(b => `<li>${esc(b.lead_name)} (${places(b.party_size)})</li>`).join('')}</ul>`,
      p(
        `If those numbers aren't enough to run it, you can cancel this date in ${link(`${l.origin}/organise`, 'the organiser')}. ` +
          "Everyone booked is emailed for you, and the café is told.",
      ),
      p("If it's going ahead, there's nothing you need to do."),
      SIGN_OFF,
    ]),
  };
}

/** To each person booked, when the host or the café cancels the date. */
export function attendeeDateCancelled(
  s: Slot,
  b: { booking_id: string; lead_name: string; email: string; party_size: number },
  by: 'host' | 'staff',
  message: string | null,
  l: Links,
): Email {
  return {
    dedupe_key: `date-cancelled:${s.occurrence_id}:${b.booking_id}`,
    kind: 'attendee_date_cancelled',
    to: b.email,
    reply_to: null,
    subject: `Cancelled: ${s.name}, ${shortDate(s.event_date)}`,
    html: join([
      p(`Hi ${esc(firstName(b.lead_name))},`),
      p(
        `Sorry, <strong>${esc(s.name)}</strong> on ${when(s)} has been cancelled ${by === 'host' ? 'by the host' : 'by the café'}, ` +
          `so your booking for ${places(b.party_size)} is cancelled too. There's nothing you need to do.`,
      ),
      message && p(`A message from ${by === 'host' ? esc(firstName(s.host_name)) : 'the café'}: "${esc(message)}"`),
      p(link(`${l.origin}/diary`, 'See what else is on')),
      p('Sorry again,<br>The Roll The Dice team'),
    ]),
  };
}

/** To the café (when the host cancels) or to the host (when the café does). */
export function dateCancelledNotice(
  s: Slot,
  by: 'host' | 'staff',
  who: string,
  hostEmail: string,
  count: { bookings: number; people: number },
  message: string | null,
  l: Links,
): Email {
  const told =
    count.bookings === 0
      ? 'Nobody had booked.'
      : `${count.bookings === 1 ? '1 booking' : `${count.bookings} bookings`} (${places(count.people)}) were cancelled, and each person has been emailed.`;
  if (by === 'host') {
    return {
      dedupe_key: `date-cancelled:${s.occurrence_id}:cafe`,
      kind: 'cafe_date_cancelled',
      to: null,
      reply_to: hostEmail,
      subject: `Host cancelled: ${s.name}, ${shortDate(s.event_date)}`,
      html: join([
        p(`${esc(who)} has cancelled <strong>${esc(s.name)}</strong> on ${when(s)}.`),
        p(told),
        message && p(`Their message to the people booked: "${esc(message)}"`),
        p('The app now shows that date as cancelled. Reply to this email to contact the host.'),
      ]),
    };
  }
  return {
    dedupe_key: `date-cancelled:${s.occurrence_id}:host`,
    kind: 'host_date_cancelled',
    to: hostEmail,
    reply_to: null,
    subject: `The café cancelled: ${s.name}, ${shortDate(s.event_date)}`,
    html: join([
      p(`Hi ${esc(firstName(s.host_name))},`),
      p(`The café has cancelled <strong>${esc(s.name)}</strong> on ${when(s)}.`),
      p(told),
      message && p(`A message from the café: "${esc(message)}"`),
      p('Any questions? Just reply to this email.'),
      SIGN_OFF,
    ]),
  };
}
