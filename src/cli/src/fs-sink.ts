import { openAsBlob } from 'node:fs';
import { type FileHandle, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlockSink, SinkFactory } from '../../web/src/transfer/sink.ts';
import { type Guard, moveInto, prepareTarget, segmentsOf } from './safe-path.ts';

export interface SinkStats {
  maxWrite: number;
  maxRead: number;
  writes: number;
}

export interface Saver {
  /** The destination's real path. */
  dest: string;
  sinks: SinkFactory & { stats: SinkStats };
  /** A verified file: moves it from its partial name to its place under the destination and resolves the path it was saved to. Refuses with a `Refused` that has a reason word. */
  finish(blob: Blob, relPath: string): Promise<string>;
  /** Removes whatever partial files are left. Call after every `finish` has settled. */
  close(): Promise<void>;
}

/** One received file, written block by block into a partial file inside the destination. At most one block is ever held in memory. */
class FsSink implements BlockSink {
  private handle: FileHandle | null = null;
  private done = false;

  constructor(readonly path: string, private readonly stats: SinkStats) {}

  private async open(): Promise<FileHandle> {
    return (this.handle ??= await open(this.path, 'w+', 0o600));
  }

  async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
    const h = await this.open();
    this.stats.maxWrite = Math.max(this.stats.maxWrite, bytes.length);
    this.stats.writes++;
    let at = 0;
    while (at < bytes.length) {
      const { bytesWritten } = await h.write(bytes, at, bytes.length - at, offset + at);
      if (bytesWritten === 0) throw new Error('short-write');
      at += bytesWritten;
    }
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    const h = await this.open();
    this.stats.maxRead = Math.max(this.stats.maxRead, length);
    const out = new Uint8Array(length);
    let at = 0;
    while (at < length) {
      const { bytesRead } = await h.read(out, at, length - at, offset + at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
    return at === length ? out : out.subarray(0, at);
  }

  async file(): Promise<Blob> {
    await this.open(); // an empty file never had a block written: it still has to exist
    await this.close();
    return openAsBlob(this.path); // backed by the file: nothing is read into memory
  }

  async close(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    await h?.close();
  }

  async dispose(): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.close().catch(() => {});
    await rm(this.path, { force: true });
  }
}

/**
 * Received files go to disk, block by block, under `dest`. While a file arrives it lives in a hidden folder of its own inside the destination
 * (so moving it into place never crosses a drive), and `finish` puts it where its name says once it has passed its checks.
 */
export async function createSaver(dest: string, opts: { overwrite: boolean; guard?: Guard }): Promise<Saver> {
  await mkdir(dest, { recursive: true });
  const destReal = await realpath(dest);
  const stats: SinkStats = { maxWrite: 0, maxRead: 0, writes: 0 };
  const byBlob = new WeakMap<Blob, FsSink>();
  const made: FsSink[] = [];
  let partDir: Promise<string> | null = null;
  let n = 0;
  const sinks: Saver['sinks'] = {
    kind: 'disk',
    stats,
    async create() {
      const dir = await (partDir ??= mkdtemp(join(destReal, '.files-direct-')));
      const sink = new FsSink(join(dir, 'f' + n++), stats);
      made.push(sink);
      const file = sink.file.bind(sink);
      sink.file = async () => {
        const blob = await file();
        byBlob.set(blob, sink);
        return blob;
      };
      return sink;
    },
    async close() {
      await Promise.all(made.map((s) => s.dispose()));
    },
  };
  return {
    dest: destReal,
    sinks,
    async finish(blob, relPath) {
      const sink = byBlob.get(blob);
      if (!sink) throw new Error('unknown file');
      try {
        const segments = segmentsOf(relPath);
        opts.guard?.(join(destReal, ...segments)); // before any folder is made
        const target = await prepareTarget(destReal, segments, opts.overwrite);
        opts.guard?.(target);
        await moveInto(sink.path, target, opts.overwrite);
        return target;
      } catch (e) {
        await sink.dispose();
        throw e;
      }
    },
    async close() {
      await sinks.close();
      if (partDir) await rm(await partDir, { recursive: true, force: true });
    },
  };
}
