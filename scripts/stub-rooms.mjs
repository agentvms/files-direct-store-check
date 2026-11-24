// A stand-in for the room service, for the desktop checks on the hosted macOS and Windows machines (files-direct-30, 34): nothing here talks to the real site.
// It answers the home page with the page's own settings block (no addresses for finding a direct route, so nothing leaves this machine), and opens a room
// for whoever asks: it tells the sender the room's nine-digit code. When a receiver opens the same room it lets it in at once (as the real service does for a link),
// tells both sides "ready", and passes their offers, answers and candidates on, so two programs on this machine can really send a file to each other over the
// machine's own network. It keeps nothing and writes nothing but its one line on start.
// Prints one line, {"port": N}, when it is ready (FD_STUB_PORT picks the port; default any). Stops when its input closes.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const HOME = `<!doctype html><title>stand-in</title><script type="application/json" id="fd-config">${JSON.stringify({ ice: [], route: { switch: false } })}</script>`;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PASSED_ON = new Set(['offer', 'answer', 'candidate']);

function frame(text) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

/** Reads the text messages a browser or program sends (masked frames, no fragments: signalling messages are small). */
function reader(onText, onClose) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (buf[1] & 0x80) !== 0;
      const start = at + (masked ? 4 : 0);
      if (buf.length < start + len) return;
      const mask = masked ? buf.subarray(at, at + 4) : null;
      const data = Buffer.from(buf.subarray(start, start + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(start + len);
      if (op === 1) onText(data.toString('utf8'));
      else if (op === 8) return onClose();
    }
  };
}

const rooms = new Map();

const server = createServer((req, res) => {
  if (req.url === '/' || req.url?.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(HOME);
  }
  res.writeHead(426);
  res.end();
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const m = /^\/api\/rooms\/([\w-]+)\/ws\?/.exec(req.url ?? '');
  if (!key || !m) return socket.destroy();
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const tell = (s, msg) => s.writable && s.write(frame(JSON.stringify(msg)));
  const role = /role=sender/.test(req.url) ? 'sender' : 'receiver';
  const room = rooms.get(m[1]) ?? {};
  rooms.set(m[1], room);
  room[role] = socket;
  const other = () => room[role === 'sender' ? 'receiver' : 'sender'];
  if (role === 'sender') tell(socket, { t: 'code', code: '123456789', ref: '0123456789ab' });
  else if (room.sender) for (const s of [room.sender, socket]) tell(s, { t: 'ready', d: { same: true, via: 'link', ref: '0123456789ab' } });
  socket.on(
    'data',
    reader(
      (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (PASSED_ON.has(msg.t) && other()) other().write(frame(text));
        else if (msg.t === 'device' && other()) other().write(frame(role === 'receiver' ? JSON.stringify({ t: 'device', d: { ...msg.d, joined: 'link' } }) : text));
        else if (msg.t === 'relay') tell(socket, { t: 'relay', d: { servers: [] } });
      },
      () => socket.end(),
    ),
  );
  socket.on('close', () => {
    if (room[role] === socket) delete room[role];
    if (role === 'receiver' && room.sender) tell(room.sender, { t: 'receiver-left' });
  });
  socket.on('error', () => {});
});
server.listen(Number(process.env.FD_STUB_PORT ?? 0), '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
