import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/cli/src/mcp.ts';
import { Run } from '../../src/cli/src/room.ts';
import { Roots } from '../../src/cli/src/roots.ts';
import { programDevice } from '../../src/shared/device.ts';

afterEach(() => vi.restoreAllMocks());

// the two methods the tests reach into
interface Inside {
  keepSaved(path: string, name: string, size: number): void;
  note(e: { event: 'progress'; done: number; total: number; speed: number; eta: number | null; file: string }): void;
}
type Reply = Record<string, unknown> & { transfer_id: string; saved: { name: string; bytes: number; path: string }[]; saved_files: number; saved_more: number };

// transfer_status lists the files that arrived from the run's own record, not from the rolling progress log
async function open() {
  const home = await mkdtemp(join(tmpdir(), 'fd-saved-'));
  const held: { run?: Inside } = {};
  vi.spyOn(Run.prototype, 'startAsk').mockImplementation(async function (this: Run) {
    held.run = this as unknown as Inside;
    Object.assign(this, { link: 'http://127.0.0.1:9/r/#abcdefghijklmnopqrstuv', code: '123456789' });
    (this as unknown as { resolveOpened(): void }).resolveOpened();
  });
  const roots = await Roots.create([home], { home });
  const { server } = createMcpServer({ roots, env: { origin: 'http://127.0.0.1:9', ice: [], device: programDevice('Linux', 0), install: 'example' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args = {}) => {
    const out = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return JSON.parse(out.content[0]!.text) as Reply;
  };
  const opened = await call('ask_for_files');
  return { home, run: () => held.run!, call, id: opened.transfer_id, close: async () => { await client.close(); await server.close(); } };
}

it('keeps the names, sizes and paths of saved files after later progress pushes their log events out', async () => {
  const s = await open();
  const run = s.run();
  const path = join(s.home, 'first.pdf');
  run.keepSaved(path, 'first.pdf', 100);
  const before = await s.call('transfer_status', { transfer_id: s.id });
  expect(before.saved).toEqual([{ name: 'first.pdf', bytes: 100, path }]);
  for (let i = 0; i < 501; i++) run.note({ event: 'progress', done: i, total: 1000, speed: 1, eta: null, file: 'second.bin' });
  const after = await s.call('transfer_status', { transfer_id: s.id });
  expect(after.saved).toEqual(before.saved);
  expect(after.saved_files).toBe(1);
  await s.close();
});

it('lists a long run of saved files a page at a time and says how many are left', async () => {
  const s = await open();
  const run = s.run();
  for (let i = 0; i < 130; i++) run.keepSaved(join(s.home, `f${i}.bin`), `f${i}.bin`, i);
  const one = await s.call('transfer_status', { transfer_id: s.id });
  expect(one.saved_files).toBe(130);
  expect(one.saved).toHaveLength(100);
  expect(one.saved[0]?.name).toBe('f0.bin');
  expect(one.saved_more).toBe(30);
  const two = await s.call('transfer_status', { transfer_id: s.id, saved_from: 100 });
  expect(two.saved.map((f) => f.name)).toEqual(Array.from({ length: 30 }, (_, i) => `f${100 + i}.bin`));
  expect(two.saved_more).toBe(0);
  await s.close();
});
