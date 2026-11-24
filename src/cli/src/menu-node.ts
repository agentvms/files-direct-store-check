import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MenuEffects } from './menu.ts';

const run = (file: string, args: string[], env?: Record<string, string>): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: String(stdout) + String(stderr) });
    });
  });

const REG = 'reg.exe';
const HKCU_ROOT = 'HKCU\\';

/** The real machine: files, reg.exe and PowerShell on Windows (the person's own part of the registry only), the Services refresh on a Mac. */
export function nodeEffects(env: Record<string, string | undefined> = process.env, platform: string = process.platform): MenuEffects {
  const sendToDir = env.APPDATA ? join(env.APPDATA, 'Microsoft', 'Windows', 'SendTo') : undefined;
  const regKey = (key: string): string => {
    if (!key.startsWith(HKCU_ROOT)) throw new Error('only the current user\'s part of the registry may be changed');
    return key;
  };
  return {
    platform,
    home: env.HOME ?? env.USERPROFILE ?? homedir(),
    sendToDir,
    async writeFile(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    removePath: (path) => rm(path, { recursive: true, force: true }),
    exists: (path) => access(path).then(() => true, () => false),
    async regImport(text) {
      const dir = await mkdtemp(join(tmpdir(), 'fd-reg-'));
      const file = join(dir, 'menu.reg');
      try {
        // reg import reads UTF-16 with a byte order mark, so a path with any letter in it is kept
        await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
        const r = await run(REG, ['import', file]);
        if (r.code !== 0) throw new Error('Windows would not take the menu entry: ' + r.out.trim());
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async regDelete(key) {
      const r = await run(REG, ['delete', regKey(key), '/f']);
      if (r.code !== 0 && (await this.regExists(key))) throw new Error('Windows would not remove the menu entry: ' + r.out.trim());
    },
    async regPruneEmpty(key) {
      const r = await run(REG, ['query', regKey(key)]);
      if (r.code !== 0) return;
      const lines = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length <= 1) await run(REG, ['delete', regKey(key), '/f']); // only its own name came back: nothing in it
    },
    regExists: async (key) => (await run(REG, ['query', regKey(key)])).code === 0,
    async shortcut(path, target, args) {
      await mkdir(dirname(path), { recursive: true });
      // the values travel in the environment, never inside the script text
      const script = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:FD_LNK);$s.TargetPath=$env:FD_TARGET;$s.Arguments=$env:FD_ARGS;$s.WindowStyle=7;$s.Description=$env:FD_TEXT;$s.Save()';
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { FD_LNK: path, FD_TARGET: target, FD_ARGS: args, FD_TEXT: 'Send with Files Direct' });
      if (r.code !== 0) throw new Error('Windows would not make the Send to shortcut: ' + r.out.trim());
    },
    async refreshServices() {
      if (platform === 'darwin') await run('/System/Library/CoreServices/pbs', ['-update']); // for this user; if it is not there or refuses, Finder finds the folder by itself
    },
  };
}
