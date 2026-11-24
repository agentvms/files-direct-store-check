import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appArguments, browserCandidates, defaultOpener } from '../../src/cli/src/browser.ts';
import { gather } from '../../src/cli/src/gather.ts';
import { qrSvg } from '../../src/cli/src/qr.ts';

// files-direct-30: the small parts of the window and the menu that have no page of their own.

const root = realpathSync(mkdtempSync(join(tmpdir(), 'fd-cli-parts-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('one right-click on several files in Windows starts one program for each: they end up in one room', () => {
  it('the first leads and gets every path; the others get nothing and leave', async () => {
    const dir = join(root, 'meet-1');
    const names = ['C:\\a.txt', 'C:\\b b.txt', "C:\\it's.txt", 'C:\\Fotos\\c;d'];
    const opts = { dir, quietMs: 300, maxMs: 3000, staleMs: 20_000 };
    const first = gather(names[0]!, opts);
    await new Promise((r) => setTimeout(r, 60));
    const rest = await Promise.all(names.slice(1).map((n) => gather(n, opts)));
    expect(rest).toEqual([null, null, null]);
    const got = (await first)!;
    expect(got[0]).toBe(names[0]);
    expect([...got].sort()).toEqual([...names].sort());
    expect(readdirSync(root).filter((n) => n.startsWith('meet-1'))).toEqual([]); // nothing left behind
  });

  it('a lone file is a room of one, without waiting more than the quiet time', async () => {
    const t = Date.now();
    expect(await gather('C:\\only.txt', { dir: join(root, 'meet-2'), quietMs: 150 })).toEqual(['C:\\only.txt']);
    expect(Date.now() - t).toBeLessThan(2500);
  });

  it('two right-clicks one after the other make two rooms, not one', async () => {
    const opts = { dir: join(root, 'meet-3'), quietMs: 100 };
    expect(await gather('one', opts)).toEqual(['one']);
    expect(await gather('two', opts)).toEqual(['two']);
  });

  it('a meeting nobody leads any more (a program that died) is cleared, and the next one leads', async () => {
    const dir = join(root, 'meet-4');
    const { mkdirSync, utimesSync } = await import('node:fs');
    mkdirSync(dir);
    utimesSync(dir, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(await gather('late', { dir, quietMs: 100, staleMs: 20_000 })).toEqual(['late']);
  });
});

describe('which browser shows the window', () => {
  it('Windows: Edge first (it is on every Windows 10 and 11), then Chrome, from the usual folders', () => {
    const c = browserCandidates('win32', { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Ann\\AppData\\Local' });
    expect(c[0]).toBe('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(c.findIndex((p) => p.includes('chrome.exe'))).toBeGreaterThan(c.findIndex((p) => p.includes('msedge.exe')));
  });
  it('Mac: Chrome, then Edge, from /Applications and the person\'s own Applications', () => {
    const c = browserCandidates('darwin', { HOME: '/Users/ann' });
    expect(c[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(c).toContain('/Users/ann/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  });
  it('the person\'s own choice comes first', () => {
    expect(browserCandidates('linux', { FILES_DIRECT_BROWSER: '/opt/b/browser', PATH: '/usr/bin' })[0]).toBe('/opt/b/browser');
  });
  it('the arguments: only the page, in a window of its own, with a profile that is thrown away', () => {
    const a = appArguments('http://127.0.0.1:5/w/x/', '/tmp/p');
    expect(a).toContain('--app=http://127.0.0.1:5/w/x/');
    expect(a).toContain('--user-data-dir=/tmp/p');
    expect(a.some((x) => x.startsWith('--window-size='))).toBe(true);
  });
  it('with no such browser, the default one is asked to open the address: one argument each', () => {
    expect(defaultOpener('darwin', 'http://127.0.0.1:5/')).toEqual(['/usr/bin/open', ['http://127.0.0.1:5/']]);
    expect(defaultOpener('win32', 'http://127.0.0.1:5/')[1]).toEqual(['url.dll,FileProtocolHandler', 'http://127.0.0.1:5/']);
  });
});

describe('the code for the window', () => {
  it('is a picture made of path letters and digits only', () => {
    const svg = qrSvg('http://127.0.0.1:5/r/#abcdefghijklmnopqrstuv');
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    expect(svg).toMatch(/<path d="(M\d+ \d+h\d+v1h-\d+z)+" fill="#000000"\/>/);
    expect(svg).not.toMatch(/<script|on\w+=|href/i);
  });
});
