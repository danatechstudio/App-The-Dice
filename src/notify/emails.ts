// Booking emails (docs/RTD_BOOKINGS.md). The app writes each email into the
// outbox; n8n (RTD Outbox) only sends it. Everything a person typed is escaped.

import { esc, firstName, longDate, places, shortDate, timeLabel } from '../lib/format';

/**
 * The café's bookings inbox (info@). n8n swaps this for rtd_config
 * RTD_BOOKINGS_EMAIL when it sends, so the address never lives in the app.
 */
export const BOOKINGS_INBOX = '@bookings';

/**
 * One email for the outbox. `to` / `reply_to`: an address, BOOKINGS_INBOX, or
 * null for the café's general address (rtd_config RTD_CAFE_NOTIFICATION_EMAIL).
 */
export interface Email {
  dedupe_key: string;
  kind: string;
  to: string | null;
  reply_to: string | null;
  subject: string;
  html: string;
}

/** One date of an event (the café's own, or a host's session), as the emails describe it. */
export interface Slot {
  occurrence_id: string;
  name: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  price_display: string | null;
  /** null: no limit on numbers. */
  capacity: number | null;
  /** Only for a host's session. */
  host_name: string | null;
}

export interface Links {
  origin: string;
}

export interface Contact {
  booking_id: string;
  lead_name: string;
  email: string;
  mobile: string | null;
  party_size: number;
  notes: string | null;
}

const p = (html: string) => `<p>${html}</p>`;
const fact = (label: string, value: string) => `<p style="margin:4px 0"><strong>${label}:</strong> ${value}</p>`;
const link = (href: string, text: string) => `<a href="${esc(href)}">${esc(text)}</a>`;
const SIGN_OFF = p('Thanks,<br>The Roll The Dice team');
const when = (s: Slot) => `${longDate(s.event_date)}, ${timeLabel(s.start_time, s.end_time)}`;
const join = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join('\n');
const isFree = (price: string) => /^free$/i.test(price.trim());
/** "5 of 8 places", or "5 places" when there's no limit. */
const taken = (booked: number, capacity: number | null) => (capacity ? `${booked} of ${capacity} places` : places(booked));
const contactLine = (c: Contact) =>
  `${esc(c.lead_name)} · ${places(c.party_size)} · ${link(`mailto:${c.email}`, c.email)}${c.mobile ? ` · ${esc(c.mobile)}` : ''}${c.notes ? ` · "${esc(c.notes)}"` : ''}`;

/** To the person who booked. `{{booking_id}}` is filled in by the database when the booking is saved. */
export function bookingConfirmed(s: Slot, b: { lead_name: string; email: string; party_size: number }, manageUrl: string, l: Links): Email {
  return {
    dedupe_key: 'booking-confirmed:{{booking_id}}',
    kind: 'booking_confirmed',
    to: b.email,
    reply_to: BOOKINGS_INBOX,
    subject: `You're booked: ${s.name}, ${shortDate(s.event_date)}`,
    html: join([
      p(`Hi ${esc(firstName(b.lead_name))},`),
      p(`You're booked on <strong>${esc(s.name)}</strong>.`),
      fact('When', when(s)),
      fact('Places', `${places(b.party_size)}, under ${esc(b.lead_name)}`),
      s.price_display && fact('Cost', isFree(s.price_display) ? 'Free' : `${esc(s.price_display)} per player, paid at the café`),
      s.host_name && fact('Hosted by', esc(firstName(s.host_name))),
      fact('Where', 'Roll The Dice Board Game Café'),
      fact('Booking', '{{booking_id}}'),
      p(link(`${l.origin}/event/${s.occurrence_id}`, 'See the details')),
      p(`Can't make it any more? ${link(manageUrl, 'Cancel your booking')}, so someone else can have your place.`),
      p('Any questions? Just reply to this email.'),
      p('See you there,<br>The Roll The Dice team'),
      `<p style="font-size:13px;color:#666">${link(`${l.origin}/privacy`, 'How we use your details')}</p>`,
    ]),
  };
}

/** To the café's bookings inbox, for every booking. Replying reaches the person who booked. */
export function cafeNewBooking(s: Slot, b: { lead_name: string; email: string; mobile: string | null; party_size: number; notes: string | null }, booked: number, l: Links): Email {
  return {
    dedupe_key: 'booking-new-cafe:{{booking_id}}',
    kind: 'cafe_new_booking',
    to: BOOKINGS_INBOX,
    reply_to: b.email,
    subject: `New booking: ${s.name}, ${shortDate(s.event_date)} (${places(b.party_size)})`,
    html: join([
      p(`<strong>${esc(b.lead_name)}</strong> has booked ${places(b.party_size)} on <strong>${esc(s.name)}</strong> (${when(s)}).`),
      fact('Email', link(`mailto:${b.email}`, b.email)),
      b.mobile && fact('Mobile', esc(b.mobile)),
      b.notes && fact('Note', `"${esc(b.notes)}"`),
      s.host_name && fact('Hosted by', esc(s.host_name)),
      fact('Booking', '{{booking_id}}'),
      p(`${taken(booked, s.capacity)} now booked.`),
      p(`Reply to this email to contact ${esc(firstName(b.lead_name))}. ${link(`${l.origin}/organise`, 'See all bookings in the organiser')}.`),
    ]),
  };
}

/** To the bookings inbox, when someone cancels their own booking. */
export function cafeBookingCancelled(s: Slot, b: { booking_id: string; lead_name: string; email: string; party_size: number }, booked: number): Email {
  return {
    dedupe_key: `booking-cancelled-cafe:${b.booking_id}`,
    kind: 'cafe_booking_cancelled',
    to: BOOKINGS_INBOX,
    reply_to: b.email,
    subject: `Booking cancelled: ${s.name}, ${shortDate(s.event_date)} (${places(b.party_size)})`,
    html: join([
      p(`${esc(b.lead_name)} has cancelled their booking (${places(b.party_size)}, ${b.booking_id}) on <strong>${esc(s.name)}</strong> (${when(s)}).`),
      p(`${taken(booked, s.capacity)} now booked.`),
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
      p(`${taken(booked, s.capacity)} are now taken.`),
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
      p(`${taken(booked, s.capacity)} are now taken.`),
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
    subject: `${s.name}, ${shortDate(s.event_date)}: ${taken(booked, s.capacity)} booked`,
    html: join([
      p(`Hi ${esc(firstName(s.host_name))},`),
      p(`<strong>${esc(s.name)}</strong> is on ${day}. ${booked ? `${taken(booked, s.capacity)} are booked:` : 'Nobody has booked a place yet.'}`),
      bookings.length > 0 && `<ul>${bookings.map(b => `<li>${esc(b.lead_name)} (${places(b.party_size)})</li>`).join('')}</ul>`,
      p(
        `If those numbers aren't enough to run it, you can cancel this date in ${link(`${l.origin}/organise`, 'the organiser')}. ` +
          'Everyone booked is emailed for you, and the café is told.',
      ),
      p("If it's going ahead, there's nothing you need to do."),
      SIGN_OFF,
    ]),
  };
}

/** To the bookings inbox two days before a café event that people have booked. */
export function cafeNumbers(s: Slot, bookings: Contact[], tomorrow: string, l: Links): Email {
  const booked = bookings.reduce((n, b) => n + b.party_size, 0);
  const day = s.event_date === tomorrow ? `tomorrow, ${when(s)}` : when(s);
  return {
    dedupe_key: `cafe-numbers:${s.occurrence_id}`,
    kind: 'cafe_numbers',
    to: BOOKINGS_INBOX,
    reply_to: null,
    subject: `${s.name}, ${shortDate(s.event_date)}: ${taken(booked, s.capacity)} booked`,
    html: join([
      p(`<strong>${esc(s.name)}</strong> is on ${day}. ${taken(booked, s.capacity)} are booked in the app:`),
      `<ul>${bookings.map(b => `<li>${contactLine(b)}</li>`).join('')}</ul>`,
      p(`If it has to be cancelled, cancel the date in ${link(`${l.origin}/organise`, 'the organiser')} (Bookings coming up), so everyone booked is emailed.`),
    ]),
  };
}

/** To the bookings inbox when a booked date has gone from the Logic Engine (moved or switched off). */
export function orphanedBookings(s: Slot, bookings: Contact[], l: Links): Email {
  const people = bookings.reduce((n, b) => n + b.party_size, 0);
  return {
    dedupe_key: `orphaned:${s.occurrence_id}`,
    kind: 'cafe_orphaned_bookings',
    to: BOOKINGS_INBOX,
    reply_to: null,
    subject: `Check bookings: ${s.name}, ${shortDate(s.event_date)}`,
    html: join([
      p(
        `<strong>${esc(s.name)}</strong> on ${when(s)} has ${bookings.length === 1 ? '1 booking' : `${bookings.length} bookings`} (${places(people)}), ` +
          'but that date is no longer in the Logic Engine: it was moved, or the event was switched off.',
      ),
      `<ul>${bookings.map(b => `<li>${contactLine(b)}</li>`).join('')}</ul>`,
      p(
        `If it's cancelled, cancel the date in ${link(`${l.origin}/organise`, 'the organiser')} so everyone booked is emailed. ` +
          "If it's moved, put the date back in the sheet, or let the people booked know.",
      ),
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
    reply_to: BOOKINGS_INBOX,
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

/**
 * After a date is cancelled: to the bookings inbox (a host cancelled, or the
 * café cancelled one of its own events) or to the host (the café cancelled theirs).
 */
export function dateCancelledNotice(
  s: Slot,
  by: 'host' | 'staff',
  who: string,
  hostEmail: string | null,
  count: { bookings: number; people: number },
  message: string | null,
  sheetNote: string | null,
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
      to: BOOKINGS_INBOX,
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
  if (hostEmail) {
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
  // One of the café's own events: a record for the bookings inbox.
  return {
    dedupe_key: `date-cancelled:${s.occurrence_id}:cafe`,
    kind: 'cafe_date_cancelled',
    to: BOOKINGS_INBOX,
    reply_to: null,
    subject: `Cancelled: ${s.name}, ${shortDate(s.event_date)}`,
    html: join([
      p(`${esc(who)} cancelled <strong>${esc(s.name)}</strong> on ${when(s)} in the organiser.`),
      p(told),
      message && p(`The message to the people booked: "${esc(message)}"`),
      sheetNote && p(sheetNote),
    ]),
  };
}
