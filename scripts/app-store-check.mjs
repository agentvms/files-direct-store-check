// What a Windows build machine can show of the Store package (files-direct-37): node scripts/app-store-check.mjs, after node scripts/app-store.mjs build.
// Everything it installs it removes again, and the test certificate it makes is trusted on this machine only for the length of the run. Nothing here talks to the real site or to any account:
// the one program that is started with a hostile name is a stand-in engine that only writes down what it was given.
//   1. the certification kit's verdict on the package (the Windows App Certification Kit when the machine has it; else the closest check there is, named)
//   2. the package, signed with the test certificate, installs; the manifest holds the menu entry; Windows registered the handler; the app starts; it wrote no classic menu entries
//   3. the handler, called the way Explorer calls it with hostile names, hands them on intact: as a plain file, and as the installed package registered it
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HANDLER_CLSID, HANDLER_FILE, LAUNCHER_FILE, buildPackage, compileHandler, kitTool, storeSettings } from './app-store.mjs';

const OUT = resolve(process.env.FD_STORE_OUT ?? 'store-out');
const SHOTS = resolve('store-check');
const problems = [];
const ok = (cond, text) => {
  console.log((cond ? 'ok      ' : 'FAILED  ') + text);
  if (!cond) problems.push(text);
  return cond;
};
const note = (text) => console.log('seen    ' + String(text).replace(/\n/g, '\n        '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...o });
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/** PowerShell, given the script encoded so that no quoting of ours reaches it. */
function ps(script, o = {}) {
  const encoded = Buffer.from('$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"; ' + script, 'utf16le').toString('base64');
  // Windows PowerShell (the one with the certificate and package commands) must not inherit the module path of the newer PowerShell that runs the workflow's steps
  const env = { ...process.env, PSModulePath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encoded], { env, ...o });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
async function until(what, fn, ms = 30_000) {
  for (let t = 0; t < ms; t += 500) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  console.log('waited ' + ms / 1000 + ' s for: ' + what);
  return null;
}

// names Windows allows; the ones with a quote, a backslash or a line break cannot exist here
const HOSTILE = ['plain.txt', 'two words.txt', "it's.txt", 'a;touch pwned.txt', '$(touch pwned).txt', '`touch pwned`.txt', 'a&touch pwned&.txt', '100%.txt', '%1 %L %V.txt', 'caret^name.txt', '-rf.txt', '--help', '$HOME', '! history', '#hash', 'ünï-名前.txt', '  padded.txt', 'sp ace  double.txt'];

function hostileFiles(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = HOSTILE.map((n, i) => (writeFileSync(join(dir, n), 'c' + i), join(dir, n)));
  const list = join(dir, '..', 'paths.bin');
  writeFileSync(list, Buffer.from(files.map((p) => p + '\0').join(''), 'utf8'));
  return { files, list };
}

/** Waits for the stand-in engine's note and compares it to what the menu should have handed on. */
async function seenBy(what, log, ms = 40_000) {
  return JSON.parse((await until('the stand-in engine (' + what + ')', () => existsSync(log) && readFileSync(log, 'utf8'), ms)) ?? 'null');
}
const exactly = (seen, files) => !!seen && JSON.stringify(seen.argv) === JSON.stringify(['open', '--app', '--paths-stdin']) && JSON.stringify(seen.stdin) === JSON.stringify(files);

async function expectHandedOn(what, log, files, home) {
  const seen = await seenBy(what, log);
  const same = exactly(seen, files);
  if (!same) note(what + ': the engine saw ' + JSON.stringify(seen)?.slice(0, 1500));
  ok(same, what + ': the engine was started with exactly "open --app --paths-stdin" and all ' + files.length + ' names, in order, on its standard input, none on a command line');
  ok(!existsSync(join(home, 'pwned.txt')) && !files.some((f) => existsSync(join(f, '..', 'pwned'))) && !existsSync(join(process.cwd(), 'pwned.txt')), what + ': nothing else ran (no file called pwned)');
}

function certificate(publisher) {
  const dir = join(OUT, 'test-certificate');
  mkdirSync(dir, { recursive: true });
  const r = ps(
    '$c = New-SelfSignedCertificate -Type Custom -Subject ' + psq(publisher) + ' -KeyUsage DigitalSignature -FriendlyName "Files Direct test certificate" -CertStoreLocation "Cert:\\CurrentUser\\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}"); ' +
      'Export-Certificate -Cert $c -FilePath ' + psq(join(dir, 'test.cer')) + ' | Out-Null; ' +
      'Import-Certificate -FilePath ' + psq(join(dir, 'test.cer')) + ' -CertStoreLocation "Cert:\\LocalMachine\\TrustedPeople" | Out-Null; ' +
      '$c.Thumbprint',
  );
  if (r.status !== 0) throw new Error('the test certificate could not be made: ' + r.err);
  return r.out.split(/\r?\n/).pop();
}
const forgetCertificate = (thumb) => ps('Get-ChildItem Cert:\\CurrentUser\\My, Cert:\\LocalMachine\\TrustedPeople | Where-Object { $_.Thumbprint -eq ' + psq(thumb) + ' } | Remove-Item -Force');

function sign(msix, thumb) {
  const signed = msix.replace(/\.msix$/, '-test-signed.msix');
  copyFileSync(msix, signed);
  const r = run(kitTool('signtool.exe'), ['sign', '/fd', 'SHA256', '/sha1', thumb, signed]);
  if (r.status !== 0) throw new Error('signtool: ' + (r.stdout + r.stderr).slice(-800));
  return signed;
}

const installed = (name) => {
  const r = ps('$p = Get-AppxPackage -Name ' + psq(name) + '; if ($p) { $p.PackageFullName + "|" + $p.PackageFamilyName + "|" + $p.InstallLocation }');
  const [full, family, location] = r.out.split('|');
  return full ? { full, family, location } : null;
};
const uninstall = (name) => ps('Get-AppxPackage -Name ' + psq(name) + ' | Remove-AppxPackage');

/** The certification step: the Windows App Certification Kit when the machine has it, the closest automated check when it does not. */
function certification(msix) {
  const appcert = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'App Certification Kit', 'appcert.exe');
  if (existsSync(appcert)) {
    const report = join(SHOTS, 'appcert-report.xml');
    note('Windows App Certification Kit: ' + appcert);
    run(appcert, ['reset'], { timeout: 120_000 });
    const r = run(appcert, ['test', '-appxpackagepath', msix, '-reportoutputpath', report], { timeout: 25 * 60_000 });
    note('appcert test exited ' + r.status + (r.error ? ' (' + r.error + ')' : '') + '\n' + String(r.stdout).split(/\r?\n/).filter(Boolean).slice(-12).join('\n'));
    const xml = existsSync(report) ? readFileSync(report, 'utf8') : '';
    const overall = /OVERALL_RESULT="([^"]*)"/.exec(xml)?.[1];
    const tests = [...xml.matchAll(/<TEST [^>]*?NAME="([^"]*)"[^>]*?OPTIONAL="(TRUE|FALSE)"[^>]*>([\s\S]*?)<\/TEST>/g)].map((m) => ({ name: m[1], optional: m[2] === 'TRUE', result: /<RESULT><!\[CDATA\[(\w+)\]\]>/.exec(m[3])?.[1] ?? '?', messages: [...m[3].matchAll(/<MESSAGE TEXT="([^"]*)"/g)].map((x) => x[1]) }));
    const count = (r) => tests.filter((t) => t.result === r).length;
    note('certification kit verdict: OVERALL_RESULT=' + (overall ?? '(no report)') + ' over ' + tests.length + ' tests: ' + count('PASS') + ' pass, ' + count('WARNING') + ' warning, ' + count('FAIL') + ' fail');
    for (const t of tests.filter((x) => x.result !== 'PASS')) note((t.optional ? 'optional test ' : 'REQUIRED test ') + '"' + t.name + '": ' + t.result + (t.messages.length ? '\n' + t.messages.slice(0, 4).join('\n') : ''));
    ok(overall === 'PASS', 'the Windows App Certification Kit passes the package (OVERALL_RESULT=' + (overall ?? 'none') + ')');
    return 'appcert';
  }
  note('The Windows App Certification Kit (appcert.exe) is not on this machine. The closest automated checks: makeappx validated the manifest against its schema while packing, and now unpacking the package again with validation, then the signature.');
  const dir = join(SHOTS, 'unpacked');
  rmSync(dir, { recursive: true, force: true });
  const r = run(kitTool('makeappx.exe'), ['unpack', '/p', msix, '/d', dir, '/l', '/v']);
  ok(r.status === 0, 'makeappx unpack /l /v reads the package back and finds it valid (exit ' + r.status + ')');
  const s = run(kitTool('signtool.exe'), ['verify', '/pa', '/v', msix]);
  note('signtool verify /pa: exit ' + s.status + '\n' + String(s.stdout + s.stderr).split(/\r?\n/).filter(Boolean).slice(-6).join('\n'));
  ok(s.status === 0, 'the test signature verifies with the test certificate trusted on this machine');
  return 'makeappx-and-signtool';
}

export async function check() {
  if (process.platform !== 'win32') throw new Error('this check is for Windows');
  mkdirSync(SHOTS, { recursive: true });
  const info = JSON.parse(readFileSync(join(OUT, 'build-store.json'), 'utf8'));
  const msix = join(OUT, info.file);
  const settings = storeSettings();
  const WORK = join(process.env.RUNNER_TEMP ?? process.cwd(), 'fd-store-check');
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const os = ps('$o = Get-CimInstance Win32_OperatingSystem; $o.Caption + " " + $o.Version');
  note('machine: ' + os.out);
  note('package: ' + info.file + ', ' + info.bytes + ' bytes, sha256 ' + info.sha256 + ', identity ' + info.identity.name + (info.identity.placeholder ? ' (placeholder)' : ''));
  const thumb = certificate(settings.publisher);
  let stubName = null;
  try {
    // ---- 1. certification ----
    const signed = sign(msix, thumb);
    note('signed with the test certificate (subject ' + settings.publisher + '): ' + signed);
    const how = certification(signed);
    writeFileSync(join(SHOTS, 'certification-by.txt'), how + '\n');

    // ---- 2. install, manifest, registration, start ----
    ok(!installed(settings.name), 'the package is not installed before the check');
    const add = ps('Add-AppxPackage -Path ' + psq(signed));
    if (!ok(add.status === 0, 'Add-AppxPackage installs the test-signed package' + (add.status === 0 ? '' : ': ' + add.err.slice(0, 600)))) throw new Error('The test package could not be installed, so the rest of the check cannot run' + (problems.length > 1 ? '. Earlier failures:\n- ' + problems.slice(0, -1).join('\n- ') : ''));
    const pkg = installed(settings.name);
    ok(!!pkg, 'Windows lists the package: ' + JSON.stringify(pkg));
    const manifest = ps('(Get-AppxPackageManifest -Package ' + psq(pkg.full) + ').OuterXml').out;
    writeFileSync(join(SHOTS, 'installed-manifest.xml'), manifest);
    const verbs = [...manifest.matchAll(/<desktop5:ItemType Type="([^"]+)">\s*<desktop5:Verb Id="([^"]+)" Clsid="([^"]+)"/g)].map((m) => m[1] + ' -> ' + m[3]);
    ok(verbs.length === 2 && verbs.every((v) => v.endsWith(HANDLER_CLSID)), 'the installed manifest holds the main right-click menu entry for files and folders: ' + verbs.join('; '));
    ok(manifest.includes('Executable="' + LAUNCHER_FILE + '"') && manifest.includes('Path="' + HANDLER_FILE + '"'), 'the installed manifest names the launcher and the handler library');
    const reg = ps('$k = Get-Item "Registry::HKEY_CLASSES_ROOT\\PackagedCom\\Package\\' + pkg.full + '\\Class\\{' + HANDLER_CLSID + '}"; ($k | Get-ItemProperty | Format-List | Out-String)');
    note('Windows registered the handler (PackagedCom): ' + (reg.status === 0 ? reg.out : 'not found: ' + reg.err.slice(0, 400)));
    ok(reg.status === 0, 'Windows registered the handler class of the installed package');
    const before = ps('Get-ChildItem "Registry::HKEY_CURRENT_USER\\Software\\Classes\\*\\shell", "Registry::HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell" -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName }');
    const start = ps('Start-Process explorer.exe -ArgumentList ' + psq('shell:AppsFolder\\' + pkg.family + '!FilesDirect'));
    note('start: explorer shell:AppsFolder\\' + pkg.family + '!FilesDirect exited ' + start.status + ' ' + start.err.slice(0, 300));
    const running = await until('the app to start', () => {
      const r = ps('Get-Process -Name FilesDirect -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + "|" + $_.Path }');
      return r.out.split(/\r?\n/).find((line) => /\|.+/.test(line)) ?? null; // the process can exist a moment before Windows can tell where it runs from
    }, 60_000);
    note('process: ' + (running ?? '(none)'));
    ok(!!running && running.toLowerCase().includes(pkg.location.toLowerCase().replace(/\\$/, '')), 'the app started, from the installed package');
    await sleep(8000); // the tray program writes its classic entries (when it does) within moments of starting
    const after = ps('Get-ChildItem "Registry::HKEY_CURRENT_USER\\Software\\Classes\\*\\shell", "Registry::HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell" -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName }');
    ok(!after.out.split(/\r?\n/).includes('FilesDirect') || before.out.split(/\r?\n/).includes('FilesDirect'), 'the packaged app wrote no classic right-click entry of its own (the manifest holds the entry)');
    ps('Get-Process -Name FilesDirect -ErrorAction SilentlyContinue | Stop-Process -Force');
    const gone = uninstall(settings.name);
    ok(gone.status === 0 && !installed(settings.name), 'Remove-AppxPackage removes it again');

    // ---- 3. the handler with hostile names ----
    const { files, list } = hostileFiles(join(WORK, 'files'));
    // 3a. as a plain file: the library, the launcher and a stand-in engine, in a folder of their own
    const direct = join(WORK, 'direct App');
    rmSync(direct, { recursive: true, force: true });
    mkdirSync(direct, { recursive: true });
    const dlog = join(WORK, 'seen-direct.json');
    const stubBuild = await buildPackage({ stub: dlog, tag: 'stub' });
    stubName = settings.name;
    for (const f of [LAUNCHER_FILE, HANDLER_FILE, 'node.exe', 'files-direct.mjs']) cpSync(join(stubBuild.layout, f), join(direct, f));
    const tester = join(stubBuild.work, 'handler-stub', 'InvokeTest.exe');
    const r1 = run(tester, [join(direct, HANDLER_FILE), list], { cwd: WORK, timeout: 60_000 });
    note('InvokeTest (library file): exit ' + r1.status + '\n' + String(r1.stdout + r1.stderr).trim());
    ok(r1.status === 0 && /title: Send with Files Direct/.test(r1.stdout), 'the handler answers with its title "Send with Files Direct" and runs Invoke');
    await expectHandedOn('handler as a plain file', dlog, files, WORK);
    // 3a'. the careless form of the handler (the paths pasted into a command line) must be broken by the same names: the check can fail
    const naive = join(WORK, 'naive App');
    rmSync(naive, { recursive: true, force: true });
    mkdirSync(naive, { recursive: true });
    const nlog = join(WORK, 'seen-naive.json');
    for (const f of [LAUNCHER_FILE, 'node.exe']) cpSync(join(stubBuild.layout, f), join(naive, f));
    writeFileSync(join(naive, 'files-direct.mjs'), readFileSync(join(stubBuild.layout, 'files-direct.mjs'), 'utf8').split(JSON.stringify(dlog)).join(JSON.stringify(nlog)));
    compileHandler(naive, join(WORK, 'naive-build'), { naive: true });
    const r0 = run(tester, [join(naive, HANDLER_FILE), list], { cwd: WORK, timeout: 60_000 });
    const careless = await seenBy('careless handler', nlog, 15_000);
    ok(r0.status === 0 && !exactly(careless, files), 'the careless handler (the paths pasted into the command line) is broken by these names, as it should be: the check can fail (' + (careless ? 'the engine saw ' + careless.stdin.length + ' names instead of ' + files.length : 'the engine never started') + ')');
    // 3b. as the installed package registered it: a package whose engine is the stand-in
    const rlog = join(WORK, 'seen-registered.json');
    const regBuild = await buildPackage({ stub: rlog, tag: 'registered' });
    const regSigned = sign(regBuild.file, thumb);
    const add2 = ps('Add-AppxPackage -Path ' + psq(regSigned));
    if (ok(add2.status === 0, 'the package with the stand-in engine installs' + (add2.status === 0 ? '' : ': ' + add2.err.slice(0, 500)))) {
      const r2 = run(tester, ['--registered', list], { cwd: WORK, timeout: 90_000 });
      note('InvokeTest (as registered): exit ' + r2.status + '\n' + String(r2.stdout + r2.stderr).trim());
      ok(r2.status === 0, 'Windows hands out the installed package\'s handler, and its Invoke works');
      if (r2.status === 0) await expectHandedOn('handler as the installed package registered it', rlog, files, WORK);
      ps('Get-Process -Name FilesDirect, node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*WindowsApps*" } | Stop-Process -Force');
      ok(uninstall(settings.name).status === 0 && !installed(settings.name), 'Remove-AppxPackage removes the check package again');
    }
  } finally {
    if (stubName) uninstall(stubName);
    forgetCertificate(thumb);
    note('the test certificate is gone from this machine again');
  }
  if (problems.length) {
    console.log('\n' + problems.length + ' check(s) failed:\n- ' + problems.join('\n- '));
    process.exit(1);
  }
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL('file://' + (process.platform === 'win32' ? '/' : '') + process.argv[1].replace(/\\/g, '/')).href) {
  try {
    await check();
  } catch (e) {
    console.error(String(e?.stack ?? e));
    process.exit(1);
  }
}
