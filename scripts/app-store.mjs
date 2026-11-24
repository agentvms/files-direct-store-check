// The Files Direct Store package for Windows (files-direct-37): the app of scripts/app-build.mjs as an MSIX, plus the handler of the Windows 11 main right-click menu.
//   node scripts/app-store.mjs build     builds the app, the handler and the package: store-out/<name>.msix, unsigned (the Store signs what it lists)
//   node scripts/app-store-check.mjs     (its own file) what the build machine can show of it: a test-signed copy installs, the app starts, the manifest holds the menu entry,
//                                        the handler passes hostile names on, the certification kit's verdict (or the closest check there is, named), and the package is removed again
// The three values that name the publisher come from build-time settings (repository variables, below); with none set the package carries clear placeholders and says so.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const STORE_VARIABLES = { name: 'FD_STORE_IDENTITY_NAME', publisher: 'FD_STORE_PUBLISHER', publisherName: 'FD_STORE_PUBLISHER_NAME' };
export const PLACEHOLDERS = { name: 'FilesDirect.Placeholder', publisher: 'CN=00000000-0000-0000-0000-000000000000', publisherName: 'Files Direct (placeholder publisher)' };
/** The class of the menu handler (app/store/ExplorerCommand.cpp gives its class this same number; a test checks it). */
export const HANDLER_CLSID = '77EA6AA1-EAF9-46EF-962D-7862CB8CA0F0';
/** The programs inside the package: the launcher the manifest starts (the same program as the installer's, under a name without a space) and the handler's library. */
export const LAUNCHER_FILE = 'FilesDirect.exe';
export const HANDLER_FILE = 'SendWithFilesDirect.dll';
const DESCRIPTION = 'Send files and folders straight from one device to another. No account, nothing kept.';

const FORMS = {
  name: [/^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/, 'letters, digits, dots and dashes, 3 to 50 characters (the "Package/Identity/Name" value from Partner Center)'],
  publisher: [/^CN=[^"<>&]{1,200}$/, 'it starts with CN= (the "Package/Identity/Publisher" value from Partner Center)'],
  publisherName: [/^[^\n\r\t]{1,100}$/, 'at most 100 characters (the "Package/Properties/PublisherDisplayName" value from Partner Center)'],
};

/** The identity of the package: from the three settings when they are all set, from the placeholders when none is; a half-set identity is refused. */
export function storeSettings(env = process.env) {
  const got = Object.fromEntries(Object.entries(STORE_VARIABLES).map(([k, v]) => [k, (env[v] ?? '').trim()]));
  const set = Object.keys(got).filter((k) => got[k]);
  if (set.length === 0) return { ...PLACEHOLDERS, placeholder: true };
  const missing = Object.keys(got).filter((k) => !got[k]).map((k) => STORE_VARIABLES[k]);
  if (missing.length) throw new Error('The package identity is half set. Set all three of ' + Object.values(STORE_VARIABLES).join(', ') + ' or none of them; missing: ' + missing.join(', ') + '.');
  for (const k of Object.keys(got)) if (!FORMS[k][0].test(got[k])) throw new Error(STORE_VARIABLES[k] + ' is not in the form the Store wants: ' + FORMS[k][1] + '.');
  return { ...got, placeholder: false };
}

/** The Store's four-part version: the last part is the Store's own and stays 0. */
export function msixVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('the package version must be three numbers (x.y.z), not "' + version + '"');
  return version + '.0';
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderManifest(settings, version, template = readFileSync(new URL('../app/store/AppxManifest.xml', import.meta.url), 'utf8')) {
  const tokens = {
    IDENTITY_NAME: settings.name,
    PUBLISHER: settings.publisher,
    PUBLISHER_NAME: settings.publisherName,
    VERSION: msixVersion(version),
    LAUNCHER: LAUNCHER_FILE,
    HANDLER_CLSID,
    HANDLER_FILE,
    DESCRIPTION,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    if (!(k in tokens)) throw new Error('the manifest template holds a token this script does not know: ' + k);
    return escapeXml(tokens[k]);
  });
}

/** A name no release upload or list of updates picks up: not files-direct-*, not desktop-*. */
export const storeFileName = (version) => 'store-files-direct-' + version + '-x64.msix';

// ---- the build (a Windows machine) ----------------------------------------------------------------------------------------------------------

const WIN = process.platform === 'win32';
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...o });
const must = (cmd, args, o) => {
  const r = run(cmd, args, o);
  if (r.status !== 0) throw new Error(cmd + ' ' + args.join(' ').slice(0, 300) + ' failed (' + r.status + '): ' + String(r.stderr || r.stdout || r.error).slice(-1500));
  return r.stdout;
};
const slashes = (p) => p.replace(/\\/g, '/');

/** The newest copy of a tool of the Windows SDK that is on the machine (makeappx, signtool). */
export function kitTool(name) {
  const root = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = existsSync(root) ? readdirSync(root).filter((d) => /^10\./.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse() : [];
  for (const v of versions) {
    const p = join(root, v, 'x64', name);
    if (existsSync(p)) return p;
  }
  throw new Error(name + ' is not in the Windows SDK on this machine (looked in ' + root + ')');
}

/** The C++ compiler's setup file, found with the tool Visual Studio itself installs for the purpose. */
function vcvars() {
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const home = must(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']).trim().split(/\r?\n/)[0];
  const bat = join(home, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!home || !existsSync(bat)) throw new Error('the C++ compiler (Visual Studio build tools) was not found on this machine');
  return bat;
}

/** Runs one command line after the compiler's setup file, in one cmd.exe. */
function withCompiler(line) {
  console.log('cl      ' + line.replace(/^.*?&& /, ''));
  return must('cmd.exe', ['/d', '/s', '/c', '"' + '"' + vcvars() + '" >nul && ' + line + '"'], { windowsVerbatimArguments: true });
}

/** The handler's library, and (for the check only) the program that calls it the way Explorer does. Both with the C runtime inside, so the package needs nothing installed beside it. */
export function compileHandler(into, work, { naive = false } = {}) {
  const src = slashes(resolve('app', 'store'));
  mkdirSync(work, { recursive: true });
  const obj = slashes(work) + '/';
  const dll = join(into, HANDLER_FILE);
  withCompiler('cl /nologo /std:c++17 /O2 /EHsc /MT /W3 /guard:cf' + (naive ? ' /DFD_NAIVE' : '') + ' /LD /Fo"' + obj + '" /Fe"' + slashes(dll) + '" "' + src + '/ExplorerCommand.cpp" /link /DEF:"' + src + '/ExplorerCommand.def" /guard:cf /DYNAMICBASE /NXCOMPAT ole32.lib shell32.lib shlwapi.lib user32.lib');
  for (const leftover of ['.lib', '.exp']) rmSync(dll.replace(/\.dll$/, leftover), { force: true }); // the linker's import library is not part of the package
  const test = join(work, 'InvokeTest.exe');
  withCompiler('cl /nologo /std:c++17 /O2 /EHsc /MT /W3 /Fo"' + obj + '" /Fe"' + slashes(test) + '" "' + src + '/InvokeTest.cpp" /link ole32.lib shell32.lib');
  return { dll, test };
}

/** The stand-in engine of the check's package: writes the words it was started with and what came on its standard input, to a file outside the package's own storage. */
const stubEngine = (log) => "import { writeFileSync } from 'node:fs'; const chunks = []; try { for await (const c of process.stdin) chunks.push(c); } catch {} writeFileSync(" + JSON.stringify(log) + ", JSON.stringify({ argv: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8').split('\\0').filter(Boolean) }));\n";

/**
 * The package folder (everything that goes into the .msix) and the .msix itself. With "stub" the engine file is a stand-in that writes what it was given to the file "stub" names,
 * so the check can follow a hostile name from the menu to the program that would send it; the check's package is otherwise the real one.
 */
export async function buildPackage({ stub, tag = 'package' } = {}) {
  const { buildEngine, compileLauncher, copyNative, fetchNode } = await import('./app-build.mjs');
  const { iconPng } = await import('./icon-png.mjs');
  const out = resolve(process.env.FD_STORE_OUT ?? 'store-out');
  const work = resolve(process.env.FD_STORE_WORK ?? join(process.env.RUNNER_TEMP ?? 'store-work', 'files-direct-store'));
  const layout = join(work, 'layout-' + tag);
  rmSync(layout, { recursive: true, force: true });
  mkdirSync(join(layout, 'Assets'), { recursive: true });
  mkdirSync(out, { recursive: true });
  const settings = storeSettings();
  const node = await fetchNode('win-x64', join(work, 'cache'));
  cpSync(node.node, join(layout, 'node.exe'));
  cpSync(node.license, join(layout, 'NODE-LICENSE'));
  let version;
  if (stub) {
    version = JSON.parse(readFileSync(existsSync('src/cli/src/main.ts') ? 'package.json' : 'cli/package.json', 'utf8')).version;
    writeFileSync(join(layout, 'files-direct.mjs'), stubEngine(stub));
  } else {
    version = (await buildEngine(join(layout, 'files-direct.mjs'))).version;
  }
  writeFileSync(join(layout, 'app.json'), JSON.stringify({ target: 'win-x64', version }) + '\n');
  copyNative('win-x64', layout);
  compileLauncher(join(layout, LAUNCHER_FILE), join(work, 'launcher-' + tag), version, false, resolve('app', 'store', 'FilesDirect.exe.manifest'));
  compileHandler(layout, join(work, 'handler-' + tag));
  for (const [file, px] of [['StoreLogo', 50], ['Square44x44Logo', 44], ['Square150x150Logo', 150]]) writeFileSync(join(layout, 'Assets', file + '.png'), iconPng(px, { samples: 4 }));
  writeFileSync(join(layout, 'AppxManifest.xml'), renderManifest(settings, version));
  const file = join(out, stub ? 'check-' + storeFileName(version) : storeFileName(version));
  rmSync(file, { force: true });
  console.log(must(kitTool('makeappx.exe'), ['pack', '/d', layout, '/p', file, '/o']).trim().split(/\r?\n/).slice(-6).join('\n'));
  const bytes = readFileSync(file);
  const report = { file: basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version, msixVersion: msixVersion(version), identity: { name: settings.name, publisher: settings.publisher, publisherName: settings.publisherName, placeholder: settings.placeholder }, makeappx: kitTool('makeappx.exe') };
  if (!stub) writeFileSync(join(out, 'build-store.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('built   ' + report.file + '  ' + report.bytes + ' bytes (' + (report.bytes / 1e6).toFixed(1) + ' MB)  sha256 ' + report.sha256);
  if (settings.placeholder) console.log('note    the package carries the placeholder identity (' + Object.values(STORE_VARIABLES).join(', ') + ' are not set): it can be tried here, not submitted');
  return { file, layout, work, report, version };
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL('file://' + (process.platform === 'win32' ? '/' : '') + process.argv[1].replace(/\\/g, '/')).href) {
  const mode = process.argv[2];
  try {
    if (!WIN) throw new Error('the Store package is built on Windows (the build machine of the release workflow)');
    if (mode === 'build') await buildPackage();
    else {
      console.error('usage: node scripts/app-store.mjs build   (the check is its own program: node scripts/app-store-check.mjs)');
      process.exit(2);
    }
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
