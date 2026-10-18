// Asking to join a private game (docs/superpowers/specs/2026-10-18-private-events-design.md).
// A private game shows in the diary by name, time and description, with "Interested in joining?
// Get in touch!" instead of booking. The message goes to the café's bookings inbox, and to the
// host for a host's session, with reply-to set to the person asking, so either can just reply.
// Nothing is emailed to the person asking: the form can't be used to email strangers.
// - Only for a private date still to come.
// - A field people can't see: if it's filled in, the answer is "sent" and nothing happens.
// - At most 3 messages an hour from one network (scrambled with the day, as bookings).
// - Kept 90 days, the network hash 2 days (src/lib/privacy.ts).

import { EMAIL, sha256 } from '../bookings/bookings';
import { esc, longDate, shortDate, timeLabel } from '../lib/format';
import { LISTED, OCCURRENCE_ID, upcoming } from '../lib/queries';
import { londonDate } from '../lib/time';
import { BOOKINGS_INBOX, fact, join, link, p, type Email } from '../notify/emails';
import { queue } from '../notify/outbox';

const NAME_MAX = 80;
const MESSAGE_MAX = 1000;
const PER_NETWORK_PER_HOUR = 3;

type Fail = { ok: false; status: 400 | 404 | 429; error: string; errors?: Record<string, string> };

interface Game {
  occurrence_id: string;
  event_id: string;
  name: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  host_email: string | null;
}

/**
 * Body: { name, email, message, consent: true, website (left empty) }. Sends the message on, or
 * says what to fix. 201 { ok } whether sent or caught by the hidden field.
 */
export async function sendEnquiry(
  db: D1Database,
  occurrenceId: string,
  body: unknown,
  ctx: { now: Date; ip: string | null; origin: string },
): Promise<{ ok: true } | Fail> {
  if (!OCCURRENCE_ID.test(occurrenceId)) return { ok: false, status: 404, error: 'Not found' };
  const iso = ctx.now.toISOString();
  const game = await db
    .prepare(
      `SELECT o.occurrence_id, o.event_id, e.display_name AS name, o.event_date AS date, o.start_time, o.end_time,
         (SELECT u.email FROM host_sessions s JOIN users u ON u.user_id = s.host_user_id
            WHERE s.session_id = e.host_session_id AND u.active = 1) AS host_email
       FROM occurrences o JOIN events e ON e.event_id = o.event_id
       WHERE o.occurrence_id = ?1 AND ${LISTED} AND COALESCE(o.visibility, e.visibility) = 'private' AND ${upcoming('?2', '?3')}`,
    )
    .bind(occurrenceId, iso, londonDate(ctx.now))
    .first<Game>();
  if (!game) return { ok: false, status: 404, error: "This game isn't taking messages." };

  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const message = typeof b.message === 'string' ? b.message.replace(/\r\n?/g, '\n').trim() : '';
  const errors: Record<string, string> = {};
  if (!name || name.length > NAME_MAX) errors.name = 'Enter your name.';
  if (!EMAIL.test(email) || email.length > 200) errors.email = 'Enter an email address they can reply to.';
  if (!message) errors.message = 'Say a little about yourself, or what you’d like to ask.';
  else if (message.length > MESSAGE_MAX) errors.message = `Keep it to ${MESSAGE_MAX} characters.`;
  if (b.consent !== true) errors.consent = 'Tick the box so we can pass your details to the organiser.';
  if (Object.keys(errors).length) return { ok: false, status: 400, error: 'Please check the form', errors };
  // Only form-filling robots fill in a field people can't see: they're told it went.
  if (typeof b.website === 'string' && b.website.trim()) return { ok: true };

  const ipHash = ctx.ip ? (await sha256(`${ctx.ip}|${londonDate(ctx.now)}`)).slice(0, 32) : null;
  if (ipHash) {
    const recent = await db
      .prepare('SELECT COUNT(*) AS n FROM enquiries WHERE ip_hash = ?1 AND created_at > ?2')
      .bind(ipHash, new Date(ctx.now.getTime() - 3_600_000).toISOString())
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= PER_NETWORK_PER_HOUR)
      return { ok: false, status: 429, error: 'Too many messages in a short time. Please try again later, or ask at the café.' };
  }

  const inserted = await db
    .prepare(
      `INSERT INTO enquiries (enquiry_id, occurrence_id, event_id, name, email, message, ip_hash, created_at)
       SELECT printf('RTD-ENQ-%05d', COALESCE(MAX(CAST(substr(enquiry_id, 9) AS INTEGER)), 0) + 1), ?1, ?2, ?3, ?4, ?5, ?6, ?7
       FROM enquiries
       RETURNING enquiry_id`,
    )
    .bind(game.occurrence_id, game.event_id, name, email, message, ipHash, iso)
    .first<{ enquiry_id: string }>();
  const id = inserted!.enquiry_id;
  const recipients = [BOOKINGS_INBOX, ...(game.host_email ? [game.host_email] : [])];
  await db.batch(recipients.map(to => queue(db, enquiryEmail(id, game, { name, email, message }, to, ctx.origin), iso)));
  return { ok: true };
}

function enquiryEmail(id: string, g: Game, m: { name: string; email: string; message: string }, to: string, origin: string): Email {
  const when = `${longDate(g.date)}${g.start_time ? `, ${timeLabel(g.start_time, g.end_time)}` : ''}`;
  return {
    dedupe_key: `enquiry:${id}:${to}`,
    kind: 'private_game_enquiry',
    to,
    reply_to: m.email,
    subject: `Someone would like to join: ${g.name}, ${shortDate(g.date)}`,
    html: join([
      p(`${esc(m.name)} saw <strong>${esc(g.name)}</strong> (${esc(when)}) in the app and would like to join.`),
      fact('Their message', esc(m.message).replace(/\n/g, '<br>')),
      fact('Their email', esc(m.email)),
      p('Reply to this email to answer them. They agreed to their details being passed to the organiser.'),
      p(link(`${origin}/event/${g.occurrence_id}`, 'See the game in the app')),
      p(`Reference ${id}.`),
    ]),
  };
}
