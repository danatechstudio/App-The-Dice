// Onboarding (docs/RTD_ONBOARDING.md). Hosts and café staff join the same way:
// sign in with Cloudflare Access (which proves their email), then ask to host.
// An approver (role `staff`, shown as "Approver": Michelle) or an admin says
// yes or no. Approving creates (or re-activates) their users row as a host,
// which only lets them plan sessions; every session still needs an approver.

import type { AuthUser, Role } from '../lib/auth';
import { addDays } from '../lib/time';

/** Always 'host' now; 'staff' only on requests made before 2026-10-06. */
export type ApplicationRole = 'host' | 'staff';
export type ApplicationStatus = 'pending' | 'approved' | 'declined' | 'withdrawn';

export interface Application {
  application_id: string;
  email: string;
  display_name: string;
  role: ApplicationRole;
  about: string;
  status: ApplicationStatus;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

/** A signed-in person can send a few requests a day, not a flood of emails to the approver. */
const MAX_REQUESTS_PER_DAY = 3;

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max + 1) : '');

export function parseApplication(
  body: unknown,
): { ok: true; value: { display_name: string; about: string } } | { ok: false; errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const name = clean(b.display_name, 60);
  if (name.length < 2 || name.length > 60) errors.display_name = 'Enter your name (2–60 characters).';
  const about = typeof b.about === 'string' ? b.about.trim() : '';
  if (about.length < 3) errors.about = 'Tell the café what you would like to run.';
  else if (about.length > 500) errors.about = 'Keep it to 500 characters.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { display_name: name, about } };
}

const FIELDS = `application_id, email, display_name, role, about, status, decision_note, decided_by, decided_at, created_at`;

export async function latestApplication(db: D1Database, email: string): Promise<Application | null> {
  return db
    .prepare(`SELECT ${FIELDS} FROM applications WHERE email = ?1 ORDER BY created_at DESC, application_id DESC LIMIT 1`)
    .bind(email)
    .first<Application>();
}

async function activeUser(db: D1Database, email: string) {
  return db.prepare('SELECT user_id, role FROM users WHERE email = ?1 AND active = 1').bind(email).first<{ user_id: string; role: Role }>();
}

const audit = (db: D1Database, entityType: string, id: string, actorType: string, actor: string, action: string, prev: string | null, next: string | null, now: string) =>
  db
    .prepare(
      `INSERT INTO audit_log (entity_type, entity_id, actor_type, actor_id, action, previous_value, new_value, source, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'organiser', ?8)`,
    )
    .bind(entityType, id, actorType, actor, action, prev, next, now);

export type Submit =
  | { ok: true; application: Application }
  | { ok: false; status: 400 | 409 | 429; error: string; errors?: Record<string, string> };

export async function submitApplication(db: D1Database, email: string, body: unknown, now: string): Promise<Submit> {
  if (await activeUser(db, email)) return { ok: false, status: 409, error: 'You already have access. Open the organiser.' };
  const latest = await latestApplication(db, email);
  if (latest?.status === 'pending') return { ok: false, status: 409, error: 'You already have a request waiting.' };
  const recent = await db
    .prepare('SELECT COUNT(*) AS n FROM applications WHERE email = ?1 AND created_at > ?2')
    .bind(email, new Date(Date.parse(now) - 86_400_000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_REQUESTS_PER_DAY) return { ok: false, status: 429, error: 'Too many requests today. Please try again tomorrow.' };
  const parsed = parseApplication(body);
  if (!parsed.ok) return { ok: false, status: 400, error: 'Please check the form', errors: parsed.errors };
  const { display_name, about } = parsed.value;
  const row = await db
    .prepare(
      `INSERT INTO applications (application_id, email, display_name, role, about, status, created_at, updated_at)
       SELECT printf('RTD-APP-%05d', COALESCE(MAX(CAST(substr(application_id, 9) AS INTEGER)), 0) + 1),
         ?1, ?2, 'host', ?3, 'pending', ?4, ?4
       FROM applications
       RETURNING application_id`,
    )
    .bind(email, display_name, about, now)
    .first<{ application_id: string }>();
  const id = row!.application_id;
  // The request's number, not the person: their details are erased later (docs/RTD_PRIVACY.md), and the audit log can't be.
  await audit(db, 'application', id, 'customer', id, 'application.host.submitted', null, JSON.stringify({ role: 'host' }), now).run();
  return { ok: true, application: (await latestApplication(db, email))! };
}

export async function withdrawApplication(db: D1Database, email: string, now: string): Promise<boolean> {
  const latest = await latestApplication(db, email);
  if (latest?.status !== 'pending') return false;
  const res = await db
    .prepare("UPDATE applications SET status = 'withdrawn', updated_at = ?2 WHERE application_id = ?1 AND status = 'pending'")
    .bind(latest.application_id, now)
    .run();
  if (!res.meta.changes) return false;
  await audit(db, 'application', latest.application_id, 'customer', latest.application_id, 'application.withdrawn', 'pending', 'withdrawn', now).run();
  return true;
}

/** Join requests for approvers and admins (the staff routes check the role). */
export async function listApplications(db: D1Database, status: ApplicationStatus = 'pending'): Promise<Application[]> {
  const { results } = await db
    .prepare(`SELECT ${FIELDS} FROM applications WHERE status = ?1 ORDER BY created_at, application_id LIMIT 100`)
    .bind(status)
    .all<Application>();
  return results;
}

const RANK: Record<Role, number> = { host: 1, staff: 2, admin: 3 };

export type Decision = { ok: true; application: Application } | { ok: false; status: 404 | 409; error: string };

/** Approve or decline once. Approval makes them a host straight away. */
export async function decideApplication(
  db: D1Database,
  reviewer: AuthUser,
  id: string,
  decision: 'approve' | 'decline',
  note: string | null,
  now: string,
): Promise<Decision> {
  const app = await db.prepare(`SELECT ${FIELDS} FROM applications WHERE application_id = ?1`).bind(id).first<Application>();
  if (!app) return { ok: false, status: 404, error: 'Request not found' };
  if (app.status !== 'pending') return { ok: false, status: 409, error: `This request is already ${app.status}.` };
  const status = decision === 'approve' ? 'approved' : 'declined';
  // Only move if still pending, so two reviewers deciding at once can't both win.
  const res = await db
    .prepare(
      `UPDATE applications SET status = ?2, decision_note = ?3, decided_by = ?4, decided_at = ?5, updated_at = ?5
       WHERE application_id = ?1 AND status = 'pending'`,
    )
    .bind(id, status, note, reviewer.email, now)
    .run();
  if (!res.meta.changes) return { ok: false, status: 409, error: 'Someone else has just decided this request.' };

  const writes = [audit(db, 'application', id, 'staff', reviewer.email, `application.${status}`, 'pending', note, now)];
  if (status === 'approved') {
    // Everyone joins as a host. Never downgrade an approver or admin. Someone
    // whose access was removed keeps their old users row (and ID), re-activated.
    const existing = await activeUser(db, app.email);
    const role: Role = existing && RANK[existing.role] > RANK.host ? existing.role : 'host';
    const previous = await db.prepare('SELECT user_id FROM users WHERE email = ?1').bind(app.email).first<{ user_id: string }>();
    const userId = previous?.user_id ?? `host-${crypto.randomUUID()}`;
    writes.push(
      db
        .prepare(
          `INSERT INTO users (user_id, email, display_name, role, active, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
           ON CONFLICT (email) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, active = 1,
             updated_at = excluded.updated_at`,
        )
        .bind(userId, app.email, app.display_name, role, now),
      audit(db, 'user', userId, 'staff', reviewer.email, `user.granted_${role}`, null, `${app.email} via ${id}`, now),
    );
  }
  await db.batch(writes);
  return { ok: true, application: (await db.prepare(`SELECT ${FIELDS} FROM applications WHERE application_id = ?1`).bind(id).first<Application>())! };
}

/** Approvers (role staff) and admins, for admins. */
export async function listApprovers(db: D1Database) {
  const { results } = await db
    .prepare("SELECT user_id, email, display_name, role, created_at FROM users WHERE role IN ('staff', 'admin') AND active = 1 ORDER BY role, display_name")
    .all<Record<string, unknown>>();
  return results;
}

/**
 * Offboarding: approvers can remove hosts; admins can also remove approvers.
 * Nobody removes an admin or themselves here, so the café can't lock itself out.
 */
export async function removeAccess(
  db: D1Database,
  actor: AuthUser,
  userId: string,
  now: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404; error: string }> {
  const target = await db.prepare('SELECT user_id, email, role FROM users WHERE user_id = ?1 AND active = 1').bind(userId).first<{ user_id: string; email: string; role: Role }>();
  if (!target) return { ok: false, status: 404, error: 'No one with access by that ID' };
  if (target.user_id === actor.user_id) return { ok: false, status: 403, error: "You can't remove your own access." };
  if (target.role === 'admin') return { ok: false, status: 403, error: 'Admins can only be removed in the database.' };
  if (target.role === 'staff' && actor.role !== 'admin') return { ok: false, status: 403, error: 'Only an admin can remove an approver.' };
  await db.batch([
    db.prepare('UPDATE users SET active = 0, updated_at = ?2 WHERE user_id = ?1').bind(userId, now),
    audit(db, 'user', target.user_id, 'staff', actor.email, `user.removed_${target.role}`, target.email, null, now),
  ]);
  return { ok: true };
}

/**
 * Admins only: make a host an approver (role `staff`: approves join requests and
 * sessions, and can remove hosts), or turn an approver back into a host.
 */
export async function setApprover(
  db: D1Database,
  actor: AuthUser,
  userId: string,
  approver: boolean,
  now: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404 | 409; error: string }> {
  if (actor.role !== 'admin') return { ok: false, status: 403, error: 'Only an admin can choose approvers.' };
  const target = await db.prepare('SELECT user_id, email, role FROM users WHERE user_id = ?1 AND active = 1').bind(userId).first<{ user_id: string; email: string; role: Role }>();
  if (!target) return { ok: false, status: 404, error: 'No one with access by that ID' };
  if (target.role === 'admin' || target.user_id === actor.user_id) return { ok: false, status: 403, error: "Admins can't be changed here." };
  const role: Role = approver ? 'staff' : 'host';
  if (target.role === role) return { ok: false, status: 409, error: approver ? 'Already an approver.' : 'Already a host.' };
  await db.batch([
    db.prepare('UPDATE users SET role = ?2, updated_at = ?3 WHERE user_id = ?1').bind(userId, role, now),
    audit(db, 'user', userId, 'staff', actor.email, approver ? 'user.made_approver' : 'user.approver_removed', target.role, role, now),
  ]);
  return { ok: true };
}

// ---- Emails, sent by n8n (RTD Team Notices) ----

const NOTICE_WINDOW_DAYS = 14;

/** New requests the approvers haven't been emailed about: they go to the café address (rtd_config in n8n). */
export async function newApplicationsForApprovers(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT ${FIELDS} FROM applications WHERE status = 'pending' AND approver_notified_at IS NULL
       ORDER BY created_at, application_id LIMIT 50`,
    )
    .all<Application>();
  // notify / notify_cafe keep the shape n8n RTD Team Notices reads.
  return results.map(a => ({ ...a, role: 'host' as const, role_label: 'host', notify: [] as string[], notify_cafe: true }));
}

/** Requests decided in the last fortnight whose applicant hasn't been told. */
export async function decidedApplicationsForApplicants(db: D1Database, today: string) {
  const { results } = await db
    .prepare(
      `SELECT ${FIELDS} FROM applications
       WHERE status IN ('approved', 'declined') AND applicant_notified_at IS NULL AND decided_at >= ?1
       ORDER BY decided_at, application_id LIMIT 50`,
    )
    .bind(addDays(today, -NOTICE_WINDOW_DAYS))
    .all<Application>();
  return results.map(a => ({
    ...a,
    role: 'host' as const,
    first_name: a.display_name.trim().split(/\s+/)[0] || 'there',
    role_label: 'host',
  }));
}

export async function markApplicationNotified(db: D1Database, id: string, who: 'approver' | 'applicant', now: string): Promise<'ok' | 'already' | 'not_found'> {
  const column = who === 'approver' ? 'approver_notified_at' : 'applicant_notified_at';
  const res = await db.prepare(`UPDATE applications SET ${column} = ?2 WHERE application_id = ?1 AND ${column} IS NULL`).bind(id, now).run();
  if (res.meta.changes) return 'ok';
  const row = await db.prepare('SELECT 1 FROM applications WHERE application_id = ?1').bind(id).first();
  return row ? 'already' : 'not_found';
}
