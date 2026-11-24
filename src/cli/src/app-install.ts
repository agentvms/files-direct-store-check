/**
 * What the double-click app does on the computer besides sending: where it is installed, how a downloaded update is put in place, and how it takes itself away.
 * The menu-bar program (Mac) and the tray program (Windows) are small shells; every rule is here, in the program they start.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { MenuEffects } from './menu.ts';
import { removeMenu } from './menu.ts';
import { type Feed, type UpdateTarget, UPDATE_TARGETS, UpdateRefused } from './update.ts';

/** The Mac app's identity: the name of its Preferences file and the like. Written once, here. */
export const APP_BUNDLE_ID = 'com.tnyforge.filesdirect';
export const MAC_APP = 'Files Direct.app';

export interface AppInfo {
  target: UpdateTarget;
  /** The folder the program's file is in. */
  dir: string;
  /** The Mac bundle (the .app folder), when this is the Mac app. */
  bundle?: string;
}

/** The app says what it is in app.json, next to its engine file. A program from npm has no such file. */
export function readAppInfo(script: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): AppInfo | null {
  const dir = dirname(script);
  try {
    const j = JSON.parse(read(join(dir, 'app.json'))) as { target?: unknown };
    if (typeof j.target !== 'string' || !(UPDATE_TARGETS as readonly string[]).includes(j.target)) return null;
    const target = j.target as UpdateTarget;
    return { target, dir, bundle: target.startsWith('mac-') ? resolve(dir, '..', '..') : undefined };
  } catch {
    return null;
  }
}

// ---- the Mac: put the new bundle in place -------------------------------------------------------------------------------------------------

/**
 * Run by /bin/sh after the app has quit, with four arguments (never pasted into the text): the app's process number, the old bundle, the new bundle, the folder the new one was unpacked in.
 * It waits for the app to end (at most a minute), sets the old bundle aside, moves the new one in, and puts the old one back when that fails. Then it opens the app again.
 */
export const SWAP_SCRIPT = [
  'pid="$1"; old="$2"; new="$3"; stage="$4"',
  'n=0',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  n=$((n+1))',
  '  if [ "$n" -gt 600 ]; then rm -rf "$stage"; exit 1; fi',
  '  sleep 0.1',
  'done',
  'bak="$old.replaced-$$"',
  'if mv "$old" "$bak"; then',
  '  if mv "$new" "$old"; then rm -rf "$bak"; else mv "$bak" "$old"; fi',
  'fi',
  'rm -rf "$stage"',
  'if [ -x /usr/bin/open ] && [ -z "$FD_NO_OPEN" ]; then /usr/bin/open "$old"; fi',
].join('\n');

const run = (file: string, args: string[]): Promise<{ code: number; out: string }> =>
  new Promise((done) => {
    const c = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', (e) => done({ code: 1, out: String(e) }));
    c.on('close', (code) => done({ code: code ?? 1, out }));
  });

/** Unpacks the downloaded .tar.xz next to the app (the same disk, so the move is one step) and checks that it is the version the signed list named. */
export async function stageMacUpdate(o: { archive: string; bundle: string; feed: Pick<Feed, 'version'>; tar?: string }): Promise<{ stage: string; bundle: string }> {
  let stage: string;
  try {
    stage = await mkdtemp(join(dirname(o.bundle), '.files-direct-update-'));
  } catch {
    throw new Error('Files Direct cannot update here: the folder the app is in is not yours to change. Put the app in your own Applications folder and try again.');
  }
  try {
    const r = await run(o.tar ?? '/usr/bin/tar', ['-xf', o.archive, '-C', stage]);
    if (r.code !== 0) throw new Error('The update could not be unpacked.');
    const bundle = join(stage, MAC_APP);
    const plist = await readFile(join(bundle, 'Contents', 'Info.plist'), 'utf8').catch(() => {
      throw new Error('The update did not hold the app.');
    });
    const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
    if (version !== o.feed.version) throw new UpdateRefused('feed');
    return { stage, bundle };
  } catch (e) {
    await rm(stage, { recursive: true, force: true }); // a refused update leaves nothing next to the app
    throw e;
  }
}

/** Starts the swap, which waits for process number "pid" (the menu-bar program) to end. Nothing is pasted into the script: it gets its four words as arguments. */
export function startSwap(o: { pid: number; bundle: string; newBundle: string; stage: string; spawnFn?: typeof spawn; sh?: string; env?: Record<string, string | undefined> }): void {
  if (!Number.isInteger(o.pid) || o.pid < 1) throw new Error('no process to wait for');
  const child = (o.spawnFn ?? spawn)(o.sh ?? '/bin/sh', ['-c', SWAP_SCRIPT, 'swap', String(o.pid), o.bundle, o.newBundle, o.stage], { detached: true, stdio: 'ignore', env: { ...process.env, ...o.env } });
  child.on('error', () => {});
  child.unref();
}

// ---- Windows: run the new installer, per user ---------------------------------------------------------------------------------------------

/** The installer's own switches: silent, no questions, no restart of the computer; it closes the running app and starts it again. */
export const INSTALLER_SWITCHES = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS'] as const;

export function startInstaller(file: string, spawnFn: typeof spawn = spawn): void {
  const child = spawnFn(file, [...INSTALLER_SWITCHES], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

// ---- Remove Files Direct ------------------------------------------------------------------------------------------------------------------

/** What the Mac app may have put in the person's own Library besides the menu entry. Each is removed when it is there. */
export const MAC_LEFTOVERS = (home: string): string[] => [
  home + '/Library/Application Support/Files Direct',
  home + '/Library/Caches/Files Direct',
  home + '/Library/Caches/' + APP_BUNDLE_ID,
  home + '/Library/Preferences/' + APP_BUNDLE_ID + '.plist',
  home + '/Library/Saved Application State/' + APP_BUNDLE_ID + '.savedState',
  home + '/Library/HTTPStorages/' + APP_BUNDLE_ID,
  home + '/Library/Logs/Files Direct',
  home + '/Library/LaunchAgents/' + APP_BUNDLE_ID + '.plist',
];

/** Where a downloaded update waits (the program's own folder in the temporary space), and what an update leaves beside the app while it is being put in place. */
export const updateFolder = (tmp: string): string => join(tmp, 'files-direct-update');
export async function stagingBeside(bundle: string | undefined): Promise<string[]> {
  if (!bundle) return [];
  const names = await readdir(dirname(bundle)).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith('.files-direct-update-')).map((n) => join(dirname(bundle), n));
}

/**
 * Clears what an earlier update left in the download folder when the app starts. Only entries that have not been touched for a while (ten minutes): the app can be started
 * by an update that is downloading into the same folder at this moment, and an installer that is still running must not lose its file.
 */
export async function tidyUpdates(dir: string, olderThanMs = 10 * 60_000, now = Date.now()): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (s && now - s.mtimeMs > olderThanMs) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

/** Takes out the Quick Action, every folder and file the app made in the person's Library, and what an update left (the downloaded file, a folder beside the app). The app itself is deleted by the menu-bar program (the Mac) or the uninstaller (Windows). */
export async function removeApp(fx: MenuEffects, extra: string[] = []): Promise<string[]> {
  const gone = await removeMenu(fx);
  for (const p of [...(fx.platform === 'darwin' ? MAC_LEFTOVERS(fx.home) : []), ...extra]) {
    if (await fx.exists(p)) {
      await fx.removePath(p);
      gone.push('Removed ' + p + '.');
    }
  }
  return gone;
}
