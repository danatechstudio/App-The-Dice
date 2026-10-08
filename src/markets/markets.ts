// Markets (docs/RTD_MARKETS.md). An admin sets up a market in the organiser;
// n8n adds it to the Logic Engine's Event Index (App Host Session = RTD-MKT-…),
// so it reaches the diary and the social posts like any event. Vendors apply
// for a pitch in the app, with up to 3 photos; approvers approve or decline.
// Approved vendors are emailed the pitch fee and the payment details the admin
// typed in. Once every pitch is approved, new applicants join a waiting list.

import { EMAIL, MOBILE, clean, sha256 } from '../bookings/bookings';
import { priceLabel } from '../host/sessions';
import type { AuthUser } from '../lib/auth';
import { ukDate, weekdayOf } from '../lib/format';
import { addDays, londonDate, parseSheetDate } from '../lib/time';
import type { Email } from '../notify/emails';
import { queue } from '../notify/outbox';
import { insuranceText, marketApplicationToApprove, vendorApplied, vendorApproved, vendorDeclined, type MarketFacts, type VendorFacts } from './emails';

export const MARKET_ID = /^RTD-MKT-\d{5,}$/;
export const VENDOR_ID = /^RTD-MV-\d{5,}$/;
const PHOTO_ID = /^[0-9a-f]{32}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseSheetDate(s) === s;

export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PER_EMAIL_PER_DAY = 3;
const PER_IP_PER_HOUR = 5;
/** Vendor photos in KV. Event photos use img:, which their clean-up lists; these never mix. */
export const photoKey = (photoId: string) => `vendor:${photoId}`;

type Fail = { ok: false; status: 400 | 403 | 404 | 409 | 429; error: string; errors?: Record<string, string> };

const audit = (db: D1Database, type: string, id: string, actorType: 'staff' | 'customer', actor: string, action: string, next: unknown, now: string) =>
  db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, new_value, source, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'organiser', ?7)`,
    )
    .bind(type, id, actorType, actor, action, next === null ? null : JSON.stringify(next), now);

// ---- Markets (admins) ----

export interface MarketInput {
  name: string;
  description: string | null;
  event_date: string;
  start_time: string;
  end_time: string | null;
  pitches: number;
  pitch_fee_pence: number;
  applications_close: string;
  payment_details: string;
}

export interface MarketRow extends MarketInput {
  market_id: string;
  status: 'scheduled' | 'published';
  event_id: string | null;
  published_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Field-by-field, so the form can show each problem next to its field. */
export function parseMarketInput(body: unknown, today: string, opts: { creating: boolean }): { ok: true; value: MarketInput } | { ok: false; errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const name = clean(b.name, 80);
  if (name.length < 3) errors.name = 'Give the market a name (at least 3 characters).';
  else if (name.length > 80) errors.name = 'Keep the name to 80 characters.';
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (description.length > 1000) errors.description = 'Keep the description to 1,000 characters.';

  const date = b.event_date;
  if (!isDate(date)) errors.event_date = 'Choose a date.';
  else if (opts.creating && date <= today) errors.event_date = 'Choose a date from tomorrow onwards.';
  else if (!opts.creating && date < today) errors.event_date = "The date can't be in the past.";
  else if (date > addDays(today, 365)) errors.event_date = 'Choose a date within the next year.';

  const start = typeof b.start_time === 'string' ? b.start_time : '';
  if (!TIME.test(start)) errors.start_time = 'Choose a start time.';
  const end = typeof b.end_time === 'string' && b.end_time !== '' ? b.end_time : null;
  if (end !== null && !TIME.test(end)) errors.end_time = 'End time must be a time, like 16:00.';
  else if (end !== null && TIME.test(start) && end <= start) errors.end_time = 'End time must be after the start time.';

  const pitches = Number(b.pitches);
  if (!Number.isInteger(pitches) || pitches < 1 || pitches > 200) errors.pitches = 'Pitches must be between 1 and 200.';
  const fee = Number(b.pitch_fee_pence ?? 0);
  if (!Number.isInteger(fee) || fee < 0 || fee > 100_000) errors.pitch_fee_pence = 'The pitch fee must be between free and £1,000.';

  const close = b.applications_close;
  if (!isDate(close)) errors.applications_close = 'Choose the last day vendors can apply.';
  else if (isDate(date) && close > date) errors.applications_close = 'Applications must close on or before the market day.';
  else if (opts.creating && close < today) errors.applications_close = "The closing date can't be in the past.";

  const payment = typeof b.payment_details === 'string' ? b.payment_details.trim() : '';
  if (payment.length > 1000) errors.payment_details = 'Keep the payment details to 1,000 characters.';
  else if (Number.isInteger(fee) && fee > 0 && payment.length < 5) errors.payment_details = 'Say how approved vendors pay: bank details or a payment link.';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      description: description || null,
      event_date: date as string,
      start_time: start,
      end_time: end,
      pitches,
      pitch_fee_pence: fee,
      applications_close: close as string,
      payment_details: payment,
    },
  };
}

export async function getMarket(db: D1Database, id: string): Promise<MarketRow | null> {
  if (!MARKET_ID.test(id)) return null;
  return db.prepare('SELECT * FROM markets WHERE market_id = ?1').bind(id).first<MarketRow>();
}

const approvedCount = (db: D1Database, marketId: string) =>
  db.prepare("SELECT COUNT(*) AS n FROM market_applications WHERE market_id = ?1 AND status = 'approved'").bind(marketId).first<{ n: number }>();

/** A new market, numbered RTD-MKT-00001 upwards in one statement. It reaches the diary within 15 minutes. */
export async function createMarket(db: D1Database, admin: AuthUser, m: MarketInput, now: string): Promise<MarketRow> {
  const row = await db
    .prepare(
      `INSERT INTO markets (market_id, name, description, event_date, start_time, end_time, pitches, pitch_fee_pence,
         applications_close, payment_details, status, created_by, created_at, updated_at)
       SELECT printf('RTD-MKT-%05d', COALESCE(MAX(CAST(substr(market_id, 9) AS INTEGER)), 0) + 1),
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'scheduled', ?10, ?11, ?11
       FROM markets
       RETURNING market_id`,
    )
    .bind(m.name, m.description, m.event_date, m.start_time, m.end_time, m.pitches, m.pitch_fee_pence, m.applications_close, m.payment_details, admin.email, now)
    .first<{ market_id: string }>();
  const id = row!.market_id;
  await audit(db, 'market', id, 'staff', admin.email, 'market.created', { name: m.name, event_date: m.event_date, pitches: m.pitches, pitch_fee_pence: m.pitch_fee_pence }, now).run();
  return (await getMarket(db, id))!;
}

/**
 * Changes a market. Pitches can't go below the vendors already approved. Once
 * it's in the Logic Engine, its name, date and times there are changed in the sheet.
 */
export async function updateMarket(db: D1Database, admin: AuthUser, id: string, m: MarketInput, now: string): Promise<{ ok: true; market: MarketRow } | Fail> {
  const before = await getMarket(db, id);
  if (!before) return { ok: false, status: 404, error: 'No market with that ID.' };
  const approved = (await approvedCount(db, id))?.n ?? 0;
  if (m.pitches < approved) {
    const error = `${approved} vendors are already approved, so there must be at least ${approved} pitches.`;
    return { ok: false, status: 409, error, errors: { pitches: error } };
  }
  await db.batch([
    db
      .prepare(
        `UPDATE markets SET name = ?2, description = ?3, event_date = ?4, start_time = ?5, end_time = ?6, pitches = ?7,
           pitch_fee_pence = ?8, applications_close = ?9, payment_details = ?10, updated_at = ?11
         WHERE market_id = ?1`,
      )
      .bind(id, m.name, m.description, m.event_date, m.start_time, m.end_time, m.pitches, m.pitch_fee_pence, m.applications_close, m.payment_details, now),
    audit(db, 'market', id, 'staff', admin.email, 'market.updated', { pitches: m.pitches, pitch_fee_pence: m.pitch_fee_pence, applications_close: m.applications_close, event_date: m.event_date }, now),
  ]);
  return { ok: true, market: (await getMarket(db, id))! };
}

/** For the organiser: markets from a month ago on, with how many applications are in each state. */
export async function marketsForStaff(db: D1Database, today: string) {
  const { results } = await db
    .prepare(
      `SELECT m.*,
         (SELECT COUNT(*) FROM market_applications a WHERE a.market_id = m.market_id AND a.status = 'pending') AS pending,
         (SELECT COUNT(*) FROM market_applications a WHERE a.market_id = m.market_id AND a.status = 'approved') AS approved
       FROM markets m WHERE m.event_date >= ?1 ORDER BY m.event_date, m.market_id LIMIT 50`,
    )
    .bind(addDays(today, -30))
    .all<MarketRow & { pending: number; approved: number }>();
  return results.map(m => ({ ...m, pitch_fee: priceLabel(m.pitch_fee_pence) }));
}

// ---- Public ----

export interface PublicMarket {
  market_id: string;
  name: string;
  description: string | null;
  event_date: string;
  start_time: string;
  end_time: string | null;
  pitch_fee: string;
  pitches: number;
  pitches_left: number;
  applications_close: string;
  /** Applications are being taken (once full, they go on the waiting list). */
  open: boolean;
  /** Its date in the diary, once the Logic Engine has it. */
  occurrence_id: string | null;
}

const PUBLIC_FIELDS = `m.market_id, m.name, m.description, m.event_date, m.start_time, m.end_time, m.pitch_fee_pence,
  m.pitches, m.applications_close,
  (SELECT COUNT(*) FROM market_applications a WHERE a.market_id = m.market_id AND a.status = 'approved') AS approved,
  (SELECT o.occurrence_id FROM occurrences o JOIN events e ON e.event_id = o.event_id
     WHERE e.event_id = m.event_id AND e.active = 1 AND o.event_date = m.event_date AND o.status = 'scheduled') AS occurrence_id`;

type PublicRow = Omit<PublicMarket, 'pitch_fee' | 'pitches_left' | 'open'> & { pitch_fee_pence: number; approved: number };

const toPublic = (r: PublicRow, today: string): PublicMarket => ({
  market_id: r.market_id,
  name: r.name,
  description: r.description,
  event_date: r.event_date,
  start_time: r.start_time,
  end_time: r.end_time,
  pitch_fee: priceLabel(r.pitch_fee_pence),
  pitches: r.pitches,
  pitches_left: Math.max(0, r.pitches - r.approved),
  applications_close: r.applications_close,
  open: r.applications_close >= today && r.event_date >= today,
  occurrence_id: r.occurrence_id,
});

/** Markets still to come, for vendors. Never says who has applied. */
export async function publicMarkets(db: D1Database, today: string): Promise<PublicMarket[]> {
  const { results } = await db
    .prepare(`SELECT ${PUBLIC_FIELDS} FROM markets m WHERE m.event_date >= ?1 ORDER BY m.event_date, m.market_id LIMIT 20`)
    .bind(today)
    .all<PublicRow>();
  return results.map(r => toPublic(r, today));
}

export async function publicMarket(db: D1Database, id: string, today: string): Promise<PublicMarket | null> {
  if (!MARKET_ID.test(id)) return null;
  const row = await db.prepare(`SELECT ${PUBLIC_FIELDS} FROM markets m WHERE m.market_id = ?1`).bind(id).first<PublicRow>();
  return row ? toPublic(row, today) : null;
}

// ---- Into the Logic Engine (n8n RTD Host Sessions To Diary, with the host sessions) ----

/**
 * Markets not yet in Event Index, in the same shape as host sessions, so the
 * same n8n branch appends them. If the name is taken, n8n adds the year.
 */
export async function marketsToPublish(db: D1Database, today: string) {
  const { results } = await db
    .prepare("SELECT * FROM markets WHERE status = 'scheduled' AND event_date >= ?1 ORDER BY event_date, market_id LIMIT 20")
    .bind(today)
    .all<MarketRow>();
  return results.map(m => ({
    session_id: m.market_id,
    clash_suffix: m.event_date.slice(0, 4),
    row: {
      'Event Name': m.name,
      Frequency: 'One-off',
      Day: weekdayOf(m.event_date),
      'Event Date': ukDate(m.event_date),
      'Event Time': m.start_time,
      'End Time': m.end_time ?? '',
      'Base Details': m.description ?? 'A market at Roll The Dice, with stalls from local makers and traders.',
      Status: 'Active',
      'Organiser Email': m.created_by,
      'App Visibility': 'Public',
      'App Category': 'Market',
      'App Price': '',
      'App Capacity': '',
      'App Host Session': m.market_id,
    },
  }));
}

/** n8n added the market to Event Index (the next sync links its Event ID). */
export async function markMarketPublished(db: D1Database, id: string, now: string): Promise<'ok' | 'already' | 'not_found'> {
  const res = await db
    .prepare("UPDATE markets SET status = 'published', published_at = ?2, updated_at = ?2 WHERE market_id = ?1 AND status = 'scheduled'")
    .bind(id, now)
    .run();
  if (res.meta.changes) {
    await db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
         VALUES ('market', ?1, 'n8n', 'n8n', 'market.published', 'scheduled', 'published', 'n8n', ?2)`,
      )
      .bind(id, now)
      .run();
    return 'ok';
  }
  return (await getMarket(db, id)) ? 'already' : 'not_found';
}

// ---- Applying (vendors, no account) ----

export interface Photo {
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Uint8Array;
}

/** The image type from its first bytes; anything else is refused. */
export function sniffImage(b: Uint8Array): Photo['type'] | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function decodePhoto(v: unknown): Photo | string {
  const raw = typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { data?: unknown }).data : null;
  if (typeof raw !== 'string') return 'That photo could not be read.';
  const b64 = raw.replace(/^data:[^,]*,/, '');
  if (b64.length > Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 4) return 'Each photo must be under 2 MB.';
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch {
    return 'That photo could not be read.';
  }
  if (bytes.length > MAX_PHOTO_BYTES) return 'Each photo must be under 2 MB.';
  const type = sniffImage(bytes);
  return type ? { type, bytes } : 'Photos must be JPEG, PNG or WebP images.';
}

export interface ApplicationInput extends Omit<VendorFacts, 'photo_count' | 'waitlisted'> {
  photos: Photo[];
}

export function parseApplication(body: unknown, today: string): { ok: true; value: ApplicationInput } | { ok: false; errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  // A field people can't see: only form-filling robots put anything in it.
  if (typeof b.website === 'string' && b.website.trim()) errors.form = 'Please try again.';
  const stall = clean(b.stall_name, 80);
  if (stall.length < 2 || stall.length > 80) errors.stall_name = "Enter your stall or business name.";
  const contact = clean(b.contact_name, 60);
  if (contact.length < 2 || contact.length > 60) errors.contact_name = 'Enter your name.';
  const email = clean(b.email, 120).toLowerCase();
  if (!EMAIL.test(email) || email.length > 120) errors.email = 'Enter an email address, like name@example.com.';
  const mobile = clean(b.mobile, 20);
  if (!MOBILE.test(mobile)) errors.mobile = 'Enter a mobile number, so we can reach you on the day.';
  const products = typeof b.products === 'string' ? b.products.trim() : '';
  if (products.length < 10) errors.products = 'Tell us what you sell (at least a few words).';
  else if (products.length > 1000) errors.products = 'Keep this to 1,000 characters.';
  const links = typeof b.links === 'string' ? b.links.trim() : '';
  if (links.length > 500) errors.links = 'Keep the links to 500 characters.';
  const notes = typeof b.notes === 'string' ? b.notes.trim() : '';
  if (notes.length > 500) errors.notes = 'Keep the note to 500 characters.';

  let insured = false;
  let insurer: string | null = null;
  let expiry: string | null = null;
  if (b.insured === true) {
    insured = true;
    insurer = clean(b.insurer, 80) || null;
    if (!insurer || insurer.length > 80) errors.insurer = 'Enter your insurer.';
    if (!isDate(b.insurance_expiry)) errors.insurance_expiry = 'Enter the date your cover ends.';
    else if (b.insurance_expiry < today) errors.insurance_expiry = 'That date has passed: enter when your current cover ends.';
    else expiry = b.insurance_expiry;
  } else if (b.insured !== false) {
    errors.insured = 'Say whether you have public liability insurance.';
  }

  const photos: Photo[] = [];
  const list = Array.isArray(b.photos) ? b.photos : b.photos == null ? [] : null;
  if (list === null || list.length > MAX_PHOTOS) errors.photos = `Add up to ${MAX_PHOTOS} photos.`;
  else
    for (const item of list) {
      const photo = decodePhoto(item);
      if (typeof photo === 'string') {
        errors.photos = photo;
        break;
      }
      photos.push(photo);
    }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: { stall_name: stall, contact_name: contact, email, mobile, products, links: links || null, insured, insurer, insurance_expiry: expiry, notes: notes || null, photos },
  };
}

const hex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));

/** Queues an email about the application saved earlier in the same batch; `{{application_id}}` becomes its number. */
const queueForApplication = (db: D1Database, e: Email, submitKey: string, now: string) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO outbox (dedupe_key, kind, to_email, reply_to, subject, html, created_at)
       SELECT replace(?1, '{{application_id}}', application_id), ?2, ?3, ?4, replace(?5, '{{application_id}}', application_id),
         replace(?6, '{{application_id}}', application_id), ?7
       FROM market_applications WHERE submit_key = ?8`,
    )
    .bind(e.dedupe_key, e.kind, e.to, e.reply_to, e.subject, e.html, now, submitKey);

export type Applied =
  | { ok: true; application: { application_id: string; market_id: string; stall_name: string; waitlisted: boolean } }
  | Fail;

/**
 * A vendor applies for a pitch. Photos go to KV first, then the application,
 * its photos, the emails (to the vendor and the approvers) and the audit entry
 * are saved together.
 */
export async function createApplication(
  db: D1Database,
  kv: KVNamespace,
  marketId: string,
  body: unknown,
  ctx: { now: string; ip: string | null; origin: string },
): Promise<Applied> {
  const today = londonDate(new Date(ctx.now));
  const m = await getMarket(db, marketId);
  if (!m) return { ok: false, status: 404, error: 'No market with that ID.' };
  if (m.applications_close < today || m.event_date < today) return { ok: false, status: 409, error: 'Applications for this market have closed.' };
  const parsed = parseApplication(body, today);
  if (!parsed.ok) return { ok: false, status: 400, error: 'Please check the form', errors: parsed.errors };
  const a = parsed.value;

  const ipHash = ctx.ip ? (await sha256(`${ctx.ip}|${today}`)).slice(0, 32) : null;
  const [dup, byEmail, byIp, approved] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM market_applications WHERE market_id = ?1 AND email = ?2 AND status IN ('pending', 'approved')").bind(marketId, a.email),
    db.prepare('SELECT COUNT(*) AS n FROM market_applications WHERE email = ?1 AND created_at > ?2').bind(a.email, new Date(Date.parse(ctx.now) - 86_400_000).toISOString()),
    db.prepare('SELECT COUNT(*) AS n FROM market_applications WHERE ip_hash = ?1 AND created_at > ?2').bind(ipHash, new Date(Date.parse(ctx.now) - 3_600_000).toISOString()),
    db.prepare("SELECT COUNT(*) AS n FROM market_applications WHERE market_id = ?1 AND status = 'approved'").bind(marketId),
  ]);
  const count = (r: D1Result | undefined) => Number((r?.results[0] as { n: number } | undefined)?.n ?? 0);
  if (count(dup)) return { ok: false, status: 409, error: "You've already applied for this market with that email. We'll email you when it's decided." };
  if (count(byEmail) >= PER_EMAIL_PER_DAY || (ipHash && count(byIp) >= PER_IP_PER_HOUR)) {
    return { ok: false, status: 429, error: 'Too many applications in a short time. Please try again later, or email the café.' };
  }
  const waitlisted = count(approved) >= m.pitches;

  const photoIds = a.photos.map(() => randomHex(16));
  await Promise.all(a.photos.map((p, i) => kv.put(photoKey(photoIds[i]!), p.bytes, { metadata: { type: p.type } })));

  const submitKey = randomHex(24);
  const vendor: VendorFacts = { ...a, photo_count: a.photos.length, waitlisted };
  const facts: MarketFacts = m;
  const organiser = `${ctx.origin}/organise#market-applications`;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO market_applications (application_id, market_id, stall_name, contact_name, email, mobile, products, links,
             insured, insurer, insurance_expiry, notes, photo_count, status, waitlisted, ip_hash, submit_key, created_at, updated_at)
           SELECT printf('RTD-MV-%05d', COALESCE(MAX(CAST(substr(application_id, 8) AS INTEGER)), 0) + 1),
             ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', ?13, ?14, ?15, ?16, ?16
           FROM market_applications`,
        )
        .bind(marketId, a.stall_name, a.contact_name, a.email, a.mobile, a.products, a.links, a.insured ? 1 : 0, a.insurer, a.insurance_expiry, a.notes,
          a.photos.length, waitlisted ? 1 : 0, ipHash, submitKey, ctx.now),
      ...a.photos.map((p, i) =>
        db
          .prepare(
            `INSERT INTO market_photos (photo_id, application_id, position, content_type, bytes, created_at)
             SELECT ?1, application_id, ?2, ?3, ?4, ?5 FROM market_applications WHERE submit_key = ?6`,
          )
          .bind(photoIds[i], i + 1, p.type, p.bytes.length, ctx.now, submitKey),
      ),
      queueForApplication(db, vendorApplied(facts, vendor), submitKey, ctx.now),
      queueForApplication(db, marketApplicationToApprove(facts, vendor, count(approved), organiser), submitKey, ctx.now),
      db
        .prepare(
          `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, new_value, source, created_at)
           SELECT 'market_application', application_id, 'customer', application_id, 'market_application.submitted',
             json_object('market_id', market_id, 'waitlisted', waitlisted, 'photos', photo_count), 'app', ?2
           FROM market_applications WHERE submit_key = ?1`,
        )
        .bind(submitKey, ctx.now),
    ]);
  } catch (err) {
    await Promise.all(photoIds.map(id => kv.delete(photoKey(id))));
    throw err;
  }
  const saved = await db.prepare('SELECT application_id FROM market_applications WHERE submit_key = ?1').bind(submitKey).first<{ application_id: string }>();
  return { ok: true, application: { application_id: saved!.application_id, market_id: marketId, stall_name: a.stall_name, waitlisted } };
}

// ---- Approving (approvers and admins) ----

export interface StaffApplication extends Omit<VendorFacts, 'insured' | 'waitlisted'> {
  application_id: string;
  market_id: string;
  insured: boolean;
  /** Their cover ends before the market. */
  insurance_lapses: boolean;
  waitlisted: boolean;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  photos: string[];
}

/** Applications for markets from a fortnight ago on, newest markets last, each with its photos. */
export async function applicationsForStaff(db: D1Database, today: string): Promise<StaffApplication[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*, m.event_date FROM market_applications a JOIN markets m ON m.market_id = a.market_id
       WHERE m.event_date >= ?1 AND a.erased_at IS NULL
       ORDER BY m.event_date, a.market_id, a.created_at, a.application_id LIMIT 500`,
    )
    .bind(addDays(today, -14))
    .all<Record<string, unknown> & { application_id: string; event_date: string; insured: number; waitlisted: number; insurance_expiry: string | null }>();
  if (!results.length) return [];
  const { results: photos } = await db
    .prepare('SELECT photo_id, application_id FROM market_photos WHERE application_id IN (SELECT value FROM json_each(?1)) ORDER BY position')
    .bind(JSON.stringify(results.map(r => r.application_id)))
    .all<{ photo_id: string; application_id: string }>();
  return results.map(({ event_date, ip_hash: _ip, submit_key: _k, sheet_hash: _s, erased_at: _e, updated_at: _u, ...r }) => ({
    ...(r as unknown as StaffApplication),
    insured: r.insured === 1,
    waitlisted: r.waitlisted === 1,
    insurance_lapses: r.insured === 1 && !!r.insurance_expiry && r.insurance_expiry < event_date,
    photos: photos.filter(p => p.application_id === r.application_id).map(p => p.photo_id),
  }));
}

type ApplicationRow = { application_id: string; market_id: string; status: string; contact_name: string; email: string; stall_name: string };

const findApplication = (db: D1Database, id: string) =>
  VENDOR_ID.test(id)
    ? db.prepare('SELECT application_id, market_id, status, contact_name, email, stall_name FROM market_applications WHERE application_id = ?1 AND erased_at IS NULL').bind(id).first<ApplicationRow>()
    : Promise.resolve(null);

/**
 * Approve or decline. Approving needs a free pitch: the count is checked in the
 * same statement, so two approvers can't both take the last one.
 */
export async function decideApplication(
  db: D1Database,
  approver: AuthUser,
  id: string,
  decision: 'approve' | 'decline',
  note: string | null,
  now: string,
): Promise<{ ok: true; status: 'approved' | 'declined' } | Fail> {
  const a = await findApplication(db, id);
  if (!a) return { ok: false, status: 404, error: 'No application with that ID.' };
  const m = (await getMarket(db, a.market_id))!;
  if (a.status !== 'pending') return { ok: false, status: 409, error: `That application is already ${a.status}.` };
  const status = decision === 'approve' ? 'approved' : 'declined';
  const res = await db
    .prepare(
      `UPDATE market_applications SET status = ?2, decision_note = ?3, decided_by = ?4, decided_at = ?5, updated_at = ?5
       WHERE application_id = ?1 AND status = 'pending'
         AND (?2 = 'declined' OR (SELECT COUNT(*) FROM market_applications WHERE market_id = ?6 AND status = 'approved') < ?7)`,
    )
    .bind(id, status, note, approver.email, now, a.market_id, m.pitches)
    .run();
  if (!res.meta.changes) {
    const latest = await findApplication(db, id);
    if (latest?.status !== 'pending') return { ok: false, status: 409, error: `That application is already ${latest?.status ?? 'gone'}.` };
    return {
      ok: false,
      status: 409,
      error: `All ${m.pitches} pitches are taken. Add a pitch to the market, or mark an approved vendor as dropped out, first.`,
    };
  }
  await db.batch([
    queue(db, status === 'approved' ? vendorApproved(m, a, note) : vendorDeclined(m, a, note), now),
    // The note stays on the application (erased with it), not in the audit log.
    audit(db, 'market_application', id, 'staff', approver.email, `market_application.${status}`, { note: !!note }, now),
  ]);
  return { ok: true, status };
}

/** A vendor dropped out (they told the café): their pitch is free again. No email is sent. */
export async function markWithdrawn(db: D1Database, approver: AuthUser, id: string, now: string): Promise<{ ok: true } | Fail> {
  const a = await findApplication(db, id);
  if (!a) return { ok: false, status: 404, error: 'No application with that ID.' };
  if (a.status !== 'pending' && a.status !== 'approved') return { ok: false, status: 409, error: `That application is already ${a.status}.` };
  await db.batch([
    db
      .prepare("UPDATE market_applications SET status = 'withdrawn', decided_by = ?2, decided_at = ?3, updated_at = ?3 WHERE application_id = ?1")
      .bind(id, approver.email, now),
    audit(db, 'market_application', id, 'staff', approver.email, 'market_application.withdrawn', { was: a.status }, now),
  ]);
  return { ok: true };
}

/** One vendor photo, for approvers only. */
export async function readPhoto(db: D1Database, kv: KVNamespace, photoId: string): Promise<{ type: string; body: ReadableStream } | null> {
  if (!PHOTO_ID.test(photoId)) return null;
  const row = await db.prepare('SELECT content_type FROM market_photos WHERE photo_id = ?1').bind(photoId).first<{ content_type: string }>();
  if (!row) return null;
  const body = await kv.get(photoKey(photoId), 'stream');
  return body ? { type: row.content_type, body } : null;
}

// ---- The market spreadsheet (n8n RTD Market Vendors To Sheet) ----

const STATUS_WORDS: Record<string, string> = { pending: 'Waiting for a decision', approved: 'Approved', declined: 'Declined', withdrawn: 'Dropped out' };

/**
 * Applications whose row in the market spreadsheet is out of date, each with the
 * full row (keys are the sheet's headers). Erased applications come through as
 * erased, so the spreadsheet is cleared too.
 */
export async function sheetRows(db: D1Database, origin: string) {
  const { results } = await db
    .prepare(
      `SELECT a.*, m.name AS market_name, m.event_date AS market_date, m.pitch_fee_pence
       FROM market_applications a JOIN markets m ON m.market_id = a.market_id
       ORDER BY a.application_id LIMIT 2000`,
    )
    .all<Record<string, string | number | null> & { application_id: string; sheet_hash: string | null; erased_at: string | null; insured: number; photo_count: number; pitch_fee_pence: number }>();
  const out: { application_id: string; hash: string; row: Record<string, string> }[] = [];
  for (const a of results) {
    const s = (v: unknown) => (v == null ? '' : String(v));
    const row: Record<string, string> = {
      'Application ID': a.application_id,
      Market: s(a.market_name),
      'Market Date': ukDate(s(a.market_date)),
      Status: a.erased_at ? 'Erased' : STATUS_WORDS[s(a.status)] ?? s(a.status),
      'Waiting List': a.waitlisted ? 'Yes' : 'No',
      'Stall Name': s(a.stall_name),
      'Contact Name': s(a.contact_name),
      Email: a.erased_at ? '' : s(a.email),
      Mobile: s(a.mobile),
      'What They Sell': s(a.products),
      Links: s(a.links),
      Insured: a.insured ? 'Yes' : 'No',
      Insurer: s(a.insurer),
      'Insurance Expiry': a.insurance_expiry ? ukDate(s(a.insurance_expiry)) : '',
      Photos: a.photo_count ? `${a.photo_count} (in the organiser)` : 'None',
      Notes: s(a.notes),
      'Pitch Fee': priceLabel(a.pitch_fee_pence),
      Applied: s(a.created_at).slice(0, 16).replace('T', ' '),
      Decided: s(a.decided_at).slice(0, 16).replace('T', ' '),
      'Decided By': s(a.decided_by),
      'Decision Note': s(a.decision_note),
      'Organiser Link': `${origin}/organise#market-applications`,
    };
    const hash = (await sha256(JSON.stringify(row))).slice(0, 32);
    if (hash !== a.sheet_hash) out.push({ application_id: a.application_id, hash, row });
    if (out.length >= 100) break;
  }
  return out;
}

export async function markSheetSynced(db: D1Database, id: string, hash: unknown): Promise<boolean> {
  if (!VENDOR_ID.test(id) || typeof hash !== 'string' || !/^[0-9a-f]{32}$/.test(hash)) return false;
  const res = await db.prepare('UPDATE market_applications SET sheet_hash = ?2 WHERE application_id = ?1').bind(id, hash).run();
  return res.meta.changes > 0;
}

// ---- Erasing (the daily privacy job) ----

/** Vendor details 12 months after their market: the row stays (as erased), the photos go. */
export async function eraseMarketApplications(db: D1Database, kv: KVNamespace | undefined, before: string, stamp: string): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT a.application_id FROM market_applications a JOIN markets m ON m.market_id = a.market_id
       WHERE a.erased_at IS NULL AND m.event_date < ?1 LIMIT 500`,
    )
    .bind(before)
    .all<{ application_id: string }>();
  if (!results.length) return 0;
  const ids = JSON.stringify(results.map(r => r.application_id));
  const { results: photos } = await db
    .prepare('SELECT photo_id FROM market_photos WHERE application_id IN (SELECT value FROM json_each(?1))')
    .bind(ids)
    .all<{ photo_id: string }>();
  if (kv) await Promise.all(photos.map(p => kv.delete(photoKey(p.photo_id))));
  await db.batch([
    db.prepare('DELETE FROM market_photos WHERE application_id IN (SELECT value FROM json_each(?1))').bind(ids),
    db
      .prepare(
        `UPDATE market_applications SET stall_name = 'Erased', contact_name = 'Erased', email = 'erased-' || application_id, mobile = '',
           products = '', links = NULL, insurer = NULL, insurance_expiry = NULL, notes = NULL, decision_note = NULL, ip_hash = NULL,
           photo_count = 0, erased_at = ?2, updated_at = ?2
         WHERE application_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(ids, stamp),
  ]);
  return results.length;
}

export { insuranceText };
