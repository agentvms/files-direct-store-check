/**
 * What one side of a room says about itself, in fixed words: the kind of device, the system, the browser and its major version.
 * Read from the browser's own text. Never an address, a name, a link, a code or a file name: every value is one of a short list or a small number.
 * The Worker passes it to the other side after cleaning it with the same function (so a page cannot pass anything else along).
 */
export const DEVICE_KINDS = ['phone', 'tablet', 'computer', 'program', 'desktop', 'app', 'unknown'] as const;
export const SYSTEMS = ['Android', 'iOS', 'macOS', 'Windows', 'Linux', 'ChromeOS', 'unknown'] as const;
/** "none" is only for a program (the command-line program of files-direct-27), for the Files Direct window of files-direct-30 and for the double-click app of files-direct-34: none of them is a browser. */
export const BROWSERS = ['Chrome', 'Edge', 'Firefox', 'Safari', 'none', 'unknown'] as const;
/** How the second device came in: the link, the QR code (the link with a marker outside its secret) or the nine-digit code. */
export const JOINED = ['link', 'qr', 'code'] as const;

export interface Device {
  kind: (typeof DEVICE_KINDS)[number];
  system: (typeof SYSTEMS)[number];
  browser: (typeof BROWSERS)[number];
  /** The browser's major version; 0 when unknown. */
  version: number;
}
export type Joined = (typeof JOINED)[number];

const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback);

/** Only the fixed words and a small whole number survive. Null when it is not an object at all. A program has no browser, and nothing else has "none". */
export function cleanDevice(raw: unknown): Device | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const v = typeof r.version === 'number' && Number.isInteger(r.version) && r.version >= 0 && r.version <= 999 ? r.version : 0;
  const kind = pick(DEVICE_KINDS, r.kind, 'unknown');
  const browser = kind === 'program' || kind === 'desktop' || kind === 'app' ? 'none' : pick(BROWSERS, r.browser, 'unknown') === 'none' ? 'unknown' : pick(BROWSERS, r.browser, 'unknown');
  return { kind, system: pick(SYSTEMS, r.system, 'unknown'), browser, version: v };
}

/** What the Files Direct window (the program, opened from a right-click or on its own) says about itself: the system and the major version. No browser: the window is shown by one, but it is the program that talks. */
export function desktopDevice(system: Device['system'], version: number): Device {
  return cleanDevice({ kind: 'desktop', system, version })!;
}

/** What the double-click Files Direct app (menu bar on a Mac, tray on Windows) says about itself: the system and the major version. No browser. */
export function appDevice(system: Device['system'], version: number): Device {
  return cleanDevice({ kind: 'app', system, version })!;
}

/** What a command-line program says about itself: the system it runs on and its major version (0 to 999). No browser. */
export function programDevice(system: Device['system'], version: number): Device {
  return cleanDevice({ kind: 'program', system, version })!;
}

export const cleanJoined = (v: unknown): Joined | null => (typeof v === 'string' && (JOINED as readonly string[]).includes(v) ? (v as Joined) : null);

/** From the browser's own text (and how many touch points it has: an iPad says it is a Mac). */
export function deviceFrom(ua: string, touchPoints = 0): Device {
  const m = (re: RegExp) => Number(re.exec(ua)?.[1] ?? 0);
  const browser: Device['browser'] = /Edg\//.test(ua) ? 'Edge' : /(?:Chrome|CriOS)\//.test(ua) ? 'Chrome' : /(?:Firefox|FxiOS)\//.test(ua) ? 'Firefox' : /Version\/\d+.*Safari/.test(ua) ? 'Safari' : 'unknown';
  const version =
    browser === 'Edge' ? m(/Edg\/(\d+)/) : browser === 'Chrome' ? m(/(?:Chrome|CriOS)\/(\d+)/) : browser === 'Firefox' ? m(/(?:Firefox|FxiOS)\/(\d+)/) : browser === 'Safari' ? m(/Version\/(\d+)/) : 0;
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const system: Device['system'] = /iPhone|iPod/.test(ua) || ipad ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown';
  const kind: Device['kind'] = /iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua)) ? 'phone' : ipad || /Android/.test(ua) ? 'tablet' : system === 'unknown' ? 'unknown' : 'computer';
  return { kind, system, browser, version };
}

/**
 * The kind of device in plain words for the other person's screen: "an Android phone", "a Mac", "an iPhone", "a Windows computer".
 * Only the kind and the system: never the browser, its version, a name or an address. "another device" when the kind is not known (no guess).
 */
export function deviceLabel(d: Device | null): string {
  if (!d || d.kind === 'unknown') return 'another device';
  if (d.kind === 'program') return 'a command-line program';
  if (d.kind === 'desktop') return d.system === 'macOS' ? 'the Files Direct window on a Mac' : d.system === 'Windows' ? 'the Files Direct window on a Windows computer' : d.system === 'Linux' ? 'the Files Direct window on a Linux computer' : 'the Files Direct window';
  if (d.kind === 'app') return d.system === 'macOS' ? 'the Files Direct app on a Mac' : d.system === 'Windows' ? 'the Files Direct app on a Windows computer' : 'the Files Direct app';
  const s = d.system;
  if (d.kind === 'phone') return s === 'Android' ? 'an Android phone' : s === 'iOS' ? 'an iPhone' : 'a phone';
  if (d.kind === 'tablet') return s === 'Android' ? 'an Android tablet' : s === 'iOS' ? 'an iPad' : 'a tablet';
  return s === 'macOS' ? 'a Mac' : s === 'Windows' ? 'a Windows computer' : s === 'ChromeOS' ? 'a Chromebook' : s === 'Linux' ? 'a Linux computer' : 'a computer';
}

export function deviceText(d: Device | null): string {
  if (!d) return 'not known';
  return [d.kind, d.system, d.browser === 'none' ? 'no browser' : d.browser === 'unknown' ? 'unknown browser' : d.browser + (d.version ? ' ' + d.version : '')].join(', ');
}
