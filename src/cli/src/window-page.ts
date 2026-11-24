import { ASK_NOTE_MAX_CHARS } from '../../shared/config.ts';
import { COLOURS, rootVars } from '../../shared/tokens.ts';

/**
 * The page the Files Direct window shows (files-direct-30). It is only a picture of what the program is doing: it asks the program for the state, and
 * tells it what the person pressed (cancel, ask, receive, let in, close). It holds no transfer rules and can never name a file or a folder:
 * what is sent comes from the program's own arguments, and what is received goes to the Downloads folder (or the folder named on the command line).
 * Every word that came from outside (file names, the other device's kind) is put in with textContent, never as markup.
 */
const CSS = `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--fd-canvas);color:var(--fd-ink-primary);font:15px/1.5 var(--fd-font-sans);-webkit-font-smoothing:antialiased}
main{padding:16px;display:flex;justify-content:center}
.parcel{width:100%;max-width:440px;background:var(--fd-parcel);border:1px solid var(--fd-border-subtle);border-radius:var(--fd-radius-parcel);box-shadow:var(--fd-shadow-parcel);padding:20px;display:flex;flex-direction:column;gap:16px}
.parcel>*{margin:0}
h1{font-family:var(--fd-font-display);font-size:1.375rem;line-height:1.25;letter-spacing:-.01em;font-weight:600;margin:0;text-wrap:balance}
h2{font-size:1rem;margin:0}
.sub{color:var(--fd-ink-secondary);font-size:.875rem}
.small{color:var(--fd-ink-muted);font-size:.8125rem}
.head{display:flex;flex-direction:column;gap:4px;text-align:center;align-items:center}
.tile{width:36px;height:36px;border-radius:var(--fd-radius-pill);background:var(--fd-pine-600);color:var(--fd-on-pine);display:flex;align-items:center;justify-content:center;font-weight:700}
.tile.bad{background:var(--fd-danger-bg);color:var(--fd-danger-ink)}
.files{list-style:none;margin:0;padding:0;border:1px solid var(--fd-border-subtle);border-radius:var(--fd-radius-media);max-height:150px;overflow:auto}
.files li{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;border-top:1px solid var(--fd-border-subtle);font-size:.875rem}
.files li:first-child{border-top:0}
.files .n{overflow-wrap:anywhere;font-weight:500}
.files .s{color:var(--fd-ink-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.share{display:flex;flex-direction:column;gap:12px;background:var(--fd-inset);border-radius:var(--fd-radius-tray);padding:14px}
.top{display:flex;gap:16px;align-items:center}
.qr{flex:none;width:132px;height:132px;border-radius:var(--fd-radius-control);overflow:hidden;background:#fff}
.qr svg{display:block;width:100%;height:100%}
.side{min-width:0;display:flex;flex-direction:column;gap:6px}
.code{font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.04em}
.row{display:flex;gap:8px}
input[type=text]{flex:1;min-width:0;min-height:40px;padding:0 12px;border:1px solid var(--fd-border-strong);border-radius:var(--fd-radius-control);background:var(--fd-parcel);color:var(--fd-ink-primary);font:inherit;font-size:.875rem}
button{min-height:40px;padding:0 16px;border-radius:var(--fd-radius-control);border:1px solid var(--fd-border-strong);background:var(--fd-parcel);color:var(--fd-ink-primary);font:inherit;font-weight:600;cursor:pointer;transition:background var(--fd-dur-fade) var(--fd-ease),border-color var(--fd-dur-fade) var(--fd-ease)}
button:hover{border-color:var(--fd-border-hover)}
button.primary{background:var(--fd-pine-600);border-color:var(--fd-pine-600);color:var(--fd-on-pine)}
button.primary:hover{background:var(--fd-pine-700);border-color:var(--fd-pine-700)}
:focus-visible{outline:3px solid var(--fd-pine-600);outline-offset:2px}
.status{display:flex;align-items:center;gap:8px;justify-content:center;color:var(--fd-ink-secondary);font-size:.875rem;text-align:center}
.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--fd-pine-live)}
@media (prefers-reduced-motion:no-preference){@keyframes b{0%,100%{opacity:.55}50%{opacity:1}}.dot{animation:b var(--fd-dur-pulse) var(--fd-ease-breath) infinite}}
progress{appearance:none;-webkit-appearance:none;border:0;border-radius:var(--fd-radius-pill);background:var(--fd-inset);overflow:hidden;height:6px;width:100%}
progress::-webkit-progress-bar{background:var(--fd-inset)}
progress::-webkit-progress-value{background:var(--fd-pine-600);border-radius:var(--fd-radius-pill)}
progress::-moz-progress-bar{background:var(--fd-pine-600);border-radius:var(--fd-radius-pill)}
.count{display:flex;justify-content:space-between;gap:12px;font-size:.8125rem;font-variant-numeric:tabular-nums}
.ask{display:flex;flex-direction:column;gap:8px;background:var(--fd-inset);border-radius:var(--fd-radius-tray);padding:14px}
.knock{background:var(--fd-amber-bg);color:var(--fd-amber-ink);border-radius:var(--fd-radius-tray);padding:12px;display:flex;flex-direction:column;gap:8px}
.err{color:var(--fd-danger-ink);font-size:.8125rem}
.actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
[hidden]{display:none!important}
`;

const SCRIPT = `
'use strict';
const base = location.pathname.replace(/[^/]*$/, '');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let last = '';
async function act(body) {
  const res = await fetch(base + 'act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json().catch(() => ({ ok: false }));
}
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
function list(items, more) {
  const ul = el('ul', 'files');
  for (const it of items) { const li = el('li'); li.append(el('span', 'n', it.name), el('span', 's', it.size)); ul.append(li); }
  if (more > 0) { const li = el('li'); li.append(el('span', 'n', 'and ' + more + ' more')); ul.append(li); }
  return ul;
}
function share(s) {
  const box = el('div', 'share');
  const top = el('div', 'top');
  const qr = el('div', 'qr'); qr.innerHTML = s.qr; // made by the program from the link: only path letters and digits
  const side = el('div', 'side');
  side.append(el('div', 'small', 'Scan with a phone camera, or type this code on the Files Direct page'), el('div', 'code', s.code));
  top.append(qr, side);
  const row = el('div', 'row');
  const inp = el('input'); inp.type = 'text'; inp.readOnly = true; inp.value = s.link; inp.setAttribute('aria-label', 'Link to share');
  const copy = el('button', '', 'Copy');
  copy.onclick = async () => { try { await navigator.clipboard.writeText(s.link); copy.textContent = 'Copied'; } catch { inp.select(); } setTimeout(() => (copy.textContent = 'Copy'), 1500); };
  row.append(inp, copy);
  box.append(top, row);
  return box;
}
function status(text, live) { const d = el('div', 'status'); if (live) d.append(el('span', 'dot')); d.append(el('span', '', text)); return d; }
function mark(kind) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', kind === 'ok' ? 'M4.5 10.5l3.5 3.5 7.5-8' : 'M10 5v6M10 14.5v.5');
  svg.append(path); return svg;
}
function head(title, sub, tile) { const h = el('div', 'head'); if (tile) { const t = el('div', 'tile' + (tile === 'bad' ? ' bad' : '')); t.append(mark(tile)); h.append(t); } h.append(el('h1', '', title)); if (sub) h.append(el('div', 'sub', sub)); return h; }
function actions(...b) { const a = el('div', 'actions'); a.append(...b); return a; }
function button(text, cls, fn) { const b = el('button', cls, text); b.onclick = fn; return b; }

function home(s) {
  const p = el('div', 'parcel');
  p.append(head('Files Direct', 'Send files and folders straight to another device. Nothing is kept on our servers.'));
  p.append(el('div', 'sub', 'To send, right-click files or a folder and choose "Send with Files Direct". Here you can ask someone for files, or take files from a link or code.'));
  const ask = el('div', 'ask');
  ask.append(el('h2', '', 'Ask someone for files'), el('div', 'small', 'They get a link. The files come to your Downloads folder.'));
  const note = el('input'); note.type = 'text'; note.maxLength = ${ASK_NOTE_MAX_CHARS}; note.placeholder = 'What you need, for them to read (optional)'; note.setAttribute('aria-label', 'What you need');
  ask.append(note, actions(button('Ask for files', 'primary', () => act({ do: 'ask', note: note.value }))));
  const rec = el('div', 'ask');
  rec.append(el('h2', '', 'Receive with a link or code'));
  const t = el('input'); t.type = 'text'; t.placeholder = 'Paste the link or type the nine digits'; t.setAttribute('aria-label', 'Link or code');
  const err = el('div', 'err'); err.hidden = true; err.setAttribute('role', 'alert');
  const go = async () => { const r = await act({ do: 'receive', target: t.value }); if (!r.ok) { err.textContent = r.error || 'That did not work.'; err.hidden = false; } };
  t.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  rec.append(t, err, actions(button('Receive', 'primary', go)));
  p.append(ask, rec, el('div', 'small', 'Saved files go to ' + s.where + '. Nothing is replaced.'), actions(button('Close', '', () => act({ do: 'close' }))));
  return p;
}

function room(s) {
  const p = el('div', 'parcel');
  const live = s.phase === 'waiting' || s.phase === 'connecting' || s.phase === 'transferring';
  if (s.phase === 'done' || s.phase === 'failed' || s.phase === 'cancelled') {
    p.append(head(s.title, s.message, s.phase === 'done' ? 'ok' : 'bad'));
    if (s.items.length) p.append(list(s.items, s.more));
    p.append(actions(button('Close', 'primary', () => act({ do: 'close' }))));
    return p;
  }
  p.append(head(s.title, s.sub));
  if (s.items.length) p.append(list(s.items, s.more));
  if (s.phase === 'waiting' && s.link) p.append(share(s));
  if (s.knock) {
    const k = el('div', 'knock'); k.setAttribute('role', 'alert');
    k.append(el('div', '', 'Someone typed your code. Only let them in if you know who it is.'), actions(button('Turn away', '', () => act({ do: 'turn-away' })), button('Let them in', 'primary', () => act({ do: 'allow' }))));
    p.append(k);
  }
  if (s.phase === 'transferring') {
    const pr = el('progress'); pr.max = s.progress.total || 1; pr.value = s.progress.done;
    pr.setAttribute('aria-label', 'Progress');
    const c = el('div', 'count'); c.append(el('span', '', s.progressText), el('span', '', s.progressFile));
    p.append(pr, c);
  } else p.append(status(s.status, live));
  p.append(actions(button('Cancel', '', () => act({ do: 'cancel' }))));
  return p;
}

function draw(s) {
  const key = JSON.stringify(s);
  if (key === last) return;
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT' && !document.activeElement.readOnly;
  if (typing && s.phase === 'home' && last.indexOf('"phase":"home"') >= 0) return; // do not take the page from under a person who is typing
  last = key;
  const main = $('main'); clear(main);
  main.append(s.phase === 'home' ? home(s) : room(s));
  // only the closing screens take the focus: a stray key must never answer "let them in"
  const f = main.querySelector('button.primary'); if (f && (s.phase === 'done' || s.phase === 'failed' || s.phase === 'cancelled')) f.focus();
}
async function tick() {
  try { const res = await fetch(base + 'state', { cache: 'no-store' }); if (res.ok) draw(await res.json()); } catch { /* the program has gone: nothing more to show */ }
}
tick(); setInterval(tick, 500);
`;

/** The page, for one token. `nonce` is made again for every load; the page's own style and script are the only ones its policy allows. */
export function windowPage(nonce: string): string {
  const canvas = COLOURS.canvas;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light">
<title>Files Direct</title>
<style nonce="${nonce}">${rootVars()}${CSS}html{background:${canvas}}</style>
</head>
<body>
<main id="main"></main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}

/** The policy sent with the page: nothing from anywhere else, no frames, no forms, and only this page's own requests. */
export const windowPolicy = (nonce: string): string =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
