import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli, type Io } from '../../src/cli/src/cli.ts';

// files-direct-30: "open --detach", what the Windows menu entries run. The program starts its real run again without a window of its own and ends at once.

const root = realpathSync(mkdtempSync(join(tmpdir(), 'fd-cli-detach-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const out: string[] = [];
const io = (program?: Io['program']): Io => ({ out: (t) => out.push(t), err: (t) => out.push('ERR ' + t), tty: false, env: {}, program });

async function waitFor(file: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(file) && readFileSync(file, 'utf8')) return readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the run never started');
}

function fake(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  const script = join(dir, 'files-direct.mjs');
  const log = join(dir, 'argv.json');
  writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
  return { program: { node: process.execPath, script }, log };
}

describe('open --detach', () => {
  it('starts the same command again, without --detach, with every path after "--" untouched, and ends at once with status 0', async () => {
    const f = fake('a');
    const names = ['--detach', '-x', 'two words', '$(touch pwned)', "it's"];
    const code = await runCli(['open', '--detach', '--gather', '--', ...names], io(f.program));
    expect(code).toBe(0);
    expect(JSON.parse(await waitFor(f.log))).toEqual(['open', '--gather', '--', ...names]);
  });

  it('drops --detach wherever it is among the options, and when there is no "--"', async () => {
    const f = fake('b');
    expect(await runCli(['open', '--gather', '--detach', '--no-window', 'file one', '--detach'], io(f.program))).toBe(0);
    expect(JSON.parse(await waitFor(f.log))).toEqual(['open', '--gather', '--no-window', 'file one']);
  });

  it('says so in words when it does not know where it is installed, and starts nothing', async () => {
    out.length = 0;
    expect(await runCli(['open', '--detach', '--', 'x'], io())).toBe(1);
    expect(out.join('\n')).toMatch(/does not know where it is installed/);
  });
});
