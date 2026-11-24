/**
 * Speed and time left. Speed is the average over the last few seconds (not since the start), so it follows the
 * connection. Time left is not shown until there are at least MIN_SPAN_MS of samples and MIN_BYTES moved; before
 * that `eta` is null. It is never negative, NaN or infinite. See docs/PROTOCOL.md.
 */
export const SPEED_WINDOW_MS = 5000;
export const MIN_SPAN_MS = 2000;
export const MIN_BYTES = 256 * 1024;

export interface Reading {
  /** Bytes per second over the recent window, 0 until two samples exist. */
  speed: number;
  /** Seconds left, or null while there is not enough data to say. */
  eta: number | null;
}

export class Meter {
  private samples: { at: number; bytes: number }[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** `bytes` is the running total moved so far. */
  add(bytes: number): void {
    const at = this.now();
    this.samples.push({ at, bytes });
    const cutoff = at - SPEED_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1]!.at <= cutoff) this.samples.shift();
  }

  /** Forget the past (after a pause, so the standstill does not count as slow). */
  reset(): void {
    this.samples = [];
  }

  read(remaining: number): Reading {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.at <= first.at) return { speed: 0, eta: null };
    const speed = Math.max(0, (last.bytes - first.bytes) / ((last.at - first.at) / 1000));
    const enough = last.at - first.at >= MIN_SPAN_MS && last.bytes - (this.samples[0]?.bytes ?? 0) >= MIN_BYTES;
    if (!enough || !(speed > 0) || !Number.isFinite(speed)) return { speed: Number.isFinite(speed) ? speed : 0, eta: null };
    const eta = Math.max(0, remaining) / speed;
    return { speed, eta: Number.isFinite(eta) ? eta : null };
  }
}
