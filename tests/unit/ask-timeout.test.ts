import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const handlers: { onMessage?: (m: unknown) => void }[] = [];
vi.mock('../../src/web/src/signal.ts', () => ({
  openSignal: (_t: unknown, _r: unknown, h: { onMessage: (m: unknown) => void }) => {
    handlers.push(h);
    return { send() {}, close() {} };
  },
}));

import { ask } from '../../src/cli/src/room.ts';
import { programDevice } from '../../src/shared/device.ts';

afterEach(() => vi.useRealTimers());

// the limit for an ask names what happened: nobody opened the link, or someone did and sent nothing
async function run(visit: boolean) {
  const dest = await mkdtemp(join(tmpdir(), 'fd-timeout-'));
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  const r = ask({ origin: 'http://127.0.0.1:9', ice: [], device: programDevice('Linux', 0), install: 'example' }, { dest, waitMs: 60_000 });
  await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
  const h = handlers.pop()!;
  if (visit) {
    h.onMessage?.({ t: 'device', d: { device: { kind: 'phone', system: 'ios' } } });
    h.onMessage?.({ t: 'receiver-left' });
  }
  vi.advanceTimersByTime(60_000);
  return (await r.done).outcome;
}

it('says nobody_came when nobody opened the request', async () => {
  expect(await run(false)).toBe('nobody_came');
});

it('says nothing_sent when someone opened it, left and sent nothing', async () => {
  expect(await run(true)).toBe('nothing_sent');
});
