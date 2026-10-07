// Privacy (docs/RTD_PRIVACY.md): who the privacy notice names, and erasing
// people's details once the app no longer needs them. Runs daily (Cron Trigger).

import { londonDate } from './time';

export interface PrivacyInfo {
  /** Who is responsible for people's details (the data controller). */
  controller: string;
  /** Where to send privacy questions; set only in the live database. */
  contact_email: string | null;
  /** Booking details are erased this many months after the event. */
  booking_retention_months: number;
}

const DEFAULT_CONTROLLER = 'Roll The Dice Board Game Café, Cleethorpes';
const DEFAULT_RETENTION_MONTHS = 12;
/** The scrambled network address is only needed for the bookings-an-hour limit. */
const KEEP_NETWORK_HASH_DAYS = 2;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;

export async function privacyInfo(db: D1Database): Promise<PrivacyInfo> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('privacy_controller', 'privacy_contact_email', 'booking_retention_months')")
    .all<{ key: string; value: string }>();
  const get = (k: string) => results.find(r => r.key === k)?.value.trim() || null;
  const months = Number(get('booking_retention_months'));
  const email = get('privacy_contact_email');
  return {
    controller: get('privacy_controller') ?? DEFAULT_CONTROLLER,
    contact_email: email && EMAIL.test(email) ? email : null,
    booking_retention_months: Number.isInteger(months) && months >= 1 && months <= 120 ? months : DEFAULT_RETENTION_MONTHS,
  };
}

/** The calendar date `months` months before `date` (YYYY-MM-DD), clamped to the month's last day. */
export function monthsBefore(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export interface Erased {
  bookings: number;
  network_hashes: number;
  requests: number;
}

/**
 * Erases what the app no longer needs. Rows stay, so numbers and history add up:
 * - bookings: name, email, mobile and note, the set number of months after the event;
 * - the scrambled network address on a booking, after 2 days;
 * - declined or withdrawn join requests: name, email and what they wrote, 12 months after.
 */
export async function applyRetention(db: D1Database, now: Date): Promise<Erased> {
  const { booking_retention_months: months } = await privacyInfo(db);
  const stamp = now.toISOString();
  const bookingsBefore = monthsBefore(londonDate(now), months);
  const requestsBefore = `${monthsBefore(londonDate(now), DEFAULT_RETENTION_MONTHS)}T00:00:00Z`;
  const hashesBefore = new Date(now.getTime() - KEEP_NETWORK_HASH_DAYS * 86_400_000).toISOString();
  const [bookings, hashes, requests] = await db.batch([
    db
      .prepare(
        `UPDATE bookings SET lead_name = 'Erased', email = 'erased-' || booking_id, mobile = NULL, notes = NULL, ip_hash = NULL,
           erased_at = ?2, updated_at = ?2
         WHERE erased_at IS NULL AND occurrence_id IN (SELECT occurrence_id FROM occurrences WHERE event_date < ?1)`,
      )
      .bind(bookingsBefore, stamp),
    db.prepare('UPDATE bookings SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at < ?1').bind(hashesBefore),
    db
      .prepare(
        `UPDATE applications SET display_name = 'Erased', email = 'erased-' || application_id, about = '', decision_note = NULL,
           erased_at = ?2, updated_at = ?2
         WHERE erased_at IS NULL AND status IN ('declined', 'withdrawn') AND COALESCE(decided_at, updated_at) < ?1`,
      )
      .bind(requestsBefore, stamp),
  ]);
  return { bookings: bookings!.meta.changes, network_hashes: hashes!.meta.changes, requests: requests!.meta.changes };
}
