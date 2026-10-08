// Web Push for approvers (docs/RTD_PUSH.md), sent straight from the Worker,
// with no third-party service. Each message is encrypted for the one browser
// it goes to (RFC 8291, aes128gcm) and signed with the app's VAPID key
// (RFC 8292). Push is a nudge on top of email: if it fails, the email still goes.

import { shortDate, weekdayOf } from '../lib/format';

const enc = new TextEncoder();

export const b64url = {
  encode(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  },
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// ---- The app's VAPID key pair ----

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url: the browser's applicationServerKey. */
  publicKey: string;
  privateKey: CryptoKey;
}

/** The app's key pair, made the first time it's needed and kept in D1 (push_keys). */
export async function vapidKeys(db: D1Database): Promise<VapidKeys> {
  const read = () => db.prepare('SELECT public_key, private_jwk FROM push_keys WHERE id = 1').first<{ public_key: string; private_jwk: string }>();
  let row = await read();
  if (!row) {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicKey = b64url.encode((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
    const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
    // Two first requests at once: the first insert wins and both use its keys.
    await db
      .prepare('INSERT OR IGNORE INTO push_keys (id, public_key, private_jwk, created_at) VALUES (1, ?1, ?2, ?3)')
      .bind(publicKey, JSON.stringify(jwk), new Date().toISOString())
      .run();
    row = await read();
  }
  const privateKey = await crypto.subtle.importKey('jwk', JSON.parse(row!.private_jwk) as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { publicKey: row!.public_key, privateKey };
}

/** The Authorization header: a short-lived ES256 token for the push service, plus our public key. */
export async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string, now: Date): Promise<string> {
  const part = (o: unknown) => b64url.encode(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject })}`;
  // WebCrypto's ECDSA signature is r || s, exactly what ES256 wants.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url.encode(signature)}, k=${keys.publicKey}`;
}

// ---- Encrypting a message for one browser (RFC 8291) ----

const RECORD_SIZE = 4096;

async function hkdf(salt: Uint8Array, ikm: ArrayBuffer | Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

/** The request body for one subscription: header (salt, record size, our one-off public key) + ciphertext. */
export async function encryptForSubscription(payload: Uint8Array, p256dh: string, authSecret: string): Promise<Uint8Array> {
  const uaPublic = b64url.decode(p256dh);
  const auth = b64url.decode(authSecret);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // Workers' types call this field `$public`; the runtime takes the standard `public`.
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256);

  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 96);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One record: the message, then 0x02 to mark it as the last.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// ---- Subscriptions ----

/** Push services the browsers use. Anything else is refused, so the app never posts to an arbitrary address. */
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function allowedEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && !u.username && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A browser's PushSubscription (toJSON()), checked. */
export function parseSubscription(body: unknown): Subscription | null {
  const b = (body && typeof body === 'object' ? body : {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
  const p256dh = typeof b.keys?.p256dh === 'string' ? b.keys.p256dh : '';
  const auth = typeof b.keys?.auth === 'string' ? b.keys.auth : '';
  if (endpoint.length > 2000 || !allowedEndpoint(endpoint)) return null;
  try {
    const key = b64url.decode(p256dh);
    if (key.length !== 65 || key[0] !== 4 || b64url.decode(auth).length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint, p256dh, auth };
}

/** "iPhone", "Android", "Mac", "Windows"…: enough to tell someone's devices apart. */
export function deviceLabel(ua: string | undefined): string {
  const s = ua ?? '';
  const device = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return browser ? `${device}, ${browser}` : device;
}

/** Keep someone's newest 10 devices. */
const MAX_DEVICES = 10;

export async function saveSubscription(db: D1Database, userId: string, sub: Subscription, label: string, now: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, device_label, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
           device_label = excluded.device_label, failures = 0`,
      )
      .bind(sub.endpoint, userId, sub.p256dh, sub.auth, label, now),
    db
      .prepare(
        `DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint NOT IN
           (SELECT endpoint FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ${MAX_DEVICES})`,
      )
      .bind(userId),
  ]);
}

export async function removeSubscription(db: D1Database, userId: string, endpoint: unknown): Promise<boolean> {
  if (typeof endpoint !== 'string') return false;
  const res = await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2').bind(endpoint, userId).run();
  return !!res.meta.changes;
}

// ---- Sending ----

/** What the notification says, and where tapping it goes. Plain text. */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  /** A newer notification with the same tag replaces the older one. */
  tag: string;
}

export interface PushContext {
  /** Who runs the app, for the push services: the app's own address. */
  subject: string;
  now: Date;
}

/** After this many failures in a row, a device is dropped. */
const MAX_FAILURES = 5;

/**
 * One message to one device, encrypted for it and signed with the app's key.
 * Returns the push service's status (0 if it couldn't be reached).
 */
export async function sendPush(
  s: Subscription,
  message: PushMessage,
  keys: VapidKeys,
  ctx: PushContext,
  opts: { ttlSeconds?: number; urgency?: 'normal' | 'high'; authorization?: string } = {},
): Promise<number> {
  try {
    const res = await fetch(s.endpoint, {
      method: 'POST',
      headers: {
        Authorization: opts.authorization ?? (await vapidHeader(s.endpoint, keys, ctx.subject, ctx.now)),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttlSeconds ?? 86400),
        Urgency: opts.urgency ?? 'high',
      },
      body: await encryptForSubscription(enc.encode(JSON.stringify(message)), s.p256dh, s.auth),
    });
    return res.status;
  } catch {
    return 0;
  }
}

async function deliver(db: D1Database, subs: Subscription[], message: PushMessage, ctx: PushContext): Promise<{ sent: number; failed: number }> {
  if (!subs.length) return { sent: 0, failed: 0 };
  const keys = await vapidKeys(db);
  const statuses = await Promise.all(subs.map(s => sendPush(s, message, keys, ctx)));
  const now = ctx.now.toISOString();
  const updates = statuses.flatMap((status, i) => {
    const endpoint = subs[i]!.endpoint;
    if (status >= 200 && status < 300) return [db.prepare('UPDATE push_subscriptions SET last_sent_at = ?2, failures = 0 WHERE endpoint = ?1').bind(endpoint, now)];
    // 404 / 410: the browser has unsubscribed, or the app was removed.
    if (status === 404 || status === 410) return [db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint)];
    return [
      db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?1').bind(endpoint),
      db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1 AND failures >= ${MAX_FAILURES}`).bind(endpoint),
    ];
  });
  await db.batch(updates);
  const sent = statuses.filter(s => s >= 200 && s < 300).length;
  return { sent, failed: statuses.length - sent };
}

/** Every active approver and admin, on every device they've turned notifications on for. */
export async function notifyApprovers(db: D1Database, message: PushMessage, ctx: PushContext & { exceptUserId?: string }) {
  const { results } = await db
    .prepare(
      `SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN users u ON u.user_id = s.user_id
       WHERE u.active = 1 AND u.role IN ('staff', 'admin') AND u.user_id IS NOT ?1`,
    )
    .bind(ctx.exceptUserId ?? null)
    .all<Subscription>();
  return deliver(db, results, message, ctx);
}

/** One person's devices (the "Send a test" button). */
export async function notifyUser(db: D1Database, userId: string, message: PushMessage, ctx: PushContext) {
  const { results } = await db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1').bind(userId).all<Subscription>();
  return deliver(db, results, message, ctx);
}

export async function myDevices(db: D1Database, userId: string) {
  const { results } = await db
    .prepare('SELECT endpoint, device_label, created_at, last_sent_at FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC')
    .bind(userId)
    .all<{ endpoint: string; device_label: string | null; created_at: string; last_sent_at: string | null }>();
  return results;
}

// ---- What approvers are told ----

export const sessionToApprove = (s: {
  session_id: string;
  name: string;
  event_date: string;
  frequency: string;
  access: string;
  host_name: string | null;
  host_email: string;
  resubmissions?: number;
}): PushMessage => ({
  title: s.resubmissions ? 'Session sent again' : 'Session to approve',
  body: `${s.host_name ?? s.host_email}: ${s.name}, ${s.frequency === 'weekly' ? `every ${weekdayOf(s.event_date)} from ${shortDate(s.event_date)}` : shortDate(s.event_date)}${s.access === 'private' ? ' (private)' : ''}`,
  url: '/organise#awaiting',
  tag: `session-${s.session_id}`,
});

export const joinRequestToApprove = (a: { application_id: string; display_name: string }): PushMessage => ({
  title: 'Join request',
  body: `${a.display_name} has asked to host games`,
  url: '/organise#join-requests',
  tag: `join-${a.application_id}`,
});

export const marketApplicationToApprove = (a: { application_id: string; stall_name: string; market_name: string; event_date: string; waitlisted: boolean }): PushMessage => ({
  title: 'Market application',
  body: `${a.stall_name}: ${a.market_name}, ${shortDate(a.event_date)}${a.waitlisted ? ' (waiting list)' : ''}`,
  url: '/organise#market-applications',
  tag: `market-${a.application_id}`,
});
