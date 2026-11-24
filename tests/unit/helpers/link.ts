import { type ChannelLike, type Sendable, type SessionOptions, type TransferEvent, Session } from '../../../src/web/src/transfer/engine.ts';
import { type BlockSink, MemorySink, type SinkFactory } from '../../../src/web/src/transfer/sink.ts';

export function pattern(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed + (i >> 8)) & 0xff;
  return out;
}

export function source(name: string, bytes: Uint8Array, type = 'application/octet-stream'): Sendable & { reads: number[] } {
  const reads: number[] = [];
  return {
    name,
    size: bytes.length,
    type,
    reads,
    slice(a, b) {
      reads.push(b - a);
      return { arrayBuffer: async () => bytes.slice(a, b).buffer };
    },
  };
}

/** One end of a stand-in channel. Frames sent here reach the other end's handler at once. */
export class End implements ChannelLike {
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = 'open';
  sent: (string | ArrayBuffer)[] = [];
  peer!: End;
  onMessage: (d: string | ArrayBuffer) => void = () => {};
  tap: (d: string | ArrayBuffer) => string | ArrayBuffer | null = (d) => d;
  private listeners: Record<string, (() => void)[]> = {};
  send(d: string | ArrayBuffer): void {
    this.sent.push(d);
    const out = this.tap(d);
    if (out !== null) this.peer.onMessage(out);
  }
  addEventListener(type: string, cb: () => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  fire(type: string): void {
    (this.listeners[type] ?? []).forEach((cb) => cb());
  }
  /** The block headers this end sent: [file, block] in order. */
  blocksSent(): string[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((s) => JSON.parse(s) as { t: string; i: number; k: number }).filter((m) => m.t === 'block').map((m) => `${m.i}:${m.k}`);
  }
}

export function channelPair(): [End, End] {
  const a = new End();
  const b = new End();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** A sink that can damage what it keeps. `flip(k)` says how many more times reading block k back should be wrong. */
export class TestSink extends MemorySink implements BlockSink {
  maxWrite = 0;
  maxRead = 0;
  flips = new Map<number, number>();
  constructor(private readonly blockSize: number) {
    super();
  }
  override async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
    this.maxWrite = Math.max(this.maxWrite, bytes.length);
    return super.writeAt(offset, bytes);
  }
  override async readAt(offset: number, length: number): Promise<Uint8Array> {
    this.maxRead = Math.max(this.maxRead, length);
    const out = await super.readAt(offset, length);
    const k = offset / this.blockSize;
    const left = this.flips.get(k) ?? 0;
    if (left > 0) {
      this.flips.set(k, left - 1);
      out[0] = out[0]! ^ 0xff;
    }
    return out;
  }
}

export interface TestSinks extends SinkFactory {
  made: TestSink[];
  create(size?: number): Promise<TestSink>;
}

export function testSinks(blockSize: number): TestSinks {
  const made: TestSink[] = [];
  return {
    kind: 'memory',
    made,
    async create() {
      const s = new TestSink(blockSize);
      made.push(s);
      return s;
    },
    async close() {},
  };
}

export interface Side {
  session: Session;
  end: End;
  events: TransferEvent[];
  sinks: ReturnType<typeof testSinks>;
  files: Map<string, Blob>;
}

export type SideExtra = { window?: number; now?: () => number; ask?: boolean; after?: SessionOptions['after']; previews?: boolean; makePreview?: SessionOptions['makePreview']; relay?: boolean };

export function makeSide(end: End, odd: boolean, blockSize: number, extra: SideExtra = {}): Side {
  const events: TransferEvent[] = [];
  const files = new Map<string, Blob>();
  const names = new Map<string, string>();
  const sinks = testSinks(blockSize);
  const session = new Session({
    channel: end,
    sinks,
    odd,
    ask: extra.ask,
    previews: extra.previews,
    makePreview: extra.makePreview,
    relay: extra.relay,
    after: extra.after,
    blockSize,
    window: extra.window,
    now: extra.now,
    emit: (e) => {
      events.push(e);
      if (e.k === 'started' && e.dir === 'in') for (const f of e.files) names.set(`${e.b}:${f.i}`, f.name);
      if (e.k === 'file-ready') files.set(names.get(`${e.b}:${e.i}`) ?? '?', e.blob);
    },
  });
  end.onMessage = (d) => session.handle(d);
  return { session, end, events, sinks, files };
}

/**
 * Waits until nothing more happens: both sessions idle, and neither end has sent a frame nor raised an event for three rounds in a row
 * (a fixed number of short waits is a race on a busy machine). Gives up after about ten seconds so a stuck transfer fails its own check.
 */
async function settle(sender: Side, receiver: Side): Promise<void> {
  const mark = () => [sender.end.sent.length, receiver.end.sent.length, sender.events.length, receiver.events.length].join(':');
  const until = Date.now() + 10_000;
  let still = 0;
  let last = '';
  while (still < 3 && Date.now() < until) {
    await sender.session.idle();
    await receiver.session.idle();
    await new Promise((r) => setTimeout(r, 2));
    const now = mark();
    still = now === last ? still + 1 : 0;
    last = now;
  }
}

/** `both` applies to both ends; `sending` and `receiving` add what only that end has (a sender that can make previews, a receiver that takes them). */
export async function connect(blockSize: number, extra: SideExtra = {}, ends: { sending?: SideExtra; receiving?: SideExtra } = {}) {
  const [a, b] = channelPair();
  const sender = makeSide(a, true, blockSize, { ...extra, ...ends.sending });
  const receiver = makeSide(b, false, blockSize, { ...extra, ...ends.receiving });
  return { sender, receiver, settle: () => settle(sender, receiver) };
}

export async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
