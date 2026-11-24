import type { CandidateKind, ConnectionFailReason } from '../../shared/events.ts';
import type { AttemptLog, Pair, Route } from '../../shared/record.ts';

export type { AttemptLog, Pair, Route };

/**
 * What the browser's own connection tells us about how two devices found each other: which kinds of address each side
 * offered, which pair ended up in use, and why a direct connection did not open. Kinds are words (host, mdns, srflx, prflx, relay);
 * an address is read here only to tell the kind or to compare two public addresses on this device, and is never kept in a result.
 * Pure functions: no page, no network.
 */

const TYPES: Record<string, CandidateKind> = { host: 'host', srflx: 'srflx', prflx: 'prflx', relay: 'relay' };

/** A host candidate whose address is a `.local` name is a local address hidden behind a name only devices on the network can look up. */
function refine(type: CandidateKind, address: unknown): CandidateKind {
  return type === 'host' && typeof address === 'string' && address.toLowerCase().endsWith('.local') ? 'mdns' : type;
}

/** The kind and address of one candidate line (`candidate:… typ host`). Null for anything else. */
export function kindOfLine(line: unknown): { kind: CandidateKind; address: string } | null {
  if (typeof line !== 'string') return null;
  const parts = line.trim().split(/\s+/);
  const at = parts.indexOf('typ');
  const type = at >= 0 ? TYPES[parts[at + 1] ?? ''] : undefined;
  const address = parts[4];
  if (!type || !address) return null;
  return { kind: refine(type, address), address };
}

/** The pair the connection is using, as kinds. Null when the report names no pair or an unknown kind. */
export function selectedPair(report: { forEach(cb: (value: unknown, key: string) => void): void }): Pair | null {
  const all = new Map<string, Record<string, unknown>>();
  report.forEach((v, k) => all.set(k, (v ?? {}) as Record<string, unknown>));
  let pair: Record<string, unknown> | undefined;
  for (const s of all.values()) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = all.get(s.selectedCandidatePairId);
    if (pair) break;
  }
  pair ??= [...all.values()].find((s) => s.type === 'candidate-pair' && s.state === 'succeeded' && (s.selected === true || s.nominated === true));
  if (!pair) return null;
  const end = (id: unknown): CandidateKind | null => {
    const c = typeof id === 'string' ? all.get(id) : undefined;
    const type = c ? TYPES[String(c.candidateType)] : undefined;
    return type ? refine(type, c!.address ?? c!.ip) : null;
  };
  const local = end(pair.localCandidateId);
  const remote = end(pair.remoteCandidateId);
  return local && remote ? { local, remote } : null;
}

/** A pair that has a relay address at either end goes through our servers; any other pair is direct. */
export function routeOf(p: Pair): Route {
  return p.local === 'relay' || p.remote === 'relay' ? 'relay' : 'direct';
}

/**
 * A comparable form of a public address: an IPv4 address as it is, an IPv6 address by its first 64 bits (the part one
 * network shares). Only ever compared on this device; never stored in a result, sent or shown.
 */
export function publicKey(address: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return address;
  if (!address.includes(':') || !/^[0-9a-f:]+$/i.test(address)) return null;
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return 'v6:' + groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':');
}

/** What one connection has seen from both sides so far. Kinds are words; the public keys never leave the device. */
export interface Gathered {
  local: Set<CandidateKind>;
  remote: Set<CandidateKind>;
  localPublic: Set<string>;
  remotePublic: Set<string>;
}

export function createGathered(): Gathered {
  return { local: new Set(), remote: new Set(), localPublic: new Set(), remotePublic: new Set() };
}

/** Takes in one candidate line from this side or the other. */
export function note(g: Gathered, side: 'local' | 'remote', line: unknown): void {
  const c = kindOfLine(line);
  if (!c) return;
  g[side].add(c.kind);
  if (c.kind === 'srflx' || c.kind === 'prflx') {
    const key = publicKey(c.address);
    if (key) g[side === 'local' ? 'localPublic' : 'remotePublic'].add(key);
  }
}

const onLocalNetwork = (kinds: Set<CandidateKind>) => kinds.has('host') || kinds.has('mdns');
const sharePublic = (g: Gathered) => [...g.localPublic].some((k) => g.remotePublic.has(k));

/** False only when both sides know their public address and the two differ: then they are not on the same network. */
export function mayShareNetwork(g: Gathered): boolean {
  if (g.localPublic.size === 0 || g.remotePublic.size === 0) return true;
  return sharePublic(g);
}

/** Why a connection that is not direct is not. Call it once direct has failed or run out of time. */
export function whyNotDirect(g: Gathered, checksFailed: boolean, sameAddress?: boolean): ConnectionFailReason {
  if (g.remote.size === 0) return 'no_remote_candidates';
  // the room's own word that both devices reach us from one address counts as much as two matching public addresses (a page without a STUN answer has none)
  if (onLocalNetwork(g.local) && onLocalNetwork(g.remote) && (sharePublic(g) || sameAddress === true)) return 'same_network_blocked';
  // names only: at least one hidden local address, and nothing else but relay addresses (an empty set is not "only names")
  const onlyNames = (k: Set<CandidateKind>) => k.has('mdns') && [...k].every((x) => x === 'mdns' || x === 'relay');
  if (onlyNames(g.local) || onlyNames(g.remote)) return 'mdns_only';
  return checksFailed ? 'checks_failed' : 'timeout';
}

/** What the page learns when a connection opens. Words and numbers only. */
export interface ConnectionInfo {
  route: Route;
  pair: Pair | null;
  localKinds: CandidateKind[];
  remoteKinds: CandidateKind[];
  /** How long direct was given: until it opened, or until the route through our servers was asked for. */
  waitMs: number;
  /** `none` when direct. */
  reason: ConnectionFailReason;
}
