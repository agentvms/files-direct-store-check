import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Session, type TransferEvent } from '../../src/web/src/transfer/engine.ts';
import { collect, sendableOf } from '../../src/cli/src/fs-source.ts';
import { createSaver } from '../../src/cli/src/fs-sink.ts';
import { Refused, conflicts } from '../../src/cli/src/safe-path.ts';
import { Roots } from '../../src/cli/src/roots.ts';
import { channelPair, pattern, source } from './helpers/link.ts';

// files-direct-27: what a hostile sender must not do on the receiving side, and what an assistant must not be talked into sending.
// Every test uses a throwaway folder under the system's temp directory.

const BS = 10_000;
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'fd-cli-')));

/** A sender with the given names and bytes, a receiver that saves into `dest`. Resolves what happened to each file. */
async function run(dest: string, files: { name: string; bytes: Uint8Array }[], opts: { overwrite?: boolean; guard?: (target: string) => void; tamper?: (d: string | ArrayBuffer) => string | ArrayBuffer | null } = {}) {
  const [a, b] = channelPair();
  if (opts.tamper) a.tap = opts.tamper;
  const saver = await createSaver(dest, { overwrite: opts.overwrite ?? false, guard: opts.guard });
  const events: TransferEvent[] = [];
  const saved: { name: string; path?: string; refused?: Refused; error?: unknown }[] = [];
  const names = new Map<string, string>();
  const pending: Promise<void>[] = [];
  const receiver = new Session({
    channel: b, sinks: saver.sinks, odd: false, ask: true, blockSize: BS,
    emit: (e) => {
      events.push(e);
      if (e.k === 'started' && e.dir === 'in') for (const f of e.files) names.set(`${e.b}:${f.i}`, f.name);
      if (e.k === 'offered') receiver.accept(e.b);
      if (e.k === 'file-ready') {
        const name = names.get(`${e.b}:${e.i}`)!;
        pending.push(saver.finish(e.blob, name).then((path) => void saved.push({ name, path }), (err) => void saved.push({ name, refused: err instanceof Refused ? err : undefined, error: err })));
      }
    },
  });
  const sender = new Session({ channel: a, sinks: saver.sinks, odd: true, blockSize: BS, emit: () => {}, after: () => () => {} });
  a.onMessage = (d) => sender.handle(d);
  b.onMessage = (d) => receiver.handle(d);
  sender.send(files.map((f) => source(f.name, f.bytes)));
  for (let n = 0; n < 6; n++) {
    await sender.idle();
    await receiver.idle();
    await Promise.all(pending);
    await new Promise((r) => setTimeout(r, 5));
  }
  return { saver, events, saved, receiver };
}

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)).map((p) => join(e.name, p)) : [e.name]));

describe('a hostile sender cannot write outside the destination', () => {
  const NAMES = ['../../escape.txt', '/tmp/escape-abs.txt', 'C:\\Windows\\escape.txt', 'a/../../escape2.txt', 'x\u0000y/../../escape3', '..\\..\\escape4.txt', 'ctl\u0007\u001b[31m.txt', './././dot.txt', '....//....//e5'];

  it('saves every one of them inside the destination or refuses it, and writes nothing next to it', async () => {
    // The temp directory is this test's own while it runs, so folders that other test files make at the same time cannot show up in what is looked at.
    const shared = process.env.TMPDIR;
    const mine = realpathSync(mkdtempSync(join(tmpdir(), 'fd-cli-private-')));
    process.env.TMPDIR = mine;
    try {
      const root = tmp();
      const dest = join(root, 'inbox');
      mkdirSync(dest);
      const before = new Set(readdirSync(tmpdir()));
      const bytes = pattern(BS * 2 + 3, 5);
      const { saver, saved } = await run(dest, NAMES.map((name) => ({ name, bytes })));
      await saver.close();
      expect(saved).toHaveLength(NAMES.length);
      for (const s of saved) {
        if (s.path) {
          expect(resolve(s.path).startsWith(resolve(dest) + '/')).toBe(true);
          expect(readFileSync(s.path)).toEqual(Buffer.from(bytes));
        }
      }
      // nothing outside: no file next to the destination, nothing new in the temp directory's top, no partial left behind
      expect(readdirSync(root)).toEqual(['inbox']);
      expect(readdirSync(tmpdir()).filter((n) => !before.has(n))).toEqual([]);
      expect(existsSync('/tmp/escape-abs.txt')).toBe(false);
      expect(readdirSync(dest).filter((n) => n.startsWith('.files-direct-'))).toEqual([]);
      expect(walk(dest).length).toBe(NAMES.length);
    } finally {
      if (shared === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = shared;
    }
  });

  it('refuses a folder inside the destination that is a link to somewhere else, and writes nothing through it', async () => {
    const root = tmp();
    const dest = join(root, 'inbox');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(dest);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dest, 'photos'));
    const { saver, saved } = await run(dest, [{ name: 'photos/a.jpg', bytes: pattern(BS + 1) }]);
    await saver.close();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.refused?.reason).toBe('link');
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('never writes through a link that stands where the file goes, even when told to overwrite', async () => {
    const root = tmp();
    const dest = join(root, 'inbox');
    mkdirSync(dest);
    const target = join(root, 'precious.txt');
    writeFileSync(target, 'keep me');
    symlinkSync(target, join(dest, 'note.txt'));
    const { saver, saved } = await run(dest, [{ name: 'note.txt', bytes: pattern(100) }], { overwrite: true });
    await saver.close();
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(saved[0]!.path ? lstatSync(saved[0]!.path).isSymbolicLink() : true).toBe(false);
  });

  it('does not replace a file that is already there unless told to, and says so with a reason word', async () => {
    const dest = tmp();
    writeFileSync(join(dest, 'a.txt'), 'old');
    const first = await run(dest, [{ name: 'a.txt', bytes: pattern(50) }]);
    await first.saver.close();
    expect(first.saved[0]!.refused?.reason).toBe('would_overwrite');
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('old');
    const second = await run(dest, [{ name: 'a.txt', bytes: pattern(50) }], { overwrite: true });
    await second.saver.close();
    expect(readFileSync(join(dest, 'a.txt'))).toEqual(Buffer.from(pattern(50)));
  });
});

describe('the file sink writes block by block and checks every block and the whole file', () => {
  it('moves a file of 3.5 blocks intact; no write or read is bigger than a block; partial files are gone at the end', async () => {
    const dest = tmp();
    const bytes = pattern(BS * 3 + BS / 2, 9);
    const { saver, saved, events, receiver } = await run(dest, [{ name: 'big.bin', bytes }]);
    expect(events.some((e) => e.k === 'complete' && e.dir === 'in')).toBe(true);
    expect(readFileSync(saved[0]!.path!)).toEqual(Buffer.from(bytes));
    expect(saver.sinks.stats.maxWrite).toBeLessThanOrEqual(BS);
    expect(saver.sinks.stats.maxRead).toBeLessThanOrEqual(BS);
    expect(saver.sinks.stats.writes).toBe(4);
    expect(receiver.stats.maxHeld).toBeLessThanOrEqual(BS);
    expect(saver.sinks.kind).toBe('disk');
    await saver.close();
    expect(readdirSync(dest)).toEqual(['big.bin']);
  });

  it('an empty file arrives as an empty file', async () => {
    const dest = tmp();
    const { saver, saved } = await run(dest, [{ name: 'empty.txt', bytes: new Uint8Array(0) }, { name: 'after.bin', bytes: pattern(10) }]);
    await saver.close();
    expect(saved.map((s) => s.error)).toEqual([undefined, undefined]);
    expect(readFileSync(join(dest, 'empty.txt'))).toEqual(Buffer.alloc(0));
    expect(readFileSync(join(dest, 'after.bin'))).toEqual(Buffer.from(pattern(10)));
  });

  it('a block damaged on the way is sent again and the file still arrives right', async () => {
    const dest = tmp();
    const bytes = pattern(BS * 3, 4);
    let pieces = 0;
    const { saver, saved, events } = await run(dest, [{ name: 'a.bin', bytes }], {
      tamper: (d) => {
        if (typeof d === 'string' || ++pieces !== 2) return d;
        const c = new Uint8Array(d.slice(0));
        c[c.length - 1] = c[c.length - 1]! ^ 1;
        return c.buffer;
      },
    });
    await saver.close();
    expect(events.some((e) => e.k === 'refetched')).toBe(true);
    expect(readFileSync(saved[0]!.path!)).toEqual(Buffer.from(bytes));
  });

  it('a file the sender never finishes leaves no partial file when the receiver closes', async () => {
    const dest = tmp();
    const [a, b] = channelPair();
    const saver = await createSaver(dest, { overwrite: false });
    const receiver = new Session({ channel: b, sinks: saver.sinks, odd: false, blockSize: BS, emit: () => {} });
    const sender = new Session({ channel: a, sinks: saver.sinks, odd: true, blockSize: BS, emit: () => {}, after: () => () => {} });
    a.onMessage = (d) => sender.handle(d);
    b.onMessage = (d) => receiver.handle(d);
    // cut the channel after the first block
    let n = 0;
    a.tap = (d) => (typeof d !== 'string' && ++n > 1 ? null : d);
    sender.send([source('half.bin', pattern(BS * 5))]);
    await new Promise((r) => setTimeout(r, 40));
    await receiver.close();
    await saver.close();
    expect(readdirSync(dest)).toEqual([]);
  });
});

describe('a received file may not land in a place for keys or passwords, even under an allowed folder', () => {
  const NAMES = ['.ssh/authorized_keys', 'proj/.ssh/id_rsa', '.npmrc', 'a/.aws/credentials', '.gnupg/pubring.kbx'];
  it('is refused, with and without overwrite, and nothing is created or replaced; an ordinary nested file still works', async () => {
    for (const overwrite of [false, true]) {
      const home = tmp();
      mkdirSync(join(home, '.ssh'));
      writeFileSync(join(home, '.ssh', 'authorized_keys'), 'mine');
      writeFileSync(join(home, '.npmrc'), 'token=mine');
      const roots = await Roots.create([home], { home });
      const bytes = pattern(500);
      const { saver, saved } = await run(home, [...NAMES, 'docs/notes/readme.txt'].map((name) => ({ name, bytes })), { overwrite, guard: (p) => roots.guardTarget(p) });
      await saver.close();
      const byName = Object.fromEntries(saved.map((s) => [s.name, s]));
      for (const n of NAMES) expect(byName[n]?.refused?.reason, `${n} (overwrite ${overwrite})`).toBe('protected');
      expect(byName['docs/notes/readme.txt']?.path).toBe(join(home, 'docs', 'notes', 'readme.txt'));
      expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe('mine');
      expect(readFileSync(join(home, '.npmrc'), 'utf8')).toBe('token=mine');
      expect(readdirSync(join(home, '.ssh'))).toEqual(['authorized_keys']);
      expect(existsSync(join(home, 'proj'))).toBe(false); // no folder was made on the way
      expect(existsSync(join(home, 'a'))).toBe(false);
      expect(existsSync(join(home, '.gnupg'))).toBe(false);
    }
  });

  it('is refused when the offer arrives, before anything is taken', async () => {
    const home = tmp();
    const roots = await Roots.create([home], { home });
    const clash = await conflicts(realpathSync(home), [...NAMES, 'ok/file.txt'], true, (p) => roots.guardTarget(p));
    expect(clash.map((c) => c.name)).toEqual(NAMES);
    expect(clash.every((c) => c.reason === 'protected')).toBe(true);
  });

  it('is the case that got through before the rule: with no guard the same file is saved', async () => {
    const home = tmp();
    const { saver, saved } = await run(home, [{ name: '.ssh/authorized_keys', bytes: pattern(20) }]);
    await saver.close();
    expect(saved[0]?.path).toBe(join(home, '.ssh', 'authorized_keys'));
  });
});

describe('the MCP server only reads and writes where it was told to', () => {
  const home = () => {
    const h = tmp();
    mkdirSync(join(h, '.ssh'), { recursive: true });
    writeFileSync(join(h, '.ssh', 'id_ed25519'), 'PRIVATE');
    mkdirSync(join(h, 'work', 'sub'), { recursive: true });
    writeFileSync(join(h, 'work', 'report.txt'), 'hello');
    writeFileSync(join(h, 'work', 'sub', 'b.txt'), 'b');
    mkdirSync(join(h, 'other'));
    writeFileSync(join(h, 'other', 'secret.txt'), 'nope');
    return h;
  };

  it('lets a file inside an allowed folder through, as its real path', async () => {
    const h = home();
    const roots = await Roots.create([join(h, 'work')], { home: h });
    expect(await roots.readable(join(h, 'work', 'report.txt'))).toBe(join(h, 'work', 'report.txt'));
  });

  it('refuses ~/.ssh even when the whole home folder is allowed, with a reason in plain words', async () => {
    const h = home();
    const roots = await Roots.create([h], { home: h });
    const err = await roots.readable(join(h, '.ssh', 'id_ed25519')).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Refused);
    expect((err as Refused).reason).toBe('protected');
    expect((err as Refused).message).toMatch(/keys|passwords|private/i);
    expect((err as Refused).message).not.toMatch(/\b(TURN|relay server|NAT|peer|WebRTC|ICE|STUN)\b/);
    // and the folder itself cannot be named as a place to save into
    await expect(roots.writable(join(h, '.ssh'))).rejects.toMatchObject({ reason: 'protected' });
  });

  it('refuses a path outside the allowed folders, a way round by "..", and a folder that is a link out', async () => {
    const h = home();
    const roots = await Roots.create([join(h, 'work')], { home: h });
    await expect(roots.readable(join(h, 'other', 'secret.txt'))).rejects.toMatchObject({ reason: 'outside' });
    await expect(roots.readable(join(h, 'work', '..', 'other', 'secret.txt'))).rejects.toMatchObject({ reason: 'outside' });
    await expect(roots.readable('/etc/hostname')).rejects.toMatchObject({ reason: 'outside' });
    symlinkSync(join(h, 'other'), join(h, 'work', 'door'));
    symlinkSync(join(h, 'other', 'secret.txt'), join(h, 'work', 'quiet.txt'));
    await expect(roots.readable(join(h, 'work', 'door', 'secret.txt'))).rejects.toMatchObject({ reason: 'outside' });
    await expect(roots.readable(join(h, 'work', 'quiet.txt'))).rejects.toMatchObject({ reason: 'outside' });
    await expect(roots.writable(join(h, 'work', 'door'))).rejects.toMatchObject({ reason: 'outside' });
  });

  it('will not start with a root that is too wide or that is a protected folder', async () => {
    const h = home();
    await expect(Roots.create(['/'], { home: h })).rejects.toBeInstanceOf(Refused);
    await expect(Roots.create([join(h, '.ssh')], { home: h })).rejects.toMatchObject({ reason: 'protected' });
    await expect(Roots.create([join(h, 'nowhere')], { home: h })).rejects.toBeInstanceOf(Refused);
  });

  it('lets a folder to save into be made inside an allowed folder, and refuses one outside', async () => {
    const h = home();
    const roots = await Roots.create([join(h, 'work')], { home: h });
    expect(await roots.writable(join(h, 'work', 'incoming', 'today'))).toBe(join(h, 'work', 'incoming', 'today'));
    await expect(roots.writable(join(h, 'other', 'x'))).rejects.toMatchObject({ reason: 'outside' });
  });

  it('a folder handed over whole leaves out what it may not send, and says what it left out', async () => {
    const h = home();
    const roots = await Roots.create([h], { home: h });
    symlinkSync(join(h, 'other', 'secret.txt'), join(h, 'work', 'quiet.txt'));
    mkdirSync(join(h, 'work', '.ssh'));
    writeFileSync(join(h, 'work', '.ssh', 'id_rsa'), 'PRIVATE2');
    const { files, skipped } = await collect([join(h, 'work')], { roots });
    expect(files.map((f) => f.name).sort()).toEqual(['work/report.txt', 'work/sub/b.txt']);
    expect(skipped.map((s) => s.reason).sort()).toEqual(['link', 'protected']);
    expect(files.every((f) => f.size > 0)).toBe(true);
    // reading what was picked goes block by block
    const s = sendableOf(files.find((f) => f.name === 'work/report.txt')!);
    expect(new Uint8Array(await s.slice(1, 4).arrayBuffer())).toEqual(new Uint8Array(Buffer.from('ell')));
    // the file named outright is refused, not skipped quietly
    await expect(collect([join(h, '.ssh', 'id_ed25519')], { roots })).rejects.toMatchObject({ reason: 'protected' });
  });
});
