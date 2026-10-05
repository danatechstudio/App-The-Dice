// Host / Staff / Admin authentication.
//
// Sign-in is handled by Cloudflare Access in front of /api/staff/* (email
// one-time PIN, so nobody's password is stored here). Access then sets a signed
// JWT cookie for the whole site, so the organiser's /api/host calls carry it
// too; we verify it on every request, then look the email up in `users` to
// decide what it may do. Access proves who someone is, this table decides
// their role, so a Host can never act as Staff.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { MiddlewareHandler } from 'hono';

export type Role = 'host' | 'staff' | 'admin';
export interface AuthUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: Role;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = jwksCache.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, keys);
  }
  return keys;
}

/** Verifies a Cloudflare Access JWT and returns the signed-in email, or null. */
export async function verifyAccessToken(
  token: string,
  opts: { teamDomain: string; audience: string; keys?: JWTVerifyGetKey },
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, opts.keys ?? remoteKeys(opts.teamDomain), {
      issuer: opts.teamDomain,
      audience: opts.audience,
    });
    return typeof payload.email === 'string' && payload.email.includes('@') ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = req.headers.get('Cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m?.[1] ?? null;
}

/** Why nobody is signed in, so the organiser can say what went wrong (never the token itself). */
export type SignedOutReason = 'not_configured' | 'missing' | 'invalid';

async function signedIn(req: Request, env: Env): Promise<{ email: string } | { email: null; reason: SignedOutReason }> {
  if (env.ENVIRONMENT === 'development' && env.DEV_AUTH_EMAIL) return { email: env.DEV_AUTH_EMAIL.toLowerCase() };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { email: null, reason: 'not_configured' }; // nobody gets in
  const token = tokenFrom(req);
  if (!token) return { email: null, reason: 'missing' };
  const email = await verifyAccessToken(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
  return email ? { email } : { email: null, reason: 'invalid' };
}

/**
 * Requires a signed-in, active user holding one of `roles`. Admin always
 * passes a Staff check; Staff and Admin do not pass a Host-only check unless
 * listed, keeping the two portals separate.
 */
export function requireRole(...roles: Role[]): MiddlewareHandler<{ Bindings: Env; Variables: { user: AuthUser } }> {
  const allowed = new Set<Role>(roles.includes('staff') ? [...roles, 'admin'] : roles);
  return async (c, next) => {
    const who = await signedIn(c.req.raw, c.env);
    if (who.email === null) return c.json({ error: 'Sign-in required', reason: who.reason }, 401);
    const user = await c.env.DB
      .prepare('SELECT user_id, email, display_name, role FROM users WHERE email = ?1 AND active = 1')
      .bind(who.email)
      .first<AuthUser>();
    if (!user || !allowed.has(user.role)) return c.json({ error: 'Not allowed' }, 403);
    c.set('user', user);
    await next();
  };
}

export type BearerCheck = 'ok' | 'not_configured' | 'missing' | 'malformed' | 'mismatch';

/**
 * Checks the n8n bearer token in constant time (compares SHA-256 digests).
 * Surrounding whitespace on either side is ignored: pasted secrets often carry
 * a stray newline. The result names the problem without revealing the token.
 */
export async function checkBearer(header: string | null | undefined, secret: string | undefined): Promise<BearerCheck> {
  const expected = (secret ?? '').trim();
  if (!expected) return 'not_configured';
  if (!header) return 'missing';
  const m = header.match(/^\s*Bearer\s+(.+?)\s*$/i);
  if (!m) return 'malformed';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(m[1])),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b) ? 'ok' : 'mismatch';
}

/**
 * Changes must come from our own pages as JSON. Browsers can't send a
 * cross-site JSON POST without a CORS preflight (which we never allow), so
 * this stops other sites using a signed-in person's Access cookie.
 */
export const sameOriginJson: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'Cross-site request refused' }, 403);
    if (!(c.req.header('Content-Type') ?? '').startsWith('application/json')) return c.json({ error: 'Send JSON' }, 415);
  }
  await next();
};
