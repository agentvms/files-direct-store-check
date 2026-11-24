// The desktop checks (files-direct-30), run by .github/workflows/desktop.yml on GitHub's own macOS and Windows machines, one step at a time:
//   node scripts/desktop-check.mjs <step>
// install | entry | menu | window | gather. Nothing here touches the real site: the program is given a stand-in room service (scripts/stub-rooms.mjs).
// Everything is for this user only: no administrator, nothing system-wide. What a step installs it removes again.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
// a folder of the runner's own user, in its temporary space (RUNNER_TEMP): nothing system-wide
const PREFIX = process.env.FD_PREFIX ?? join(process.env.RUNNER_TEMP ?? tmpdir(), 'files-direct-prefix');
const PROGRAM = WIN ? join(PREFIX, 'node_modules', 'files-direct', 'dist', 'files-direct.mjs') : join(PREFIX, 'lib', 'node_modules', 'files-direct', 'dist', 'files-direct.mjs');
const SHOTS = join(process.cwd(), 'desktop-shots');
const SERVICES = join(homedir(), 'Library', 'Services');
const WORKFLOW = join(SERVICES, 'Send with Files Direct.workflow');
const KEYS = ['HKCU\\Software\\Classes\\*\\shell\\FilesDirect', 'HKCU\\Software\\Classes\\Directory\\shell\\FilesDirect'];
const SENDTO = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'SendTo', 'Files Direct.lnk');

const problems = [];
const ok = (cond, text) => {
  console.log((cond ? 'ok      ' : 'FAILED  ') + text);
  if (!cond) problems.push(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...o });
const program = (args, o = {}) => run(process.execPath, [PROGRAM, ...args], o);

/** Every name that has to survive. Windows does not allow a quote, a backslash, a tab, a line break or < > : | ? * in a name. */
const HOSTILE = ['plain.txt', 'two words.txt', 'say "hi".txt', "it's.txt", 'a;touch pwned.txt', '$(touch pwned).txt', '`touch pwned`.txt', 'a&touch pwned&.txt', '100%.txt', '%1 %L %V.txt', '%1 %L %V %*.txt', 'caret^name.txt', '-rf.txt', '--help', '$HOME', '! history', '#hash', 'ünï-名前.txt', '  padded.txt', 'tab\there.txt', 'two\nlines.txt'];
const names = WIN ? HOSTILE.filter((n) => !/["\\\t\n<>:|?*]/.test(n)) : HOSTILE;

function makeFiles(dir) {
  mkdirSync(dir, { recursive: true });
  return names.map((n, i) => {
    const p = join(dir, n);
    writeFileSync(p, 'content ' + i);
    return p;
  });
}

async function waitFor(file, ms = 30_000) {
  for (let t = 0; t < ms; t += 100) {
    if (existsSync(file) && readFileSync(file, 'utf8')) return readFileSync(file, 'utf8');
    await sleep(100);
  }
  return null;
}

/** The program and the rest of a command line, the way Windows reads the first word (quoted when it holds a space). */
const splitCommand = (line) => (line.startsWith('"') ? [line.slice(1, line.indexOf('"', 1)), line.slice(line.indexOf('"', 1) + 2)] : [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]);

const noMarkers = (...dirs) => dirs.every((d) => !readdirSync(d).some((n) => n.startsWith('pwned')));

// ---- install ------------------------------------------------------------------------------------------------------------------------------

function install() {
  const pack = run('npm', ['pack', '--ignore-scripts', '--json'], { shell: WIN });
  const tgz = JSON.parse(pack.stdout)[0];
  console.log(`package file: ${tgz.filename}, ${tgz.size} bytes packed, ${tgz.unpackedSize} bytes unpacked`);
  const r = run('npm', ['install', '--global', '--prefix', PREFIX, tgz.filename], { shell: WIN });
  ok(r.status === 0, 'npm install --global --prefix <a folder of this user> ' + tgz.filename + ' (no administrator)');
  if (typeof process.getuid === 'function') ok(process.getuid() !== 0, 'running as a standard user, not root');
  const v = program(['version']);
  ok(v.status === 0 && /^\d+\.\d+\.\d+/.test(v.stdout), 'the installed program answers "version": ' + v.stdout.trim());
  const size = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
  console.log(`installed under ${PREFIX}: ${(size(PREFIX) / 1e6).toFixed(1)} MB (the program and the packages it needs, with the Node that is already here)`);
}

// ---- the registry and the Services folder, as the checks read them ----------------------------------------------------------------

const regQuery = (key, extra = []) => run('reg.exe', ['query', key, ...extra]);
const regText = () => run('reg.exe', ['query', 'HKCU\\Software\\Classes\\*\\shell', '/s']).stdout + run('reg.exe', ['query', 'HKCU\\Software\\Classes\\Directory\\shell', '/s']).stdout;
const regDefault = (key) => /REG_SZ\s+(.*)\r?$/m.exec(regQuery(key + '\\command', ['/ve']).stdout)?.[1]?.trim();
const lnk = (path) => {
  const script = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:FD_LNK); Write-Output $s.TargetPath; Write-Output $s.Arguments';
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FD_LNK: path } });
  const [target, ...rest] = r.stdout.split(/\r?\n/);
  return { target, args: rest.join('').trim() };
};
const listServices = () => (existsSync(SERVICES) ? readdirSync(SERVICES).sort() : []);

// ---- entry: a hostile name goes through the installed entry, as one argument -----------------------------------------------------------

async function entry() {
  const work = mkdtempSync(join(tmpdir(), 'fd-entry-'));
  const files = makeFiles(join(work, 'files'));
  const cwd = join(work, 'cwd');
  mkdirSync(cwd);
  // a stand-in program that only writes the arguments it got
  const fake = join(work, 'fake program', "files-direct '&' fake.mjs");
  mkdirSync(join(work, 'fake program'), { recursive: true });
  const out = join(work, 'argv.json');
  writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  // the entry's own code, from the source of this very package, bundled for this check
  const bundle = await build({ stdin: { contents: "export * from './src/cli/src/menu.ts'; export { nodeEffects } from './src/cli/src/menu-node.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  const modFile = join(work, 'menu.mjs');
  writeFileSync(modFile, bundle.outputFiles[0].text);
  const { installMenu, removeMenu, nodeEffects } = await import(new URL('file:///' + modFile.replace(/\\/g, '/')).href);
  const fx = nodeEffects();
  const before = WIN ? regText() : listServices().join('\n');
  try {
    await installMenu({ node: process.execPath, script: fake }, fx);
    if (MAC) {
      const cmd = run('plutil', ['-extract', 'actions.0.action.ActionParameters.COMMAND_STRING', 'raw', '-o', '-', join(WORKFLOW, 'Contents', 'document.wflow')]);
      ok(cmd.status === 0 && cmd.stdout.length > 0, 'read the shell script out of the installed workflow');
      const script = join(work, 'action.sh');
      writeFileSync(script, cmd.stdout);
      // what the Quick Action does with "files as arguments": the script runs with the chosen files as its arguments
      const r = run('/bin/bash', [script, ...files], { cwd });
      ok(r.status === 0, 'the Quick Action script ran');
      const got = JSON.parse((await waitFor(out)) ?? 'null');
      ok(Array.isArray(got) && got[0] === 'open' && got[1] === '--', 'the program is told "open --" first');
      ok(JSON.stringify(got?.slice(2)) === JSON.stringify(files), `all ${files.length} hostile names reached the program as separate arguments, in order`);
    } else if (WIN) {
      const verb = regDefault(KEYS[0]);
      ok(Boolean(verb), 'read the command of the registry entry');
      for (const file of files) {
        rmSync(out, { force: true });
        const line = verb.replace('%1', () => file);
        const [exe, rest] = splitCommand(line);
        const r = spawn(exe, [rest], { windowsVerbatimArguments: true, cwd, stdio: 'ignore' });
        r.on('error', () => {});
        const got = JSON.parse((await waitFor(out)) ?? 'null');
        ok(Array.isArray(got) && got.at(-1) === file && got.at(-2) === '--' && got.includes('--detach') && got.includes('--gather'), 'registry entry: ' + JSON.stringify(file.slice(file.lastIndexOf('\\') + 1)) + ' reached the program as one argument');
      }
      // Send to: Explorer adds each chosen file as its own quoted argument
      const link = lnk(SENDTO);
      ok(link.target.toLowerCase() === process.execPath.toLowerCase(), 'the Send to shortcut starts node: ' + link.target);
      rmSync(out, { force: true });
      const line = link.args + ' ' + files.map((f) => '"' + f + '"').join(' ');
      spawn(link.target, [line], { windowsVerbatimArguments: true, cwd, stdio: 'ignore' }).on('error', () => {});
      const got = JSON.parse((await waitFor(out)) ?? 'null');
      ok(JSON.stringify(got?.slice(got.indexOf('--') + 1)) === JSON.stringify(files), `Send to: all ${files.length} names reached the program as separate arguments, in order`);
    }
    ok(noMarkers(cwd, join(work, 'files'), work), 'no marker file appeared: nothing a name said was run');
    ok(readdirSync(join(work, 'files')).length === files.length, 'the files are still there, none added');
  } finally {
    await removeMenu(fx);
  }
  const after = WIN ? regText() : listServices().join('\n');
  ok(after === before, 'after removing, the registry (Windows) or the Services folder (Mac) is as it was before');
  rmSync(work, { recursive: true, force: true });
}

// ---- menu: the real program installs and removes its entry ---------------------------------------------------------------------------

async function menu() {
  const before = WIN ? regText() : listServices().join('\n');
  ok(program(['menu', 'status']).status === 1, 'menu status: not installed yet (exit 1)');
  const inst = program(['menu', 'install']);
  ok(inst.status === 0, 'menu install ran without an administrator: ' + inst.stdout.replace(/\s+/g, ' ').slice(0, 160));
  ok(program(['menu', 'status']).status === 0, 'menu status: installed (exit 0)');
  if (MAC) {
    const info = join(WORKFLOW, 'Contents', 'Info.plist');
    const wf = join(WORKFLOW, 'Contents', 'document.wflow');
    ok(existsSync(info) && existsSync(wf), 'the workflow is in ~/Library/Services: Info.plist and document.wflow');
    ok(run('plutil', ['-lint', info]).status === 0 && run('plutil', ['-lint', wf]).status === 0, 'both property lists are valid (plutil -lint)');
    ok(run('plutil', ['-extract', 'NSServices.0.NSMenuItem.default', 'raw', '-o', '-', info]).stdout.trim() === 'Send with Files Direct', 'the menu text is "Send with Files Direct"');
    ok(run('plutil', ['-extract', 'actions.0.action.ActionParameters.inputMethod', 'raw', '-o', '-', wf]).stdout.trim() === '1', 'the shell script takes the chosen files as arguments');
    // the system lists it as a Service
    run('/System/Library/CoreServices/pbs', ['-update']);
    let listed = false;
    for (let i = 0; i < 10 && !listed; i++) {
      listed = run('/System/Library/CoreServices/pbs', ['-dump_pboard']).stdout.includes('Send with Files Direct');
      if (!listed) await sleep(1000);
    }
    ok(listed, 'the system lists the Service (pbs -dump_pboard)');
  } else if (WIN) {
    for (const k of KEYS) ok(regQuery(k).status === 0 && /FilesDirect/.test(regDefault(k) ? k : ''), 'registry key present: ' + k);
    ok(/--gather -- "%1"$/.test(regDefault(KEYS[0]) ?? ''), 'the entry for files ends with: --gather -- "%1"');
    ok(existsSync(SENDTO), 'the Send to shortcut is there: ' + SENDTO);
    ok(!regQuery('HKLM\\Software\\Classes\\*\\shell\\FilesDirect').stdout.includes('FilesDirect'), 'nothing was written for all users (HKLM)');
  }
  const rem = program(['menu', 'remove']);
  ok(rem.status === 0, 'menu remove ran');
  ok(program(['menu', 'status']).status === 1, 'menu status: not installed (exit 1)');
  if (MAC) ok(!existsSync(WORKFLOW), 'the workflow folder is gone');
  if (WIN) {
    for (const k of KEYS) ok(regQuery(k).status !== 0, 'registry key gone: ' + k);
    ok(!existsSync(SENDTO), 'the Send to shortcut is gone');
  }
  ok((WIN ? regText() : listServices().join('\n')) === before, 'menu remove left nothing behind: the registry (Windows) or the Services folder (Mac) is as it was');
  ok(program(['menu', 'remove']).status === 0, 'menu remove again is harmless');
}

// ---- window: the page the right-click opens ---------------------------------------------------------------------------------------------

function stubRooms() {
  const child = spawn(process.execPath, [join(process.cwd(), 'scripts', 'stub-rooms.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve({ child, site: 'http://127.0.0.1:' + JSON.parse(String(d).split('\n')[0]).port }));
    child.once('error', reject);
  });
}

function opened(args, site, env = {}) {
  const child = spawn(process.execPath, [PROGRAM, 'open', '--json', '--site', site, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const p = { child, lines: [], err: '', code: new Promise((r) => child.on('close', (c) => r(c))) };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      try {
        p.lines.push(JSON.parse(buf.slice(0, i)));
      } catch {
        // not a line of ours
      }
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on('data', (d) => (p.err += d));
  p.window = async (ms = 30_000) => {
    for (let t = 0; t < ms; t += 50) {
      const w = p.lines.find((l) => l.event === 'window');
      if (w) return w;
      await sleep(50);
    }
    return null;
  };
  return p;
}

async function window() {
  mkdirSync(SHOTS, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'fd-window-'));
  const files = makeFiles(join(work, 'files'));
  const { child: stub, site } = await stubRooms();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch(WIN ? { channel: 'msedge' } : MAC ? { channel: 'chrome' } : {}); // the browser already on the runner; no download
  try {
    // 1. the page: link, QR code and the nine-digit code, and what is about to be sent; Cancel sends nothing
    const p = opened(['--no-window', ...files], site);
    const w = await p.window();
    ok(Boolean(w), 'open --no-window prints the window\'s address' + (w ? '' : ': ' + p.err));
    const page = await browser.newPage({ viewport: { width: 480, height: 760 } });
    await page.goto(w.url);
    await page.locator('.share').waitFor({ timeout: 30_000 });
    const link = await page.getByLabel('Link to share').inputValue();
    ok(/^http:\/\/127\.0\.0\.1:\d+\/r\/#[\w-]{22}$/.test(link), 'the window shows the link');
    ok(/^\d{3} \d{3} \d{3}$/.test((await page.locator('.code').textContent()) ?? ''), 'the window shows the nine-digit code');
    ok((await page.locator('.qr svg path').count()) === 1, 'the window shows the QR code');
    ok((await page.locator('.files li .n').count()) >= 1 && (await page.locator('.files li .n').first().textContent()) !== '', 'the window names what is about to be sent');
    ok((await page.locator('h1').textContent()).startsWith('Send ' + names.length + ' files'), 'the title counts the files: ' + (await page.locator('h1').textContent()));
    await page.screenshot({ path: join(SHOTS, 'window-waiting-' + process.platform + '.png') });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByText('Nothing was sent.').waitFor({ timeout: 15_000 });
    ok(true, 'Cancel before anyone joined: "Nothing was sent."');
    await page.getByRole('button', { name: 'Close' }).click();
    ok((await Promise.race([p.code, sleep(15_000).then(() => 'late')])) === 7, 'the program ended with status 7 (cancelled)');
    await page.close();

    // 2. the real window: an app-style window of the browser that is on this computer; closing it ends the program
    if (!MAC && !WIN) return;
    const q = opened(files.slice(0, 2), site);
    const real = await q.window();
    ok(Boolean(real) && real.how === 'app window' && Number.isInteger(real.pid), 'open started an app-style window of an installed browser (' + (real ? real.how : q.err) + ')');
    await sleep(4000);
    if (MAC) run('screencapture', ['-x', join(SHOTS, 'screen-' + process.platform + '.png')]);
    if (WIN) run('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save($env:FD_SHOT)"], { env: { ...process.env, FD_SHOT: join(SHOTS, 'screen-win32.png') } });
    ok(q.child.exitCode === null, 'the program is still running while the window is open');
    if (real?.pid) {
      if (WIN) run('taskkill', ['/PID', String(real.pid), '/T', '/F']);
      else process.kill(real.pid);
    }
    ok((await Promise.race([q.code, sleep(30_000).then(() => 'still running')])) === 7, 'closing the window cancelled the room and ended the program (status 7)');
  } finally {
    await browser.close();
    stub.stdin.end();
    stub.kill();
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- gather: one right-click on several files in Windows starts one program for each -------------------------------------------

async function gather() {
  const work = mkdtempSync(join(tmpdir(), 'fd-gather-'));
  const files = makeFiles(join(work, 'files')).slice(0, 4);
  const { child: stub, site } = await stubRooms();
  try {
    const runs = files.map((f) => opened(['--no-window', '--gather', f], site));
    await sleep(6000);
    const windows = runs.filter((r) => r.lines.some((l) => l.event === 'window'));
    ok(windows.length === 1, 'one room for ' + files.length + ' programs started together (windows opened: ' + windows.length + ')');
    ok(runs.filter((r) => r !== windows[0]).every((r) => r.child.exitCode === 0), 'the others handed their file over and ended with status 0');
    const url = new URL(windows[0].lines.find((l) => l.event === 'window').url);
    const state = await fetch(url.href + 'state', { headers: { host: url.host } }).then((r) => r.json());
    ok(state.items.length + state.more === files.length, 'the one window lists all ' + files.length + ' files');
    await fetch(url.href + 'act', { method: 'POST', headers: { 'content-type': 'application/json', origin: url.origin }, body: JSON.stringify({ do: 'close' }) });
    ok((await Promise.race([windows[0].code, sleep(15_000).then(() => 'late')])) === 7, 'the program ended after Close');
  } finally {
    stub.stdin.end();
    stub.kill();
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- detach: the entry the real program installed starts the real run without a window of its own and ends at once -------------------------------------

const processes = () => {
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { maxBuffer: 64 * 1024 * 1024 });
  try {
    return [].concat(JSON.parse(r.stdout)).filter((p) => p && p.CommandLine);
  } catch {
    return [];
  }
};

async function detach() {
  if (!WIN) return;
  mkdirSync(SHOTS, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'fd-detach-'));
  const files = makeFiles(join(work, 'files')).slice(0, 3);
  const { child: stub, site } = await stubRooms();
  program(['menu', 'install']);
  try {
    const verb = regDefault(KEYS[0]);
    ok(Boolean(verb), 'read the command of the real registry entry: ' + verb);
    // the registry entry, for the first file only (the others are the same program started again): it has to end quickly, with no window left behind
    const line = verb.replace('%1', () => files[0]);
    const [exe, rest] = splitCommand(line);
    const started = Date.now();
    const launcher = spawn(exe, [rest], { windowsVerbatimArguments: true, env: { ...process.env, FILES_DIRECT_ORIGIN: site }, stdio: 'ignore' });
    const code = await new Promise((r) => launcher.on('exit', (c) => r(c)));
    ok(code === 0 && Date.now() - started < 8000, 'the program the entry starts ends at once with status 0 (' + (Date.now() - started) + ' ms)');
    // the real run is a child with no window of its own, and it opens the window
    let app = null;
    for (let t = 0; t < 40 && !app; t++) {
      await sleep(500);
      app = processes().find((p) => /--app=http:\/\/127\.0\.0\.1:\d+\/w\//.test(p.CommandLine));
    }
    ok(Boolean(app), 'the real run started the window (an app-style window of the browser)');
    const real = processes().find((p) => /files-direct\.mjs"? open /.test(p.CommandLine) && !/--detach/.test(p.CommandLine));
    ok(Boolean(real), 'the real run is its own process, started without --detach');
    await sleep(3000);
    run('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save($env:FD_SHOT)"], { env: { ...process.env, FD_SHOT: join(SHOTS, 'entry-window-win32.png') } });
    if (app) run('taskkill', ['/PID', String(app.ProcessId), '/T', '/F']);
    let gone = false;
    for (let t = 0; t < 60 && !gone; t++) {
      await sleep(500);
      gone = real ? !processes().some((p) => p.ProcessId === real.ProcessId) : true;
    }
    ok(gone, 'closing the window ended the real run: nothing is left running');
  } finally {
    program(['menu', 'remove']);
    stub.stdin.end();
    stub.kill();
    rmSync(work, { recursive: true, force: true });
  }
}

const steps = { install, entry, menu, window, gather, detach };
const step = process.argv[2];
if (!steps[step]) {
  console.error('usage: node scripts/desktop-check.mjs ' + Object.keys(steps).join(' | '));
  process.exit(2);
}
await steps[step]();
if (problems.length) {
  console.error(`\n${problems.length} check(s) failed:\n - ` + problems.join('\n - '));
  process.exit(1);
}
console.log('\nall checks passed');
process.exit(0);
