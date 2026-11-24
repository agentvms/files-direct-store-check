/**
 * Moving a running transfer from one channel to another without starting over.
 * The side that opens the move stops using the old channel between two messages: its last message there is
 * `{"t":"switch"}`, and everything after goes on the new channel. The other side holds what arrives on the new channel
 * until it has taken everything from the old one up to that marker, then carries on in order. Its last message on the old
 * channel is `{"t":"switched"}`, so the first side also takes nothing from the new channel before the old one is drained.
 * The transfer code on either side sees one channel.
 */
export const SWITCH = JSON.stringify({ t: 'switch' });
export const SWITCHED = JSON.stringify({ t: 'switched' });

type Data = string | ArrayBuffer;

export interface PathHooks {
  /** Every message, once, in order. */
  deliver(data: Data): void;
  /** A channel this path sends on has room (or just sent): the caller reports how full it is. */
  low(ch: RTCDataChannel): void;
  /** The channel in use closed. */
  closed(): void;
  /** Called with a channel before the path listens on it. */
  prepare?(ch: RTCDataChannel): void;
}

export class ChannelPath {
  private out: RTCDataChannel;
  private inn: RTCDataChannel;
  private next: RTCDataChannel | null = null;
  private held: Data[] = [];
  private marker = false;
  private moved: (() => void) | null = null;

  constructor(first: RTCDataChannel, private readonly hooks: PathHooks) {
    this.out = this.inn = first;
    this.listen(first);
  }

  /** The channel the page sends on now. */
  get channel(): RTCDataChannel {
    return this.out;
  }

  private listen(ch: RTCDataChannel): void {
    this.hooks.prepare?.(ch);
    ch.addEventListener('message', (e) => {
      const data = e.data as Data;
      if (ch === this.inn) {
        if (data === SWITCH) {
          this.marker = true;
          this.cross();
        } else if (data === SWITCHED) {
          // the other side has taken everything from the old channel
          this.inn = this.next ?? this.inn;
          this.next = null;
          for (const m of this.held.splice(0)) this.hooks.deliver(m);
          const done = this.moved;
          this.moved = null;
          done?.();
        } else this.hooks.deliver(data);
      } else if (ch === this.next) this.held.push(data);
    });
    ch.addEventListener('bufferedamountlow', () => {
      if (ch === this.out) this.hooks.low(ch);
    });
    ch.addEventListener('close', () => {
      if (ch === this.out || ch === this.inn) this.hooks.closed();
    });
  }

  /** Between two messages: mark the end on the old channel and carry on on the new one. `moved` runs when the other side confirms. */
  moveTo(next: RTCDataChannel, moved: () => void): void {
    if (this.next) return;
    this.moved = moved;
    this.next = next;
    this.listen(next);
    this.out.send(SWITCH);
    this.out = next;
    this.hooks.low(next); // the sender may be waiting on the old channel's buffer
  }

  /** A second channel opened on the side that is moved: hold its messages until the old one has said it is finished. */
  extra(next: RTCDataChannel): void {
    this.next = next;
    this.listen(next);
    this.cross();
  }

  private cross(): void {
    const next = this.next;
    if (!this.marker || !next) return;
    this.out.send(SWITCHED); // last message on the old channel
    this.inn = this.out = next;
    this.next = null;
    this.marker = false;
    this.hooks.low(next);
    for (const m of this.held.splice(0)) this.hooks.deliver(m);
  }
}

/**
 * The sender's page moves a transfer to a direct channel. The route report that lets the room end the relay credential goes out
 * only once the receiver has confirmed the old route is drained, never before.
 */
export function moveToDirect(path: Pick<ChannelPath, 'moveTo'>, next: RTCDataChannel, done: { keepOnly: () => void; report: () => void }): void {
  path.moveTo(next, () => {
    done.keepOnly();
    done.report();
  });
}
