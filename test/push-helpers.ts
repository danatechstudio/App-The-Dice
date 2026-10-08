// A pretend browser for push tests: its subscription, and decrypting what it's sent.
import { expect } from 'vitest';
import { b64url } from '../src/notify/push';

const enc = new TextEncoder();

/** A browser's side of a push subscription: its key pair and auth secret. */
export async function browser(endpoint: string) {
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
export async function decrypt(body: Uint8Array, b: Awaited<ReturnType<typeof browser>>): Promise<string> {
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
