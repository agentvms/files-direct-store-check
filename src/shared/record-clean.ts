/**
 * Cuts whatever a page sent down to the record's own words (shape and lines: shared/record.ts). Kept in its own file so the page loads it
 * only when a room opens, and the Worker, which stores the record, uses the same code.
 */
import { cleanStart } from './ask.ts';
import { type Device, cleanDevice, cleanJoined } from './device.ts';
import { CANDIDATE_KINDS, CONNECTION_FAIL_REASONS, type CandidateKind, type ConnectionFailReason, cleanKinds, waitBucket } from './events.ts';
import { ATTEMPT_ENDS, MAX_ATTEMPTS, type AttemptLog, type Pair, type RoomRecord, cleanRef } from './record.ts';

/** The start of the bucket a wait falls in, so a stored record holds buckets and not exact times. */
export function snapMs(ms: unknown): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
  const b = waitBucket(n);
  return b === 'under 2 s' ? 0 : b === '2-5 s' ? 2000 : b === '5-10 s' ? 5000 : b === '10-20 s' ? 10_000 : 20_000;
}

const kind = (v: unknown): CandidateKind | null => (typeof v === 'string' && (CANDIDATE_KINDS as readonly string[]).includes(v) ? (v as CandidateKind) : null);

function cleanPairObject(raw: unknown): Pair | null {
  if (!raw || typeof raw !== 'object') return null;
  const local = kind((raw as { local?: unknown }).local);
  const remote = kind((raw as { remote?: unknown }).remote);
  return local && remote ? { local, remote } : null;
}

function cleanAttempt(raw: unknown): AttemptLog | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const ended = (ATTEMPT_ENDS as readonly unknown[]).includes(a.ended) ? (a.ended as AttemptLog['ended']) : 'open';
  return {
    route: a.route === 'relay' ? 'relay' : 'direct',
    local: cleanKinds(a.local),
    remote: cleanKinds(a.remote),
    pair: cleanPairObject(a.pair),
    ms: snapMs(a.ms),
    ended,
  };
}

const UNKNOWN_DEVICE: Device = { kind: 'unknown', system: 'unknown', browser: 'unknown', version: 0 };

/**
 * Whatever a page sent, cut down to the record's own words. Null when it is not an object at all.
 * `ref` is the room's own reference, never the page's. `start` is the room's own word on how it began: given, it replaces whatever the page said.
 */
export function cleanRecord(raw: unknown, ref: string | null, start?: unknown): RoomRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const retries = typeof r.retries === 'number' && Number.isInteger(r.retries) && r.retries >= 0 ? Math.min(r.retries, 99) : 0;
  return {
    ref: cleanRef(ref),
    self: cleanDevice(r.self) ?? UNKNOWN_DEVICE,
    other: cleanDevice(r.other),
    joined: cleanJoined(r.joined),
    sameAddress: typeof r.sameAddress === 'boolean' ? r.sameAddress : null,
    route: r.route === 'direct' || r.route === 'through our servers' ? r.route : null,
    reason: (CONNECTION_FAIL_REASONS as readonly unknown[]).includes(r.reason) ? (r.reason as ConnectionFailReason) : null,
    attempts: (Array.isArray(r.attempts) ? r.attempts : []).slice(0, MAX_ATTEMPTS).map(cleanAttempt).filter((a): a is AttemptLog => a !== null),
    retries,
    start: cleanStart(start === undefined ? r.start : start),
  };
}
