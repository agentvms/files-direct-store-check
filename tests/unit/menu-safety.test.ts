import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { quickActionScript, windowsSendToArguments, windowsVerbCommand } from '../../src/cli/src/menu.ts';

// files-direct-30, done-when 1: a file with a hostile name reaches the program as one separate argument and nothing else runs.
// This is the first test of the epic and it was written against a naive version (paths pasted into the command line); it must fail there.
// The Mac script runs here under /bin/sh and under bash with a fake program that writes the arguments it got. The Windows command lines are
// read the way Windows reads them (the C runtime's rules) after Explorer has put the chosen file in the place of %1.

const root = realpathSync(mkdtempSync(join(tmpdir(), 'fd-cli-menu-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Every name that has to survive. Control characters and a newline only where the system allows them. */
const HOSTILE = [
  'plain.txt',
  'two words.txt',
  'say "hi".txt',
  "it's.txt",
  'a;touch pwned.txt',
  '$(touch pwned).txt',
  '`touch pwned`.txt',
  'a&touch pwned&.txt',
  '100%.txt',
  '%1 %L %V %*.txt',
  'caret^name.txt',
  '-rf.txt',
  '--help',
  '-',
  '~',
  '*.txt',
  'back\\slash.txt',
  'tab\there.txt',
  'two\nlines.txt',
  'ünï-名前.txt',
  '  padded  ',
  '$HOME',
  '${HOME}',
  '! history',
  '#hash',
];
// what Windows allows in a name: no quote, backslash, tab, newline or the characters < > : | ? *
const WINDOWS_OK = HOSTILE.filter((n) => !/["\\\t\n<>:|?*]/.test(n));

/** How Windows splits a command line into arguments (the rules of CommandLineToArgvW and the C runtime). */
function argvOf(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    while (i < line.length) {
      let slashes = 0;
      while (line[i] === '\\') {
        slashes++;
        i++;
      }
      if (line[i] === '"') {
        arg += '\\'.repeat(slashes >> 1);
        if (slashes & 1) arg += '"';
        else quoted = !quoted;
        i++;
      } else {
        arg += '\\'.repeat(slashes);
        if (i >= line.length || (!quoted && (line[i] === ' ' || line[i] === '\t'))) break;
        arg += line[i++];
      }
    }
    out.push(arg);
  }
  return out;
}

/** A fake program in a folder whose own name is hostile: it writes the arguments it received, one JSON line, next to itself. */
function fakeProgram(folder: string): { node: string; script: string; out: string } {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'files-direct.mjs');
  const out = join(dir, 'argv.json');
  writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  return { node: process.execPath, script, out };
}

async function waitFor(file: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (text) return text;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the program never ran');
}

describe('the Mac Quick Action script', () => {
  for (const shell of ['/bin/sh', '/bin/bash']) {
    it(`hands every hostile name to the program as one argument, under ${shell}, and runs nothing else`, async () => {
      const work = mkdtempSync(join(root, 'cwd-'));
      for (const folder of ['prog', "Ann's & Bob's \"files\" $(touch pwned-prog)", 'new\nline']) {
        const p = fakeProgram(join('run-' + shell.split('/').pop(), folder));
        const script = join(work, 'action.sh');
        writeFileSync(script, quickActionScript({ node: p.node, script: p.script }));
        const run = spawnSync(shell, [script, ...HOSTILE], { cwd: work, encoding: 'utf8' });
        expect(run.status, run.stderr).toBe(0);
        const argv = JSON.parse(await waitFor(p.out)) as string[];
        const at = argv.indexOf('--');
        expect(argv[0], 'the program is told what to do first').toBe('open');
        expect(at, 'a "--" ends the options, so a name that starts with "-" is a name').toBeGreaterThan(0);
        expect(argv.slice(at + 1)).toEqual(HOSTILE);
        expect(argv.slice(1, at).some((a) => HOSTILE.includes(a))).toBe(false);
        rmSync(p.out);
      }
      expect(readdirSync(work).sort(), 'nothing was created by a name').toEqual(['action.sh']);
      expect(existsSync(join(root, 'pwned'))).toBe(false);
    });
  }

  it('does nothing harmful and says so in plain words when the program is gone', () => {
    const work = mkdtempSync(join(root, 'gone-'));
    const script = join(work, 'action.sh');
    writeFileSync(script, quickActionScript({ node: process.execPath, script: join(work, 'not-here.mjs') }));
    const run = spawnSync('/bin/sh', [script, 'a.txt'], { cwd: work, encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
    expect(run.status).toBe(0);
    expect(readdirSync(work)).toEqual(['action.sh']);
  });
});

describe('the Windows registry entry and the Send to shortcut', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const script = "C:\\Users\\Ann & Bob's \\AppData\\Roaming\\npm\\node_modules\\files-direct\\dist\\files-direct.mjs";

  it('registry: the chosen file is one argument after "--", whatever it is called', () => {
    const line = windowsVerbCommand({ node, script });
    for (const name of WINDOWS_OK) {
      const path = 'C:\\Users\\Ann\\Documents\\' + name;
      const argv = argvOf(line.replace('%1', () => path));
      const at = argv.indexOf('--');
      expect(argv.slice(0, 2), name).toEqual([node, script]);
      expect(argv.slice(2, at), name).toEqual(['open', '--detach', '--gather']);
      expect(argv.slice(at + 1), name).toEqual([path]);
    }
  });

  it('Send to: Windows adds the chosen files after the arguments; they come through one by one after "--"', () => {
    const args = windowsSendToArguments({ node, script });
    const argv = argvOf(args);
    expect(argv.slice(0, 3)).toEqual([script, 'open', '--detach']);
    expect(argv.at(-1)).toBe('--');
    // Explorer adds each file as its own quoted argument
    const files = WINDOWS_OK.map((n) => 'C:\\Users\\Ann\\' + n);
    const whole = argvOf(args + ' ' + files.map((f) => '"' + f + '"').join(' '));
    expect(whole.slice(whole.indexOf('--') + 1)).toEqual(files);
  });

  it('refuses a program path that Windows would change on the way (a % in it)', () => {
    expect(() => windowsVerbCommand({ node, script: 'C:\\100%Legal\\files-direct.mjs' })).toThrow(/%/);
  });
});

// keeps the helper honest: the reader of command lines splits as Windows does
describe('the command-line reader used above', () => {
  it('splits like Windows', () => {
    expect(argvOf('a "b c" d\\"e "f\\\\" g')).toEqual(['a', 'b c', 'd"e', 'f\\', 'g']);
    expect(execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")']).toString()).toBe('ok');
  });
});
