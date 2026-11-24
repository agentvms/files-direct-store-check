/**
 * Updates of the double-click Files Direct app (files-direct-34).
 *
 * The rules, all of them checked here and none of them by trust:
 *  - the program asks only its own site (the address it was built with, or the one named on the command line for a check on this computer), and takes no address from what it is told:
 *    the feed names files, never addresses, and a name that is not a plain file name is refused;
 *  - the feed is signed with our own Ed25519 key; the public half is in the program (UPDATE_PUBLIC_KEY in shared/config.ts, or the one a test build was given). A bad signature,
 *    another key, a feed that was changed by one byte: refused, before anything is read from it;
 *  - the version must be newer than the running one: an older or equal feed is never installed (a replayed old feed cannot take the app back);
 *  - the file must have exactly the size and the SHA-256 the signed feed says, counted as it arrives; one byte more, less or different is refused and removed;
 *  - nothing is followed to another address: a redirect is refused.
 * This is our own check and costs nothing; it is not Apple's or Microsoft's signing.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UPDATE_TARGETS = ['mac-arm64', 'mac-x64', 'win-x64'] as const;
export type UpdateTarget = (typeof UPDATE_TARGETS)[number];

export interface FeedFile {
  name: string;
  size: number;
  sha256: string;
}
export interface Feed {
  version: string;
  files: Partial<Record<UpdateTarget, FeedFile>>;
}

export type Refusal = 'off' | 'signature' | 'feed' | 'older' | 'address' | 'no_file' | 'size' | 'hash' | 'unreachable';

/** Every reason the program gives for not updating, in plain words. */
const WORDS: Record<Refusal, string> = {
  off: 'This copy has no key to check updates with, so it does not update itself.',
  signature: 'The update was not signed by Files Direct, so it was not used.',
  feed: 'The list of updates is not in the form expected, so it was not used.',
  older: 'The update on offer is older than this one, so it was not used.',
  address: 'The update did not come from the Files Direct site, so it was not used.',
  no_file: 'There is no update for this kind of computer.',
  size: 'The update has the wrong size, so it was thrown away.',
  hash: 'The update is not the file that was signed, so it was thrown away.',
  unreachable: 'The site could not be reached to look for an update.',
};

export class UpdateRefused extends Error {
  constructor(readonly reason: Refusal) {
    super(WORDS[reason]);
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const FEED_MAX = 64 * 1024;
const FILE_MAX = 400 * 1024 * 1024;

/** The raw 32 bytes of an Ed25519 public key (base64) as a key the verifier takes. */
export function publicKeyFrom(raw: string): KeyObject {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) throw new UpdateRefused('off');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]), format: 'der', type: 'spki' });
}

/** The signed list, after its signature has been checked against our key and every field against its form. */
export function readFeed(feed: Uint8Array, signature: string, key: KeyObject): Feed {
  if (feed.length === 0 || feed.length > FEED_MAX) throw new UpdateRefused('feed');
  const sig = Buffer.from(signature.trim(), 'base64');
  const good = (() => {
    try {
      return sig.length === 64 && verify(null, feed, key, sig);
    } catch {
      return false;
    }
  })();
  if (!good) throw new UpdateRefused('signature');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(feed).toString('utf8'));
  } catch {
    throw new UpdateRefused('feed');
  }
  const o = raw as { version?: unknown; files?: unknown };
  if (!o || typeof o !== 'object' || typeof o.version !== 'string' || !VERSION.test(o.version) || !o.files || typeof o.files !== 'object') throw new UpdateRefused('feed');
  const files: Feed['files'] = {};
  for (const [target, f] of Object.entries(o.files as Record<string, unknown>)) {
    if (!(UPDATE_TARGETS as readonly string[]).includes(target)) continue; // a kind of computer this program does not know: not for it
    const x = f as Partial<FeedFile> | null;
    // a name is a plain file name: no folder, no scheme, no address (the program makes the address itself)
    if (!x || typeof x.name !== 'string' || !NAME.test(x.name) || x.name.includes('..')) throw new UpdateRefused('address');
    if (!Number.isInteger(x.size) || (x.size as number) < 1 || (x.size as number) > FILE_MAX || typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(x.sha256)) throw new UpdateRefused('feed');
    files[target as UpdateTarget] = { name: x.name, size: x.size as number, sha256: x.sha256 };
  }
  return { version: o.version, files };
}

/** Negative when a is older than b, 0 when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export type Check = { state: 'current'; version: string } | { state: 'available'; version: string; file: FeedFile };

export interface UpdateOptions {
  /** The site's address, as the program was built with it. */
  origin: string;
  /** The version that is running. */
  current: string;
  target: UpdateTarget;
  /** The public key; an empty one means this copy does not update itself. */
  key: string;
  fetch?: typeof fetch;
}

/** A site that does not answer must not hold the app: the list gets half a minute, a file (which may be big and the line slow) twenty minutes. */
const LIST_MS = 30_000;
const FILE_MS = 20 * 60_000;

async function get(f: typeof fetch, origin: string, path: string, ms = LIST_MS): Promise<Response> {
  let res: Response;
  try {
    res = await f(origin + path, { redirect: 'error', headers: { accept: '*/*' }, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    // a refused redirect and an unreachable site are told apart: only the first is about the address
    throw new UpdateRefused(/redirect/i.test(String((e as { cause?: unknown; message?: string })?.message ?? '') + String((e as { cause?: { message?: string } })?.cause?.message ?? '')) ? 'address' : 'unreachable');
  }
  if (res.url && new URL(res.url).origin !== new URL(origin).origin) throw new UpdateRefused('address');
  if (!res.ok) throw new UpdateRefused('unreachable');
  return res;
}

const smallBody = async (res: Response): Promise<Uint8Array> => {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > FEED_MAX) throw new UpdateRefused('feed');
  return bytes;
};

/** Looks for a newer version. Never installs anything. */
export async function checkForUpdate(o: UpdateOptions): Promise<Check> {
  if (!o.key) throw new UpdateRefused('off');
  const key = publicKeyFrom(o.key);
  const f = o.fetch ?? fetch;
  const [feed, sig] = await Promise.all([get(f, o.origin, '/desktop/feed.json').then(smallBody), get(f, o.origin, '/desktop/feed.json.sig').then(async (r) => Buffer.from(await smallBody(r)).toString('utf8'))]);
  const list = readFeed(feed, sig, key);
  const c = compareVersions(list.version, o.current);
  if (c < 0) throw new UpdateRefused('older');
  if (c === 0) return { state: 'current', version: o.current };
  const file = list.files[o.target];
  if (!file) throw new UpdateRefused('no_file');
  return { state: 'available', version: list.version, file };
}

/** Takes the file the signed list names into dir, counting its size and SHA-256 as it arrives. Returns its path; a file that is not exactly what was signed is removed. */
export async function downloadUpdate(o: { origin: string; file: FeedFile; dir: string; fetch?: typeof fetch }): Promise<string> {
  await mkdir(o.dir, { recursive: true });
  const res = await get(o.fetch ?? fetch, o.origin, '/desktop/' + o.file.name, FILE_MS);
  const length = res.headers.get('content-length');
  if (length !== null && Number(length) !== o.file.size) throw new UpdateRefused('size');
  if (!res.body) throw new UpdateRefused('size');
  const part = join(o.dir, o.file.name + '.part');
  const hash = createHash('sha256');
  let count = 0;
  try {
    const counted = Readable.fromWeb(res.body as never).map((chunk: Buffer) => {
      count += chunk.length;
      if (count > o.file.size) throw new UpdateRefused('size');
      hash.update(chunk);
      return chunk;
    });
    await pipeline(counted, createWriteStream(part));
    if (count !== o.file.size) throw new UpdateRefused('size');
    if (hash.digest('hex') !== o.file.sha256) throw new UpdateRefused('hash');
    const done = join(o.dir, o.file.name);
    await rename(part, done);
    return done;
  } catch (e) {
    await rm(part, { force: true });
    throw e instanceof UpdateRefused ? e : new UpdateRefused('unreachable');
  }
}

export const refusalText = (e: unknown): string => (e instanceof UpdateRefused ? e.message : 'The update did not work.');
