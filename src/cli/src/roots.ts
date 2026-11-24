import { realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve, sep, isAbsolute } from 'node:path';
import { Refused } from './safe-path.ts';

/** Folders that hold keys, passwords or logins: never sent and never written into, wherever they sit. */
const PRIVATE_NAMES = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.azure', '.password-store']);
/** The same, as paths below the home folder. */
const PRIVATE_BELOW_HOME = [['.config', 'gcloud'], ['.config', 'gh'], ['.config', 'op'], ['.local', 'share', 'keyrings']];
const PRIVATE_FILES = new Set(['.npmrc', '.netrc', '.pgpass', '.git-credentials', '.pypirc']);

const inside = (real: string, root: string) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The folders the MCP server may read from and write into, chosen when it starts (default: the folder it started in).
 * Every check goes through the real path, so a link that leads out of a folder does not count as inside it.
 */
export class Roots {
  private constructor(readonly list: string[], private readonly home: string | null) {}

  static async create(allowed: string[], opts: { home?: string } = {}): Promise<Roots> {
    let home: string | null = null;
    try {
      home = realpathSync(opts.home ?? homedir());
    } catch {
      // no home folder to speak of
    }
    const roots = new Roots([], home);
    for (const given of allowed) {
      const real = await realpath(resolve(given)).catch(() => null);
      if (!real) throw new Refused('missing', `The folder ${given} does not exist, so it cannot be allowed.`);
      if (!(await stat(real)).isDirectory()) throw new Refused('bad_name', `${given} is not a folder, so it cannot be allowed.`);
      if (dirname(real) === real) throw new Refused('outside', 'The top of the disk is too wide to allow. Name a narrower folder.');
      if (roots.isProtected(real)) throw new Refused('protected', `${given} holds keys or passwords and cannot be allowed.`);
      roots.list.push(real);
    }
    return roots;
  }

  /** A folder or file that holds keys, passwords or logins. */
  isProtected(real: string): boolean {
    const parts = real.split(sep).filter(Boolean);
    if (parts.some((p) => PRIVATE_NAMES.has(p))) return true;
    if (PRIVATE_FILES.has(basename(real))) return true;
    if (this.home && inside(real, this.home)) {
      const below = relative(this.home, real).split(sep);
      return PRIVATE_BELOW_HOME.some((p) => p.every((x, i) => below[i] === x));
    }
    return false;
  }

  /** A place a received file is about to be written: refused when it holds keys or passwords. (The folder it goes into was already checked with `writable`.) */
  guardTarget(target: string): void {
    if (this.isProtected(target)) throw new Refused('protected', 'That file would land in a place for keys or passwords, so it was not saved.');
  }

  private check(real: string, what: string): void {
    if (this.isProtected(real)) throw new Refused('protected', `That is a place for keys or passwords, and Files Direct will not send it or write into it (${what}).`);
    if (!this.list.some((r) => inside(real, r))) {
      throw new Refused('outside', `That is outside the folders this server may use (${this.list.join(', ')}). The person who started it chooses them with --allow.`);
    }
  }

  /** The real path of a file or folder that may be sent. Refuses with a reason: `missing`, `outside` (also for a link that leads out) or `protected`. */
  async readable(path: string): Promise<string> {
    if (typeof path !== 'string' || path === '' || path.includes('\0')) throw new Refused('missing', 'No path was given.');
    const abs = isAbsolute(path) ? resolve(path) : resolve(this.list[0] ?? '.', path);
    const real = await realpath(abs).catch(() => null);
    if (!real) throw new Refused('missing', 'That file or folder does not exist.');
    this.check(real, 'reading');
    return real;
  }

  /** The folder to save into, made of the nearest folder that exists plus the rest of the name. It is not created here. */
  async writable(dir: string): Promise<string> {
    if (typeof dir !== 'string' || dir === '' || dir.includes('\0')) throw new Refused('missing', 'No folder was given.');
    const abs = isAbsolute(dir) ? resolve(dir) : resolve(this.list[0] ?? '.', dir);
    const rest: string[] = [];
    let at = abs;
    for (;;) {
      const real = await realpath(at).catch(() => null);
      if (real) {
        const full = resolve(real, ...rest);
        this.check(real, 'writing');
        this.check(full, 'writing');
        return full;
      }
      const up = dirname(at);
      if (up === at) throw new Refused('missing', 'That folder cannot be made.');
      rest.unshift(basename(at));
      at = up;
    }
  }
}
