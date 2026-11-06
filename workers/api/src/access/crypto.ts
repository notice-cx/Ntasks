/** Web Crypto helpers for tokens: random values, hashes and their encodings. */

const encoder = new TextEncoder();

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The bytes of lowercase hexadecimal text, or null when the text is not that. */
export function fromHex(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Base64url without padding (RFC 4648 section 5). */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** A random secret of `bytes` bytes, base64url-encoded. */
export function randomSecret(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Compares two hashes without revealing, by its timing, where they differ. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Checks a value Better Auth signed for a cookie: base64 of HMAC-SHA-256
 * under the auth secret, as better-call's signed cookies make it.
 * `crypto.subtle.verify` compares in constant time.
 */
export async function verifyCookieSignature(value: string, signature: string, secret: string): Promise<boolean> {
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(value));
}
