import type { ChannelLike } from '../../web/src/transfer/engine.ts';
import { ChannelPath } from '../../web/src/route-switch.ts';

/**
 * What the transfer loop sees as its channel: one object that stays the same when the transfer moves from one connection to another
 * (web/src/route-switch.ts does the move). The page does the same through its worker; here the loop runs in this process.
 */
export class PathChannel implements ChannelLike {
  private threshold = 0;
  private lows: (() => void)[] = [];
  private closes: (() => void)[] = [];
  private readonly path: ChannelPath;

  constructor(first: RTCDataChannel, deliver: (data: string | ArrayBuffer) => void) {
    this.path = new ChannelPath(first, {
      deliver,
      low: () => this.lows.forEach((f) => f()),
      closed: () => this.closes.forEach((f) => f()),
      prepare: (c) => {
        c.binaryType = 'arraybuffer';
        c.bufferedAmountLowThreshold = this.threshold;
      },
    });
  }

  get bufferedAmount(): number {
    return this.path.channel.bufferedAmount;
  }

  get readyState(): string {
    return this.path.channel.readyState;
  }

  get bufferedAmountLowThreshold(): number {
    return this.threshold;
  }

  set bufferedAmountLowThreshold(v: number) {
    this.threshold = v;
    this.path.channel.bufferedAmountLowThreshold = v;
  }

  send(data: string | ArrayBuffer): void {
    this.path.channel.send(data as never);
  }

  addEventListener(type: 'bufferedamountlow' | 'close', listener: () => void): void {
    (type === 'close' ? this.closes : this.lows).push(listener);
  }

  /** The transfer goes on a direct channel from the next message (the other side is told in order). `moved` runs once it has everything from the old one. */
  moveTo(next: RTCDataChannel, moved: () => void): void {
    this.path.moveTo(next, moved);
  }

  /** A second channel opened on the side that is moved. */
  extra(next: RTCDataChannel): void {
    this.path.extra(next);
  }
}
