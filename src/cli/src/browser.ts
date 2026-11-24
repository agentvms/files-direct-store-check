/**
 * Shows the window's page in an app-style window of a browser that is already on the computer (files-direct-30, D1): no new runtime, nothing to download.
 * Edge or Chrome (or Chromium) is started with its own throwaway profile folder, so it is its own program for the time the window is open: it does not
 * join the person's running browser, and when it ends the window is closed. With none of them the page opens in the default browser, as a tab.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface WindowHandle {
  /** Resolves when the window was closed (the browser we started ended). Never, for a tab in the default browser. */
  closed: Promise<void>;
  /** Closes the window and removes its throwaway profile. */
  close(): Promise<void>;
  /** What was started, in words for a log. */
  how: 'app window' | 'default browser';
  /** The browser's process, when it is ours to end (an app window). */
  pid?: number;
}

export interface Where {
  platform: string;
  env: Record<string, string | undefined>;
  /** True when a program can be started from this path. */
  exists(path: string): Promise<boolean>;
  spawn?: typeof nodeSpawn;
}

export const WINDOW_SIZE = { width: 480, height: 760 };

const canRun = (p: string): Promise<boolean> => access(p, constants.X_OK).then(() => true, () => false);
export const realWhere = (): Where => ({ platform: process.platform, env: process.env, exists: canRun });

/** The browsers to try, best first. The person's own choice (FILES_DIRECT_BROWSER) comes before them all. */
export function browserCandidates(platform: string, env: Record<string, string | undefined>): string[] {
  const own = env.FILES_DIRECT_BROWSER ? [env.FILES_DIRECT_BROWSER] : [];
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((r): r is string => Boolean(r));
    return [...own, ...roots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')), ...roots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))].map((p) => p.replace(/\//g, '\\'));
  }
  if (platform === 'darwin') {
    const apps = [['Google Chrome', 'Google Chrome'], ['Microsoft Edge', 'Microsoft Edge'], ['Chromium', 'Chromium']] as const;
    const homes = ['/Applications', ...(env.HOME ? [join(env.HOME, 'Applications')] : [])];
    return [...own, ...apps.flatMap(([app, bin]) => homes.map((h) => join(h, app + '.app', 'Contents', 'MacOS', bin)))];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser'];
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  return [...own, ...names.flatMap((n) => dirs.map((d) => join(d, n)))];
}

/** The arguments that make a Chromium-family browser show only the page: no tabs, no address bar. */
export function appArguments(url: string, profile: string): string[] {
  return [`--app=${url}`, `--user-data-dir=${profile}`, `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-features=Translate'];
}

/** The program that opens an address in the default browser, with its arguments. */
export function defaultOpener(platform: string, url: string): [string, string[]] {
  return platform === 'darwin' ? ['/usr/bin/open', [url]] : platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
}

export async function launchWindow(url: string, where: Where = realWhere()): Promise<WindowHandle | null> {
  const spawn = where.spawn ?? nodeSpawn;
  for (const bin of browserCandidates(where.platform, where.env)) {
    if (!(await where.exists(bin))) continue;
    const profile = await mkdtemp(join(tmpdir(), 'files-direct-window-'));
    const child: ChildProcess = spawn(bin, appArguments(url, profile), { stdio: 'ignore', detached: false });
    const closed = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    const cleanup = () => rm(profile, { recursive: true, force: true }).catch(() => {});
    void closed.then(cleanup);
    return {
      how: 'app window',
      pid: child.pid,
      closed,
      async close() {
        if (child.exitCode === null) child.kill();
        await Promise.race([closed, new Promise((r) => setTimeout(r, 2000))]);
        await cleanup();
      },
    };
  }
  const [bin, args] = defaultOpener(where.platform, url);
  try {
    const child = spawn(bin, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return { how: 'default browser', closed: new Promise(() => {}), close: async () => {} };
  } catch {
    return null;
  }
}
