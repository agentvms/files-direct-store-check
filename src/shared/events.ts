/** The event contract, shared by the page, the Worker and the tests. See docs/ANALYTICS.md. */

export const APP_ID = 'files-direct';

export const EVENT_NAMES = [
  '$pageview',
  '$pageleave',
  '$exception',
  'room_opened',
  'room_joined',
  'join_declined',
  'report_sent',
  'connected',
  'connection_outcome',
  'route_switched',
  'transfer_finished',
  'transfer_failed',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/**
 * The path a visitor landed on, for transfer_finished: the path only (no query, no fragment),
 * lowercase letters, digits, dashes and slashes, and never a room address (/r). Anything else is undefined.
 */
export function landingPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const path = raw.replace(/[?#].*$/s, '');
  if (path.length > 120 || !/^\/[a-z0-9/-]*$/.test(path)) return undefined;
  if (/^\/r(\/|$)/.test(path)) return undefined;
  return path;
}

export const FAIL_REASONS = ['damaged', 'incomplete', 'unreadable', 'lost', 'sender_left', 'relay_limit', 'month_stop'] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

/** The route a connection or a finished transfer took. `switched`: started through our servers, finished directly. */
export type ConnectedRoute = 'direct' | 'relay';
export type FinishedRoute = ConnectedRoute | 'switched';

/** The kinds of candidate address a browser gathers. Words only: never the address itself. `mdns` is a local address hidden behind a `.local` name. */
export const CANDIDATE_KINDS = ['host', 'mdns', 'srflx', 'prflx', 'relay'] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

/** Why a connection did not go direct, from a fixed list. `none`: it did. */
export const CONNECTION_FAIL_REASONS = ['none', 'no_remote_candidates', 'mdns_only', 'same_network_blocked', 'checks_failed', 'timeout'] as const;
export type ConnectionFailReason = (typeof CONNECTION_FAIL_REASONS)[number];

/** How long the page gave a direct connection before it opened or before the relay was asked for. Coarse buckets. */
export const WAIT_BUCKETS = ['under 2 s', '2-5 s', '5-10 s', '10-20 s', 'over 20 s'] as const;
export function waitBucket(ms: number): (typeof WAIT_BUCKETS)[number] {
  if (!(ms >= 2000)) return 'under 2 s';
  if (ms < 5000) return '2-5 s';
  if (ms < 10_000) return '5-10 s';
  if (ms < 20_000) return '10-20 s';
  return 'over 20 s';
}

/** Only the fixed kind words survive, once each, in a fixed order. Anything else (an address, a name) is dropped. */
export function cleanKinds(value: unknown): CandidateKind[] {
  if (!Array.isArray(value)) return [];
  return CANDIDATE_KINDS.filter((k) => value.includes(k));
}

/** `host-host`, `mdns-srflx`, …: two kind words, or nothing. */
export function cleanPair(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const [a, b, ...rest] = value.split('-');
  return rest.length === 0 && CANDIDATE_KINDS.includes(a as CandidateKind) && CANDIDATE_KINDS.includes(b as CandidateKind) ? value : undefined;
}

/** Coarse buckets: never the exact count or size. */
export function filesBucket(n: number): string {
  if (n <= 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 20) return '6-20';
  if (n <= 100) return '21-100';
  return '100+';
}

export function bytesBucket(bytes: number): string {
  const MB = 1024 ** 2;
  const GB = 1024 ** 3;
  if (bytes < MB) return 'under 1 MB';
  if (bytes < 10 * MB) return '1-10 MB';
  if (bytes < 100 * MB) return '10-100 MB';
  if (bytes < GB) return '100 MB-1 GB';
  if (bytes < 10 * GB) return '1-10 GB';
  return 'over 10 GB';
}

/** What the Worker hands the page when telemetry is on. Absent when it is off. */
export interface ClientTelemetryConfig {
  key: string;
  /** Same-origin path the page sends to. */
  host: string;
  environment: string;
  release: string;
}
