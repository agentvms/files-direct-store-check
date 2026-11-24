import { cleanRecord } from '../../shared/record-clean.ts';
import type { RoomRecord } from '../../shared/record.ts';import type { Device, Joined } from '../../shared/device.ts';
import type { Connection } from './connection.ts';
import type { Signal } from './signal.ts';

export { cleanRef, recordText } from '../../shared/record.ts';
/** What this page knows of its room now: the page's own facts, and the connection's log of attempts. */
export function roomRecord(
  s: { ref: string | null; other: Device | null; joined: Joined | null; same: boolean | null; connected: boolean; relayed: boolean },
  self: Device,
  conn: Connection | undefined,
): RoomRecord {
  const log = conn?.log();
  return {
    ref: s.ref,
    self,
    other: s.other,
    joined: s.joined,
    sameAddress: s.same,
    route: s.connected ? (s.relayed ? 'through our servers' : 'direct') : null,
    reason: log && !(s.connected && !s.relayed) ? conn!.why() : null,
    attempts: log?.attempts ?? [],
    retries: log?.retries ?? 0,
  };
}

/** Hands the room this side's record whenever it differs from the one it has (compared by its cleaned, bucketed form, so a running clock alone does not send). */
export function recordSender(signal: Signal): (r: RoomRecord) => void {
  let last = '';
  return (r) => {
    const clean = cleanRecord(r, r.ref);
    const now = JSON.stringify(clean);
    if (!clean || now === last) return;
    last = now;
    signal.send({ t: 'record', d: clean });
  };
}
