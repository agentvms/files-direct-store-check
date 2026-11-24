/** Wire format of the data channel. See docs/PROTOCOL.md. No page dependencies: this runs in a worker. */

export const PIECE_HEADER_BYTES = 16;
export const DIGEST_BYTES = 32;

export interface FileInfo {
  i: number;
  /** The path the person sees, folders included ("photos/2024/a.jpg"). Cleaned by the receiver before use. */
  name: string;
  size: number;
  type: string;
}

/** Frames every one of which names its batch, `b`. Batch numbers are odd for one side and even for the other. */
export type Control =
  | {
      t: 'manifest';
      b: number;
      blockSize: number;
      files: FileInfo[];
      /** 2: this sender waits for the receiver's yes. Pages that predate it leave it out. */
      v?: number;
      /**
       * A request for files instead of an offer (files-direct-28): no files, no `v`, and the asker's optional note. A page from before it answers any manifest
       * without `v: 2` with `cancel` and its own "out of date" notice, which is exactly the old page's path; a current page answers `asking` and shows the request.
       */
      ask?: { note?: string };
    }
  /** Announces the next block of file i; its pieces follow. `h` is the block's SHA-256, hex. */
  | { t: 'block'; b: number; i: number; k: number; h: string }
  /** After the last block of a file: how many blocks, and the fingerprint (SHA-256 over every block's digest, in order), hex. */
  | { t: 'end'; b: number; i: number; blocks: number; fp: string }
  /** From the receiver: block k is checked and written. */
  | { t: 'ack'; b: number; i: number; k: number }
  /** From the receiver: send block k again. */
  | { t: 'again'; b: number; i: number; k: number }
  /** From the receiver: the whole file was read back and checked. */
  | { t: 'fileok'; b: number; i: number }
  /** From the receiver: the file could not be made right. */
  | { t: 'failed'; b: number; i: number; /** "storage": the receiving device could not keep the data (no room left). */ why?: 'storage' }
  /** From the receiver: every file in the batch is checked and complete. */
  | { t: 'ok'; b: number }
  /**
   * From the receiver: the manifest is read and the person is being asked. Tells the sender this page waits for a yes.
   * `pv: 1` (files-direct-32): this page can show small previews of photos, so the sender may send them now. A page that predates it never says so and never gets one.
   */
  | { t: 'asking'; b: number; pv?: 1 }
  /**
   * From the sender, after the manifest and before the answer, only to a receiver that said `pv`: a small picture of file `i` (a photo), one frame each, the whole frame at most PIECE_SIZE.
   * `data` is the picture, base64. The receiver drops anything out of bounds without a word (docs/PROTOCOL.md, "Previews").
   */
  | { t: 'preview'; b: number; i: number; type: string; w: number; h: number; data: string }
  /** From the receiver: yes, send this batch. Nothing is sent before it. */
  | { t: 'accept'; b: number }
  /** From the receiver: no thanks. Nothing was sent. */
  | { t: 'decline'; b: number }
  | { t: 'pause'; b: number }
  | { t: 'resume'; b: number }
  | { t: 'cancel'; b: number };

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Fingerprint of a file: SHA-256 over the digests of its blocks, in order. (The built-in digest cannot hash a stream.) */
export async function fingerprint(digests: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(digests.length * DIGEST_BYTES);
  digests.forEach((d, n) => all.set(d, n * DIGEST_BYTES));
  return sha256(all);
}

/** A piece: 16-byte header (u32 batch, file, block, offset inside the block; big endian), then up to PIECE_SIZE bytes. */
export function encodePiece(b: number, i: number, k: number, offset: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(PIECE_HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, b);
  view.setUint32(4, i);
  view.setUint32(8, k);
  view.setUint32(12, offset);
  out.set(payload, PIECE_HEADER_BYTES);
  return out.buffer;
}

export interface Piece {
  b: number;
  i: number;
  k: number;
  offset: number;
  payload: Uint8Array;
}

/** Returns null when the frame is too short to hold a header. */
export function decodePiece(frame: ArrayBuffer): Piece | null {
  if (frame.byteLength < PIECE_HEADER_BYTES) return null;
  const view = new DataView(frame);
  return {
    b: view.getUint32(0),
    i: view.getUint32(4),
    k: view.getUint32(8),
    offset: view.getUint32(12),
    payload: new Uint8Array(frame, PIECE_HEADER_BYTES),
  };
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The last path segment: what a saved file is called. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
