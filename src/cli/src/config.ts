import { ICE_URLS, UPDATE_PUBLIC_KEY } from '../../shared/config.ts';
import { type Device, type SYSTEMS, appDevice, desktopDevice, programDevice } from '../../shared/device.ts';
import type { RouteConfig } from '../../shared/route.ts';
import type { RoomEnv } from './room.ts';

// Put in at build time (scripts/build-cli.mjs): the program's version, and the address of the site that serves it. The address comes from
// wrangler.toml (SITE_ORIGIN) and is never written in the source.
declare const __FD_VERSION__: string | undefined;
declare const __FD_ORIGIN__: string | undefined;
// A build for a check on the runners is given its own throwaway public key (files-direct-34); the real build uses UPDATE_PUBLIC_KEY of shared/config.ts.
declare const __FD_UPDATE_KEY__: string | undefined;

export const VERSION = typeof __FD_VERSION__ === 'string' ? __FD_VERSION__ : '0.0.0';
export const BUILT_ORIGIN = typeof __FD_ORIGIN__ === 'string' ? __FD_ORIGIN__ : '';
export const BUILT_UPDATE_KEY = (typeof __FD_UPDATE_KEY__ === 'string' && __FD_UPDATE_KEY__) || UPDATE_PUBLIC_KEY;

/** The site this program talks to: --site, then FILES_DIRECT_ORIGIN, then the address it was built with. */
export function originFrom(flag: string | undefined, env: Record<string, string | undefined>): string | null {
  const given = flag ?? env.FILES_DIRECT_ORIGIN ?? BUILT_ORIGIN;
  if (!given) return null;
  try {
    const u = new URL(given);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The one line that updates this program, from the site it came from. */
export const installLine = (origin: string): string => `npm install -g ${origin}/cli/files-direct.tgz`;

export function systemOf(platform: string = process.platform): Device['system'] {
  const map: Record<string, (typeof SYSTEMS)[number]> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };
  return map[platform] ?? 'unknown';
}

export const deviceOfThisProgram = (): Device => programDevice(systemOf(), Number.parseInt(VERSION, 10) || 0);

/** The Files Direct window (the program started with `open`, from a right-click or on its own): its own fixed word, so the other side and the records can tell it from a terminal. */
export const deviceOfTheWindow = (): Device => desktopDevice(systemOf(), Number.parseInt(VERSION, 10) || 0);

/** The double-click app (menu bar or tray): its own word, so the records count it apart from the window of the command line. */
export const deviceOfTheApp = (): Device => appDevice(systemOf(), Number.parseInt(VERSION, 10) || 0);

/**
 * What the page gets in its `fd-config` block: the addresses for finding a direct route and the route settings. A program reads the same block
 * from the home page, so it follows whatever the site says (and the tests' own settings). Without it: the built-in defaults.
 */
export async function siteSettings(origin: string, headers?: Record<string, string>): Promise<{ ice: string[]; route?: RouteConfig }> {
  try {
    const res = await fetch(origin + '/', { headers });
    const html = await res.text();
    const m = /<script type="application\/json" id="fd-config">([\s\S]*?)<\/script>/.exec(html);
    if (m) {
      const c = JSON.parse(m[1]!) as { ice?: unknown; route?: RouteConfig };
      return { ice: Array.isArray(c.ice) ? c.ice.filter((u): u is string => typeof u === 'string') : ICE_URLS, route: c.route };
    }
  } catch {
    // fall through to the defaults
  }
  return { ice: ICE_URLS, route: { switch: true } };
}

export async function roomEnv(origin: string, headers?: Record<string, string>, window = false, app = false): Promise<RoomEnv> {
  const s = await siteSettings(origin, headers);
  return { origin, headers, ice: s.ice, route: s.route, device: app ? deviceOfTheApp() : window ? deviceOfTheWindow() : deviceOfThisProgram(), install: installLine(origin) };
}
