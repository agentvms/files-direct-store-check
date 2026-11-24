import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Sendable } from '../../web/src/transfer/engine.ts';
import { Refused } from './safe-path.ts';
import type { Roots } from './roots.ts';

export interface Picked {
  /** The path the other side sees: "folder/sub/a.txt". */
  name: string;
  /** The real path the bytes are read from. */
  abs: string;
  size: number;
}
export interface Skipped {
  path: string;
  reason: 'link' | 'protected' | 'not_a_file';
}

/**
 * The files to send for the paths given. A folder is walked; a link inside it is not followed (it is listed in `skipped`), and with `roots`
 * anything protected is left out too. A path named outright that is refused throws a `Refused`.
 */
export async function collect(paths: string[], opts: { roots?: Roots } = {}): Promise<{ files: Picked[]; skipped: Skipped[] }> {
  const files: Picked[] = [];
  const skipped: Skipped[] = [];
  const walk = async (abs: string, name: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = join(abs, e.name);
      const childName = name + '/' + e.name;
      if (e.isSymbolicLink()) skipped.push({ path: childName, reason: 'link' });
      else if (opts.roots?.isProtected(child)) skipped.push({ path: childName, reason: 'protected' });
      else if (e.isDirectory()) await walk(child, childName);
      else if (e.isFile()) files.push({ name: childName, abs: child, size: (await lstat(child)).size });
      else skipped.push({ path: childName, reason: 'not_a_file' });
    }
  };
  for (const given of paths) {
    const real = opts.roots ? await opts.roots.readable(given) : await realpath(given).catch(() => Promise.reject(new Refused('missing', `${given} does not exist.`)));
    const name = basename(real) || 'files';
    const st = await stat(real);
    if (st.isDirectory()) await walk(real, name);
    else if (st.isFile()) files.push({ name, abs: real, size: st.size });
    else skipped.push({ path: name, reason: 'not_a_file' });
  }
  return { files, skipped };
}

/** The engine's view of a file on disk: it asks for one block at a time, and each is read from the file when asked. */
export function sendableOf(f: Picked): Sendable {
  return {
    name: f.name,
    size: f.size,
    type: 'application/octet-stream',
    slice: (a, b) => ({
      arrayBuffer: async () => {
        const h = await open(f.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const out = new Uint8Array(b - a);
          let at = 0;
          while (at < out.length) {
            const { bytesRead } = await h.read(out, at, out.length - at, a + at);
            if (bytesRead === 0) throw new Error('the file changed while it was being sent');
            at += bytesRead;
          }
          return out.buffer;
        } finally {
          await h.close();
        }
      },
    }),
  };
}
