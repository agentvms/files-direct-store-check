/**
 * The record of a room, the one shape the page builds, the Worker stores and the team reads (docs/RECORDS.md).
 * Every value is one of a fixed list, a yes/no or a coarse bucket: never an address, a link, a code, a password or a file name.
 * `cleanRecord` (shared/record-clean.ts, kept apart so the first page load does not carry it) is the only way a record gets into the store,
 * so what a page sends can only ever be cut down to these words.
 */
import { type Device, type Joined, deviceText } from './device.ts';
import { type Start } from './ask.ts';
import { type CandidateKind, type ConnectionFailReason, waitBucket } from './events.ts';

export type Route = 'direct' | 'relay';

export interface Pair {
  local: CandidateKind;
  remote: CandidateKind;
}

export const ATTEMPT_ENDS = ['open', 'carrying', 'failed', 'timed out', 'closed', 'replaced'] as const;

/** What one connection attempt looked like, in words and coarse numbers (never an address). */
export interface AttemptLog {
  route: Route;
  /** Kinds this device offered and kinds the other device offered, for this attempt. */
  local: CandidateKind[];
  remote: CandidateKind[];
  /** The pair in use (kinds), only for the attempt that carries the transfer. */
  pair: Pair | null;
  /** Milliseconds from the start of the attempt to its end (or to now while it is open). The store keeps the start of its bucket. */
  ms: number;
  ended: (typeof ATTEMPT_ENDS)[number];
}

export type RoutePhrase = 'direct' | 'through our servers';

export interface RoomRecord {
  /** The room's short reference (12 hex characters, from the room itself), or null before the room said it. */
  ref: string | null;
  /** The device that built this record. */
  self: Device;
  other: Device | null;
  joined: Joined | null;
  /** Whether both devices reach us from one address; null until the room says. */
  sameAddress: boolean | null;
  route: RoutePhrase | null;
  /** Why the transfer is not direct, when it is not. */
  reason: ConnectionFailReason | null;
  attempts: AttemptLog[];
  retries: number;
  /** How the room began, as the room itself says (a page's own word never counts); null for a record from before the word existed. */
  start?: Start | null;
}

export const REF_SHORT = /^[0-9a-f]{12}$/;
/** What a team lookup accepts: the whole room reference or its start (at least 8 characters). */
export const REF_LOOKUP = /^[0-9a-f]{8,64}$/;
export const MAX_ATTEMPTS = 12;

export const shortRef = (full: string): string => full.slice(0, 12);
export const cleanRef = (v: unknown): string | null => (typeof v === 'string' && REF_SHORT.test(v) ? v : null);

const REASON_WORDS: Record<ConnectionFailReason, string> = {
  none: 'direct',
  no_remote_candidates: 'the other device offered no address',
  mdns_only: 'one device only offered hidden local addresses',
  same_network_blocked: 'both on one network but no direct pair opened',
  checks_failed: 'every direct check failed',
  timeout: 'direct did not open in time',
};

const kinds = (k: CandidateKind[]) => (k.length ? [...k].sort().join(', ') : 'none');
const pair = (p: Pair | null) => (p ? p.local + ' with ' + p.remote : 'none');

export function recordLines(r: RoomRecord): string[] {
  const lines = [
    'Room reference: ' + (r.ref ?? 'not known'),
    ...(r.start ? ['How the room began: ' + (r.start === 'ask' ? 'someone asked for files' : 'someone sent files')] : []),
    'This device: ' + deviceText(r.self),
    'Other device: ' + deviceText(r.other),
    'How the other device came in: ' + (r.joined === 'qr' ? 'QR code' : r.joined === 'code' ? 'code' : r.joined === 'link' ? 'link' : 'not known'),
    'Same public address: ' + (r.sameAddress === null ? 'not known' : r.sameAddress ? 'yes' : 'no'),
    'Route in use: ' + (r.route ?? 'none yet'),
  ];
  if (r.route !== 'direct' && r.reason && r.reason !== 'none') lines.push('Why not direct: ' + REASON_WORDS[r.reason]);
  r.attempts.forEach((a, i) => {
    lines.push(
      `Attempt ${i + 1} (${a.route === 'relay' ? 'through our servers' : 'direct'}): this device offered ${kinds(a.local)}; the other offered ${kinds(a.remote)}; ` +
        `pair in use: ${pair(a.pair)}; ${a.ended}, ${waitBucket(a.ms)}`,
    );
  });
  lines.push('Direct tries while on our servers: ' + r.retries);
  return lines;
}

export const recordText = (r: RoomRecord) => recordLines(r).join('\n');

/** "Chrome on macOS": the browser and system of one device, for the count by browser pair. */
export const deviceLabel = (d: Device | null): string =>
  d ? (d.kind === 'program' ? 'command-line program' : d.kind === 'desktop' ? 'Files Direct window' : d.kind === 'app' ? 'Files Direct app' : d.browser === 'unknown' ? 'unknown browser' : d.browser) + ' on ' + (d.system === 'unknown' ? 'unknown system' : d.system) : 'unknown device';

/** The two devices of a room as one label, in a fixed order so the same pair always reads the same. */
export const pairLabel = (a: Device | null, b: Device | null): string => [deviceLabel(a), deviceLabel(b)].sort().join(' + ');
