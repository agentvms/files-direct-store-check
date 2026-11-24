/** Where a received file is kept while it arrives. The receiver never holds more than one block of a file in memory. */
export interface BlockSink {
  /** Writes bytes at a position in the file. */
  writeAt(offset: number, bytes: Uint8Array): Promise<void>;
  /** Reads bytes back, to check them after they were written. */
  readAt(offset: number, length: number): Promise<Uint8Array>;
  /** The finished file, once every block is written. */
  file(type: string): Promise<Blob>;
  /** Frees whatever the sink holds (a cancelled or failed file, or one already handed over). */
  dispose(): Promise<void>;
}

/** Makes one sink per received file. `kind` says where the bytes really go. */
export interface SinkFactory {
  readonly kind: 'disk' | 'memory';
  create(size: number): Promise<BlockSink>;
  /** Frees everything this factory made. */
  close(): Promise<void>;
}

/** The fallback where the browser has no private file storage: the file is kept in memory until it is saved. */
export class MemorySink implements BlockSink {
  private parts = new Map<number, Uint8Array>();

  async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
    this.parts.set(offset, bytes.slice());
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    const part = this.parts.get(offset);
    return part && part.length === length ? part.slice() : new Uint8Array(length);
  }

  async file(type: string): Promise<Blob> {
    const ordered = [...this.parts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1] as BlobPart);
    return new Blob(ordered, { type: type || 'application/octet-stream' });
  }

  async dispose(): Promise<void> {
    this.parts.clear();
  }
}

export function memorySinks(): SinkFactory {
  return { kind: 'memory', create: async () => new MemorySink(), close: async () => {} };
}
