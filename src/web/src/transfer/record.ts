/**
 * Which blocks of one file are safely written. A bitset behind a small interface, so the resume work can
 * keep it in the browser's own storage and rebuild it later (`toBytes` / `fromBytes`).
 */
export class BlockRecord {
  private readonly bits: Uint8Array;

  constructor(readonly blocks: number, bytes?: Uint8Array) {
    this.bits = new Uint8Array(Math.ceil(blocks / 8));
    if (bytes) this.bits.set(bytes.subarray(0, this.bits.length));
  }

  static fromBytes(blocks: number, bytes: Uint8Array): BlockRecord {
    return new BlockRecord(blocks, bytes);
  }

  has(k: number): boolean {
    return k >= 0 && k < this.blocks && (this.bits[k >> 3]! & (1 << (k & 7))) !== 0;
  }

  set(k: number): void {
    if (k >= 0 && k < this.blocks) this.bits[k >> 3]! |= 1 << (k & 7);
  }

  clear(k: number): void {
    if (k >= 0 && k < this.blocks) this.bits[k >> 3]! &= ~(1 << (k & 7));
  }

  count(): number {
    let n = 0;
    for (let k = 0; k < this.blocks; k++) if (this.has(k)) n++;
    return n;
  }

  complete(): boolean {
    return this.count() === this.blocks;
  }

  toBytes(): Uint8Array {
    return this.bits.slice();
  }
}
