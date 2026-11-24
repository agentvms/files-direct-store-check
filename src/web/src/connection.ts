import { CREDENTIAL_RENEW_MS, DIRECT_RETRY_MS, DIRECT_TRY_MS, DIRECT_WAIT_LOCAL_MS, DIRECT_WAIT_MS, type RouteConfig } from '../../shared/route.ts';
import { type AttemptLog, type ConnectionInfo, type Pair, createGathered, kindOfLine, mayShareNetwork, note, routeOf, selectedPair, whyNotDirect } from './candidates.ts';
import type { CandidateKind, ConnectionFailReason } from '../../shared/events.ts';
import { type Message, type Signal } from './signal.ts';
import type { Role } from './types.ts';

// the record's code is fetched with the connection code, not with the first page
export { cleanRef, recordSender, recordText, roomRecord } from './record-send.ts';

export type Route = 'direct' | 'relay';

/** The longest the page waits for the connection's own report of the pair in use before it names the route from the attempt. */
const STATS_WAIT_MS = 1500;

export interface Connection {
  /** The attempts so far (at most the last eight) and how many direct tries were made while the transfer was on our servers. */
  log(): { attempts: AttemptLog[]; retries: number };
  /** Why the transfer is not (yet) direct, from what has been seen so far. `none` once a direct channel carries it. */
  why(): ConnectionFailReason;
  /** The room's word on whether both devices reach us from one address. */
  hint(same: boolean | undefined): void;
  /** Feed every message the room server passes on. */
  onSignal(msg: Message): void;
  /** Sender: start over from the beginning on the same room (the "Try again" button). */
  retry(): void;
  /** Close every connection but the one carrying the transfer (after a move to the direct one). */
  keepOnly(): void;
  close(): void;
}

export interface ConnectionHandlers {
  /** The first channel that opened, and which route it is on: named from the pair in use, which can differ from what was asked for. */
  onChannel(ch: RTCDataChannel, route: Route, info: ConnectionInfo): void;
  /** A direct channel that opened while the transfer is on the relay (only when the switch is on). */
  onDirectChannel?(ch: RTCDataChannel): void;
  onLost(): void;
  /** The room says there is no route through our servers. The direct try carries on; the page says it is taking longer. */
  onNoRelay?(): void;
  /** The log of attempts changed (an attempt ended, the route through our servers was asked for, a direct retry was made): the page keeps it. */
  onLog?(): void;
}

export interface ConnectionOptions {
  iceUrls: string[];
  route?: RouteConfig;
}

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

interface Attempt {
  id: number;
  route: Route;
  pc: RTCPeerConnection;
  remoteSet: boolean;
  early: RTCIceCandidateInit[];
  opened: boolean;
  /** The connection failed or closed: it must not be announced as a way through. */
  dead?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  started: number;
  endedAt?: number;
  ended: AttemptLog['ended'];
  local: Set<CandidateKind>;
  remote: Set<CandidateKind>;
  pair?: Pair | null;
}

type TestHooks = { __fdAllowDirect?: boolean };

/**
 * The browser's own connection. The sender makes the offer and the data channel when the room says both
 * are in; the receiver answers. It tries a direct connection first. If none opens in a few seconds it asks
 * the room for the route through our servers and connects that way, and while relayed it keeps trying
 * a direct connection in the background. Every message to the room names its attempt (`c`) and route (`k`).
 */
export function createConnection(role: Role, signal: Signal, opts: ConnectionOptions, h: ConnectionHandlers): Connection {
  const test = opts.route?.test;
  const attempts = new Map<number, Attempt>();
  let nextId = 0;
  let active: Attempt | null = null;
  let relayServers: IceServer[] = [];
  let relayAsked = false;
  let retryIndex = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let gathered = createGathered();
  let readyAt = Date.now();
  let relayAskedAt: number | undefined;
  let directFailed = false;
  /** Why direct did not open, taken when the route through our servers is asked for (the retry's own candidates must not rewrite it). */
  let directReason: ConnectionFailReason | undefined;
  let extended = false;
  let sameAddress: boolean | undefined;
  let retries = 0;
  const history: Attempt[] = [];
  const end = (a: Attempt, how: AttemptLog['ended']) => {
    if (a.endedAt === undefined) {
      a.endedAt = Date.now();
      a.ended = how;
      h.onLog?.();
    }
  };
  const baseWait = () => test?.directWaitMs ?? DIRECT_WAIT_MS;
  const localWait = () => (test ? test.directWaitMs * 2 : DIRECT_WAIT_LOCAL_MS);
  /** The other side offered addresses on its own network and the two could share one: a direct connection may still be coming. */
  const mayStillBeDirect = () => (gathered.remote.has('host') || gathered.remote.has('mdns')) && mayShareNetwork(gathered);

  const allowDirect = () => !test?.relayOnly || (globalThis as TestHooks).__fdAllowDirect === true;

  function config(route: Route): RTCConfiguration {
    if (route === 'relay') {
      const seen = new Set(relayServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])));
      const extra = opts.iceUrls.filter((u) => !seen.has(u));
      return { iceServers: [...(extra.length ? [{ urls: extra }] : []), ...relayServers], iceTransportPolicy: allowDirect() ? 'all' : 'relay' };
    }
    return { iceServers: opts.iceUrls.length ? [{ urls: opts.iceUrls }] : [], iceTransportPolicy: allowDirect() ? 'all' : 'relay' };
  }

  /** One unusable or late candidate from the other browser must never drop the whole connection. */
  async function addIce(a: Attempt, c: RTCIceCandidateInit): Promise<void> {
    if (a.dead) return;
    try {
      await a.pc.addIceCandidate(c);
    } catch {
      // ignore invalid or stale candidate; other pairs carry on
    }
  }

  function drop(a: Attempt): void {
    end(a, a.opened ? 'replaced' : a.timer === undefined && !a.dead ? 'closed' : a.dead ? 'failed' : 'timed out');
    clearTimeout(a.timer);
    attempts.delete(a.id);
    a.pc.close();
  }

  /** Close every attempt that has not opened a channel (and the active one too when `all`). */
  function clear(all: boolean): void {
    for (const a of [...attempts.values()]) if (all || (!a.opened && a !== active)) drop(a);
    if (all) active = null;
  }

  function make(id: number, route: Route): Attempt {
    const pc = new RTCPeerConnection(config(route));
    const a: Attempt = { id, route, pc, remoteSet: false, early: [], opened: false, started: Date.now(), ended: 'open', local: new Set(), remote: new Set() };
    attempts.set(id, a);
    history.push(a);
    if (history.length > 8) history.shift();
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) return;
      note(gathered, 'local', e.candidate.candidate);
      const k = kindOfLine(e.candidate.candidate);
      if (k) a.local.add(k.kind);
      signal.send({ t: 'candidate', c: id, d: e.candidate.toJSON() });
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') a.dead = false; // an early failure can recover before the channel opens
      if (pc.connectionState !== 'failed' && pc.connectionState !== 'closed') return;
      a.dead = true;
      end(a, 'failed');
      if (a === active) return h.onLost();
      if (!a.opened && a.route === 'direct' && !active && role === 'sender') {
        directFailed = true;
        if (mayStillBeDirect() && Date.now() - readyAt < localWait()) return; // the other side is on a network we might share: the timer decides
        askRelay(); // no direct route: do not wait out the timer
      }
      else if (!a.opened && attempts.get(id) === a) drop(a);
    });
    return a;
  }

  /** A channel of this attempt is open: the first one is the transfer's route, a later direct one may replace the relay. */
  function opened(a: Attempt, ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer';
    a.opened = true;
    clearTimeout(a.timer);
    if (!active) {
      active = a;
      clearTimeout(waitTimer);
      clear(false);
      settle(a, ch);
    } else if (opts.route?.switch && a.route === 'direct' && active.route === 'relay' && h.onDirectChannel) {
      leaveRelay();
      end(active, 'replaced'); // the relay no longer carries the transfer
      active = a;
      recordCarrying(a, null);
      h.onDirectChannel(ch);
      if (typeof a.pc.getStats === 'function') void pairWithin(a).then((pair) => { if (active === a && !a.dead) a.pair = pair; });
    } else {
      drop(a); // a second channel that is not a move to direct is not needed
    }
  }

  /**
   * The first channel is open. Name the route from the pair the connection actually uses: a try made through our servers
   * can still open on a direct pair (two devices on one Wi-Fi), and then it is direct. Whatever the other side sends in the
   * meantime is held and handed over once the page has the channel.
   */
  /** This attempt now carries the transfer: its record says so (a retry that ended earlier and later opens is carrying again, with the clock running). */
  function recordCarrying(a: Attempt, pair: Pair | null): void {
    a.pair = pair;
    a.ended = 'carrying';
    a.endedAt = undefined;
  }

  /** The pair the connection reports it is using, or null when it does not say within the wait. */
  function pairWithin(a: Attempt): Promise<Pair | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), STATS_WAIT_MS);
      a.pc.getStats().then((r) => { clearTimeout(timer); resolve(selectedPair(r)); }, () => { clearTimeout(timer); resolve(null); });
    });
  }

  function settle(a: Attempt, ch: RTCDataChannel): void {
    if (typeof a.pc.getStats !== 'function') return announce(a, ch, null);
    const held: Event[] = [];
    const hold = (e: Event) => held.push(e);
    ch.addEventListener('message', hold);
    let done = false;
    const finish = (pair: Pair | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ch.removeEventListener('message', hold);
      announce(a, ch, pair);
      if (active === a) for (const e of held) ch.dispatchEvent(new MessageEvent('message', { data: (e as MessageEvent).data }));
    };
    const timer = setTimeout(() => finish(null), STATS_WAIT_MS);
    a.pc.getStats().then((r) => finish(selectedPair(r)), () => finish(null));
  }

  function announce(a: Attempt, ch: RTCDataChannel, pair: Pair | null): void {
    if (active !== a || a.dead) return; // closed or failed while waiting
    if (ch.readyState === 'closing' || ch.readyState === 'closed') return h.onLost();
    const real: Route = pair ? routeOf(pair) : a.route;
    recordCarrying(a, pair);
    const info: ConnectionInfo = {
      route: real,
      pair,
      localKinds: [...gathered.local],
      remoteKinds: [...gathered.remote],
      waitMs: real === 'relay' ? (relayAskedAt ?? Date.now()) - readyAt : Date.now() - readyAt,
      reason: real === 'direct' ? 'none' : (directReason ?? whyNotDirect(gathered, directFailed, sameAddress)),
    };
    h.onChannel(ch, real, info);
    if (role !== 'sender') return;
    if (real === 'relay') {
      if (opts.route?.switch) scheduleRetry();
      renewTimer = setInterval(() => {
        if (active?.route === 'relay') signal.send({ t: 'relay' });
      }, CREDENTIAL_RENEW_MS);
    } else if (a.route === 'relay') {
      signal.send({ t: 'route', d: 'direct' }); // opened on a direct pair after all: the room ends the credential
    }
  }

  async function offer(route: Route): Promise<void> {
    const a = make(nextId++, route);
    const ch = a.pc.createDataChannel('files');
    ch.binaryType = 'arraybuffer';
    ch.addEventListener('open', () => opened(a, ch));
    await a.pc.setLocalDescription(await a.pc.createOffer());
    signal.send({ t: 'offer', c: a.id, k: route, d: a.pc.localDescription });
    if (route === 'direct' && active) a.timer = setTimeout(() => drop(a), test ? test.directWaitMs * 4 : DIRECT_TRY_MS);
  }

  /** The transfer is leaving the relay: no more direct tries, no more credential renewals. */
  function leaveRelay(): void {
    clearTimeout(retryTimer);
    clearInterval(renewTimer);
  }

  function askRelay(): void {
    if (relayAsked || active) return;
    relayAsked = true;
    relayAskedAt = Date.now();
    for (const a of attempts.values()) if (!a.opened) end(a, a.dead ? 'failed' : 'timed out'); // the direct try did not open in its time
    directReason = whyNotDirect(gathered, directFailed, sameAddress);
    h.onLog?.(); // the reason is now known
    signal.send({ t: 'relay' });
  }

  /** The plain wait is over. Wait on, once, when the other side may be on our network; otherwise ask for the route through our servers. */
  function directWaitUp(): void {
    if (active) return;
    if (!extended && mayStillBeDirect()) {
      extended = true;
      waitTimer = setTimeout(directWaitUp, Math.max(0, localWait() - baseWait()));
      return;
    }
    askRelay();
  }

  function scheduleRetry(): void {
    const wait = test ? test.retryMs : (DIRECT_RETRY_MS[Math.min(retryIndex, DIRECT_RETRY_MS.length - 1)] ?? 30_000);
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      if (active?.route !== 'relay') return;
      retries += 1;
      h.onLog?.();
      void offer('direct').catch(() => {});
      scheduleRetry();
    }, wait);
  }

  async function handle(msg: Message): Promise<void> {
    if (msg.t === 'ready' && role === 'sender') {
      clear(true);
      clearTimeout(retryTimer);
      clearInterval(renewTimer);
      relayAsked = false;
      relayAskedAt = undefined;
      retryIndex = 0;
      gathered = createGathered();
      directFailed = false;
      directReason = undefined;
      extended = false;
      readyAt = Date.now();
      await offer('direct');
      waitTimer = setTimeout(directWaitUp, baseWait());
    } else if (msg.t === 'relay') {
      const servers = (msg.d as { servers?: IceServer[] } | undefined)?.servers ?? [];
      relayServers = servers;
      for (const a of attempts.values()) if (a.route === 'relay') a.pc.setConfiguration(config('relay'));
      if (servers.length === 0 && !active) h.onNoRelay?.(); // no route through our servers: the page says so, the direct try carries on
      if (role === 'sender' && !active && relayAsked) {
        if (servers.length === 0) return;
        await offer('relay');
      }
    } else if (msg.t === 'offer' && role === 'receiver') {
      if (attempts.size === 0 && !active) readyAt = Date.now();
      if (active?.route === 'relay' && (msg.k ?? 'direct') === 'direct') {
        retries += 1; // the sender's direct try while the transfer is on our servers
        h.onLog?.();
      }
      if (active) clear(false);
      const a = make(msg.c ?? 0, msg.k ?? 'direct');
      a.pc.addEventListener('datachannel', (e) => {
        e.channel.binaryType = 'arraybuffer';
        if (e.channel.readyState === 'connecting') e.channel.addEventListener('open', () => opened(a, e.channel), { once: true });
        else opened(a, e.channel);
      });
      await a.pc.setRemoteDescription(msg.d as RTCSessionDescriptionInit);
      a.remoteSet = true;
      for (const c of a.early.splice(0)) await addIce(a, c);
      await a.pc.setLocalDescription(await a.pc.createAnswer());
      signal.send({ t: 'answer', c: a.id, d: a.pc.localDescription });
    } else if (msg.t === 'answer' && role === 'sender') {
      const a = attempts.get(msg.c ?? 0);
      if (!a) return;
      await a.pc.setRemoteDescription(msg.d as RTCSessionDescriptionInit);
      a.remoteSet = true;
      for (const c of a.early.splice(0)) await addIce(a, c);
    } else if (msg.t === 'candidate') {
      const line = (msg.d as RTCIceCandidateInit | undefined)?.candidate;
      note(gathered, 'remote', line);
      const a = attempts.get(msg.c ?? 0);
      if (!a) return;
      const k = kindOfLine(line);
      if (k) a.remote.add(k.kind);
      const c = msg.d as RTCIceCandidateInit;
      if (a.remoteSet) await addIce(a, c);
      else a.early.push(c);
    }
  }

  return {
    log: () => ({
      retries,
      attempts: history.map((a) => ({
        route: a.route,
        local: [...a.local],
        remote: [...a.remote],
        pair: a.pair ?? null,
        ms: (a.endedAt ?? Date.now()) - a.started,
        ended: a.ended,
      })),
    }),
    why: () => (active?.route === 'direct' || (active && active.pair && routeOf(active.pair) === 'direct') ? 'none' : (directReason ?? whyNotDirect(gathered, directFailed, sameAddress))),
    hint: (same) => {
      sameAddress = same;
    },
    // one message at a time, in the order the room passed them on
    onSignal: (msg) => {
      queue = queue.then(() => handle(msg)).catch(() => h.onLost());
    },
    retry() {
      if (role === 'sender') queue = queue.then(() => handle({ t: 'ready' })).catch(() => h.onLost());
    },
    keepOnly() {
      for (const a of [...attempts.values()]) if (a !== active) drop(a);
    },
    close: () => {
      clearTimeout(retryTimer);
      clearTimeout(waitTimer);
      clearInterval(renewTimer);
      clear(true);
    },
  };
}
