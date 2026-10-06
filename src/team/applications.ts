// Onboarding for hosts and café staff (docs/RTD_ONBOARDING.md).
//
// Someone signs in with Cloudflare Access (which proves their email), then
// asks to host games or to join the café team. Staff approve host requests;
// only an admin approves café team requests. Approving creates (or re-activates)
// their users row, which is what actually grants access.

import type { AuthUser, Role } from '../lib/auth';
import { addDays } from '../lib/time';

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
): { ok: true; value: { role: ApplicationRole; display_name: string; about: string } } | { ok: false; errors: Record<string, string> } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const role = b.role;
  if (role !== 'host' && role !== 'staff') errors.role = 'Choose hosting games or the café team.';
  const name = clean(b.display_name, 60);
  if (name.length < 2 || name.length > 60) errors.display_name = 'Enter your name (2–60 characters).';
  const about = typeof b.about === 'string' ? b.about.trim() : '';
  if (about.length < 3) errors.about = role === 'staff' ? 'Tell us your role at the café.' : 'Tell the café what you would like to run.';
  else if (about.length > 500) errors.about = 'Keep it to 500 characters.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { role: role as ApplicationRole, display_name: name, about } };
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
  const { role, display_name, about } = parsed.value;
  const row = await db
    .prepare(
      `INSERT INTO applications (application_id, email, display_name, role, about, status, created_at, updated_at)
       SELECT printf('RTD-APP-%05d', COALESCE(MAX(CAST(substr(application_id, 9) AS INTEGER)), 0) + 1),
         ?1, ?2, ?3, ?4, 'pending', ?5, ?5
       FROM applications
       RETURNING application_id`,
    )
    .bind(email, display_name, role, about, now)
    .first<{ application_id: string }>();
  const id = row!.application_id;
  await audit(db, 'application', id, 'customer', email, `application.${role}.submitted`, null, JSON.stringify(parsed.value), now).run();
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
  await audit(db, 'application', latest.application_id, 'customer', email, 'application.withdrawn', 'pending', 'withdrawn', now).run();
  return true;
}

/** Roles a reviewer may approve: staff approve hosts; admins approve hosts and café team. */
export const reviewableRoles = (reviewer: AuthUser): ApplicationRole[] => (reviewer.role === 'admin' ? ['host', 'staff'] : ['host']);

export async function listApplications(db: D1Database, reviewer: AuthUser, status: ApplicationStatus = 'pending'): Promise<Application[]> {
  const roles = reviewableRoles(reviewer);
  const { results } = await db
    .prepare(
      `SELECT ${FIELDS} FROM applications
       WHERE status = ?1 AND role IN (SELECT value FROM json_each(?2))
       ORDER BY created_at, application_id LIMIT 100`,
    )
    .bind(status, JSON.stringify(roles))
    .all<Application>();
  return results;
}

const RANK: Record<Role, number> = { host: 1, staff: 2, admin: 3 };

export type Decision = { ok: true; application: Application } | { ok: false; status: 403 | 404 | 409; error: string };

/** Approve or decline once. Approval grants the requested access straight away. */
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
  if (!reviewableRoles(reviewer).includes(app.role)) return { ok: false, status: 403, error: 'Only an admin can approve café team requests.' };
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
    // Never downgrade someone who already holds a higher role.
    const existing = await activeUser(db, app.email);
    const role: Role = existing && RANK[existing.role] > RANK[app.role] ? existing.role : app.role;
    const userId = existing?.user_id ?? `${app.role}-${crypto.randomUUID()}`;
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

/** Café team (staff and admins), for admins. */
export async function listTeam(db: D1Database) {
  const { results } = await db
    .prepare("SELECT user_id, email, display_name, role, created_at FROM users WHERE role IN ('staff', 'admin') AND active = 1 ORDER BY role, display_name")
    .all<Record<string, unknown>>();
  return results;
}

/**
 * Offboarding: staff can remove hosts; admins can also remove staff. Nobody
 * removes an admin or themselves here, so the café can't lock itself out.
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
  if (target.role === 'staff' && actor.role !== 'admin') return { ok: false, status: 403, error: 'Only an admin can remove café team members.' };
  await db.batch([
    db.prepare('UPDATE users SET active = 0, updated_at = ?2 WHERE user_id = ?1').bind(userId, now),
    audit(db, 'user', target.user_id, 'staff', actor.email, `user.removed_${target.role}`, target.email, null, now),
  ]);
  return { ok: true };
}

// ---- Emails, sent by n8n (RTD Team Notices) ----

const NOTICE_WINDOW_DAYS = 14;

/** New requests the approver hasn't been emailed about. Café team requests go to the admins. */
export async function newApplicationsForApprovers(db: D1Database) {
  const [apps, admins] = await db.batch([
    db.prepare(
      `SELECT ${FIELDS} FROM applications WHERE status = 'pending' AND approver_notified_at IS NULL
       ORDER BY created_at, application_id LIMIT 50`,
    ),
    db.prepare("SELECT email FROM users WHERE role = 'admin' AND active = 1 ORDER BY email"),
  ]);
  const adminEmails = ((admins?.results ?? []) as { email: string }[]).map(a => a.email);
  return ((apps?.results ?? []) as unknown as Application[]).map(a => ({
    ...a,
    role_label: a.role === 'staff' ? 'café team' : 'host',
    // Café team requests: the admins. Host requests: the café address (n8n reads it from rtd_config).
    notify: a.role === 'staff' ? adminEmails : [],
    notify_cafe: a.role === 'host',
  }));
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
    first_name: a.display_name.trim().split(/\s+/)[0] || 'there',
    role_label: a.role === 'staff' ? 'café team' : 'host',
  }));
}

export async function markApplicationNotified(db: D1Database, id: string, who: 'approver' | 'applicant', now: string): Promise<'ok' | 'already' | 'not_found'> {
  const column = who === 'approver' ? 'approver_notified_at' : 'applicant_notified_at';
  const res = await db.prepare(`UPDATE applications SET ${column} = ?2 WHERE application_id = ?1 AND ${column} IS NULL`).bind(id, now).run();
  if (res.meta.changes) return 'ok';
  const row = await db.prepare('SELECT 1 FROM applications WHERE application_id = ?1').bind(id).first();
  return row ? 'already' : 'not_found';
}
