import { describe, expect, it } from 'vitest';
import { ASK_NOTE_MAX_CHARS } from '../../src/shared/config.ts';
import { bytesOf, connect, pattern, source } from './helpers/link.ts';

const BS = 10_000;
const fast = (fn: () => void) => {
  const t = setTimeout(fn, 20);
  return () => clearTimeout(t);
};
const frames = (end: { sent: (string | ArrayBuffer)[] }) => end.sent.filter((d): d is string => typeof d === 'string').map((s) => JSON.parse(s) as Record<string, unknown>);

describe('asking for files', () => {
  it('a request reaches the other side with its note, cleaned there, and is answered "asking"; nothing is sent', async () => {
    const { sender, receiver, settle } = await connect(BS, { ask: true });
    const b = sender.session.askFor('  the signed\nlease\u202e  ');
    await settle();
    expect(receiver.events).toEqual([{ k: 'asked', b, note: 'the signed lease' }]);
    expect(frames(receiver.end)).toEqual([{ t: 'asking', b }]);
    expect(sender.end.sent.filter((d) => typeof d !== 'string')).toHaveLength(0);
    expect(sender.events).toEqual([]);
  });

  it('the request is a manifest with no files and no version word, so a page from before it answers cancel (its own out-of-date path)', async () => {
    const { sender, receiver, settle } = await connect(BS, { ask: true });
    sender.session.askFor('x');
    await settle();
    const wire = frames(sender.end)[0]!;
    expect(wire).toMatchObject({ t: 'manifest', files: [], ask: { note: 'x' } });
    expect('v' in wire).toBe(false);
    void receiver;
  });

  it('a note is cut to the limit by the asker and again by the receiver, which also drops hidden characters', async () => {
    const { sender, receiver, settle } = await connect(BS, { ask: true });
    sender.session.askFor('n'.repeat(ASK_NOTE_MAX_CHARS * 3));
    await settle();
    const e = receiver.events.find((x) => x.k === 'asked') as { note: string };
    expect(e.note).toHaveLength(ASK_NOTE_MAX_CHARS);
    // a note longer or odder than the asker's own page would send is cleaned on arrival all the same
    receiver.end.onMessage(JSON.stringify({ t: 'manifest', b: 3, blockSize: BS, files: [], ask: { note: '\u0000a\u202eb' + 'z'.repeat(500) } }));
    await settle();
    const second = receiver.events.filter((x) => x.k === 'asked')[1] as { note: string };
    expect(second.note.startsWith('ab')).toBe(true);
    expect(second.note).toHaveLength(ASK_NOTE_MAX_CHARS);
  });

  it('no note, or a note of nothing, is no note', async () => {
    const { sender, receiver, settle } = await connect(BS, { ask: true });
    sender.session.askFor();
    sender.session.askFor('  \u0000 ');
    receiver.end.onMessage(JSON.stringify({ t: 'manifest', b: 7, blockSize: BS, files: [], ask: 'not an object' }));
    receiver.end.onMessage(JSON.stringify({ t: 'manifest', b: 9, blockSize: BS, files: [], ask: { note: 5 } }));
    await settle();
    expect(receiver.events.filter((x) => x.k === 'asked').map((x) => (x as { note: string }).note)).toEqual(['', '', '', '']);
    expect(receiver.events.some((x) => x.k === 'error')).toBe(false);
  });

  it('the person asked answers by sending a batch of its own, and the asker is asked the usual question about it', async () => {
    const { sender, receiver, settle } = await connect(BS, { ask: true });
    sender.session.askFor('the photos');
    await settle();
    const bytes = pattern(BS * 2 + 3, 9);
    const b = receiver.session.send([source('photo.jpg', bytes)]);
    expect(b).toBe(2); // the other side's numbers, as for any batch
    await settle();
    expect(sender.events.find((e) => e.k === 'offered')).toMatchObject({ k: 'offered', b: 2, files: 1, bytes: bytes.length });
    expect(sender.files.size).toBe(0); // nothing is saved until the asker says yes
    sender.session.accept(2);
    await settle();
    expect(await bytesOf(sender.files.get('photo.jpg')!)).toEqual(bytes);
    expect(sender.events.filter((e) => e.k === 'error')).toEqual([]);
  });

  it('the asker can say no to what comes back, and nothing moves', async () => {
    const { sender, receiver, settle } = await connect(BS, { ask: true });
    sender.session.askFor();
    await settle();
    const b = receiver.session.send([source('a.bin', pattern(BS))]);
    await settle();
    sender.session.decline(b);
    await settle();
    expect(receiver.events).toContainEqual({ k: 'declined', b, by: 'remote' });
    expect(sender.files.size).toBe(0);
  });

  it('a request is never taken for a batch twice, and a number used by a request is not reused', async () => {
    const { sender, receiver, settle } = await connect(BS, { ask: true });
    const a = sender.session.askFor('one');
    const s = sender.session.send([source('x.bin', pattern(10))]);
    expect([a, s]).toEqual([1, 3]);
    await settle();
    receiver.end.onMessage(JSON.stringify({ t: 'manifest', b: a, blockSize: BS, files: [], ask: {} })); // the same number again
    await settle();
    expect(receiver.events.filter((e) => e.k === 'error')).toMatchObject([{ why: 'unreadable', site: 'v21' }]);
  });
});

describe('a page from before requests', () => {
  it('answers a request with cancel, as it answers any manifest without the version word: the asker is told the other page is out of date', async () => {
    const { sender, receiver, settle } = await connect(BS, { ask: true, after: fast });
    // what a page from before this change does with the request: it takes it for an old sender and cancels it
    receiver.end.tap = () => null;
    const b = sender.session.askFor('the lease');
    sender.end.onMessage(JSON.stringify({ t: 'cancel', b }));
    await settle();
    expect(sender.events).toEqual([{ k: 'error', why: 'refresh', b, site: 'old-receiver' }]);
    void receiver;
  });

  it('one that says nothing at all is called out of date after the usual wait, and not before', async () => {
    const { sender, receiver, settle } = await connect(BS, { after: fast });
    receiver.end.tap = () => null;
    const b = sender.session.askFor('the lease');
    await settle();
    expect(sender.events).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(sender.events).toEqual([{ k: 'error', why: 'refresh', b, site: 'old-receiver' }]);
  });

  it('a current page that answers is never called out of date, however long the person takes', async () => {
    const { sender, settle } = await connect(BS, { ask: true, after: fast });
    sender.session.askFor('the lease');
    await settle();
    await new Promise((r) => setTimeout(r, 60));
    expect(sender.events).toEqual([]);
  });
});
