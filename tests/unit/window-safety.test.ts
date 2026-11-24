import { request } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Desk, refusal, serveDesk, type DeskServer } from '../../src/cli/src/window.ts';
import { windowPage, windowPolicy } from '../../src/cli/src/window-page.ts';
import { programDevice } from '../../src/shared/device.ts';

// files-direct-30, D2: the window's page is served on this computer only, and only to the page that was given it. Every refusal below has its own test.
// A request is made by hand (node:http), so the Host and Origin it carries are the ones a hostile web page could make a browser send.

const root = realpathSync(mkdtempSync(join(tmpdir(), 'fd-cli-window-')));
const env = { origin: 'http://127.0.0.1:1', ice: [], device: programDevice('Linux', 0), install: 'npm install -g x' };
const servers: DeskServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  rmSync(root, { recursive: true, force: true });
});

async function up() {
  const downloads = join(root, 'Downloads-' + servers.length);
  const desk = new Desk({ env, downloads });
  const server = await serveDesk(desk, { idleMs: 60_000, firstMs: 60_000 });
  servers.push(server);
  const word = new URL(server.url).pathname.split('/')[2]!;
  return { desk, server, word, downloads };
}

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function call(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}
const post = (port: number, word: string, body: unknown, h: Record<string, string> = {}) =>
  call(port, `/w/${word}/act`, { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });

describe('where the window is served', () => {
  it('listens on this computer only, on a port of its own, with an unguessable word in the path', async () => {
    const a = await up();
    const b = await up();
    expect(new URL(a.server.url).hostname).toBe('127.0.0.1');
    expect(a.word).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.word).not.toBe(b.word);
    expect(a.server.port).not.toBe(b.server.port);
  });

  it('gives the page, with a policy that allows only its own script and style, and says it must not be kept or framed', async () => {
    const { server, word } = await up();
    const r = await call(server.port, `/w/${word}/`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/html');
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toMatch(/^default-src 'none'; script-src 'nonce-[\w+/=]+'; style-src 'nonce-[\w+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/unsafe-|https?:|\*/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(r.body).toContain(`<script nonce="${nonce}">`);
    expect(r.body).not.toMatch(/<script(?![^>]*nonce)/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    // a different nonce for every load
    const again = await call(server.port, `/w/${word}/`);
    expect(String(again.headers['content-security-policy'])).not.toBe(csp);
    expect(windowPolicy('x')).toContain("'nonce-x'");
    expect(windowPage('x')).toContain('nonce="x"');
  });

  it('sends no header that would let another site read it', async () => {
    const { server, word } = await up();
    const r = await call(server.port, `/w/${word}/state`);
    expect(r.status).toBe(200);
    for (const h of Object.keys(r.headers)) expect(h).not.toMatch(/^access-control-/);
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});

describe('what it refuses', () => {
  it('a request without the word, with a wrong word, or with the word cut short: nothing at all, 404', async () => {
    const { server, word } = await up();
    for (const path of ['/', '/state', '/w/', `/w/${word.slice(0, -1)}/`, `/w/${word.toUpperCase()}/`, `/w/x${word}/`, '/w/../state', `/${word}/`]) {
      const r = await call(server.port, path);
      expect(r.status, path).toBe(404);
      expect(r.body).toBe('');
    }
  });

  it('another Host (a web page that points its own name at 127.0.0.1, so called DNS rebinding): 403, even with the right word', async () => {
    const { server, word } = await up();
    for (const host of ['evil.example', `evil.example:${server.port}`, `localhost:${server.port}`, '127.0.0.1', `127.0.0.1:${server.port + 1}`, `127.0.0.1:${server.port}.evil.example`]) {
      for (const path of [`/w/${word}/`, `/w/${word}/state`]) expect((await call(server.port, path, { host })).status, host).toBe(403);
      expect((await post(server.port, word, { do: 'close' }, { host })).status, host).toBe(403);
    }
  });

  it('another Origin: 403, for a read as for a press (no cross-site reading, no cross-site pressing)', async () => {
    const { server, word } = await up();
    for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:1', `https://127.0.0.1:${server.port}`, `http://localhost:${server.port}`]) {
      expect((await call(server.port, `/w/${word}/state`, { headers: { origin } })).status, origin).toBe(403);
      expect((await post(server.port, word, { do: 'close' }, { origin })).status, origin).toBe(403);
    }
  });

  it('a press with no Origin and no same-origin mark: 403; one that is not JSON: 415; a method that is neither: 405', async () => {
    const { server, word } = await up();
    const bare = await call(server.port, `/w/${word}/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"do":"close"}' });
    expect(bare.status).toBe(403);
    const form = await post(server.port, word, 'do=close', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    const text = await call(server.port, `/w/${word}/act`, { method: 'POST', headers: { origin: `http://127.0.0.1:${server.port}`, 'content-type': 'text/plain' }, body: '{"do":"close"}' });
    expect(text.status).toBe(415);
    expect((await call(server.port, `/w/${word}/act`, { method: 'PUT', headers: { origin: `http://127.0.0.1:${server.port}` } })).status).toBe(405);
    expect((await call(server.port, `/w/${word}/state`, { method: 'DELETE' })).status).toBe(405);
    // a press from the page itself, marked by the browser as same-origin, is fine even when it sends no Origin
    const ok = await call(server.port, `/w/${word}/act`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{"do":"nothing"}' });
    expect(ok.status).toBe(200);
  });

  it('the rules as plain data', () => {
    const h = (o: Record<string, string>) => ({ method: 'GET', url: '/w/abc/state', headers: { host: '127.0.0.1:5', ...o } });
    expect(refusal(h({}), 5, 'abc')).toBeNull();
    expect(refusal({ ...h({}), url: '/w/abd/state' }, 5, 'abc')).toBe(404);
    expect(refusal(h({ host: 'a.b:5' }), 5, 'abc')).toBe(403);
    expect(refusal(h({ origin: 'http://a.b' }), 5, 'abc')).toBe(403);
  });
});

describe('what the page can and cannot ask for', () => {
  it('the page can name no path: a press that carries one is refused, and nothing is opened, read or written', async () => {
    const { server, word, downloads } = await up();
    for (const body of [
      { do: 'send', paths: ['/etc/passwd'] },
      { do: 'send', path: '/etc/passwd' },
      { do: 'receive', target: '/etc/passwd', to: '/tmp/elsewhere' },
      { do: 'open', path: 'C:\\Windows' },
      { do: 'save-to', folder: '/tmp/elsewhere' },
    ]) {
      const r = await post(server.port, word, body);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).ok, JSON.stringify(body)).toBe(false);
    }
    expect(readdirSync(root).filter((n) => n === 'elsewhere')).toEqual([]);
    // nothing started: still the start page
    expect(JSON.parse((await call(server.port, `/w/${word}/state`)).body)).toMatchObject({ phase: 'home', job: null, where: downloads });
  });

  it('"ask" starts one thing and nothing else: a folder named in the press is ignored, the files can only go to the folder the program chose', async () => {
    const { desk, server, word, downloads } = await up();
    const r = JSON.parse((await post(server.port, word, { do: 'ask', note: 'x', to: join(root, 'elsewhere'), dest: join(root, 'elsewhere'), downloads: join(root, 'elsewhere') })).body);
    expect(r.ok).toBe(true);
    expect(JSON.parse((await call(server.port, `/w/${word}/state`)).body)).toMatchObject({ job: 'ask', where: downloads });
    expect(readdirSync(root).includes('elsewhere')).toBe(false);
    await desk.act({ do: 'close' });
    await desk.ended;
  });

  it('"receive" takes only a link of this site or a nine-digit code, as text', async () => {
    const { server, word } = await up();
    for (const target of ['https://evil.example/r/#abcdefghijklmnopqrstuv', 'file:///etc/passwd', '../../x', '12345', '', 'http://127.0.0.1:1/other#abcdefghijklmnopqrstuv']) {
      const r = JSON.parse((await post(server.port, word, { do: 'receive', target })).body);
      expect(r.ok, target).toBe(false);
      expect(r.error).toBe('That is not a link from this site or a nine-digit code.');
    }
  });

  it('a body that is not JSON, or too big, ends in an error and not in a crash', async () => {
    const { server, word } = await up();
    const raw = await call(server.port, `/w/${word}/act`, { method: 'POST', headers: { origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json' }, body: 'not json' });
    expect(raw.status).toBe(400);
    const big = await post(server.port, word, { do: 'ask', note: 'x'.repeat(100_000) }).catch(() => ({ status: 0 }));
    expect([0, 400]).toContain(big.status);
    expect((await call(server.port, `/w/${word}/state`)).status).toBe(200);
  });

  it('puts what came from outside in as text: the page never writes a name or a note into markup', () => {
    const page = windowPage('n');
    // the only place the page sets markup is the picture of the code, which the program made from the link
    expect([...page.matchAll(/innerHTML/g)].length).toBe(1);
    expect(page).toContain('qr.innerHTML = s.qr');
    expect(page).not.toMatch(/document\.write|eval\(|insertAdjacentHTML|outerHTML/);
  });
});

describe('one job at a time', () => {
  it('two presses at once start one engine: the second is told something is open, and Close cancels the one that runs', async () => {
    const { desk, downloads } = await up();
    const both = await Promise.all([desk.act({ do: 'ask', note: 'first' }), desk.act({ do: 'ask', note: 'second' })]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)!.error).toBe('Something is already open in this window.');
    expect(desk.snapshot()).toMatchObject({ job: 'ask', where: downloads });
    expect(desk.snapshot().sub).toContain('first');
    // a receive while an ask is open is refused too
    const code = await desk.act({ do: 'receive', target: '123456789' });
    expect(code).toEqual({ ok: false, error: 'Something is already open in this window.' });
    await desk.act({ do: 'close' });
    await desk.ended;
  });

  it('an ask and a receive at once start one engine', async () => {
    const { desk } = await up();
    const both = await Promise.all([desk.act({ do: 'receive', target: '123456789' }), desk.act({ do: 'ask', note: 'x' })]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    await desk.act({ do: 'close' });
    await desk.ended;
  });

  it('Close while the folder is still being made starts nothing', async () => {
    const { desk } = await up();
    const pending = desk.act({ do: 'ask', note: 'late' });
    await desk.act({ do: 'close' });
    expect(await pending).toEqual({ ok: false, error: 'The window was closed.' });
    expect(await desk.ended).toBe(0);
    expect(desk.snapshot()).toMatchObject({ phase: 'home', job: null });
    expect(await desk.act({ do: 'ask', note: 'after' })).toEqual({ ok: false, error: 'Something is already open in this window.' });
  });
});

describe('when the window goes away', () => {
  it('a page that stops answering counts as a closed window: the program ends and nothing keeps running', async () => {
    const desk = new Desk({ env, downloads: join(root, 'idle') });
    let gone = false;
    const server = await serveDesk(desk, { idleMs: 1000, firstMs: 1000, onGone: () => (gone = true) });
    servers.push(server);
    const word = new URL(server.url).pathname.split('/')[2]!;
    await call(server.port, `/w/${word}/`); // the page loads once, then says nothing
    expect(await Promise.race([desk.ended, new Promise((r) => setTimeout(() => r('still open'), 3500))])).toBe(0);
    expect(gone).toBe(true);
  }, 10_000);

  it('Close on the start page ends the program with status 0', async () => {
    const { desk, server, word } = await up();
    expect((await post(server.port, word, { do: 'close' })).status).toBe(200);
    expect(await desk.ended).toBe(0);
  });
});
