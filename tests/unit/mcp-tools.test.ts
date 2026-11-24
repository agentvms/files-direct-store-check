import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { programDevice } from '../../src/shared/device.ts';
import { createMcpServer } from '../../src/cli/src/mcp.ts';
import { Roots } from '../../src/cli/src/roots.ts';

// The MCP server lists every tool. This list is written at the source and checked there against what the server registers.
const TOOLS = ['ask_for_files', 'cancel_transfer', 'close_room', 'receive_files', 'send_files', 'transfer_status'];

it('lists every tool, including the one that asks a person for files', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fd-tools-')));
  mkdirSync(join(home, 'work'));
  const roots = await Roots.create([join(home, 'work')], { home });
  const env = { origin: 'http://127.0.0.1:9', ice: [], device: programDevice('Linux', 0), install: 'npm install -g example' };
  const { server, closeAll } = createMcpServer({ roots, env });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(listed).toEqual(TOOLS);
  closeAll();
});
