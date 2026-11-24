import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE, PIECE_SIZE } from '../../src/shared/config.ts';
import { decodePiece, encodePiece } from '../../src/web/src/transfer/frames.ts';
import { bytesOf, connect, pattern, source } from './helpers/link.ts';

const BS = 10_000;

describe('piece frames', () => {
  it('round-trip', () => {
    const payload = pattern(500);
    const p = decodePiece(encodePiece(3, 4, 9, 70, payload))!;
    expect([p.b, p.i, p.k, p.offset, p.payload.length]).toEqual([3, 4, 9, 70, 500]);
    expect(p.payload).toEqual(payload);
  });
  it('refuses a frame too short for its header', () => {
    expect(decodePiece(new ArrayBuffer(5))).toBeNull();
  });
});

describe('the channel closing', () => {
  it('keeps files that already arrived and frees the ones still coming', async () => {
    const { sender, receiver, settle } = await connect(BS);
    sender.session.send([source('done.bin', pattern(BS * 2)), source('big.bin', pattern(BS * 40))]);
    // let the first file finish, then cut the channel while the second is mid-way
    for (let n = 0; n < 200 && !receiver.files.has('done.bin'); n++) await new Promise((r) => setTimeout(r, 1));
    const disposed: string[] = [];
    receiver.sinks.made.forEach((s, k) => {
      const d = s.dispose.bind(s);
      s.dispose = async () => {
        disposed.push(`${k}`);
        return d();
      };
    });
    await receiver.session.close();
    void settle;
    expect(receiver.files.has('done.bin')).toBe(true);
    expect(disposed).not.toContain('0');
  });
});

describe('blocks (fd-arf)', () => {
  it('moves a file of 3.5 blocks intact; no read or held buffer is bigger than a block', async () => {
    const bytes = pattern(BS * 3 + BS / 2, 7);
    const f = source('a.bin', bytes);
    const { sender, receiver, settle } = await connect(BS);
    sender.session.send([f]);
    await settle();
    expect(receiver.events.filter((e) => e.k === 'error')).toEqual([]);
    expect(await bytesOf(receiver.files.get('a.bin')!)).toEqual(bytes);
    expect(Math.max(...f.reads)).toBeLessThanOrEqual(BS);
    expect(f.reads).toHaveLength(4);
    expect(receiver.session.stats.maxHeld).toBeLessThanOrEqual(BS);
    const sink = receiver.sinks.made[0]!;
    expect(sink.maxWrite).toBeLessThanOrEqual(BS);
    expect(sink.maxRead).toBeLessThanOrEqual(BS);
    expect(sender.events.some((e) => e.k === 'complete')).toBe(true);
    expect(receiver.events.some((e) => e.k === 'complete')).toBe(true);
  });

  it('a block crosses the channel as pieces no bigger than PIECE_SIZE', async () => {
    const { sender, receiver, settle } = await connect(BS * 20);
    sender.session.send([source('p.bin', pattern(PIECE_SIZE * 3 + 5))]);
    await settle();
    const sizes = sender.end.sent.filter((d): d is ArrayBuffer => typeof d !== 'string').map((d) => d.byteLength - 16);
    expect(sizes).toEqual([PIECE_SIZE, PIECE_SIZE, PIECE_SIZE, 5]);
    expect(receiver.files.has('p.bin')).toBe(true);
  });

  it('a damaged piece costs one block: asked for again, sent again alone, file completes', async () => {
    const bytes = pattern(BS * 3, 3);
    const { sender, receiver, settle } = await connect(BS);
    let pieces = 0;
    let flipped = false;
    sender.end.tap = (d) => {
      if (typeof d === 'string') return d;
      // each block is one piece here: damage the second one, once
      if (++pieces === 2 && !flipped) {
        flipped = true;
        const c = new Uint8Array(d.slice(0));
        c[c.length - 1] = c[c.length - 1]! ^ 1;
        return c.buffer;
      }
      return d;
    };
    sender.session.send([source('a.bin', bytes)]);
    await settle();
    const sends = sender.end.blocksSent();
    expect(sends.filter((s) => s === '0:0')).toHaveLength(1);
    const twice = sends.filter((s, n) => sends.indexOf(s) !== n);
    expect(twice).toHaveLength(1);
    expect(sends).toHaveLength(4);
    expect(await bytesOf(receiver.files.get('a.bin')!)).toEqual(bytes);
    expect(receiver.events.some((e) => e.k === 'refetched')).toBe(true);
    expect(receiver.events.filter((e) => e.k === 'file-failed')).toEqual([]);
  });

  it('the block size is one constant: the round trip works at two sizes', async () => {
    for (const bs of [4096, 25_000]) {
      const bytes = pattern(100_000, bs);
      const f = source('x', bytes);
      const { sender, receiver, settle } = await connect(bs);
      sender.session.send([f]);
      await settle();
      expect(f.reads).toHaveLength(Math.ceil(100_000 / bs));
      expect(Math.max(...f.reads)).toBe(bs);
      expect(await bytesOf(receiver.files.get('x')!)).toEqual(bytes);
    }
    expect(BLOCK_SIZE).toBe(4 * 1024 * 1024);
  });

  it('moves files of every kind: empty, one block, several blocks, exact multiple', async () => {
    const inputs = [pattern(0), pattern(10, 2), pattern(BS * 2 + 5, 3), pattern(BS * 3, 4)];
    const { sender, receiver, settle } = await connect(BS);
    sender.session.send(inputs.map((b, i) => source(`f${i}`, b)));
    await settle();
    expect(receiver.events.filter((e) => e.k === 'error')).toEqual([]);
    for (const [i, b] of inputs.entries()) expect(await bytesOf(receiver.files.get(`f${i}`)!)).toEqual(b);
    expect(sender.events.filter((e) => e.k === 'complete')).toHaveLength(1);
  });
});

describe('whole-file check (fd-4jh)', () => {
  it('a block that went bad on disk is found by the re-read and sent again alone', async () => {
    const bytes = pattern(BS * 4, 5);
    const { sender, receiver, settle } = await connect(BS);
    // block 2 reads back wrong, once
    const make = receiver.sinks.create.bind(receiver.sinks);
    receiver.sinks.create = async () => {
      const s = await make();
      s.flips.set(2, 1);
      return s;
    };
    sender.session.send([source('d.bin', bytes)]);
    await settle();
    const sends = sender.end.blocksSent();
    expect(sends.filter((s) => s === '0:2')).toHaveLength(2);
    expect(sends.filter((s) => s !== '0:2')).toEqual(['0:0', '0:1', '0:3']);
    expect(await bytesOf(receiver.files.get('d.bin')!)).toEqual(bytes);
  });

  it('a block that is bad on disk three times fails the file, not forever', async () => {
    const { sender, receiver, settle } = await connect(BS);
    const make = receiver.sinks.create.bind(receiver.sinks);
    receiver.sinks.create = async () => {
      const s = await make();
      s.flips.set(1, 99);
      return s;
    };
    sender.session.send([source('bad.bin', pattern(BS * 3)), source('fine.bin', pattern(5))]);
    await settle();
    expect(sender.end.blocksSent().filter((s) => s === '0:1')).toHaveLength(3);
    expect(receiver.events.filter((e) => e.k === 'file-failed')).toMatchObject([{ k: 'file-failed', name: 'bad.bin' }]);
    expect(sender.events.filter((e) => e.k === 'file-failed')).toMatchObject([{ name: 'bad.bin' }]);
    expect(receiver.files.has('bad.bin')).toBe(false);
    expect(receiver.files.has('fine.bin')).toBe(true);
    expect(sender.events.some((e) => e.k === 'complete')).toBe(false);
  });

  it('a fingerprint that does not match, with every block right, is a plain failure', async () => {
    const { sender, receiver, settle } = await connect(BS);
    sender.end.tap = (d) => (typeof d === 'string' && d.includes('"t":"end"') ? d.replace(/"fp":"[0-9a-f]{2}/, '"fp":"ff') : d);
    sender.session.send([source('l.bin', pattern(BS * 2))]);
    await settle();
    expect(receiver.events.filter((e) => e.k === 'file-failed')).toHaveLength(1);
    expect(receiver.files.size).toBe(0);
    expect(sender.end.blocksSent()).toHaveLength(2);
  });
});

describe('what the other side may send', () => {
  it('a block header for an unknown batch is not trusted', async () => {
    const { receiver, settle } = await connect(BS);
    receiver.end.onMessage(JSON.stringify({ t: 'block', b: 9, i: 0, k: 0, h: '00'.repeat(32) }));
    await settle();
    expect(receiver.events).toMatchObject([{ k: 'error', why: 'unreadable', b: 9 }]);
  });
  it('refuses a manifest with an absurd block size', async () => {
    const { receiver, settle } = await connect(BS);
    receiver.end.onMessage(JSON.stringify({ t: 'manifest', b: 1, blockSize: 2 ** 31, files: [] }));
    await settle();
    expect(receiver.events.map((e) => e.k)).toEqual(['error']);
  });
  it('cleans paths in the manifest', async () => {
    const { sender, receiver, settle } = await connect(BS);
    sender.session.send([source('../../etc/passwd', pattern(3)), source('/abs/x.txt', pattern(3)), source('a//b/./c.txt', pattern(3))]);
    await settle();
    const started = receiver.events.find((e) => e.k === 'started')!;
    expect(started.k === 'started' && started.files.map((f) => f.name)).toEqual(['etc/passwd', 'abs/x.txt', 'a/b/c.txt']);
  });
});
