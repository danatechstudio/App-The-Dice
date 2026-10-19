// What's waiting in each section of the organiser (docs/superpowers/specs/2026-10-17-organiser-hub-design.md):
// one read-only batch of counts for the hub's cards, with only what the
// caller's role can open. Each count uses the same rule as its panel.

import { enabled as attentionOn } from '../attention/attention';
import type { AuthUser } from '../lib/auth';
import { addDays, londonDate } from '../lib/time';
import { REVIEW_SQL } from '../social/admin';

export type SectionKey = 'approve' | 'attention' | 'events' | 'bookings' | 'people' | 'content' | 'stats';

export interface SectionSummary {
  /** Things waiting on a person: the sum of parts. */
  count: number;
  parts?: Record<string, number>;
  /** Shown on the card, never counted as waiting. */
  info?: Record<string, number>;
}

export interface StaffSummary {
  sections: Partial<Record<SectionKey, SectionSummary>>;
}

// A booking device that has gone is never tried again, so it isn't a failure to chase (as src/notify/delivery.ts).
const NOT_GONE = 'COALESCE(last_status, 0) NOT IN (404, 410, -1)';

const COUNTS = {
  join_requests: "SELECT COUNT(*) AS n FROM applications WHERE status = 'pending'",
  sessions: "SELECT COUNT(*) AS n FROM host_sessions WHERE status = 'submitted' AND deleted_at IS NULL",
  changes: "SELECT COUNT(*) AS n FROM event_change_requests WHERE status = 'pending'",
  // The panel lists markets from 14 days ago onwards (applicationsForStaff, src/markets/markets.ts).
  market_applications: `SELECT COUNT(*) AS n FROM market_applications a JOIN markets m ON m.market_id = a.market_id
     WHERE a.status = 'pending' AND a.erased_at IS NULL AND m.event_date >= ?1`,
  open_items: "SELECT COUNT(*) AS n FROM attention_items WHERE status = 'open'",
  failed_emails: 'SELECT COUNT(*) AS n FROM outbox WHERE created_at >= ?1 AND dead_at IS NOT NULL AND sent_at IS NULL',
  failed_pushes: `SELECT COUNT(*) AS n FROM push_outbox WHERE created_at >= ?1 AND dead_at IS NOT NULL AND sent_at IS NULL AND ${NOT_GONE}`,
  sheet_edit_problems: "SELECT COUNT(*) AS n FROM sheet_edits WHERE status IN ('conflict', 'dead')",
  games_to_review: "SELECT COUNT(*) AS n FROM game_review WHERE status = 'open'",
  menu_sheet_problem: "SELECT CASE WHEN json_extract(value, '$.ok') = 0 THEN 1 ELSE 0 END AS n FROM settings WHERE key = 'food_menu_sync'",
  booked_dates_7_days: `SELECT COUNT(DISTINCT o.occurrence_id) AS n FROM occurrences o JOIN bookings b ON b.occurrence_id = o.occurrence_id
     WHERE b.status = 'confirmed' AND o.status = 'scheduled' AND o.event_date BETWEEN ?1 AND ?2`,
  // As the Social prompts panel (src/social/admin.ts): prompts waiting for a person, and posts that failed their check this week.
  social_review: `SELECT (SELECT COUNT(*) FROM (${REVIEW_SQL})) + (SELECT COUNT(*) FROM social_checks WHERE result = 'fail' AND created_at >= ?1) AS n`,
  social_on: "SELECT CASE WHEN value IN ('shadow', 'enforce') THEN 1 ELSE 0 END AS n FROM settings WHERE key = 'social_prompts'",
} as const;

const BINDS: Partial<Record<keyof typeof COUNTS, (t: { weekAgo: string; today: string }) => string[]>> = {
  market_applications: t => [addDays(t.today, -14)],
  failed_emails: t => [t.weekAgo],
  failed_pushes: t => [t.weekAgo],
  booked_dates_7_days: t => [t.today, addDays(t.today, 6)],
  social_review: t => [t.weekAgo],
};

const section = (parts: Record<string, number>): SectionSummary => ({ count: Object.values(parts).reduce((a, b) => a + b, 0), parts });

export async function staffSummary(db: D1Database, user: AuthUser, now: Date): Promise<StaffSummary> {
  const today = londonDate(now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const keys = Object.keys(COUNTS) as (keyof typeof COUNTS)[];
  const [results, attention] = await Promise.all([
    db.batch(keys.map(k => db.prepare(COUNTS[k]).bind(...(BINDS[k]?.({ weekAgo, today }) ?? [])))),
    attentionOn(db),
  ]);
  const n = Object.fromEntries(keys.map((k, i) => [k, Number((results[i]!.results[0] as { n?: number } | undefined)?.n ?? 0)])) as Record<keyof typeof COUNTS, number>;
  const admin = user.role === 'admin';

  const sections: StaffSummary['sections'] = {
    approve: section({ join_requests: n.join_requests, sessions: n.sessions, changes: n.changes, market_applications: n.market_applications }),
    attention: section({ open_items: attention ? n.open_items : 0, failed_deliveries: n.failed_emails + n.failed_pushes }),
    // Social prompts count only while the switch isn't Off; at Off the part isn't there.
    events: admin ? section({ sheet_edit_problems: n.sheet_edit_problems, ...(n.social_on ? { social_review: n.social_review } : {}) }) : { count: 0 },
    bookings: { count: 0, info: { booked_dates_7_days: n.booked_dates_7_days } },
    people: { count: 0 },
  };
  if (admin) {
    sections.content = section({ menu_sheet_problem: n.menu_sheet_problem, games_to_review: n.games_to_review });
    sections.stats = { count: 0 };
  }
  return { sections };
}
