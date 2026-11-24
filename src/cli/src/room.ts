/**
 * One run: a room opened or joined, a transfer through it, and how it ended. The command line and the MCP server both drive this.
 * The rules (the room's messages, the connection, the transfer loop) are the page's own code, imported, not copied: web/src/signal.ts,
 * web/src/connection.ts, web/src/transfer/engine.ts. Only the pieces that touch the file system and the process are here.
 */
import { cleanNote } from '../../shared/ask.ts';
import { generateSecret, roomIdFromSecret } from '../../shared/secret.ts';
import { cleanDevice, cleanJoined, deviceLabel, type Device, type Joined } from '../../shared/device.ts';
import type { RouteConfig, RouteMessage } from '../../shared/route.ts';
import { buildLink } from '../../web/src/handover/links.ts';
import { later } from '../../web/src/later.ts';
import { type Connection, type Route, createConnection, recordSender, roomRecord, cleanRef } from '../../web/src/connection.ts';
import { type JoinFailure, type Message, type Signal, type Target, openSignal } from '../../web/src/signal.ts';
import { type Sendable, type TransferEvent, Session } from '../../web/src/transfer/engine.ts';
import { PathChannel } from './channel.ts';
import { type Saver, createSaver } from './fs-sink.ts';
import { type Picked, type Skipped, sendableOf } from './fs-source.ts';
import { type Guard, Refused, conflicts } from './safe-path.ts';
import { type Outcome, type Reason, reasonText } from './words.ts';

export interface RoomEnv {
  origin: string;
  /** Headers added to every request to the site (the test lane's mark). */
  headers?: Record<string, string>;
  ice: string[];
  route?: RouteConfig;
  device: Device;
  /** What to tell a person to type to update this program. */
  install: string;
}

/** One line of the program's account of a run. `event` is the fixed word; the other keys are fixed per event (cli/README.md). Names and device words are data, cleaned by the shared rules. */
export type ProgramEvent =
  | { event: 'room'; link: string; code: string; password: boolean }
  | { event: 'knock'; allowed: boolean }
  | { event: 'knocking' }
  | { event: 'joined'; device: string; kind: Device['kind']; system: Device['system']; how: Joined | null }
  | { event: 'connected'; route: Route; reason: string; pair: { local: string; remote: string } | null }
  | { event: 'offered'; files: number; bytes: number; names: { name: string; size: number }[] }
  | { event: 'accepted' }
  | { event: 'progress'; done: number; total: number; speed: number; eta: number | null; file: string }
  | { event: 'file'; name: string; size: number; path: string | null }
  | { event: 'skipped'; path: string; reason: Skipped['reason'] }
  | { event: 'wait'; seconds: number; why: 'too_many_rooms' | 'slow_down' }
  | { event: 'paused' | 'resumed'; by: 'this' | 'other' }
  /** While the transfer goes through our servers: how much of the free amount this room's address has used, in bytes, as the server counts it. */
  | { event: 'meter'; used: number; free: number }
  | { event: 'finished'; files: number; bytes: number; route: Route | null }
  | { event: 'failed'; reason: Reason; message: string };

/** A file that was saved whole: the name the other side gave it (data), its size, and its place on this computer. */
export interface SavedFile {
  name: string;
  bytes: number;
  path: string;
}

export interface Result {
  outcome: Outcome;
  message: string;
  files: number;
  bytes: number;
  route: Route | null;
  /** Receive: where each file was saved. */
  saved: string[];
  /** The wait in seconds, for a limit. */
  wait?: number;
}

export type RunState = 'opening' | 'waiting' | 'knocking' | 'connecting' | 'offered' | 'transferring' | 'finished' | 'failed' | 'cancelled';

/** What the window adds: someone is at the keyboard, so a typed code can be answered by asking them. */
export interface KnockOptions {
  password?: string;
  allowCode?: boolean;
  /** Asked when someone types the code. Resolves yes to let them in. Used only when `allowCode` is off. The signal fires when that visitor has gone, or another one has knocked: the question is dead then and its answer is never sent. */
  letIn?: (gone: AbortSignal) => Promise<boolean>;
}

export interface SendOptions {
  files: Picked[];
  skipped?: Skipped[];
  password?: string;
  /** Let a code join in without anyone at the keyboard. Off by default: a nine-digit code can be guessed, so a stranger's knock is refused. */
  allowCode?: boolean;
  letIn?: KnockOptions['letIn'];
  /** Give up when nobody has joined after this long. 0: never. */
  waitMs?: number;
}

/** Asking for files (files-direct-28): the room is opened here, and what comes into it is received by the same rules as `receive`, with the ask itself as the yes. */
export interface AskOptions {
  /** What is wanted, for the other person to read. Cleaned and cut like a file name; never sent to the room service. */
  note?: string;
  /** Where the files go. */
  dest: string;
  /** Refuse an offer bigger than this many bytes, or with more files than `maxFiles`. */
  maxSize?: number;
  maxFiles?: number;
  password?: string;
  allowCode?: boolean;
  letIn?: KnockOptions['letIn'];
  /** Give up when no files have started to arrive after this long. 0: never. A transfer already under way is not cut short. */
  waitMs?: number;
  guard?: Guard;
}

export interface ReceiveOptions {
  /** A room link, or the nine-digit code. */
  target: { kind: 'link'; secret: string } | { kind: 'code'; code: string };
  dest: string;
  maxSize?: number;
  overwrite?: boolean;
  password?: string;
  /** A rule about where a received file may go (the MCP server passes its folder rule here). Checked when the offer arrives and again before each file is placed. */
  guard?: Guard;
}

const PROGRESS_EVERY_MS = 250;
const GRACE_MS = 400;
const MAX_LOG = 500;
const MAX_LISTED = 200;

export class Run {
  readonly role: 'sender' | 'receiver';
  readonly events: ProgramEvent[] = [];
  link: string | null = null;
  code: string | null = null;
  state: RunState = 'opening';
  /** Resolves when the run has ended, however it ended. */
  readonly done: Promise<Result>;
  /** Sender: resolves with the link and code as soon as the room has them. Receiver: resolves once what is offered was listed and taken. Rejects with the result if the run ended first. */
  readonly opened: Promise<void>;
  progress = { done: 0, total: 0, speed: 0, eta: null as number | null, file: '' };
  listeners = new Set<() => void>();

  private resolveDone!: (r: Result) => void;
  private resolveOpened!: () => void;
  private rejectOpened!: (r: Result) => void;
  private signal!: Signal;
  private conn!: Connection;
  private session: Session | null = null;
  private pc: PathChannel | null = null;
  private saver: Saver | null = null;
  private ended = false;
  private route: Route | null = null;
  private lastProgress = 0;
  private st = { ref: null as string | null, other: null as Device | null, joined: null as Joined | null, same: null as boolean | null, connected: false, relayed: false };
  private names = new Map<string, string>();
  private sizes = new Map<string, number>();
  private batch: { b: number; dir: 'in' | 'out'; files: number; bytes: number } | null = null;
  private pending = new Set<Promise<void>>();
  private saved: string[] = [];
  /** Receive: what each saved file was called, its size and where it is. Kept apart from the rolling log, which drops its oldest lines. */
  private savedFiles: SavedFile[] = [];
  /** Someone opened the room (even if they have left since). */
  private visited = false;
  private failedSave: Result | null = null;
  private sent: Sendable[] = [];
  private fileCount = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private asked = false;
  /** This run asked for files: it opened the room, and what comes into it is taken like a receive. */
  private asking: string | null = null;
  private guard: Guard | undefined;
  private joinedOnce = false;
  /** The question about the visitor who knocked last, while it is open. */
  private knockGone: AbortController | null = null;
  private sendRecord!: (r: ReturnType<typeof roomRecord>) => void;

  constructor(private readonly env: RoomEnv, role: 'sender' | 'receiver', private readonly onEvent?: (e: ProgramEvent) => void) {
    this.role = role;
    this.done = new Promise((r) => (this.resolveDone = r));
    this.opened = new Promise((ok, no) => {
      this.resolveOpened = ok;
      this.rejectOpened = no;
    });
    this.opened.catch(() => {});
  }

  // ---- what anyone may ask --------------------------------------------------------------------

  /** Stops a transfer that is running (nothing is kept) or a room that is waiting. */
  cancel(): void {
    if (this.ended) return;
    if (this.session && this.batch) this.session.cancel(this.batch.b);
    else this.finish('cancelled');
  }

  /** Closes the room, whatever it is doing. */
  close(): void {
    if (this.ended) return;
    if (this.session && this.batch && this.state === 'transferring') this.session.cancel(this.batch.b);
    this.finish(this.state === 'waiting' || this.state === 'opening' ? 'closed' : 'cancelled');
  }

  /** Resolves when something changed or `ms` have passed. */
  changed(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const cb = () => done();
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.listeners.add(cb);
      void this.done.then(() => this.listeners.delete(cb));
    });
  }

  private keepSaved(path: string, name: string, size: number): void {
    this.saved.push(path);
    this.savedFiles.push({ name, bytes: size, path });
    this.note({ event: 'file', name, size, path });
  }

  private note(e: ProgramEvent): void {
    this.events.push(e);
    if (this.events.length > MAX_LOG) this.events.splice(0, this.events.length - MAX_LOG);
    this.onEvent?.(e);
    this.poke();
  }

  private poke(): void {
    const l = [...this.listeners];
    this.listeners.clear();
    l.forEach((f) => f());
  }

  private setState(s: RunState): void {
    if (this.state !== s) {
      this.state = s;
      this.poke();
    }
  }

  // ---- ending ---------------------------------------------------------------------------------

  private finish(outcome: Outcome, ctx: { wait?: number } = {}): void {
    if (this.ended) return;
    this.ended = true;
    this.knockGone?.abort();
    const ok = outcome === 'finished';
    const message = reasonText(outcome, { wait: ctx.wait, install: this.env.install });
    const result: Result = { outcome, message, files: this.batch?.files ?? this.fileCount, bytes: this.batch?.bytes ?? 0, route: this.route, saved: this.saved, ...(ctx.wait === undefined ? {} : { wait: ctx.wait }) };
    this.setState(ok ? 'finished' : outcome === 'cancelled' || outcome === 'closed' ? 'cancelled' : 'failed');
    this.note(ok ? { event: 'finished', files: result.files, bytes: result.bytes, route: this.route } : { event: 'failed', reason: outcome as Reason, message });
    this.rejectOpened(result);
    this.keepRecord();
    // let the other side hear the last word before the room goes
    this.timers.push(setTimeout(() => void this.teardown().then(() => this.resolveDone(result)), this.pc ? GRACE_MS : 0));
  }

  private async teardown(): Promise<void> {
    this.timers.forEach(clearTimeout);
    try {
      this.signal?.close();
      this.conn?.close();
      await Promise.all([...this.pending]);
      await this.session?.close();
      await this.saver?.close();
    } catch {
      // closing must never throw
    }
  }

  private keepRecord(): void {
    if (!this.signal) return;
    this.sendRecord?.(roomRecord({ ...this.st }, this.env.device, this.conn));
  }

  // ---- starting -------------------------------------------------------------------------------

  /** Opens a room and waits for the other device. */
  async startSend(o: SendOptions): Promise<void> {
    if (o.files.length === 0) return this.finish('nothing_to_send');
    this.sent = o.files.map(sendableOf);
    this.fileCount = o.files.length;
    for (const s of o.skipped ?? []) this.note({ event: 'skipped', path: s.path, reason: s.reason });
    const secret = generateSecret();
    const id = await roomIdFromSecret(secret);
    this.link = buildLink(this.env.origin, secret);
    if (o.waitMs) this.timers.push(setTimeout(() => this.state === 'waiting' && this.finish('nobody_came'), o.waitMs));
    this.signal = openSignal({ kind: 'room', id }, 'sender', {
      onMessage: (m) => this.onSenderMessage(m, o),
      onFailed: (why, wait) => this.failedToJoin(why, wait),
      onClosed: () => {},
    }, { origin: this.env.origin, headers: this.env.headers });
    this.sendRecord = recordSender(this.signal);
    this.makeConnection('sender');
    this.progress.total = o.files.reduce((n, f) => n + f.size, 0);
    this.keepRecord();
  }

  /** Opens a room that asks for files, and takes what the other device sends. */
  async startAsk(o: AskOptions): Promise<void> {
    this.asking = cleanNote(o.note ?? '');
    try {
      this.guard = o.guard;
      this.saver = await createSaver(o.dest, { overwrite: false, guard: o.guard });
    } catch (e) {
      return this.finish(e instanceof Refused ? 'not_allowed' : 'save_failed');
    }
    const secret = generateSecret();
    const id = await roomIdFromSecret(secret);
    this.link = buildLink(this.env.origin, secret);
    // the limit is for the files to start coming: a transfer already under way is allowed to finish
    if (o.waitMs) this.timers.push(setTimeout(() => !this.ended && !this.batch && this.finish(this.visited ? 'nothing_sent' : 'nobody_came'), o.waitMs));
    this.signal = openSignal({ kind: 'room', id }, 'sender', {
      onMessage: (m) => this.onSenderMessage(m, o),
      onFailed: (why, wait) => this.failedToJoin(why, wait),
      onClosed: () => {},
    }, { origin: this.env.origin, headers: this.env.headers }, 'ask');
    this.sendRecord = recordSender(this.signal);
    this.makeConnection('sender');
    this.keepRecord();
  }

  /** Joins a room by its link or code and takes what is offered. */
  async startReceive(o: ReceiveOptions): Promise<void> {
    try {
      this.guard = o.guard;
      this.saver = await createSaver(o.dest, { overwrite: o.overwrite ?? false, guard: o.guard });
    } catch (e) {
      return this.finish(e instanceof Refused ? 'not_allowed' : 'save_failed');
    }
    const target: Target = o.target.kind === 'link' ? { kind: 'room', id: await roomIdFromSecret(o.target.secret) } : { kind: 'code', code: o.target.code };
    this.setState('connecting');
    this.signal = openSignal(target, 'receiver', {
      onMessage: (m) => this.onReceiverMessage(m, o),
      onFailed: (why, wait) => this.failedToJoin(why, wait),
      onClosed: () => {},
    }, { origin: this.env.origin, headers: this.env.headers });
    this.sendRecord = recordSender(this.signal);
    this.st.joined = o.target.kind === 'code' ? 'code' : 'link';
    this.makeConnection('receiver');
    this.keepRecord();
  }

  private failedToJoin(why: JoinFailure, wait?: number): void {
    const map: Record<JoinFailure, Reason> = { gone: 'room_gone', full: 'room_full', busy: 'too_many_rooms', paused: 'rooms_paused', network: 'network', 'wrong-code': 'wrong_code', 'slow-down': 'slow_down' };
    const reason = map[why];
    if (wait !== undefined && (reason === 'too_many_rooms' || reason === 'slow_down')) this.note({ event: 'wait', seconds: Math.ceil(wait), why: reason });
    this.finish(reason, { wait });
  }

  private makeConnection(role: 'sender' | 'receiver'): void {
    this.conn = createConnection(role === 'sender' ? 'sender' : 'receiver', this.signal, { iceUrls: this.env.ice, route: this.env.route }, {
      onNoRelay: () => this.keepRecord(),
      onLog: () => this.keepRecord(),
      onLost: () => {
        if (this.ended) return;
        // someone who opened an ask and went away before sending anything is not the end of it: the link still works for their next try
        if (this.asking !== null && !this.batch) return this.setState('waiting');
        this.finish(this.batch ? 'lost' : 'network');
      },
      onChannel: (ch, route, info) => this.onChannel(ch, route, info.pair),
      onDirectChannel: (ch) => {
        if (!this.pc || this.ended) return;
        if (this.role === 'sender') {
          this.pc.moveTo(ch, () => {
            this.conn.keepOnly();
            this.signal.send({ t: 'route', d: 'direct' });
          });
        } else this.pc.extra(ch);
        this.route = 'direct';
        this.st.relayed = false;
        this.keepRecord();
      },
    });
  }

  // ---- the room's messages --------------------------------------------------------------------

  private takeDevice(d: unknown): void {
    const raw = (d ?? {}) as { device?: unknown; joined?: unknown };
    this.visited = true;
    this.st.other = cleanDevice(raw.device);
    const j = cleanJoined(raw.joined);
    if (j && this.role === 'sender') this.st.joined = j;
    const other = this.st.other;
    this.note({ event: 'joined', device: deviceLabel(other), kind: other?.kind ?? 'unknown', system: other?.system ?? 'unknown', how: this.st.joined });
    this.keepRecord();
  }

  private onRoute(m: Message): boolean {
    const s = m as unknown as RouteMessage;
    if (s.state === 'relay') {
      if (typeof s.used === 'number' && typeof s.free === 'number' && Number.isFinite(s.used) && Number.isFinite(s.free)) {
        const last = this.events.findLast((e) => e.event === 'meter');
        if (!last || last.used !== s.used || last.free !== s.free) this.note({ event: 'meter', used: s.used, free: s.free });
      }
      this.keepRecord();
      return true;
    }
    if (!this.ended) this.finish(s.state === 'limit' ? 'relay_limit' : 'month_stop');
    return true;
  }

  private onSenderMessage(m: Message, o: KnockOptions): void {
    if (m.t === 'code' && typeof m.code === 'string') {
      this.code = m.code;
      this.st.ref = cleanRef(m.ref);
      if (o.password) this.signal.send({ t: 'set-password', d: o.password });
      this.setState('waiting');
      this.note({ event: 'room', link: this.link!, code: m.code, password: Boolean(o.password) });
      this.resolveOpened();
      this.keepRecord();
    } else if (m.t === 'knock') {
      if (o.letIn && !o.allowCode) {
        // somebody is at the window: they are asked who may in
        this.knockGone?.abort(); // a new knock means the one before has gone
        const ask = (this.knockGone = new AbortController());
        const answer = (yes: boolean) => {
          if (this.ended || ask.signal.aborted) return; // an answer to a visitor who has left must not reach the next one
          this.knockGone = null;
          this.signal.send({ t: yes ? 'allow' : 'decline' });
          this.note({ event: 'knock', allowed: yes });
        };
        o.letIn(ask.signal).then(answer, () => answer(false));
        return;
      }
      // a typed code can be guessed: nobody is here to look at who it is, so by default the knock is refused
      this.signal.send({ t: o.allowCode ? 'allow' : 'decline' });
      this.note({ event: 'knock', allowed: Boolean(o.allowCode) });
    } else if (m.t === 'knock-gone') {
      this.knockGone?.abort();
      this.knockGone = null;
    } else if (m.t === 'route') this.onRoute(m);
    else if (m.t === 'device') this.takeDevice(m.d);
    else if (m.t === 'ready') {
      const room = (m.d ?? {}) as { same?: boolean; ref?: unknown };
      this.st.same = typeof room.same === 'boolean' ? room.same : null;
      this.st.ref = cleanRef(room.ref);
      if (this.st.same !== null) this.conn.hint(this.st.same);
      this.st.joined = null;
      this.st.other = null;
      this.setState('connecting');
      this.signal.send({ t: 'device', d: { device: this.env.device } });
      this.keepRecord();
      this.conn.onSignal(m);
    } else if (m.t === 'room-closed' || m.t === 'receiver-left') {
      if (m.t === 'receiver-left' && this.batch && !this.ended) this.finish('lost');
    } else if (m.t === 'error' || m.t === 'password-set' || m.t === 'password-cleared') {
      // nothing to do: the password is set before anyone can be at the door
    } else this.conn.onSignal(m);
  }

  private onReceiverMessage(m: Message, o: ReceiveOptions): void {
    if (m.t === 'password-needed') {
      if (!o.password) return this.finish('password_needed');
      this.signal.send({ t: 'password', d: o.password });
    } else if (m.t === 'wrong-password') this.finish('wrong_password');
    else if (m.t === 'slow-down') {
      const wait = m.retryAfter ?? 30;
      this.note({ event: 'wait', seconds: Math.ceil(wait), why: 'slow_down' });
      this.finish('slow_down', { wait });
    } else if (m.t === 'knocking') {
      this.setState('knocking');
      this.note({ event: 'knocking' });
    } else if (m.t === 'declined') this.finish('declined');
    else if (m.t === 'replaced') this.finish('closed');
    else if (m.t === 'error' && m.reason === 'room-full') this.finish('room_full');
    else if (m.t === 'timed-out') this.finish('timed_out');
    else if (m.t === 'room-closed') {
      if (!this.ended && this.state !== 'finished') this.finish(this.joinedOnce ? 'sender_left' : 'room_gone');
    } else if (m.t === 'route') this.onRoute(m);
    else if (m.t === 'ready') {
      this.joinedOnce = true;
      const room = (m.d ?? {}) as { same?: boolean; ref?: unknown };
      this.st.same = typeof room.same === 'boolean' ? room.same : null;
      this.st.ref = cleanRef(room.ref);
      if (this.st.same !== null) this.conn.hint(this.st.same);
      this.signal.send({ t: 'device', d: { device: this.env.device, joined: this.st.joined } });
      this.setState('connecting');
      this.keepRecord();
    } else if (m.t === 'device') this.takeDevice(m.d);
    else this.conn.onSignal(m);
    if (m.t === 'ready') this.conn.onSignal(m);
  }

  // ---- the channel and the transfer loop ------------------------------------------------------

  private onChannel(ch: RTCDataChannel, route: Route, pair: { local: string; remote: string } | null): void {
    if (this.ended) return;
    void this.session?.close();
    this.route = route;
    this.st.connected = true;
    this.st.relayed = route === 'relay';
    this.batch = null;
    this.asked = false;
    this.note({ event: 'connected', route, reason: this.conn.why(), pair });
    this.keepRecord();
    const session = new Session({
      channel: (this.pc = new PathChannel(ch, (d) => session.handle(d))),
      sinks: this.saver?.sinks ?? { kind: 'disk', create: () => Promise.reject(new Error('this run does not receive')), close: async () => {} },
      odd: this.role === 'sender',
      ask: this.role === 'receiver' || this.asking !== null,
      after: later,
      emit: (e) => this.onEngine(e),
    });
    this.session = session;
    if (this.asking !== null) session.askFor(this.asking); // the note goes over the connection to the other device and nowhere else
    else if (this.role === 'sender') session.send(this.sent);
  }

  private onEngine(e: TransferEvent): void {
    if (this.ended) return;
    switch (e.k) {
      case 'started':
        for (const f of e.files) {
          this.names.set(`${e.b}:${f.i}`, f.name);
          this.sizes.set(`${e.b}:${f.i}`, f.size);
        }
        this.batch = { b: e.b, dir: e.dir, files: e.files.length, bytes: e.files.reduce((n, f) => n + f.size, 0) };
        this.progress.total = this.batch.bytes;
        break;
      case 'offered':
        void this.decide(e.b);
        break;
      case 'asked':
        // this run was started to receive, and the link is a request for files: there is nothing here to take
        if (this.asking === null) this.finish('ask_link');
        break;
      case 'progress': {
        this.progress = { done: e.done, total: e.total, speed: e.speed, eta: e.eta, file: this.names.get(`${e.b}:${e.i}`) ?? '' };
        if (this.state === 'offered' || this.state === 'connecting') this.setState('transferring');
        const at = Date.now();
        if (at - this.lastProgress >= PROGRESS_EVERY_MS || e.done === e.total) {
          this.lastProgress = at;
          this.note({ event: 'progress', ...this.progress });
        }
        break;
      }
      case 'file-sent':
        this.note({ event: 'file', name: this.names.get(`${e.b}:${e.i}`) ?? '', size: this.sizes.get(`${e.b}:${e.i}`) ?? 0, path: null });
        break;
      case 'file-ready': {
        const name = this.names.get(`${e.b}:${e.i}`) ?? 'file';
        const size = this.sizes.get(`${e.b}:${e.i}`) ?? 0;
        const p = this.saver!
          .finish(e.blob, name)
          .then((path) => {
            this.keepSaved(path, name, size);
          })
          .catch((err: unknown) => {
            const why: Reason = err instanceof Refused ? (err.reason === 'would_overwrite' ? 'would_overwrite' : 'not_allowed') : 'save_failed';
            if (!this.ended) this.finish(why);
          })
          .finally(() => this.pending.delete(p));
        this.pending.add(p);
        break;
      }
      case 'file-failed':
        this.finish(e.why === 'storage' ? 'no_room_left' : 'damaged');
        break;
      case 'declined':
        this.finish('declined');
        break;
      case 'cancelled':
        this.finish('cancelled');
        break;
      case 'paused':
      case 'resumed':
        this.note({ event: e.k, by: e.by === 'local' ? 'this' : 'other' });
        break;
      case 'complete':
        void Promise.all([...this.pending]).then(() => this.finish('finished'));
        break;
      case 'error':
        this.finish(e.why === 'lost' ? 'lost' : e.why === 'refresh' ? 'out_of_date' : 'unreadable');
        break;
      default:
        break;
    }
  }

  /** The receiver's yes: receiving is the acceptance, after the rules here have looked at what is offered. */
  private async decide(b: number): Promise<void> {
    const batch = this.batch;
    if (!batch || this.asked || !this.session || !this.saver) return;
    this.asked = true;
    const names = [...this.names.entries()].filter(([k]) => k.startsWith(`${b}:`));
    this.note({
      event: 'offered',
      files: batch.files,
      bytes: batch.bytes,
      names: names.slice(0, MAX_LISTED).map(([k, name]) => ({ name, size: this.sizes.get(k) ?? 0 })),
    });
    this.setState('offered');
    const o = this.limits;
    if (o.maxSize !== undefined && batch.bytes > o.maxSize) {
      this.finish('too_big'); // first, so the "no thanks" it sends is not taken for the whole story
      return this.session.decline(b);
    }
    if (o.maxFiles !== undefined && batch.files > o.maxFiles) {
      this.finish('too_many_files');
      return this.session.decline(b);
    }
    const clash = await conflicts(this.saver.dest, names.map(([, n]) => n), o.overwrite, this.guard);
    if (clash.length > 0) {
      this.finish(clash.some((c) => c.reason === 'would_overwrite') ? 'would_overwrite' : 'not_allowed');
      return this.session.decline(b);
    }
    this.session.accept(b);
    this.note({ event: 'accepted' });
  }

  /** The rules of a receiving run, set by the caller before it starts. */
  limits: { maxSize?: number; maxFiles?: number; overwrite: boolean } = { overwrite: false };

  /** For `opened`: a receiving run is "open" once what was offered has been listed and taken. */
  markOpened(): void {
    this.resolveOpened();
  }

  /** The run's own account, for a tool that asks. */
  status(): { state: RunState; link: string | null; code: string | null; progress: Run['progress']; route: Route | null; files: number; saved: string[]; savedFiles: SavedFile[]; outcome?: Outcome; message?: string } {
    return { state: this.state, link: this.link, code: this.code, progress: { ...this.progress }, route: this.route, files: this.batch?.files ?? this.fileCount, saved: [...this.saved], savedFiles: this.savedFiles.map((f) => ({ ...f })) };
  }
}

/** Starts a sending run. Resolves at once with the run; `run.opened` says when the link and code are ready. */
export function send(env: RoomEnv, o: SendOptions, onEvent?: (e: ProgramEvent) => void): Run {
  const run = new Run(env, 'sender', onEvent);
  void run.startSend(o);
  return run;
}

/** Starts a run that asks for files. `run.opened` says when the link and code are ready; the files land in `dest` when someone sends them. */
export function ask(env: RoomEnv, o: AskOptions, onEvent?: (e: ProgramEvent) => void): Run {
  const run = new Run(env, 'sender', onEvent);
  run.limits = { maxSize: o.maxSize, maxFiles: o.maxFiles, overwrite: false };
  void run.startAsk(o);
  return run;
}

/** Starts a receiving run. */
export function receive(env: RoomEnv, o: ReceiveOptions, onEvent?: (e: ProgramEvent) => void): Run {
  const run = new Run(env, 'receiver', onEvent);
  run.limits = { maxSize: o.maxSize, overwrite: o.overwrite ?? false };
  void run.startReceive(o);
  // a receiving run is open once its offer was listed and taken
  void (async () => {
    for (;;) {
      if (run.state === 'finished' || run.state === 'failed' || run.state === 'cancelled') return;
      if (run.events.some((e) => e.event === 'accepted')) return run.markOpened();
      await run.changed(1000);
    }
  })();
  return run;
}
