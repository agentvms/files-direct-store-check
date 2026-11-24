import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSignal, type JoinFailure } from '../../src/web/src/signal.ts';

type Listener = (e?: unknown) => void;
class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  private on = new Map<string, Listener[]>();
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.on.set(type, [...(this.on.get(type) ?? []), fn]);
  }
  fire(type: string, e?: unknown) {
    for (const f of this.on.get(type) ?? []) f(e);
  }
  open() {
    this.readyState = 1;
    this.fire('open');
  }
  /** The browser's view of a refused or dropped upgrade: a close, and no reason. */
  refuse() {
    this.readyState = 3;
    this.fire('close');
  }
  send() {}
  close() {}
}

const probes: (() => Response | Promise<Response>)[] = [];
const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers });

function join(target: Parameters<typeof openSignal>[0] = { kind: 'room', id: 'room1' }) {
  const failed: [JoinFailure, number | undefined][] = [];
  const messages: unknown[] = [];
  const signal = openSignal(target, 'receiver', {
    onMessage: (m) => messages.push(m),
    onFailed: (why, wait) => failed.push([why, wait]),
    onClosed: () => {},
  });
  return { signal, failed, messages };
}

const settle = () => vi.advanceTimersByTimeAsync(10_000);

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  probes.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'x.test' });
  vi.stubGlobal('fetch', vi.fn(async () => (probes.shift() ?? answer(426))()));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a program is not a page (files-direct-27)', () => {
  it('a refused socket that reports an error and never closes (node) is read as a refusal, once', async () => {
    probes.push(answer(404), answer(404), answer(404), answer(404));
    const { failed } = join();
    // node's WebSocket: "error" for a refused upgrade, and no "close"; a browser sends both, which must not count twice
    const done = new Set<FakeSocket>();
    for (let round = 0; round < 8; round++) {
      for (const s of FakeSocket.all) {
        if (done.has(s)) continue;
        done.add(s);
        s.fire('error');
        if (s === FakeSocket.all[0]) s.refuse();
      }
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(failed).toEqual([['gone', undefined]]);
    expect(FakeSocket.all).toHaveLength(4); // the first try and the three more the page's rule allows
  });
  it('an error after the socket opened changes nothing (the close that follows is the end)', async () => {
    const { failed } = join();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.fire('error');
    await settle();
    expect(failed).toEqual([]);
    expect(FakeSocket.all).toHaveLength(1);
  });
  it('asks for the room at the address it was given, with the headers it was given, and not at the page\'s own', async () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'page.test' });
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (seen.push({ url, init }), new Response('{}', { status: 426 }))));
    openSignal({ kind: 'room', id: 'room1' }, 'receiver', { onMessage: () => {}, onFailed: () => {}, onClosed: () => {} }, { origin: 'http://127.0.0.1:9999', headers: { 'x-mark': 'yes' } });
    FakeSocket.all[0]!.fire('error');
    await settle();
    expect(FakeSocket.all[0]!.url).toBe('ws://127.0.0.1:9999/api/rooms/room1/ws?role=receiver');
    expect(seen[0]).toMatchObject({ url: 'http://127.0.0.1:9999/api/rooms/room1/ws?role=receiver', init: { headers: { 'x-mark': 'yes' } } });
  });
});

describe('joining by the link', () => {
  it('tries again when the room is fine (the probe says it could be joined) instead of saying the server is unreachable', async () => {
    const { failed, messages } = join();
    FakeSocket.all[0]!.refuse(); // one socket failed; the room itself is fine: the probe answers 426
    await settle();
    expect(failed).toEqual([]);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.fire('message', { data: JSON.stringify({ t: 'ready' }) });
    expect(messages).toEqual([{ t: 'ready' }]);
    expect(failed).toEqual([]);
  });

  it('tries again after a server error or a probe that did not arrive', async () => {
    const { failed } = join();
    probes.push(answer(500, { error: 'server-error' }), () => Promise.reject(new TypeError('Failed to fetch')));
    FakeSocket.all[0]!.refuse();
    await settle();
    FakeSocket.all[1]!.refuse();
    await settle();
    expect(FakeSocket.all).toHaveLength(3);
    expect(failed).toEqual([]);
  });

  it('gives up with the network message only after a few tries', async () => {
    const { failed } = join();
    for (let i = 0; i < 10 && failed.length === 0; i++) {
      FakeSocket.all.at(-1)!.refuse();
      await settle();
    }
    expect(failed).toEqual([['network', undefined]]);
    expect(FakeSocket.all.length).toBeGreaterThan(2);
    expect(FakeSocket.all.length).toBeLessThanOrEqual(6);
  });

  it('does not try again when the room answered for good: full, or a limit with a wait', async () => {
    const full = join();
    probes.push(answer(409, { error: 'room-full' }));
    FakeSocket.all[0]!.refuse();
    await settle();
    expect(full.failed).toEqual([['full', undefined]]);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('does not try again when new rooms are paused (503): it ends on paused', async () => {
    const paused = join();
    probes.push(answer(503, { error: 'rooms-off' }));
    FakeSocket.all[0]!.refuse();
    await settle();
    expect(paused.failed).toEqual([['paused', undefined]]);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('tries again when the sender has not opened the room yet, then says the link is gone', async () => {
    const early = join();
    probes.push(answer(404, { error: 'room-not-found' }));
    FakeSocket.all[0]!.refuse();
    await settle();
    expect(early.failed).toEqual([]);
    expect(FakeSocket.all).toHaveLength(2);

    const gone = join();
    for (let i = 0; i < 10 && gone.failed.length === 0; i++) {
      probes.push(answer(404, { error: 'room-not-found' }));
      FakeSocket.all.at(-1)!.refuse();
      await settle();
    }
    expect(gone.failed).toEqual([['gone', undefined]]);
  });

  it('does not try again once the page closed the signal', async () => {
    const { signal, failed } = join();
    signal.close();
    FakeSocket.all[0]!.refuse();
    await settle();
    expect(FakeSocket.all).toHaveLength(1);
    expect(failed).toEqual([]);
  });
});

describe('the room limit', () => {
  it('is told as a limit with its wait, never as the network, and not tried again', async () => {
    const { failed } = join();
    probes.push(answer(429, { error: 'too-many-rooms', retryAfter: 1500 }, { 'retry-after': '1500' }));
    FakeSocket.all[0]!.refuse();
    await settle();
    expect(failed).toEqual([['busy', 1500]]);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('is not tried again by a sender either, whatever the probe says', async () => {
    const failed: JoinFailure[] = [];
    openSignal({ kind: 'room', id: 'room1' }, 'sender', { onMessage: () => {}, onFailed: (w) => failed.push(w), onClosed: () => {} });
    FakeSocket.all[0]!.refuse();
    await settle();
    expect(failed).toEqual(['network']);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('joining by the code', () => {
  it('never tries a code twice: a wrong code counts every time', async () => {
    const { failed } = join({ kind: 'code', code: '123456789' });
    await settle(); // the probe answered 426: the socket opens
    FakeSocket.all[0]!.refuse();
    await settle();
    expect(FakeSocket.all).toHaveLength(1);
    expect(failed).toEqual([['network', undefined]]);
  });
});

describe('the start word of a room that asks (files-direct-28)', () => {
  const open = (role: 'sender' | 'receiver', target: Parameters<typeof openSignal>[0], start?: 'ask') => {
    openSignal(target, role, { onMessage: () => {}, onFailed: () => {}, onClosed: () => {} }, undefined, start);
    return FakeSocket.all[0]?.url;
  };
  it('is on the creator\'s socket and only there: a sender asking says so, a plain sender and a receiver never do', () => {
    expect(open('sender', { kind: 'room', id: 'room1' }, 'ask')).toBe('ws://x.test/api/rooms/room1/ws?role=sender&start=ask');
    FakeSocket.all = [];
    expect(open('sender', { kind: 'room', id: 'room1' })).toBe('ws://x.test/api/rooms/room1/ws?role=sender');
    FakeSocket.all = [];
    expect(open('receiver', { kind: 'room', id: 'room1' }, 'ask')).toBe('ws://x.test/api/rooms/room1/ws?role=receiver');
  });
  it('carries nothing else: no note, and the plain request that asks why a socket was refused has the same address', async () => {
    const note = 'the signed lease';
    open('sender', { kind: 'room', id: 'room1' }, 'ask');
    FakeSocket.all[0]!.refuse();
    await vi.advanceTimersByTimeAsync(10);
    const asked = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0]);
    expect(asked).toEqual(['http://x.test/api/rooms/room1/ws?role=sender&start=ask']);
    for (const u of [FakeSocket.all[0]!.url, ...asked]) expect(u).not.toContain(note.split(' ')[0]!);
  });
});
