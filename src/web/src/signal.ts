import type { Role } from './types.ts';

/** `c` names the connection attempt a message belongs to and `k` its route ("direct" or "relay"). */
export type Message = { t: string; d?: unknown; c?: number; k?: 'direct' | 'relay'; code?: string; ref?: string; retryAfter?: number; reason?: string };

export interface Signal {
  send(msg: Message): void;
  close(): void;
}

export type JoinFailure = 'gone' | 'full' | 'busy' | 'paused' | 'network' | 'wrong-code' | 'slow-down';

export interface SignalHandlers {
  onMessage(msg: Message): void;
  /** The server could not be reached, or the room refused us. `waitSeconds` comes with `slow-down`. */
  onFailed(why: JoinFailure, waitSeconds?: number): void;
  onClosed(): void;
}

/** Where to connect: a room by its id (the link), or a room by the nine-digit code. */
export type Target = { kind: 'room'; id: string } | { kind: 'code'; code: string };

/** Where the room server is, when this is not a page (the command-line program): its address, and headers to add to every request (the test lane's mark). */
export interface SignalWhere {
  origin: string;
  headers?: Record<string, string>;
}

function wsUrl(target: Target, role: Role, where?: SignalWhere, start?: 'ask'): string {
  const u = where ? new URL(where.origin) : location;
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return target.kind === 'room'
    ? `${proto}//${u.host}/api/rooms/${target.id}/ws?role=${role}${role === 'sender' && start ? '&start=' + start : ''}`
    : `${proto}//${u.host}/api/codes/${target.code}/ws`;
}

function failureOf(status: number): JoinFailure {
  return status === 404 ? 'gone' : status === 409 ? 'full' : status === 429 ? 'busy' : status === 503 ? 'paused' : 'network';
}

/**
 * A link join that fails for a reason that can pass is tried again after these waits (so four tries in about three seconds):
 * the sender's page shows the link a moment before its own socket is in the room (404), one socket may simply drop (the
 * probe then says the room can be joined, 426), or the server may blink (5xx, or no answer). Full (409), a limit (429) and paused (503, the
 * stop switch) are final. Only a receiver (a sender's socket opens a room, and every one counts against the room limit) and only links: a code is
 * never tried twice, because every wrong code counts.
 */
export const JOIN_RETRY_MS = [300, 800, 1600];

function mayPass(status: number | null): boolean {
  return status === null || status === 404 || status === 426 || (status >= 500 && status !== 503);
}

/**
 * Opens the room's WebSocket. A browser hides why a socket was refused, so for a link a plain request asks
 * after a failure. A code is asked first, once: every wrong code counts against the person's limit, so it
 * must not be tried twice.
 */
export function openSignal(target: Target, role: Role, h: SignalHandlers, where?: SignalWhere, start?: 'ask'): Signal {
  let ws: WebSocket | null = null;
  let closed = false;
  let tries = 0;
  const httpUrl = () => wsUrl(target, role, where, start).replace(/^ws/, 'http');
  const plain = (): RequestInit | undefined => (where?.headers ? { headers: where.headers } : undefined);

  function connect(): void {
    // a page cannot add headers to its socket; a program can (the second argument is the program's own WebSocket)
    const socket = where?.headers ? new (WebSocket as unknown as new (url: string, o: unknown) => WebSocket)(wsUrl(target, role, where, start), { headers: where.headers }) : new WebSocket(wsUrl(target, role, where, start));
    ws = socket;
    let opened = false;
    socket.addEventListener('open', () => (opened = true));
    socket.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      try {
        h.onMessage(JSON.parse(e.data) as Message);
      } catch {
        // not ours to read
      }
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (opened || closed) return h.onClosed();
      if (target.kind === 'code') return h.onFailed('network');
      void askWhy();
    };
    socket.addEventListener('close', end);
    // a socket the server refused: a browser says so and then closes; node's own WebSocket says so and never closes
    socket.addEventListener('error', () => {
      if (!opened) end();
    });
  }

  /** The socket was refused or dropped before it opened: a plain request says why, and a passing reason gets another try. */
  async function askWhy(): Promise<void> {
    let status: number | null = null;
    let wait: number | undefined;
    try {
      const r = await fetch(httpUrl(), plain());
      status = r.status;
      if (status === 429) {
        const body = (await r.json().catch(() => ({}))) as { retryAfter?: number };
        wait = body.retryAfter ?? (Number(r.headers.get('retry-after')) || undefined);
      }
    } catch {
      // no answer: counts as a server that blinked
    }
    if (closed) return;
    if (role === 'receiver' && mayPass(status) && tries < JOIN_RETRY_MS.length) {
      setTimeout(() => !closed && connect(), JOIN_RETRY_MS[tries++]);
      return;
    }
    h.onFailed(status === null ? 'network' : failureOf(status), wait);
  }

  if (target.kind === 'code') {
    fetch(httpUrl(), plain())
      .then(async (r) => {
        if (closed) return;
        if (r.status === 426) return connect();
        if (r.status === 404) return h.onFailed('wrong-code');
        if (r.status === 429) {
          const body = (await r.json().catch(() => ({}))) as { retryAfter?: number };
          return h.onFailed('slow-down', body.retryAfter ?? Number(r.headers.get('retry-after') ?? 30));
        }
        h.onFailed(r.status === 409 ? 'full' : 'network');
      })
      .catch(() => h.onFailed('network'));
  } else {
    connect();
  }

  return {
    send: (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: () => {
      closed = true;
      ws?.close(1000, 'bye');
    },
  };
}
