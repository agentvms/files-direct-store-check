import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Desk } from '../../src/cli/src/window.ts';
import { Run, type RoomEnv } from '../../src/cli/src/room.ts';
import { programDevice } from '../../src/shared/device.ts';

// files-direct-30: the question "let this person in?" belongs to the visitor who knocked. When that visitor leaves, or another knocks, the old question is
// dead: its timer and its answer can never decline or admit the next one, and can never clear the next one's prompt. Time is made up; the Run is driven by
// the room's own messages ("knock", "knock-gone"), the way the room service sends them.

const env = { origin: 'http://127.0.0.1:1', ice: [], device: programDevice('Linux', 0), install: '' } as RoomEnv;
const T = 60_000;

function rig() {
  const desk = new Desk({ env, downloads: '/tmp/not-used', knockMs: T });
  const run = new Run(env, 'sender') as unknown as { signal: unknown; conn: unknown; onSenderMessage(m: unknown, o: unknown): void; events: { event: string; allowed?: boolean }[] };
  const sent: { t: string }[] = [];
  run.signal = { send: (m: { t: string }) => sent.push(m) };
  run.conn = { onSignal: () => {} };
  const options = { letIn: (gone: AbortSignal) => (desk as unknown as { letIn(g: AbortSignal): Promise<boolean> }).letIn(gone) };
  return { desk, run, sent, knock: () => run.onSenderMessage({ t: 'knock' }, options), gone: () => run.onSenderMessage({ t: 'knock-gone' }, options) };
}
const words = (r: ReturnType<typeof rig>) => r.sent.map((m) => m.t);

describe('a question about a visitor', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('shows while someone is knocking, and is turned away by Turn away or let in by Let them in, once', async () => {
    const r = rig();
    r.knock();
    expect(r.desk.snapshot().knock).toBe(true);
    await r.desk.act({ do: 'turn-away' });
    await vi.advanceTimersByTimeAsync(0);
    expect(words(r)).toEqual(['decline']);
    expect(r.desk.snapshot().knock).toBe(false);
    await r.desk.act({ do: 'turn-away' }); // nothing is asked any more: nothing is sent
    await vi.advanceTimersByTimeAsync(T * 2);
    expect(words(r)).toEqual(['decline']);
    r.knock();
    await r.desk.act({ do: 'allow' });
    await vi.advanceTimersByTimeAsync(0);
    expect(words(r)).toEqual(['decline', 'allow']);
  });

  it('declines a knock nobody answers after the time, and says so', async () => {
    const r = rig();
    r.knock();
    await vi.advanceTimersByTimeAsync(T - 1);
    expect(r.desk.snapshot().knock).toBe(true);
    expect(words(r)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(words(r)).toEqual(['decline']);
    expect(r.desk.snapshot().knock).toBe(false);
  });

  it('a visitor who leaves takes the question with them: it goes from the window and nothing is sent', async () => {
    const r = rig();
    r.knock();
    await vi.advanceTimersByTimeAsync(10_000);
    r.gone();
    expect(r.desk.snapshot().knock).toBe(false);
    await vi.advanceTimersByTimeAsync(T * 2);
    expect(words(r)).toEqual([]);
    // the button pressed late answers nobody
    await r.desk.act({ do: 'allow' });
    await vi.advanceTimersByTimeAsync(0);
    expect(words(r)).toEqual([]);
  });

  it('the old visitor\'s timer cannot decline the next one or clear their prompt (knock at 0, gone at 10 s, a new knock at 20 s)', async () => {
    const r = rig();
    r.knock();
    await vi.advanceTimersByTimeAsync(10_000);
    r.gone();
    await vi.advanceTimersByTimeAsync(10_000);
    r.knock();
    await vi.advanceTimersByTimeAsync(40_000); // t = 60 s: the first question's time is up
    expect(words(r)).toEqual([]);
    expect(r.desk.snapshot().knock).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000 - 1); // the second one still has its own full minute
    expect(words(r)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(words(r)).toEqual(['decline']);
    expect(r.desk.snapshot().knock).toBe(false);
  });

  it('a new knock without a "gone" in between replaces the question: only the newest is answered', async () => {
    const r = rig();
    r.knock();
    await vi.advanceTimersByTimeAsync(5_000);
    r.knock();
    await vi.advanceTimersByTimeAsync(55_000);
    expect(words(r)).toEqual([]);
    expect(r.desk.snapshot().knock).toBe(true);
    await r.desk.act({ do: 'allow' });
    await vi.advanceTimersByTimeAsync(0);
    expect(words(r)).toEqual(['allow']);
  });

  it('the run ending takes the question away, and nothing is sent to a room that is closed', async () => {
    const r = rig();
    r.knock();
    (r.run as unknown as { ended: boolean }).ended = true;
    await r.desk.act({ do: 'allow' });
    await vi.advanceTimersByTimeAsync(T);
    expect(words(r)).toEqual([]);
  });
});
