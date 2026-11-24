/**
 * Windows starts one program for each file chosen in a registry entry (the entry names "%1"), so one right-click on three files starts three programs.
 * They have to end up in one room. The first one to start becomes the leader and the others hand it their file and leave:
 *  - the leader makes a folder (the first to make it wins: making a folder is one step that cannot be done twice), and waits until nothing new has come for a moment;
 *  - each other program puts one small file with its path in that folder;
 *  - the leader renames the folder (so a late file finds no folder and makes its own) and reads what is in it.
 * The folder is in the person's own temporary space. It holds paths only while it exists, a second or two.
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface GatherOptions {
  /** Where the meeting folder is made. */
  dir?: string;
  /** The leader waits until nothing new has come for this long. */
  quietMs?: number;
  /** ...but never longer than this. */
  maxMs?: number;
  /** A folder older than this has no leader any more: it is cleared and the next program leads. */
  staleMs?: number;
}

const NAME = 'files-direct-gather';

/** Resolves every path of the right-click (when this program leads), or null (when it handed its path to the leader and has nothing more to do). */
export async function gather(path: string, o: GatherOptions = {}): Promise<string[] | null> {
  const dir = o.dir ?? join(tmpdir(), NAME);
  const quiet = o.quietMs ?? 600;
  const max = o.maxMs ?? 5000;
  const stale = o.staleMs ?? 20_000;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await mkdir(dir); // not recursive: it fails when somebody leads already
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') {
        // the temporary space itself is missing or not ours to use: do without the meeting
        return [path];
      }
      const age = Date.now() - (await stat(dir).then((s) => s.mtimeMs, () => Date.now()));
      if (age > stale) {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      try {
        await writeFile(join(dir, randomBytes(8).toString('hex') + '.path'), path, { flag: 'wx' });
        return null;
      } catch {
        continue; // the leader has just closed the folder: lead, or hand over to the next one
      }
    }
    // this one leads
    const started = Date.now();
    let seen = -1;
    let lastChange = Date.now();
    for (;;) {
      const n = (await readdir(dir).catch(() => [])).length;
      if (n !== seen) {
        seen = n;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange >= quiet || Date.now() - started >= max) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const closed = await mkdtemp(dir + '-closed-');
    await rm(closed, { recursive: true, force: true });
    await rename(dir, closed);
    const others = await Promise.all((await readdir(closed)).sort().map((f) => readFile(join(closed, f), 'utf8').catch(() => '')));
    await rm(closed, { recursive: true, force: true });
    return [path, ...others.filter(Boolean)];
  }
  return [path];
}
