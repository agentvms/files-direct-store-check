/** The room secret and the room id the server sees. See docs/PROTOCOL.md. */

export const SECRET_BYTES = 16;
export const ROOM_ID_BYTES = 16;
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{22,}$/;

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 128 random bits from the crypto API, base64url. */
export function generateSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** The public room id: the first 16 bytes of SHA-256 over a fixed label and the secret. */
export async function roomIdFromSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode('files-direct room' + secret);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return base64url(digest.slice(0, ROOM_ID_BYTES));
}
