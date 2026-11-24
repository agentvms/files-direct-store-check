/** Small previews of photos: what both ends agree on, with no page dependencies (docs/PROTOCOL.md, "Previews"). The picture-making itself is in preview-make.ts. */
import { PREVIEW_SOURCE_MAX_BYTES, PREVIEW_SOURCE_TYPES, PREVIEW_TYPES } from '../../../shared/config.ts';

/** A preview the sender made: the picture, ready for a frame. */
export interface PreviewImage {
  type: string;
  w: number;
  h: number;
  bytes: Uint8Array;
}

/** May this file (as the manifest names it) be shown as a preview? The type is the sender's word; the picture itself is checked again when it arrives and when it is drawn. */
export const isPreviewSource = (type: string, size: number): boolean => PREVIEW_SOURCE_TYPES.includes(type.toLowerCase().split(';')[0]!.trim()) && size > 0 && size <= PREVIEW_SOURCE_MAX_BYTES;

/** Is the manifest's type one a preview may be drawn for? (the size does not matter to the one who receives it) */
export const isPreviewKind = (type: string): boolean => PREVIEW_SOURCE_TYPES.includes(type.toLowerCase().split(';')[0]!.trim());

export const isPreviewType = (type: unknown): type is string => typeof type === 'string' && PREVIEW_TYPES.includes(type);

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Null when it is not base64. */
export function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The first bytes of the picture say what it is. A preview whose bytes are not the kind it names is dropped before anything decodes it. */
export function looksLike(type: string, b: Uint8Array): boolean {
  if (type === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/webp') return b.length > 12 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP';
  return false;
}

/** A photo with more pixels than this is decoded already scaled down, and a decoded picture with more is never drawn from: one threshold for both, so a photo is never decoded in full only to be refused. */
export const MAX_DECODE_PIXELS = 8_000_000;

/** How to decode a file whose first bytes gave this size (null: not known): as it is only when it is known to be small, otherwise scaled down while it decodes. */
export const decodeScaled = (size: { w: number; h: number } | null): boolean => size === null || size.w * size.h > MAX_DECODE_PIXELS;

/** The size a picture of w by h has when its longest side is at most edge. Never larger than it is. */
export function fitWithin(w: number, h: number, edge: number): { w: number; h: number } {
  const scale = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * The size in pixels that the first bytes of a PNG, GIF, JPEG or WebP file give, or null (another kind, or the header is not in what was read). It tells the maker whether the decoder has to
 * scale a big photo down while it decodes, or whether the picture is small already.
 */
export function readSize(b: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (at: number, s: string) => at + s.length <= b.length && [...s].every((c, n) => b[at + n] === c.charCodeAt(0));
  if (b.length > 24 && b[0] === 0x89 && tag(1, 'PNG')) return { w: v.getUint32(16), h: v.getUint32(20) };
  if (b.length > 10 && (tag(0, 'GIF87a') || tag(0, 'GIF89a'))) return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
  if (b.length > 30 && tag(0, 'RIFF') && tag(8, 'WEBP')) {
    if (tag(12, 'VP8X')) return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (tag(12, 'VP8L') && b[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (tag(12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { w: v.getUint16(26, true) & 0x3fff, h: v.getUint16(28, true) & 0x3fff };
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1]!;
      if (marker === 0xff) {
        at++;
        continue;
      }
      const length = v.getUint16(at + 2);
      // the start-of-frame markers hold the size (not the tables that share their numbers: C4, C8, CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: v.getUint16(at + 7), h: v.getUint16(at + 5) };
      if (length < 2) return null;
      at += 2 + length;
    }
  }
  return null;
}
