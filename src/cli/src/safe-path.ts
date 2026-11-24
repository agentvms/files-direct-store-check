import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** A rule about where a received file may go (the MCP server's folder rule). Throws a `Refused` to say no. */
export type Guard = (target: string) => void;

/** Fixed words for why something was refused. They are part of the program's JSON output (see cli/README.md). */
export type RefusalReason = 'outside' | 'link' | 'would_overwrite' | 'protected' | 'bad_name' | 'missing';

/** A refusal with a fixed reason word and a sentence a person (or an assistant) can read. */
export class Refused extends Error {
  constructor(readonly reason: RefusalReason, message: string) {
    super(message);
  }
}

const MAX_SEGMENT_BYTES = 255;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f/\\]/;
const WINDOWS_BAD = /[<>:"|?*]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** The pieces of a name that came from the other side, checked once more (the engine cleans names too; this is the second lock). */
export function segmentsOf(relPath: string, platform: string = process.platform): string[] {
  const segments = relPath.split('/');
  if (relPath === '' || relPath.startsWith('/') || segments.length > 64) throw new Refused('bad_name', 'The other side sent a file name that cannot be saved.');
  return segments.map((raw) => {
    let seg = raw;
    if (seg === '' || seg === '.' || seg === '..' || BAD_CHARS.test(seg) || /^[A-Za-z]:/.test(seg)) throw new Refused('bad_name', 'The other side sent a file name that cannot be saved.');
    if (platform === 'win32') {
      seg = seg.replace(WINDOWS_BAD, '_').replace(/[. ]+$/, '');
      if (seg === '') seg = '_';
      if (WINDOWS_RESERVED.test(seg)) seg = '_' + seg;
    }
    return fit(seg);
  });
}

/** A name longer than a file system allows (in bytes) is cut, keeping a short ending such as ".jpg". */
function fit(seg: string): string {
  const size = (s: string) => Buffer.byteLength(s);
  if (size(seg) <= MAX_SEGMENT_BYTES) return seg;
  const dot = seg.lastIndexOf('.');
  const ext = dot > 0 && size(seg.slice(dot)) <= 16 ? seg.slice(dot) : '';
  let head = ext ? seg.slice(0, dot) : seg;
  while (size(head) + size(ext) > MAX_SEGMENT_BYTES) head = [...head].slice(0, -1).join('');
  return head + ext;
}

const inside = (real: string, root: string) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Makes the folders a file goes into, one step at a time, never following a link, and returns where the file goes.
 * `destReal` is the destination's real path. Refuses (`link`) a link in the way, and (`would_overwrite`) a file or folder already there unless `overwrite`.
 */
export async function prepareTarget(destReal: string, segments: string[], overwrite: boolean): Promise<string> {
  let cur = destReal;
  for (const seg of segments.slice(0, -1)) {
    const next = join(cur, seg);
    let st = await lstat(next).catch(() => null);
    if (!st) {
      await mkdir(next).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      st = await lstat(next);
    }
    if (st.isSymbolicLink()) throw new Refused('link', 'A link inside the folder you are saving into points somewhere else, so nothing was saved through it.');
    if (!st.isDirectory()) throw new Refused('bad_name', 'A file is where a folder needs to go, so this file was not saved.');
    cur = next;
  }
  const realParent = await realpath(cur);
  if (!inside(realParent, destReal)) throw new Refused('outside', 'That file would land outside the folder you are saving into, so it was not saved.');
  const target = join(realParent, segments[segments.length - 1]!);
  const st = await lstat(target).catch(() => null);
  if (st && !overwrite) throw new Refused('would_overwrite', 'A file with that name is already there. Nothing was replaced (use the overwrite option to replace it).');
  if (st?.isDirectory()) throw new Refused('would_overwrite', 'A folder with that name is already there, so this file was not saved.');
  return target;
}

/** Before anything is taken: which of the offered names would not be saved cleanly (a file already there, or a link in the way). */
export async function conflicts(destReal: string, names: string[], overwrite: boolean, guard?: Guard): Promise<{ name: string; reason: RefusalReason }[]> {
  const out: { name: string; reason: RefusalReason }[] = [];
  for (const name of names) {
    let segs: string[];
    try {
      segs = segmentsOf(name);
      guard?.(join(destReal, ...segs));
    } catch (e) {
      out.push({ name, reason: e instanceof Refused ? e.reason : 'bad_name' });
      continue;
    }
    let cur = destReal;
    let found: RefusalReason | null = null;
    for (let i = 0; i < segs.length && !found; i++) {
      cur = join(cur, segs[i]!);
      const st = await lstat(cur).catch(() => null);
      if (!st) break; // the rest does not exist yet
      if (st.isSymbolicLink()) found = i === segs.length - 1 && overwrite ? null : 'link';
      else if (i === segs.length - 1) found = overwrite && st.isFile() ? null : 'would_overwrite';
      else if (!st.isDirectory()) found = 'bad_name';
    }
    if (found) out.push({ name, reason: found });
  }
  return out;
}

/** Puts a finished partial file in its place. Without `overwrite` it never replaces anything; with it a link standing there is replaced, never written through. */
export async function moveInto(partial: string, target: string, overwrite: boolean): Promise<void> {
  if (overwrite) return rename(partial, target);
  try {
    await link(partial, target); // fails if the name is taken: no check-then-write gap
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new Refused('would_overwrite', 'A file with that name is already there. Nothing was replaced (use the overwrite option to replace it).');
    // a file system without links (some network or removable drives): copy, and refuse to replace
    await copyFile(partial, target, constants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') throw new Refused('would_overwrite', 'A file with that name is already there. Nothing was replaced (use the overwrite option to replace it).');
      throw err;
    });
  }
  await unlink(partial).catch(() => {});
}
