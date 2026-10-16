// Needs attention (docs/RTD_EVENT_CONTROL_AUDIT.md, G-2; Stage 3b).
//
// Two kinds of item, one per situation, ever (attention_items.item_key):
// - expired: an event's latest date has ended and nothing follows it (a one-off or
//   monthly that's over, or a series that has gone quiet). Weekly clubs that roll
//   on never appear: their next date is already there.
// - no_date: an active, listed event with nothing to come and no usable date in
//   the Logic Engine (blank, free text, or a date that has passed).
//
// Approvers and admins resolve each one in the organiser: set a new date, archive
// it, mark a one-off finished, or (no date) leave it as it is. Opening the
// organiser or an email never resolves anything. An item also settles itself when
// the Logic Engine answers it: a new date arrives (renewed), or a no-date event is
// switched off (archived). One-off host sessions and markets are closed straight
// away: the host is already invited to run it again (RTD Host Follow-up).
//
// Event Index renewals and archives reach the sheet through the same n8n branch as
// cancelled dates (/internal/sheet-fixes), matched on Event ID. The Standard Diary
// can't be written, so those are changed in the sheet by hand.
//
// The detector runs hourly from the Cron Trigger and whenever the organiser opens
// the list; it's idempotent. Switched off (settings.needs_attention) until an
// admin turns it on.

import type { AuthUser } from '../lib/auth';
import { ukDate } from '../lib/format';
import { upcoming } from '../lib/queries';
import { addDays, londonDate, parseSheetDate } from '../lib/time';

export type Kind = 'expired' | 'no_date';
export type Resolution = 'renewed' | 'archived' | 'completed' | 'dismissed';
export type Action = 'renew' | 'archive' | 'complete' | 'dismiss';

/** More new items than this in one run looks like a broken sheet read: open none and say so. */
export const MAX_NEW = 50;
const RESOLVED_DAYS = 30;
const NOTE_MAX = 300;

const LISTED = "COALESCE(o.visibility, e.visibility) IN ('public', 'app_bookable', 'private')";
const EVENT_LISTED = "e.visibility IN ('public', 'app_bookable', 'private')";
/** Over, by the same rule as the public diary (src/lib/queries.ts `upcoming`). */
const ENDED = "CASE WHEN o.ends_at IS NOT NULL THEN o.ends_at <= ?1 ELSE o.event_date < ?2 END";
/** The event's latest date that wasn't cancelled or moved. */
const LATEST = `o.event_date = (SELECT MAX(x.event_date) FROM occurrences x WHERE x.event_id = o.event_id AND x.status IN ('scheduled', 'completed'))`;
/** The event has a date still to come (inner alias o; the outer query mustn't use o). */
const HAS_UPCOMING = `EXISTS (SELECT 1 FROM occurrences o WHERE o.event_id = e.event_id AND ${upcoming('?1', '?2')})`;

export const ref = (id: number) => `RTD-ATT-${String(id).padStart(5, '0')}`;
const noDateKey = (eventId: string, raw: string | null) => `no_date:${eventId}:${raw ?? ''}`;

export async function enabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'needs_attention'").first<{ value: string }>();
  return row?.value === 'on';
}

const auditOpened = (db: D1Database, key: string, now: string) =>
  db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, occurrence_id, actor_type, actor_id, action, new_value, source, created_at)
       SELECT 'attention', printf('RTD-ATT-%05d', item_id), occurrence_id, 'system', 'needs-attention',
         CASE status WHEN 'open' THEN 'attention.opened' ELSE 'attention.resolved' END,
         json_object('kind', kind, 'event_id', event_id, 'resolution', resolution), 'attention', ?2
       FROM attention_items WHERE item_key = ?1 AND opened_at = ?2`,
    )
    .bind(key, now);

// ---- Finding items, and settling the ones the Logic Engine has answered ----

interface OpenRow {
  item_id: number;
  item_key: string;
  kind: Kind;
  event_id: string;
  active: number;
  listed: number;
  sheet_date_raw: string | null;
  next_id: string | null;
}

export async function detect(db: D1Database, now: Date): Promise<{ opened: number; settled: number; blocked: number }> {
  if (!(await enabled(db))) return { opened: 0, settled: 0, blocked: 0 };
  const iso = now.toISOString();
  const today = londonDate(now);
  const [expiredRes, noDateRes, openRes] = await db.batch([
    db
      .prepare(
        `SELECT o.occurrence_id, o.event_id, e.frequency, e.host_session_id, e.market_id
         FROM occurrences o JOIN events e ON e.event_id = o.event_id
         WHERE ${LISTED} AND o.status IN ('scheduled', 'completed') AND ${ENDED} AND ${LATEST}
           AND NOT EXISTS (SELECT 1 FROM attention_items a WHERE a.item_key = 'expired:' || o.occurrence_id)
         ORDER BY o.event_date`,
      )
      .bind(iso, today),
    db
      .prepare(
        `SELECT e.event_id, e.sheet_date_raw FROM events e
         WHERE e.active = 1 AND ${EVENT_LISTED} AND NOT ${HAS_UPCOMING}
           -- An event whose latest date already has an expired item is handled there.
           AND NOT EXISTS (
             SELECT 1 FROM attention_items a JOIN occurrences lo ON lo.occurrence_id = a.occurrence_id
             WHERE a.kind = 'expired' AND a.event_id = e.event_id
               AND lo.event_date = (SELECT MAX(x.event_date) FROM occurrences x WHERE x.event_id = e.event_id AND x.status IN ('scheduled', 'completed')))
           AND NOT EXISTS (SELECT 1 FROM attention_items a WHERE a.item_key = 'no_date:' || e.event_id || ':' || COALESCE(e.sheet_date_raw, ''))
         ORDER BY e.event_id`,
      )
      .bind(iso, today),
    db
      .prepare(
        `SELECT a.item_id, a.item_key, a.kind, a.event_id, e.active, (${EVENT_LISTED}) AS listed, e.sheet_date_raw,
           (SELECT o.occurrence_id FROM occurrences o WHERE o.event_id = a.event_id AND ${upcoming('?1', '?2')}
            ORDER BY o.event_date LIMIT 1) AS next_id
         FROM attention_items a JOIN events e ON e.event_id = a.event_id
         WHERE a.status = 'open'`,
      )
      .bind(iso, today),
  ]);
  const expired = (expiredRes?.results ?? []) as { occurrence_id: string; event_id: string; frequency: string; host_session_id: string | null; market_id: string | null }[];
  const expiredEvents = new Set(expired.map(x => x.event_id));
  // An event that has only just ended is an expired item, not a missing date as well.
  const noDate = ((noDateRes?.results ?? []) as { event_id: string; sheet_date_raw: string | null }[]).filter(x => !expiredEvents.has(x.event_id));

  const writes: D1PreparedStatement[] = [];
  const settle = (r: OpenRow, resolution: Resolution, note: string, newOccurrence: string | null = null) => {
    writes.push(
      db
        .prepare(
          `UPDATE attention_items SET status = 'resolved', resolution = ?2, resolved_by = 'sheet', resolution_note = ?3,
             new_occurrence_id = ?4, resolved_at = ?5 WHERE item_id = ?1 AND status = 'open'`,
        )
        .bind(r.item_id, resolution, note, newOccurrence, iso),
      db
        .prepare(
          `INSERT INTO audit_log (entity_type, entity_id, occurrence_id, actor_type, actor_id, action, new_value, source, created_at)
           SELECT 'attention', printf('RTD-ATT-%05d', item_id), occurrence_id, 'system', 'logic-engine', 'attention.resolved',
             json_object('resolution', resolution, 'by', 'sheet'), 'attention', ?2
           FROM attention_items WHERE item_id = ?1 AND resolved_at = ?2 AND resolved_by = 'sheet'`,
        )
        .bind(r.item_id, iso),
    );
  };
  let settled = 0;
  for (const r of (openRes?.results ?? []) as unknown as OpenRow[]) {
    if (r.next_id) settle(r, 'renewed', 'A new date arrived from the Logic Engine.', r.next_id);
    else if (r.kind === 'no_date' && (!r.active || !r.listed)) settle(r, 'archived', 'Switched off or hidden in the Logic Engine.');
    else if (r.kind === 'no_date' && r.item_key !== noDateKey(r.event_id, r.sheet_date_raw)) settle(r, 'dismissed', "The Logic Engine's date changed.");
    else continue;
    settled++;
  }

  const fresh = expired.length + noDate.length;
  const blocked = fresh > MAX_NEW ? fresh : 0;
  if (blocked) console.error(`attention: ${fresh} new items in one run; opening none (check the Logic Engine read)`);
  else {
    for (const x of expired) {
      const key = `expired:${x.occurrence_id}`;
      const autoClose = x.frequency === 'one-off' && (x.host_session_id || x.market_id);
      writes.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO attention_items (item_key, kind, event_id, occurrence_id, status, resolution, resolved_by, resolution_note, opened_at, resolved_at)
             VALUES (?1, 'expired', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
          )
          .bind(
            key, x.event_id, x.occurrence_id,
            autoClose ? 'resolved' : 'open',
            autoClose ? 'completed' : null,
            autoClose ? 'system' : null,
            autoClose ? `A one-off ${x.market_id ? 'market' : 'host session'}: ${x.market_id ? 'nothing to renew' : 'the host is invited to run it again'}.` : null,
            iso,
            autoClose ? iso : null,
          ),
        auditOpened(db, key, iso),
      );
    }
    for (const x of noDate) {
      const key = noDateKey(x.event_id, x.sheet_date_raw);
      writes.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO attention_items (item_key, kind, event_id, detail, status, opened_at)
             VALUES (?1, 'no_date', ?2, ?3, 'open', ?4)`,
          )
          .bind(key, x.event_id, x.sheet_date_raw, iso),
        auditOpened(db, key, iso),
      );
    }
  }
  if (writes.length) await db.batch(writes);
  return { opened: blocked ? 0 : fresh, settled, blocked };
}

// ---- What approvers and admins see ----

interface ItemRow {
  item_id: number;
  kind: Kind;
  event_id: string;
  occurrence_id: string | null;
  detail: string | null;
  status: 'open' | 'resolved';
  resolution: Resolution | null;
  renew_date: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  opened_at: string;
  resolved_at: string | null;
  name: string;
  source: string;
  frequency: string;
  active: number;
  host_session_id: string | null;
  market_id: string | null;
  date: string | null;
  start_time: string | null;
  renew_arrived: number;
}

/** What can be done with an item, and why not the rest. */
export function actionsFor(r: Pick<ItemRow, 'kind' | 'source' | 'host_session_id' | 'market_id'>): Action[] {
  const fromApp = !!(r.host_session_id || r.market_id); // a host's session or a market: renewed by them, not here
  const writable = r.source === 'event_index';
  if (r.kind === 'expired') return [...(writable && !fromApp ? (['renew'] as const) : []), 'archive', 'complete'];
  return [...(writable && !fromApp ? (['renew'] as const) : []), 'archive', 'dismiss'];
}

function shapeItem(r: ItemRow, today: string) {
  const raw = r.detail;
  return {
    item_id: r.item_id,
    ref: ref(r.item_id),
    kind: r.kind,
    event_id: r.event_id,
    name: r.name,
    source: r.source,
    frequency: r.frequency,
    occurrence_id: r.occurrence_id,
    date: r.date,
    start_time: r.start_time,
    /** no_date: what the sheet holds, and whether it's blank, text, or a date that has passed. */
    detail: raw,
    detail_kind: r.kind !== 'no_date' ? null : !raw ? 'blank' : parseSheetDate(raw) ? 'past' : 'text',
    status: r.status,
    resolution: r.resolution,
    renew_date: r.renew_date,
    /** A new date set here that the Logic Engine hasn't reached yet. */
    renew_waiting: r.resolution === 'renewed' && !!r.renew_date && r.renew_date >= today && !r.renew_arrived,
    resolved_by: r.resolved_by,
    resolution_note: r.resolution_note,
    opened_at: r.opened_at,
    resolved_at: r.resolved_at,
    actions: r.status === 'open' ? actionsFor(r) : [],
    /** Renewing or archiving reaches the Logic Engine by itself (Event Index), or is done in the sheet by hand (Standard Diary). */
    sheet: r.source === 'event_index' ? 'auto' : 'manual',
    /** Already switched off in the Logic Engine, so archiving changes nothing there. */
    inactive: !r.active,
  };
}

export type AttentionItem = ReturnType<typeof shapeItem>;

const ITEM_SQL = `
  SELECT a.item_id, a.kind, a.event_id, a.occurrence_id, a.detail, a.status, a.resolution, a.renew_date, a.resolved_by,
    a.resolution_note, a.opened_at, a.resolved_at, e.display_name AS name, e.source, e.frequency, e.active, e.host_session_id,
    e.market_id, o.event_date AS date, o.start_time,
    EXISTS (SELECT 1 FROM occurrences r WHERE r.event_id = a.event_id AND r.event_date = a.renew_date) AS renew_arrived
  FROM attention_items a JOIN events e ON e.event_id = a.event_id
  LEFT JOIN occurrences o ON o.occurrence_id = a.occurrence_id`;

/** Open items (oldest first), what was sorted in the last 30 days, and timed dates with no end time. */
export async function attentionOverview(db: D1Database, now: Date) {
  const on = await enabled(db);
  if (!on) return { enabled: false as const };
  const found = await detect(db, now);
  const iso = now.toISOString();
  const today = londonDate(now);
  const [open, resolved, noEnd] = await db.batch([
    db.prepare(`${ITEM_SQL} WHERE a.status = 'open' ORDER BY a.opened_at, a.item_id LIMIT 200`),
    db
      .prepare(`${ITEM_SQL} WHERE a.status = 'resolved' AND a.resolved_at >= ?1 ORDER BY a.resolved_at DESC, a.item_id DESC LIMIT 50`)
      .bind(new Date(now.getTime() - RESOLVED_DAYS * 86_400_000).toISOString()),
    // Shown until an hour after they start (src/lib/time.ts): worth an End Time in the sheet.
    db
      .prepare(
        `SELECT e.event_id, e.display_name AS name, MIN(o.event_date) AS date FROM occurrences o JOIN events e ON e.event_id = o.event_id
         WHERE e.active = 1 AND ${LISTED} AND ${upcoming('?1', '?2')} AND o.start_time IS NOT NULL AND o.end_time IS NULL
         GROUP BY e.event_id ORDER BY date LIMIT 20`,
      )
      .bind(iso, today),
  ]);
  return {
    enabled: true as const,
    blocked: found.blocked,
    open: ((open?.results ?? []) as unknown as ItemRow[]).map(r => shapeItem(r, today)),
    resolved: ((resolved?.results ?? []) as unknown as ItemRow[]).map(r => shapeItem(r, today)),
    no_end_time: (noEnd?.results ?? []) as { event_id: string; name: string; date: string }[],
  };
}

// ---- Resolving one ----

type Fail = { ok: false; status: 400 | 403 | 404 | 409; error: string; errors?: Record<string, string> };

const RESOLUTION: Record<Action, Resolution> = { renew: 'renewed', archive: 'archived', complete: 'completed', dismiss: 'dismissed' };

/** Body: { action: 'renew' | 'archive' | 'complete' | 'dismiss', date?: 'YYYY-MM-DD' (renew), note? }. */
export async function resolveItem(db: D1Database, user: AuthUser, itemId: string, body: unknown, now: Date): Promise<{ ok: true; item: AttentionItem } | Fail> {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id < 1) return { ok: false, status: 404, error: 'Nothing to sort with that number.' };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const action = b.action as Action;
  if (!(action in RESOLUTION)) return { ok: false, status: 400, error: 'Choose what to do with it.' };
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > NOTE_MAX) return { ok: false, status: 400, error: 'Please check the form', errors: { note: `Keep the note to ${NOTE_MAX} characters.` } };
  const today = londonDate(now);
  let date: string | null = null;
  if (action === 'renew') {
    date = typeof b.date === 'string' && parseSheetDate(b.date) === b.date ? b.date : null;
    if (!date || date <= today || date > addDays(today, 365)) {
      return { ok: false, status: 400, error: 'Please check the form', errors: { date: 'Choose a date from tomorrow up to a year ahead.' } };
    }
  }
  const row = await db.prepare(`${ITEM_SQL} WHERE a.item_id = ?1`).bind(id).first<ItemRow>();
  if (!row) return { ok: false, status: 404, error: 'Nothing to sort with that number.' };
  if (row.status !== 'open') return { ok: false, status: 409, error: 'Someone has already sorted this one.' };
  if (!actionsFor(row).includes(action)) {
    const why =
      action === 'renew' && row.source !== 'event_index'
        ? 'Standard Diary dates are set in the sheet: change it there, and this clears itself when the new date arrives.'
        : action === 'renew'
          ? "This came from the organiser (a host's session or a market), so it's run again from there."
          : "That can't be done for this one.";
    return { ok: false, status: 409, error: why };
  }
  const iso = now.toISOString();
  const [res] = await db.batch([
    db
      .prepare(
        `UPDATE attention_items SET status = 'resolved', resolution = ?2, renew_date = ?3, resolved_by = ?4, resolution_note = ?5, resolved_at = ?6
         WHERE item_id = ?1 AND status = 'open'`,
      )
      .bind(id, RESOLUTION[action], date, user.email, note || null, iso),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, occurrence_id, actor_type, actor_id, action, new_value, source, created_at)
         SELECT 'attention', ?1, occurrence_id, 'staff', ?2, 'attention.resolved', json_object('resolution', ?3, 'renew_date', ?4, 'note', ?5), 'organiser', ?6
         FROM attention_items WHERE item_id = ?7 AND resolved_at = ?6 AND resolved_by = ?2`,
      )
      .bind(ref(id), user.email, RESOLUTION[action], date, note || null, iso, id),
  ]);
  if (!res?.meta.changes) return { ok: false, status: 409, error: 'Someone has already sorted this one.' };
  const fresh = await db.prepare(`${ITEM_SQL} WHERE a.item_id = ?1`).bind(id).first<ItemRow>();
  return { ok: true, item: shapeItem(fresh!, today) };
}

/** Admins switch the whole thing on or off. */
export async function setAttention(db: D1Database, admin: AuthUser, on: boolean, now: Date): Promise<{ ok: true; enabled: boolean } | Fail> {
  if (admin.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can switch Needs attention on or off.' };
  const iso = now.toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('needs_attention', ?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .bind(on ? 'on' : 'off', iso, admin.email),
    db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, new_value, source, created_at)
         VALUES ('setting', 'needs_attention', 'staff', ?1, ?2, ?3, 'organiser', ?4)`,
      )
      .bind(admin.email, on ? 'attention.switched_on' : 'attention.switched_off', JSON.stringify({ on }), iso),
  ]);
  return { ok: true, enabled: on };
}

// ---- Into the Logic Engine (n8n RTD Host Sessions To Diary, branch C) ----

/**
 * Event Index changes for items resolved here, in the same shape as the fixes for
 * cancelled dates (src/bookings/bookings.ts sheetFixes), matched on Event ID:
 * - renewed: Status Active and the new Event Date, until that date arrives in the app;
 * - archived: Status Inactive (the date cell is written back as it was), while the event is still active.
 * Each is offered until n8n reports it done. The latest decision per event wins.
 */
export async function attentionSheetFixes(db: D1Database, today: string) {
  const { results } = await db
    .prepare(
      `SELECT a.item_id, a.event_id, a.resolution, a.renew_date, e.active, e.sheet_date_raw, f.fix_key AS sent,
         EXISTS (SELECT 1 FROM occurrences r WHERE r.event_id = a.event_id AND r.event_date = a.renew_date) AS arrived
       FROM attention_items a JOIN events e ON e.event_id = a.event_id
       LEFT JOIN sheet_fixes f ON f.event_id = a.event_id
       WHERE a.status = 'resolved' AND a.resolution IN ('renewed', 'archived') AND a.resolved_by LIKE '%@%'
         AND e.source = 'event_index' AND a.resolved_at >= ?1
       ORDER BY a.resolved_at DESC, a.item_id DESC`,
    )
    .bind(`${addDays(today, -RESOLVED_DAYS)}T00:00:00Z`)
    .all<{ item_id: number; event_id: string; resolution: Resolution; renew_date: string | null; active: number; sheet_date_raw: string | null; sent: string | null; arrived: number }>();
  const seen = new Set<string>();
  const fixes: { event_id: string; key: string; row: Record<string, string> }[] = [];
  for (const r of results) {
    if (seen.has(r.event_id)) continue;
    seen.add(r.event_id);
    if (r.resolution === 'renewed' && r.renew_date && r.renew_date > today && !r.arrived) {
      const key = `renew:${r.renew_date}`;
      if (r.sent !== key) fixes.push({ event_id: r.event_id, key, row: { 'Event ID': r.event_id, Status: 'Active', 'Event Date': ukDate(r.renew_date) } });
    } else if (r.resolution === 'archived' && r.active) {
      const key = `archive:${r.item_id}`;
      if (r.sent !== key) fixes.push({ event_id: r.event_id, key, row: { 'Event ID': r.event_id, Status: 'Inactive', 'Event Date': r.sheet_date_raw ?? '' } });
    }
  }
  return fixes;
}
