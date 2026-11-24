/**
 * The transfer loop, both directions, one protocol (docs/PROTOCOL.md). No page dependencies: it runs in a worker
 * and is tested in node with a stand-in channel. A Session is one data channel; every frame names its batch, so a
 * batch each way can run at once.
 */
import { BLOCK_SIZE, HIGH_WATER, LOW_WATER, MAX_BLOCK_SIZE, MAX_BLOCK_TRIES, PIECE_SIZE, PREVIEW_ONE_MS, PREVIEW_TOTAL_MS, WINDOW_BLOCKS, previewLimits, type PreviewLimits } from '../../../shared/config.ts';
import { cleanNote } from '../../../shared/ask.ts';
import { type Control, type FileInfo, DIGEST_BYTES, decodePiece, encodePiece, fingerprint, fromHex, sameBytes, sha256, toHex } from './frames.ts';
import { Meter } from './meter.ts';
import { cleanPaths } from './paths.ts';
import { type PreviewImage, fromBase64, isPreviewKind, isPreviewSource, isPreviewType, looksLike, toBase64 } from './preview.ts';
import { BlockRecord } from './record.ts';
import type { BlockSink, SinkFactory } from './sink.ts';

/** Marks the engine in a build: the page's own script must not contain it (the loop runs in a worker). */
export const ENGINE_MARK = 'fd-transfer-engine';

/** The part of a data channel the loop uses, so tests and the worker can stand in for it. */
export interface ChannelLike {
  send(data: string | ArrayBuffer): void;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  readonly readyState: string;
  addEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void;
}

export interface Sendable {
  /** The path the person sees. */
  name: string;
  size: number;
  type: string;
  /** The file itself, where the browser can read it as a picture (a preview is made from it). */
  blob?: Blob;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export type Side = 'local' | 'remote';
export type Direction = 'out' | 'in';

/** What the loop tells whoever draws the screen. Plain data, so it can cross from a worker. */
export type TransferEvent =
  | { k: 'started'; b: number; dir: Direction; files: { i: number; name: string; size: number }[]; storage: 'disk' | 'memory' }
  | { k: 'progress'; b: number; dir: Direction; i: number; fileDone: number; fileSize: number; done: number; total: number; speed: number; eta: number | null }
  | { k: 'file-ready'; b: number; i: number; blob: Blob }
  | { k: 'file-sent'; b: number; i: number }
  | { k: 'file-failed'; b: number; dir: Direction; i: number; name: string; why?: 'storage' }
  | { k: 'refetched'; b: number; dir: Direction }
  | { k: 'paused' | 'resumed' | 'cancelled'; b: number; dir: Direction; by: Side }
  | { k: 'complete'; b: number; dir: Direction }
  /** Receiver: a batch was offered and nothing moves until the person accepts or declines it. */
  | { k: 'offered'; b: number; files: number; bytes: number }
  /** Receiver: a small picture of file `i` came with the offer, inside the limits (the page still checks that it draws). Plain data, never sent anywhere but to the screen. */
  | { k: 'preview'; b: number; i: number; blob: Blob; w: number; h: number }
  /** The other side is asking this one for files. `note` is what the asker wrote, cleaned here like a file name ("" when there is none). Nothing is sent until the person picks files. */
  | { k: 'asked'; b: number; note: string }
  /** Sender: the other side said no thanks. Nothing was sent. */
  | { k: 'declined'; b: number; by: Side }
  /** The other side sent something that makes no sense, or the channel was lost while sending. */
  | { k: 'error'; why: 'unreadable' | 'lost' | 'refresh'; b?: number; /** Where in the loop it was noticed: for tests and bug reports, never shown. */ site?: string };

export interface SessionOptions {
  channel: ChannelLike;
  sinks: SinkFactory;
  emit(e: TransferEvent): void;
  /** Batch numbers this side hands out: 1, 3, 5... (the side that opened the room) or 2, 4, 6... */
  odd: boolean;
  /** Receiver: wait for `accept(b)` or `decline(b)` before taking a batch. Off (take at once) is for engine tests. */
  ask?: boolean;
  /** Receiver: this page can show small previews of photos, so it says so to the sender (`pv` on `asking`) and takes the ones that come. Needs `ask`. */
  previews?: boolean;
  /** Sender: makes the small picture of a file for a receiver that takes them, or gives null (it cannot be decoded, it is too big, ...). Runs one file at a time. */
  makePreview?: (src: Sendable, limits: PreviewLimits) => Promise<PreviewImage | null>;
  /** This connection goes through our servers: previews stay tiny. Can change later (setRelay). */
  relay?: boolean;
  blockSize?: number;
  window?: number;
  now?: () => number;
  /** Sender: runs a function later and returns how to cancel it. Used to notice a receiver page that never answers (the loop itself has no timers). */
  after?: (fn: () => void, ms: number) => () => void;
}

const PROGRESS_EVERY_MS = 100;
const MAX_FILES = 100_000;
/** How long a sent batch may go without any answer from the other page before that page is called out of date. */
const HELLO_MS = 8000;

interface OutFile {
  src: Sendable;
  blocks: number;
  hashes: Uint8Array[];
  sentBlocks: Set<number>;
  state: 'sending' | 'ended' | 'ok' | 'failed';
  sentBytes: number;
}

interface OutBatch {
  b: number;
  files: OutFile[];
  blockSize: number;
  nextFile: number;
  nextBlock: number;
  pending: Set<string>;
  resend: [number, number][];
  paused: { local: boolean; remote: boolean };
  sent: number;
  total: number;
  meter: Meter;
  lastEmit: number;
  dead: boolean;
  /** Nothing is sent until the receiver says yes. */
  accepted: boolean;
  /** The receiver's page said it is asking its person (a page that predates the question never says so). */
  asked: boolean;
  /** Previews are being made for this batch (the receiver said it takes them). */
  previewing: boolean;
}

/** A request for files this side made: it is answered when the other page says it is showing it. */
interface Ask {
  acked: boolean;
}

interface InFile {
  info: FileInfo;
  blocks: number;
  record: BlockRecord;
  hashes: Uint8Array[];
  counted: Set<number>;
  awaiting: Set<number>;
  tries: number[];
  end: { blocks: number; fp: Uint8Array } | null;
  sink: Promise<BlockSink> | null;
  state: 'receiving' | 'verifying' | 'ok' | 'failed';
  checked: boolean;
  recheck: Set<number>;
  got: number;
  /** A preview of this file was taken. */
  previewed: boolean;
}

interface InBatch {
  b: number;
  files: InFile[];
  blockSize: number;
  paused: { local: boolean; remote: boolean };
  received: number;
  total: number;
  meter: Meter;
  lastEmit: number;
  dead: boolean;
  /** This side has said yes (at once when it does not ask). Until then nothing of the batch is taken. */
  accepted: boolean;
  /** Previews taken so far (at most the route's count). */
  previews: number;
}

interface Assembling {
  batch: InBatch;
  file: InFile;
  k: number;
  buf: Uint8Array;
  got: number;
  digest: Uint8Array;
  /** The first time this block arrives: only then do its bytes count towards progress. */
  first: boolean;
}

export class Session {
  /** Largest buffer the receiving side held at once, for tests that watch memory. */
  readonly stats = { maxHeld: 0 };
  private readonly ch: ChannelLike;
  private readonly sinks: SinkFactory;
  private readonly emit: (e: TransferEvent) => void;
  private readonly blockSize: number;
  private readonly ask: boolean;
  private readonly previews: boolean;
  private readonly makePreview: SessionOptions['makePreview'];
  private relay: boolean;
  private readonly window: number;
  private readonly now: () => number;
  private nextBatch: number;
  private out = new Map<number, OutBatch>();
  private inn = new Map<number, InBatch>();
  private asks = new Map<number, Ask>();
  private gone = new Set<number>();
  private cur: Assembling | null = null;
  private chain: Promise<void> = Promise.resolve();
  private tasks = new Set<Promise<void>>();
  private closed = false;
  private pumping = false;
  private rr = 0;
  private waiters: (() => void)[] = [];
  private timers = new Set<() => void>();
  private after: SessionOptions['after'];

  constructor(o: SessionOptions) {
    this.ch = o.channel;
    this.sinks = o.sinks;
    this.emit = o.emit;
    this.blockSize = o.blockSize ?? BLOCK_SIZE;
    this.ask = o.ask ?? false;
    this.previews = (o.previews ?? false) && this.ask;
    this.makePreview = o.makePreview;
    this.relay = o.relay ?? false;
    this.after = o.after;
    this.window = o.window ?? WINDOW_BLOCKS;
    this.now = o.now ?? (() => Date.now());
    this.nextBatch = o.odd ? 1 : 2;
    this.ch.bufferedAmountLowThreshold = LOW_WATER;
    this.ch.addEventListener('bufferedamountlow', () => this.wake());
    this.ch.addEventListener('close', () => {
      this.closed = true;
      this.wake();
    });
  }

  // ---- the page's side of the API ------------------------------------------------------------

  /** Starts a batch to the other side. Returns its number. */
  send(files: Sendable[]): number {
    const b = this.nextBatch;
    this.nextBatch += 2;
    const outFiles: OutFile[] = files.map((src) => ({
      src,
      blocks: Math.ceil(src.size / this.blockSize),
      hashes: [],
      sentBlocks: new Set(),
      state: 'sending',
      sentBytes: 0,
    }));
    const batch: OutBatch = {
      b,
      files: outFiles,
      blockSize: this.blockSize,
      nextFile: 0,
      nextBlock: 0,
      pending: new Set(),
      resend: [],
      paused: { local: false, remote: false },
      sent: 0,
      total: files.reduce((n, f) => n + f.size, 0),
      meter: new Meter(this.now),
      lastEmit: 0,
      dead: false,
      accepted: false,
      asked: false,
      previewing: false,
    };
    this.out.set(b, batch);
    const infos: FileInfo[] = files.map((f, i) => ({ i, name: f.name, size: f.size, type: f.type }));
    this.emit({ k: 'started', b, dir: 'out', files: infos.map(({ i, name, size }) => ({ i, name, size })), storage: this.sinks.kind });
    this.control({ t: 'manifest', b, blockSize: this.blockSize, files: infos, v: 2 });
    // a receiver page from before the question never answers: say so instead of waiting for ever
    if (this.after)
      this.timers.add(
        this.after(() => {
          if (!batch.accepted && !batch.asked && !batch.dead && !this.closed) this.emit({ k: 'error', why: 'refresh', b, site: 'old-receiver' });
        }, HELLO_MS),
      );
    if (files.length === 0) this.finishOutIfDone(batch);
    this.pump();
    return b;
  }

  /**
   * Asks the other side for files (files-direct-28). Takes a batch number like a batch does (the other side's answer, a batch of its own, comes with its own numbers).
   * The note is cleaned and cut here too, so the frame stays small; the other side cleans it again. Returns the number.
   */
  askFor(note = ''): number {
    const b = this.nextBatch;
    this.nextBatch += 2;
    const ask: Ask = { acked: false };
    this.asks.set(b, ask);
    const text = cleanNote(note);
    this.control({ t: 'manifest', b, blockSize: this.blockSize, files: [], ask: text ? { note: text } : {} });
    // a page from before the request answers with `cancel` at once; one that says nothing at all gets the same words after the usual wait
    if (this.after)
      this.timers.add(
        this.after(() => {
          if (this.asks.get(b) === ask && !ask.acked && !this.closed) {
            this.asks.delete(b);
            this.emit({ k: 'error', why: 'refresh', b, site: 'old-receiver' });
          }
        }, HELLO_MS),
      );
    return b;
  }

  /** The connection now goes through our servers (or no longer does): the limits of previews that come after follow. */
  setRelay(on: boolean): void {
    this.relay = on;
  }

  pause(b: number): void {
    this.setPaused(b, 'local', true);
  }

  resume(b: number): void {
    this.setPaused(b, 'local', false);
  }

  /** The person said yes to an offered batch: the sender may start. */
  accept(b: number): void {
    const batch = this.inn.get(b);
    if (!batch || batch.accepted || batch.dead) return;
    batch.accepted = true;
    this.control({ t: 'accept', b });
  }

  /** The person said no thanks: tell the sender and drop the batch. Nothing was received. */
  decline(b: number): void {
    const batch = this.inn.get(b);
    if (!batch || batch.accepted || batch.dead) return;
    this.control({ t: 'decline', b });
    batch.dead = true;
    this.gone.add(b);
    this.inn.delete(b);
    this.emit({ k: 'declined', b, by: 'local' });
  }

  /** Stops a batch on both sides and frees what it holds. */
  cancel(b: number): void {
    this.cancelBatch(b, 'local');
  }

  /** Call for every message that arrives, in arrival order. */
  handle(data: string | ArrayBuffer): void {
    this.chain = this.chain.then(() => this.process(data)).catch((e: unknown) => this.violation(undefined, 'v1 ' + String(e)));
  }

  /** Resolves when everything handed to `handle` so far, and the checks it started, has been dealt with. */
  async idle(): Promise<void> {
    for (;;) {
      const before = this.chain;
      await before;
      await Promise.all([...this.tasks]);
      if (before === this.chain && this.tasks.size === 0) return;
    }
  }

  /** The channel is gone: stop, and free everything. */
  async close(): Promise<void> {
    this.closed = true;
    this.timers.forEach((cancel) => cancel());
    this.timers.clear();
    this.wake();
    // files already verified stay: the person may still be saving them after the sender has left
    for (const b of this.inn.values()) await this.disposeIn(b, true);
    this.inn.clear();
    this.out.clear();
  }

  // ---- sending --------------------------------------------------------------------------------

  private control(msg: Control): void {
    if (this.ch.readyState === 'open') this.ch.send(JSON.stringify(msg));
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.ch.readyState === 'open' && this.ch.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.closed || this.ch.readyState !== 'open') throw new Error('channel-closed');
  }

  private pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    void (async () => {
      try {
        for (;;) {
          const job = this.pickJob();
          if (!job) break;
          await this.sendBlock(job.batch, job.i, job.k);
        }
      } catch {
        if (!this.closed) this.emit({ k: 'error', why: 'lost' });
      } finally {
        this.pumping = false;
      }
    })();
  }

  private pickJob(): { batch: OutBatch; i: number; k: number } | null {
    const list = [...this.out.values()];
    for (let n = 0; n < list.length; n++) {
      const batch = list[(this.rr + n) % list.length]!;
      const job = this.nextOf(batch);
      if (job) {
        this.rr = (this.rr + n + 1) % list.length;
        return { batch, ...job };
      }
    }
    return null;
  }

  private nextOf(batch: OutBatch): { i: number; k: number } | null {
    if (batch.dead || !batch.accepted || batch.paused.local || batch.paused.remote) return null;
    while (batch.resend.length) {
      const [i, k] = batch.resend.shift()!;
      if (batch.files[i]?.state !== 'failed') return { i, k };
    }
    while (batch.nextFile < batch.files.length) {
      const i = batch.nextFile;
      const f = batch.files[i]!;
      if (f.state === 'failed' || batch.nextBlock >= f.blocks) {
        if (f.state === 'sending') {
          f.state = 'ended';
          void this.sendEnd(batch, i);
        }
        batch.nextFile++;
        batch.nextBlock = 0;
        continue;
      }
      if (batch.pending.size >= this.window) return null;
      const k = batch.nextBlock++;
      batch.pending.add(`${i}:${k}`);
      return { i, k };
    }
    return null;
  }

  private async sendEnd(batch: OutBatch, i: number): Promise<void> {
    const f = batch.files[i]!;
    const fp = await fingerprint(f.hashes);
    this.control({ t: 'end', b: batch.b, i, blocks: f.blocks, fp: toHex(fp) });
  }

  private async sendBlock(batch: OutBatch, i: number, k: number): Promise<void> {
    const f = batch.files[i]!;
    const start = k * batch.blockSize;
    const payload = new Uint8Array(await f.src.slice(start, Math.min(start + batch.blockSize, f.src.size)).arrayBuffer());
    const digest = (f.hashes[k] ??= await sha256(payload));
    if (batch.dead || f.state === 'failed') return;
    await this.drain();
    this.control({ t: 'block', b: batch.b, i, k, h: toHex(digest) });
    const first = !f.sentBlocks.has(k);
    f.sentBlocks.add(k);
    for (let off = 0; off < payload.length; off += PIECE_SIZE) {
      await this.drain();
      if (batch.dead) return;
      const piece = payload.subarray(off, Math.min(off + PIECE_SIZE, payload.length));
      this.ch.send(encodePiece(batch.b, i, k, off, piece));
      if (first) {
        f.sentBytes += piece.length;
        batch.sent += piece.length;
        this.tickOut(batch, i, false);
      }
    }
    if (first) this.tickOut(batch, i, true);
  }

  private tickOut(batch: OutBatch, i: number, force: boolean): void {
    const at = this.now();
    if (!force && at - batch.lastEmit < PROGRESS_EVERY_MS) return;
    batch.lastEmit = at;
    batch.meter.add(batch.sent);
    const f = batch.files[i]!;
    const r = batch.meter.read(batch.total - batch.sent);
    this.emit({ k: 'progress', b: batch.b, dir: 'out', i, fileDone: f.sentBytes, fileSize: f.src.size, done: batch.sent, total: batch.total, ...r });
  }

  private finishOutIfDone(batch: OutBatch): void {
    // an empty batch has nothing to wait for
    if (batch.files.length === 0) this.emit({ k: 'complete', b: batch.b, dir: 'out' });
  }

  // ---- what arrives ---------------------------------------------------------------------------

  private violation(b?: number, site = '?'): void {
    const batch = b === undefined ? undefined : this.inn.get(b);
    if (batch) void this.disposeIn(batch);
    this.emit({ k: 'error', why: 'unreadable', b, site });
  }

  private async process(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      const msg = JSON.parse(data) as Control;
      // a preview frame is at most a piece as a whole, whatever else it carries (padding, extra properties): a bigger one is dropped like any out-of-bounds preview
      if (msg.t === 'preview' && new TextEncoder().encode(data).length > PIECE_SIZE) return;
      return this.processControl(msg);
    }
    const piece = decodePiece(data);
    const cur = this.cur;
    if (!piece) return this.violation(undefined, 'v2');
    if (!cur) {
      // pieces of a batch that was just cancelled may still be on their way
      if (this.gone.has(piece.b)) return;
      return this.violation(piece.b, 'v3');
    }
    if (cur.batch.dead) {
      this.cur = null;
      return;
    }
    const room = cur.buf.length - cur.got;
    if (piece.b !== cur.batch.b || piece.i !== cur.file.info.i || piece.k !== cur.k || piece.offset !== cur.got || piece.payload.length > PIECE_SIZE || piece.payload.length > room || piece.payload.length === 0) {
      return this.violation(cur.batch.b, 'v4');
    }
    cur.buf.set(piece.payload, cur.got);
    cur.got += piece.payload.length;
    if (cur.first && cur.file.state !== 'failed') {
      cur.batch.received += piece.payload.length;
      cur.file.got += piece.payload.length;
      this.tickIn(cur.batch, cur.file, false);
    }
    if (cur.got === cur.buf.length) {
      this.cur = null;
      await this.finishBlock(cur);
    }
  }

  private async processControl(msg: Control): Promise<void> {
    switch (msg.t) {
      case 'manifest':
        return this.onManifest(msg);
      case 'block':
        return this.onBlockHeader(msg);
      case 'end':
        return this.onEnd(msg);
      case 'ack':
        return this.onAck(msg);
      case 'again':
        return this.onAgain(msg);
      case 'fileok':
        return this.onFileOk(msg);
      case 'failed':
        return this.onFileFailed(msg);
      case 'ok':
        return this.onBatchOk(msg);
      case 'asking': {
        const ask = this.asks.get(msg.b);
        if (ask) {
          ask.acked = true;
          return;
        }
        const batch = this.out.get(msg.b);
        if (batch) {
          batch.asked = true;
          if (msg.pv === 1) this.startPreviews(batch);
        } else if (!this.gone.has(msg.b)) this.violation(undefined, 'v18');
        return;
      }
      case 'preview':
        return this.onPreview(msg);
      case 'accept':
        return this.onAccept(msg);
      case 'decline':
        return this.onDecline(msg);
      case 'pause':
        return this.setPaused(msg.b, 'remote', true);
      case 'resume':
        return this.setPaused(msg.b, 'remote', false);
      case 'cancel':
        return this.cancelBatch(msg.b, 'remote');
      default:
        return this.violation(undefined, 'v5');
    }
  }

  /** The other side asks for files: nothing to take, only to show. The number is used up, so no frame may follow for it. */
  private onAsked(m: Extract<Control, { t: 'manifest' }>): void {
    if (!Number.isInteger(m.b) || this.inn.has(m.b) || this.out.has(m.b) || this.gone.has(m.b) || this.asks.has(m.b)) return this.violation(undefined, 'v21');
    this.gone.add(m.b);
    this.control({ t: 'asking', b: m.b });
    this.emit({ k: 'asked', b: m.b, note: cleanNote(m.ask && typeof m.ask === 'object' ? m.ask.note : undefined) });
  }

  private onManifest(m: Extract<Control, { t: 'manifest' }>): void {
    if (m.ask !== undefined) return this.onAsked(m);
    if (this.ask && m.v !== 2 && Number.isInteger(m.b) && !this.inn.has(m.b) && !this.gone.has(m.b)) {
      // a sender page from before the question would send without waiting: take nothing, and say why
      this.gone.add(m.b);
      this.control({ t: 'cancel', b: m.b });
      return this.emit({ k: 'error', why: 'refresh', b: m.b, site: 'old-sender' });
    }
    const sane =
      Number.isInteger(m.b) && !this.inn.has(m.b) && !this.out.has(m.b) && !this.gone.has(m.b) &&
      Number.isInteger(m.blockSize) && m.blockSize > 0 && m.blockSize <= MAX_BLOCK_SIZE &&
      Array.isArray(m.files) && m.files.length <= MAX_FILES &&
      m.files.every((f, n) => f && f.i === n && typeof f.name === 'string' && Number.isSafeInteger(f.size) && f.size >= 0 && typeof f.type === 'string');
    if (!sane) return this.violation(undefined, 'v6');
    const names = cleanPaths(m.files.map((f) => f.name));
    const files: InFile[] = m.files.map((f, n) => {
      const blocks = Math.ceil(f.size / m.blockSize);
      return {
        info: { i: n, name: names[n]!, size: f.size, type: f.type },
        blocks,
        record: new BlockRecord(blocks),
        hashes: [],
        counted: new Set(),
        awaiting: new Set(),
        tries: [],
        end: null,
        sink: null,
        state: 'receiving',
        checked: false,
        recheck: new Set(),
        got: 0,
        previewed: false,
      };
    });
    const batch: InBatch = {
      b: m.b,
      files,
      blockSize: m.blockSize,
      paused: { local: false, remote: false },
      received: 0,
      total: files.reduce((n, f) => n + f.info.size, 0),
      meter: new Meter(this.now),
      lastEmit: 0,
      dead: false,
      accepted: !this.ask,
      previews: 0,
    };
    this.inn.set(m.b, batch);
    this.emit({ k: 'started', b: m.b, dir: 'in', files: files.map((f) => ({ i: f.info.i, name: f.info.name, size: f.info.size })), storage: this.sinks.kind });
    if (this.ask) {
      this.control(this.previews ? { t: 'asking', b: m.b, pv: 1 } : { t: 'asking', b: m.b });
      this.emit({ k: 'offered', b: m.b, files: files.length, bytes: batch.total });
    } else this.control({ t: 'accept', b: m.b });
  }

  /**
   * A small picture of a photo of the offered batch. Anything out of bounds is dropped without a word: it is not a reason to stop the batch, and it never shows as an error.
   * (A batch this side does not know, one already answered, a file that is not a photo in the manifest, a second picture of one file, more than the route's count, a kind not on the list,
   * a picture over the route's size or byte limit, something that is not what its type says.)
   */
  private onPreview(m: Extract<Control, { t: 'preview' }>): void {
    if (!this.previews) return;
    const batch = this.inn.get(m.b);
    if (!batch || batch.dead || batch.accepted) return;
    const limits = previewLimits(this.relay);
    const file = Number.isSafeInteger(m.i) ? batch.files[m.i] : undefined;
    if (!file || file.previewed || batch.previews >= limits.count || !isPreviewKind(file.info.type)) return;
    if (!isPreviewType(m.type) || !Number.isSafeInteger(m.w) || !Number.isSafeInteger(m.h) || m.w < 1 || m.h < 1 || m.w > limits.edge || m.h > limits.edge) return;
    if (typeof m.data !== 'string' || m.data.length > PIECE_SIZE) return;
    const bytes = fromBase64(m.data);
    if (!bytes || bytes.length === 0 || bytes.length > limits.bytes || !looksLike(m.type, bytes)) return;
    file.previewed = true;
    batch.previews++;
    this.emit({ k: 'preview', b: m.b, i: m.i, blob: new Blob([bytes as BlobPart], { type: m.type }), w: m.w, h: m.h });
  }

  /**
   * The receiver takes previews: make them, one file at a time, and send each as it is ready. It runs beside everything else and nothing waits on it; it stops at the answer
   * (a preview after the yes is dropped by the other side anyway), at the cap, or when time is up (PREVIEW_TOTAL_MS; PREVIEW_ONE_MS for one picture).
   */
  private startPreviews(batch: OutBatch): void {
    const make = this.makePreview;
    if (!make || batch.previewing || batch.dead || batch.accepted) return;
    batch.previewing = true;
    const over = () => batch.dead || batch.accepted || this.closed;
    const task = (async () => {
      let timeUp = false;
      const stop = this.after?.(() => (timeUp = true), PREVIEW_TOTAL_MS);
      let sent = 0;
      let tried = 0;
      try {
        for (const [i, f] of batch.files.entries()) {
          const limits = previewLimits(this.relay);
          if (over() || timeUp || sent >= limits.count || tried >= limits.count * 3) break;
          if (f.state === 'failed' || !isPreviewSource(f.src.type, f.src.size)) continue;
          tried++;
          const image = await this.within(make(f.src, limits).catch(() => null), PREVIEW_ONE_MS);
          const now = previewLimits(this.relay); // the route may have changed while the picture was made
          if (over() || timeUp || !image || !isPreviewType(image.type) || image.bytes.length === 0 || image.bytes.length > now.bytes || image.w > now.edge || image.h > now.edge || image.w < 1 || image.h < 1) continue;
          const frame = JSON.stringify({ t: 'preview', b: batch.b, i, type: image.type, w: image.w, h: image.h, data: toBase64(image.bytes) } satisfies Control);
          if (frame.length > PIECE_SIZE) continue;
          await this.drain();
          if (over()) break;
          if (this.ch.readyState === 'open') this.ch.send(frame);
          sent++;
        }
      } catch {
        // a preview is never worth a failure: whatever went wrong, there is simply no picture
      } finally {
        stop?.();
      }
    })().finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  /** What `work` gives, or null once `ms` have passed (where this session has a timer). */
  private within<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
    if (!this.after) return work;
    return new Promise((resolve) => {
      const cancel = this.after!(() => resolve(null), ms);
      void work.then(
        (v) => {
          cancel();
          resolve(v);
        },
        () => {
          cancel();
          resolve(null);
        },
      );
    });
  }

  private onAccept(m: Extract<Control, { t: 'accept' }>): void {
    const batch = this.out.get(m.b);
    if (!batch || batch.dead) return this.gone.has(m.b) ? undefined : this.violation(undefined, 'v12');
    batch.accepted = true;
    this.pump();
  }

  private onDecline(m: Extract<Control, { t: 'decline' }>): void {
    const batch = this.out.get(m.b);
    if (!batch || batch.dead) return this.gone.has(m.b) ? undefined : this.violation(undefined, 'v13');
    batch.dead = true;
    this.gone.add(m.b);
    this.out.delete(m.b);
    this.emit({ k: 'declined', b: m.b, by: 'remote' });
  }

  private onBlockHeader(m: Extract<Control, { t: 'block' }>): void {
    if (this.gone.has(m.b) && !this.inn.has(m.b)) return;
    const batch = this.inn.get(m.b);
    const file = batch?.files[m.i];
    const digest = typeof m.h === 'string' ? fromHex(m.h) : null;
    if (!batch || !file || batch.dead || this.cur || !digest || digest.length !== DIGEST_BYTES) return this.violation(m.b, 'v7');
    if (!batch.accepted) return this.violation(m.b, 'v19'); // nothing is taken before the yes
    if (!Number.isInteger(m.k) || m.k < 0 || m.k >= file.blocks) return this.violation(m.b, 'v8');
    // a block arrives once, or again after it was asked for; a file already given up on still drains what is on the way
    if (file.state !== 'failed' && (file.record.has(m.k) || (file.hashes[m.k] && !file.awaiting.has(m.k)))) return this.violation(m.b, 'v9');
    const first = !file.counted.has(m.k);
    file.counted.add(m.k);
    const len = Math.min(batch.blockSize, file.info.size - m.k * batch.blockSize);
    file.awaiting.delete(m.k);
    file.hashes[m.k] = digest;
    this.stats.maxHeld = Math.max(this.stats.maxHeld, len);
    this.cur = { batch, file, k: m.k, buf: new Uint8Array(len), got: 0, digest, first };
  }

  private sinkOf(file: InFile): Promise<BlockSink> {
    return (file.sink ??= this.sinks.create(file.info.size));
  }

  private async finishBlock(c: Assembling): Promise<void> {
    const { batch, file, k } = c;
    if (file.state === 'failed') return;
    const ok = sameBytes(await sha256(c.buf), c.digest);
    if (batch.dead) return;
    if (!ok) return this.askAgain(batch, file, k);
    try {
      await (await this.sinkOf(file)).writeAt(k * batch.blockSize, c.buf);
    } catch {
      // the device could not keep it (usually: no room left)
      return this.failFile(batch, file, 'storage');
    }
    if (batch.dead) return;
    file.record.set(k);
    this.control({ t: 'ack', b: batch.b, i: file.info.i, k });
    this.tickIn(batch, file, true);
    if (file.checked) file.recheck.add(k);
    this.maybeVerify(batch, file);
  }

  /** A block failed a check: ask for it again, or give the file up after the limit. */
  private askAgain(batch: InBatch, file: InFile, k: number): void {
    file.tries[k] = (file.tries[k] ?? 0) + 1;
    if (file.tries[k]! >= MAX_BLOCK_TRIES) return this.failFile(batch, file);
    this.requestAgain(batch, file, k);
  }

  private requestAgain(batch: InBatch, file: InFile, k: number): void {
    file.record.clear(k);
    file.awaiting.add(k);
    this.control({ t: 'again', b: batch.b, i: file.info.i, k });
    this.emit({ k: 'refetched', b: batch.b, dir: 'in' });
  }

  private onEnd(m: Extract<Control, { t: 'end' }>): void {
    const batch = this.inn.get(m.b);
    const file = batch?.files[m.i];
    const fp = typeof m.fp === 'string' ? fromHex(m.fp) : null;
    if (!batch || !file || batch.dead) return this.gone.has(m.b) ? undefined : this.violation(m.b, 'v10');
    if (!batch.accepted) return this.violation(m.b, 'v20');
    if (file.state === 'failed') return;
    if (m.blocks !== file.blocks || !fp || fp.length !== DIGEST_BYTES || file.end) return this.violation(m.b, 'v11');
    file.end = { blocks: m.blocks, fp };
    this.maybeVerify(batch, file);
  }

  /** Once the end is known and every block is written: read the file back, block by block, and check it. */
  private maybeVerify(batch: InBatch, file: InFile): void {
    if (!file.end || file.state !== 'receiving' || !file.record.complete() || this.cur?.file === file) return;
    file.state = 'verifying';
    const task = this.verify(batch, file)
      .catch(() => this.failFile(batch, file))
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private async verify(batch: InBatch, file: InFile): Promise<void> {
    const sink = await this.sinkOf(file);
    const wanted = file.checked ? [...file.recheck] : Array.from({ length: file.blocks }, (_, k) => k);
    file.recheck.clear();
    const bad: number[] = [];
    for (const k of wanted) {
      if (batch.dead) return;
      const start = k * batch.blockSize;
      const bytes = await sink.readAt(start, Math.min(batch.blockSize, file.info.size - start));
      this.stats.maxHeld = Math.max(this.stats.maxHeld, bytes.length);
      if (!sameBytes(await sha256(bytes), file.hashes[k]!)) bad.push(k);
    }
    if (batch.dead) return;
    file.checked = true;
    if (bad.length) {
      file.state = 'receiving';
      for (const k of bad) {
        file.tries[k] = (file.tries[k] ?? 0) + 1;
        if (file.tries[k]! >= MAX_BLOCK_TRIES) return this.failFile(batch, file);
      }
      for (const k of bad) this.requestAgain(batch, file, k);
      return;
    }
    if (!sameBytes(await fingerprint(file.hashes), file.end!.fp)) return this.failFile(batch, file);
    const blob = await sink.file(file.info.type);
    if (batch.dead) return;
    file.state = 'ok';
    this.control({ t: 'fileok', b: batch.b, i: file.info.i });
    this.emit({ k: 'file-ready', b: batch.b, i: file.info.i, blob });
    if (batch.files.every((f) => f.state === 'ok')) {
      this.control({ t: 'ok', b: batch.b });
      this.emit({ k: 'complete', b: batch.b, dir: 'in' });
    }
  }

  private failFile(batch: InBatch, file: InFile, why?: 'storage'): void {
    if (file.state === 'failed') return;
    file.state = 'failed';
    this.control({ t: 'failed', b: batch.b, i: file.info.i, why });
    this.emit({ k: 'file-failed', b: batch.b, dir: 'in', i: file.info.i, name: file.info.name, why });
    if (this.cur?.file === file) this.cur = null;
    void file.sink?.then((s) => s.dispose()).catch(() => {});
  }

  private tickIn(batch: InBatch, file: InFile, force: boolean): void {
    const at = this.now();
    if (!force && at - batch.lastEmit < PROGRESS_EVERY_MS) return;
    batch.lastEmit = at;
    batch.meter.add(batch.received);
    const r = batch.meter.read(batch.total - batch.received);
    this.emit({ k: 'progress', b: batch.b, dir: 'in', i: file.info.i, fileDone: file.got, fileSize: file.info.size, done: batch.received, total: batch.total, ...r });
  }

  // ---- the sender hears back ------------------------------------------------------------------

  private outFile(m: { b: number; i: number }): { batch: OutBatch; file: OutFile } | null {
    const batch = this.out.get(m.b);
    const file = batch?.files[m.i];
    if (!batch || !file) {
      if (!this.gone.has(m.b)) this.violation(m.b, 'v12');
      return null;
    }
    return { batch, file };
  }

  private onAck(m: Extract<Control, { t: 'ack' }>): void {
    const hit = this.outFile(m);
    if (!hit) return;
    const key = `${m.i}:${m.k}`;
    hit.batch.pending.delete(key);
    this.pump();
  }

  private onAgain(m: Extract<Control, { t: 'again' }>): void {
    const hit = this.outFile(m);
    if (!hit) return;
    if (!Number.isInteger(m.k) || !hit.file.sentBlocks.has(m.k)) return this.violation(m.b, 'v13');
    if (!hit.batch.resend.some(([i, k]) => i === m.i && k === m.k)) hit.batch.resend.push([m.i, m.k]);
    this.emit({ k: 'refetched', b: m.b, dir: 'out' });
    this.pump();
  }

  private onFileOk(m: Extract<Control, { t: 'fileok' }>): void {
    const hit = this.outFile(m);
    if (!hit) return;
    hit.file.state = 'ok';
    this.emit({ k: 'file-sent', b: m.b, i: m.i });
  }

  private onFileFailed(m: Extract<Control, { t: 'failed' }>): void {
    const hit = this.outFile(m);
    if (!hit) return;
    hit.file.state = 'failed';
    for (const key of [...hit.batch.pending]) if (key.startsWith(`${m.i}:`)) hit.batch.pending.delete(key);
    this.emit({ k: 'file-failed', b: m.b, dir: 'out', i: m.i, name: hit.file.src.name, why: m.why === 'storage' ? 'storage' : undefined });
    this.pump();
  }

  private onBatchOk(m: Extract<Control, { t: 'ok' }>): void {
    const batch = this.out.get(m.b);
    if (!batch) return this.gone.has(m.b) ? undefined : this.violation(m.b, 'v14');
    if (batch.files.some((f) => f.state !== 'ok')) return this.violation(m.b, 'v15');
    this.emit({ k: 'complete', b: m.b, dir: 'out' });
  }

  // ---- pause and cancel -----------------------------------------------------------------------

  private find(b: number): { batch: OutBatch | InBatch; dir: Direction } | null {
    const o = this.out.get(b);
    if (o) return { batch: o, dir: 'out' };
    const i = this.inn.get(b);
    return i ? { batch: i, dir: 'in' } : null;
  }

  private setPaused(b: number, side: Side, on: boolean): void {
    const hit = this.find(b);
    if (!hit) return this.gone.has(b) ? undefined : this.violation(b, 'v16');
    if (hit.batch.paused[side] === on) return;
    hit.batch.paused[side] = on;
    hit.batch.meter.reset();
    if (side === 'local') this.control({ t: on ? 'pause' : 'resume', b });
    this.emit({ k: on ? 'paused' : 'resumed', b, dir: hit.dir, by: side });
    if (!on) this.pump();
  }

  private cancelBatch(b: number, by: Side): void {
    const ask = this.asks.get(b);
    if (ask && by === 'remote') {
      // the other page cancelled our request: only a page from before requests does that (a current one answers "asking")
      this.asks.delete(b);
      if (!ask.acked) this.emit({ k: 'error', why: 'refresh', b, site: 'old-receiver' });
      return;
    }
    const hit = this.find(b);
    if (!hit) return;
    hit.batch.dead = true;
    this.gone.add(b);
    this.out.delete(b);
    this.inn.delete(b);
    if (this.cur?.batch.b === b) this.cur = null;
    if (hit.dir === 'in') void this.disposeIn(hit.batch as InBatch);
    if (by === 'local') this.control({ t: 'cancel', b });
    this.emit({ k: 'cancelled', b, dir: hit.dir, by });
  }

  private async disposeIn(batch: InBatch, keepDone = false): Promise<void> {
    batch.dead = true;
    const files = keepDone ? batch.files.filter((f) => f.state !== 'ok') : batch.files;
    await Promise.all(files.map((f) => f.sink?.then((s) => s.dispose()).catch(() => {})));
  }
}
