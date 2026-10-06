import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedEndpoint, b64url, encryptForSubscription, vapidHeader, vapidKeys } from '../src/notify/push';
import { env, freshDb, request } from './helpers';

const as = (email: string) => ({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email });
const DAN = as('dan@example.com'); // admin
const MICHELLE = as('michelle@example.com'); // approver
const SAM = as('sam@example.com'); // host
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const enc = new TextEncoder();

/** A browser's side of a push subscription: its key pair and auth secret. */
async function browser(endpoint: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, raw, auth, subscription: { endpoint, keys: { p256dh: b64url.encode(raw), auth: b64url.encode(auth) } } };
}

const hkdf = async (salt: Uint8Array, ikm: ArrayBuffer | Uint8Array, info: Uint8Array, bits: number) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
      bits,
    ),
  );
const join = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of a) (out.set(x, i), (i += x.length));
  return out;
};

/** Decrypts a push body the way the browser does (RFC 8291 / RFC 8188). */
async function decrypt(body: Uint8Array, b: Awaited<ReturnType<typeof browser>>): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, b.pair.privateKey, 256);
  const ikm = await hkdf(b.auth, shared, join(enc.encode('WebPush: info\0'), b.raw, asPublic), 256);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 128);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 96);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)));
  expect(plain.at(-1)).toBe(2); // the last-record delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

type Sent = { url: string; headers: Headers; body: Uint8Array };
let sent: Sent[] = [];
let status = 201;

beforeEach(async () => {
  await freshDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  const now = '2026-10-01T00:00:00Z';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users VALUES ('u-dan', 'dan@example.com', 'Dan', 'admin', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-mich', 'michelle@example.com', 'Michelle', 'staff', 1, ?1, ?1)").bind(now),
    env.DB.prepare("INSERT INTO users VALUES ('u-sam', 'sam@example.com', 'Sam Host', 'host', 1, ?1, ?1)").bind(now),
  ]);
  sent = [];
  status = 201;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: new Uint8Array(init?.body as Uint8Array) });
    return new Response(null, { status });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the encryption and signing', () => {
  it('encrypts a message only the subscribed browser can read', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/abc');
    const body = await encryptForSubscription(enc.encode('{"title":"Hello"}'), b.subscription.keys.p256dh, b.subscription.keys.auth);
    expect(await decrypt(body, b)).toBe('{"title":"Hello"}');
    const other = await browser('https://fcm.googleapis.com/fcm/send/xyz');
    await expect(decrypt(body, other)).rejects.toThrow();
  });

  it('signs a short-lived token for the push service, naming the app, not a person', async () => {
    const keys = await vapidKeys(env.DB);
    expect((await vapidKeys(env.DB)).publicKey).toBe(keys.publicKey); // made once, then kept
    const header = await vapidHeader('https://web.push.apple.com/QK7abc', keys, 'https://rtd.example', new Date('2026-10-06T10:00:00Z'));
    const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = token!.split('.');
    expect(JSON.parse(new TextDecoder().decode(b64url.decode(h!)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(new TextDecoder().decode(b64url.decode(c!)));
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', sub: 'https://rtd.example', exp: Date.parse('2026-10-06T22:00:00Z') / 1000 });
    const pub = await crypto.subtle.importKey('raw', b64url.decode(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64url.decode(s!), enc.encode(`${h}.${c}`))).toBe(true);
  });

  it('only ever posts to the browsers’ own push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-db5p.notify.windows.com/w/?token=x']) {
      expect(allowedEndpoint(ok), ok).toBe(true);
    }
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x', 'not a url']) {
      expect(allowedEndpoint(bad), bad).toBe(false);
    }
  });
});

describe('turning notifications on', () => {
  it('is for approvers and admins only', async () => {
    expect((await request('/api/staff/push/key', {}, SAM)).status).toBe(403);
    const { public_key } = await (await request('/api/staff/push/key', {}, MICHELLE)).json<{ public_key: string }>();
    expect(b64url.decode(public_key)).toHaveLength(65);
    const b = await browser('https://fcm.googleapis.com/fcm/send/sam');
    expect((await request('/api/staff/push/subscribe', json(b.subscription), SAM)).status).toBe(403);
  });

  it('saves a device, refuses bad details, and turns it off again', async () => {
    const b = await browser('https://fcm.googleapis.com/fcm/send/michelle-phone');
    expect((await request('/api/staff/push/subscribe', json({ ...b.subscription, endpoint: 'https://evil.example/x' }), MICHELLE)).status).toBe(400);
    expect((await request('/api/staff/push/subscribe', json({ ...b.subscription, keys: { p256dh: 'abc', auth: 'def' } }), MICHELLE)).status).toBe(400);
    const res = await request('/api/staff/push/subscribe', { ...json(b.subscription), headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } }, MICHELLE);
    expect(res.status).toBe(200);
    const { devices } = await (await request('/api/staff/push/devices', {}, MICHELLE)).json<{ devices: { device_label: string }[] }>();
    expect(devices).toEqual([expect.objectContaining({ device_label: 'iPhone, Safari' })]);
    expect((await (await request('/api/staff/push/devices', {}, DAN)).json<{ devices: unknown[] }>()).devices).toEqual([]);
    expect(await (await request('/api/staff/push/unsubscribe', json({ endpoint: b.subscription.endpoint }), DAN)).json()).toEqual({ ok: true, removed: false }); // not Dan's
    expect(await (await request('/api/staff/push/unsubscribe', json({ endpoint: b.subscription.endpoint }), MICHELLE)).json()).toEqual({ ok: true, removed: true });
  });

  it('sends a test to your own devices only', async () => {
    const mine = await browser('https://fcm.googleapis.com/fcm/send/michelle');
    const dans = await browser('https://web.push.apple.com/dan');
    await request('/api/staff/push/subscribe', json(mine.subscription), MICHELLE);
    await request('/api/staff/push/subscribe', json(dans.subscription), DAN);
    expect(await (await request('/api/staff/push/test', json({}), MICHELLE)).json()).toEqual({ sent: 1, failed: 0 });
    expect(sent.map(s => s.url)).toEqual([mine.subscription.endpoint]);
    expect(JSON.parse(await decrypt(sent[0]!.body, mine))).toMatchObject({ title: 'Notifications are on', url: '/organise' });
  });
});

describe('when something needs approving', () => {
  let michelle: Awaited<ReturnType<typeof browser>>;
  let dan: Awaited<ReturnType<typeof browser>>;
  beforeEach(async () => {
    michelle = await browser('https://fcm.googleapis.com/fcm/send/michelle');
    dan = await browser('https://web.push.apple.com/dan');
    await request('/api/staff/push/subscribe', json(michelle.subscription), MICHELLE);
    await request('/api/staff/push/subscribe', json(dan.subscription), DAN);
  });
  const session = { name: 'Root Night', event_date: '2026-10-08', start_time: '19:00', price_pence: 0, max_players: 4 };

  it('pushes a new session to every approver and admin, encrypted for each device', async () => {
    expect((await request('/api/host/sessions', json(session), SAM)).status).toBe(201);
    expect(sent.map(s => s.url).sort()).toEqual([dan.subscription.endpoint, michelle.subscription.endpoint].sort());
    const toMichelle = sent.find(s => s.url === michelle.subscription.endpoint)!;
    expect(toMichelle.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(toMichelle.headers.get('TTL')).toBe('86400');
    expect(toMichelle.headers.get('Authorization')).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    expect(JSON.parse(await decrypt(toMichelle.body, michelle))).toEqual({
      title: 'Session to approve',
      body: 'Sam Host: Root Night, Thu 8 Oct',
      url: '/organise#awaiting',
      tag: 'session-RTD-HS-00001',
    });
    const toDan = sent.find(s => s.url === dan.subscription.endpoint)!;
    expect(JSON.parse(await decrypt(toDan.body, dan)).title).toBe('Session to approve');
  });

  it("doesn't push someone their own session", async () => {
    await request('/api/host/sessions', json({ ...session, frequency: 'weekly', access: 'private' }), MICHELLE);
    expect(sent.map(s => s.url)).toEqual([dan.subscription.endpoint]);
    expect(JSON.parse(await decrypt(sent[0]!.body, dan)).body).toBe('Michelle: Root Night, every Thursday from Thu 8 Oct (private)');
  });

  it('pushes a new join request', async () => {
    expect((await request('/api/join/apply', json({ display_name: 'Nina Newbie', about: 'Catan nights' }), as('nina@example.com'))).status).toBe(201);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(await decrypt(sent.find(s => s.url === michelle.subscription.endpoint)!.body, michelle))).toEqual({
      title: 'Join request',
      body: 'Nina Newbie has asked to host games',
      url: '/organise#join-requests',
      tag: 'join-RTD-APP-00001',
    });
  });

  it('stops pushing to someone who is no longer an approver', async () => {
    await env.DB.prepare("UPDATE users SET role = 'host' WHERE user_id = 'u-mich'").run();
    await request('/api/host/sessions', json(session), SAM);
    expect(sent.map(s => s.url)).toEqual([dan.subscription.endpoint]);
  });

  it('forgets a device the push service says is gone, and still saves the session if pushing fails', async () => {
    status = 410;
    expect((await request('/api/host/sessions', json(session), SAM)).status).toBe(201);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first();
    expect(left).toEqual({ n: 0 });
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    expect((await request('/api/host/sessions', json({ ...session, name: 'Root Night 2' }), SAM)).status).toBe(201);
  });
});
