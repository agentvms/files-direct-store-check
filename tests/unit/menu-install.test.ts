import { describe, expect, it } from 'vitest';
import { MAC_WORKFLOW, MENU_TEXT, WIN_KEYS, WIN_SENDTO, installMenu, macInfoPlist, macWorkflow, menuStatus, removeMenu, windowsRegText, windowsSendToArguments, windowsVerbCommand, type Launch, type MenuEffects } from '../../src/cli/src/menu.ts';

// files-direct-30, done-when 2: what menu install writes, and that menu remove takes out exactly that and nothing else.
// The machine here is made up: a table of files and a table of registry keys, with a few things in them that are not ours.

const LAUNCH: Launch = { node: '/Users/ann/.nvm/versions/node/v22.22.0/bin/node', script: "/Users/ann/.nvm/versions/node/v22.22.0/lib/node_modules/files-direct/dist/files-direct.mjs" };
const WIN: Launch = { node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\Ann\\AppData\\Roaming\\npm\\node_modules\\files-direct\\dist\\files-direct.mjs' };

function machine(platform: string) {
  const files = new Map<string, string>([
    ['/Users/ann/Library/Services/Other.workflow/Contents/Info.plist', 'someone else'],
    ['/Users/ann/Library/Services/' + MAC_WORKFLOW + '.bak', 'not ours either'],
    ['C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\SendTo\\Notes.lnk', 'someone else'],
  ]);
  const keys = new Map<string, string>([
    ['HKCU\\Software\\Classes\\*\\shell\\OtherTool', 'someone else'],
    ['HKCU\\Software\\Classes\\Directory\\shell\\OtherTool\\command', 'someone else'],
    ['HKCU\\Software\\Classes\\*\\shell\\FilesDirectory', 'a key whose name starts like ours'],
  ]);
  let refreshed = 0;
  const fx: MenuEffects = {
    platform,
    home: '/Users/ann',
    sendToDir: 'C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\SendTo',
    async writeFile(p, c) { files.set(p, String(c)); },
    async removePath(p) { for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); },
    async exists(p) { return [...files.keys()].some((k) => k === p || k.startsWith(p + '/')); },
    async regImport(text) {
      const re = /^\[HKEY_CURRENT_USER\\(.+)\]$/gm;
      // the parents the entry sits in are made on the way when they were not there
      for (const p of ['HKCU\\Software\\Classes\\*\\shell', 'HKCU\\Software\\Classes\\*', 'HKCU\\Software\\Classes\\Directory\\shell', 'HKCU\\Software\\Classes\\Directory']) if (![...keys.keys()].some((x) => x === p || x.startsWith(p + '\\'))) keys.set(p, 'made by install');
      for (const m of text.matchAll(re)) keys.set('HKCU\\' + m[1], 'ours');
    },
    async regDelete(k) { for (const x of [...keys.keys()]) if (x === k || x.startsWith(k + '\\')) keys.delete(x); },
    async regExists(k) { return [...keys.keys()].some((x) => x === k || x.startsWith(k + '\\')); },
    async regPruneEmpty(k) { if (![...keys.keys()].some((x) => x.startsWith(k + '\\')) && keys.get(k) === 'made by install') keys.delete(k); },
    async shortcut(p, t, a) { files.set(p, 'shortcut ' + t + ' ' + a); },
    async refreshServices() { refreshed++; },
  };
  return { fx, files, keys, refreshed: () => refreshed, snapshot: () => JSON.stringify([[...files.entries()].sort(), [...keys.entries()].sort()]) };
}

describe('on a Mac', () => {
  it('installs one workflow in the person\'s own Services folder, and tells the system', async () => {
    const m = machine('darwin');
    const lines = await installMenu(LAUNCH, m.fx);
    expect(lines).toHaveLength(1);
    const ours = [...m.files.keys()].filter((k) => k.includes(MAC_WORKFLOW + '/')).sort();
    expect(ours).toEqual([`/Users/ann/Library/Services/${MAC_WORKFLOW}/Contents/Info.plist`, `/Users/ann/Library/Services/${MAC_WORKFLOW}/Contents/document.wflow`]);
    expect(m.refreshed()).toBe(1);
    expect(await menuStatus(m.fx)).toMatchObject({ installed: true });
  });

  it('writes a workflow Finder reads: the menu text, files and folders, arguments in, the program quoted', () => {
    const info = macInfoPlist();
    expect(info).toContain(`<string>${MENU_TEXT}</string>`);
    expect(info).toContain('com.apple.finder');
    expect(info).toContain('public.item');
    const wf = macWorkflow(LAUNCH);
    expect(wf).toContain('<key>inputMethod</key>\n\t\t\t\t\t<integer>1</integer>'); // chosen files come in as arguments
    expect(wf).toContain('com.apple.Automator.servicesMenu');
    expect(wf).toContain("open -- &quot;$@&quot;");
    expect(wf).toContain("node='/Users/ann/.nvm/versions/node/v22.22.0/bin/node'");
    // a program path with a quote in it stays inside its quotes, in the plist too
    expect(macWorkflow({ node: "/Users/o'neil/bin/node", script: '/a & b/<x>.mjs' })).toContain("node='/Users/o'\\''neil/bin/node'");
    expect(macWorkflow({ node: "/n", script: '/a & b/<x>.mjs' })).toContain('/a &amp; b/&lt;x&gt;.mjs');
  });

  it('removes exactly the workflow, and leaves other Services alone; removing twice is fine', async () => {
    const m = machine('darwin');
    const before = m.snapshot();
    await installMenu(LAUNCH, m.fx);
    expect((await removeMenu(m.fx)).length).toBe(1);
    expect(m.snapshot()).toBe(before);
    expect(await removeMenu(m.fx)).toEqual([]);
    expect(m.snapshot()).toBe(before);
    expect(await menuStatus(m.fx)).toMatchObject({ installed: false });
  });

  it('installing again replaces the workflow: no file of the first one is left', async () => {
    const m = machine('darwin');
    await installMenu(LAUNCH, m.fx);
    m.files.set(`/Users/ann/Library/Services/${MAC_WORKFLOW}/Contents/stale`, 'old');
    await installMenu({ ...LAUNCH, node: '/usr/local/bin/node' }, m.fx);
    expect([...m.files.keys()].filter((k) => k.endsWith('/stale'))).toEqual([]);
    expect(m.files.get(`/Users/ann/Library/Services/${MAC_WORKFLOW}/Contents/document.wflow`)).toContain("/usr/local/bin/node");
  });
});

describe('on Windows', () => {
  it('writes the entry for files and for folders, each with its command, in the current user\'s part of the registry only, and a Send to shortcut', async () => {
    const text = windowsRegText(WIN);
    expect(text.split('\r\n')[0]).toBe('Windows Registry Editor Version 5.00');
    const headings = [...text.matchAll(/^\[(.+)\]$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\FilesDirect',
      'HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\FilesDirect\\command',
      'HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\FilesDirect',
      'HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\FilesDirect\\command',
    ]);
    expect(text).not.toMatch(/HKEY_LOCAL_MACHINE|HKLM|HKEY_CLASSES_ROOT/);
    expect(text).toContain('@="Send with Files Direct"');
    // the command, as the file holds it: backslashes and quotes doubled
    expect(text).toContain('@="\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" ');
    expect(text).toContain('open --detach --gather -- \\"%1\\""');
    const m = machine('win32');
    const lines = await installMenu(WIN, m.fx);
    expect(lines).toHaveLength(2);
    expect([...m.keys.keys()].filter((k) => /FilesDirect($|\\)/.test(k)).sort()).toEqual(WIN_KEYS.flatMap((k) => [k, k + '\\command']).sort());
    expect(m.files.get('C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\SendTo\\' + WIN_SENDTO)).toContain('open --detach --');
    expect(await menuStatus(m.fx)).toMatchObject({ installed: true });
  });

  it('removes exactly what it wrote: a key and a shortcut that are someone else\'s stay, a key that starts like ours stays', async () => {
    const m = machine('win32');
    const before = m.snapshot();
    await installMenu(WIN, m.fx);
    expect(m.snapshot()).not.toBe(before);
    const gone = await removeMenu(m.fx);
    expect(gone.length).toBe(3);
    expect(m.snapshot()).toBe(before);
    expect(await removeMenu(m.fx)).toEqual([]);
  });

  it('removes what is left of a half-done install, whether or not the program is still there', async () => {
    const m = machine('win32');
    await installMenu(WIN, m.fx);
    m.files.delete('C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\SendTo\\' + WIN_SENDTO);
    expect(await menuStatus(m.fx)).toMatchObject({ installed: false });
    await removeMenu(m.fx);
    expect([...m.keys.keys()].filter((k) => /FilesDirect($|\\)/.test(k))).toEqual([]);
  });

  it('writes nothing when the program path cannot be used', async () => {
    const m = machine('win32');
    const before = m.snapshot();
    await expect(installMenu({ ...WIN, node: 'C:\\100%\\node.exe' }, m.fx)).rejects.toThrow(/%/);
    expect(m.snapshot()).toBe(before);
  });
});

describe('on Windows, on a computer with no other menu entries', () => {
  it('takes out the folders of keys it had to make, too: the registry is as it was', async () => {
    const m = machine('win32');
    for (const k of [...m.keys.keys()]) m.keys.delete(k);
    const before = m.snapshot();
    await installMenu(WIN, m.fx);
    expect([...m.keys.keys()]).toContain('HKCU\\Software\\Classes\\Directory\\shell');
    await removeMenu(m.fx);
    expect(m.snapshot()).toBe(before);
  });
});

describe('on any other system', () => {
  it('says plainly that the menu is for a Mac or Windows and changes nothing', async () => {
    const m = machine('linux');
    const before = m.snapshot();
    await expect(installMenu(LAUNCH, m.fx)).rejects.toThrow(/Mac or a Windows/);
    await expect(removeMenu(m.fx)).rejects.toThrow(/Mac or a Windows/);
    expect(m.snapshot()).toBe(before);
  });
});

// files-direct-34: the entries the double-click app writes. On a Mac the Quick Action runs the app's own Node and engine and says it is the app (--app); on Windows
// every entry starts the app's own launcher (a program with no console window), which hands the chosen paths to the engine on its standard input.
describe('for the double-click app', () => {
  const APP: Launch = { node: '/Users/ann/Applications/Files Direct.app/Contents/Resources/node', script: '/Users/ann/Applications/Files Direct.app/Contents/Resources/files-direct.mjs', app: true };
  const WAPP: Launch = { node: 'C:\\Users\\Ann\\AppData\\Local\\Programs\\Files Direct\\node.exe', script: 'C:\\Users\\Ann\\AppData\\Local\\Programs\\Files Direct\\files-direct.mjs', app: true, launcher: 'C:\\Users\\Ann\\AppData\\Local\\Programs\\Files Direct\\Files Direct.exe' };

  it('on a Mac: the Quick Action runs the app\'s own engine and tells it that it is the app, files after "--"', () => {
    const wf = macWorkflow(APP);
    expect(wf).toContain('open --app -- &quot;$@&quot;');
    expect(wf).toContain("node='/Users/ann/Applications/Files Direct.app/Contents/Resources/node'");
    expect(macWorkflow(LAUNCH)).not.toContain('--app');
  });

  it('on a Mac: refuses to write an entry from a place the app will not stay in (a disk image, or the temporary copy macOS makes of a download)', async () => {
    const m = machine('darwin');
    const before = m.snapshot();
    for (const script of ['/Volumes/Files Direct/Files Direct.app/Contents/Resources/files-direct.mjs', '/private/var/folders/x/AppTranslocation/9F/d/Files Direct.app/Contents/Resources/files-direct.mjs']) {
      await expect(installMenu({ ...APP, node: script.replace('files-direct.mjs', 'node'), script }, m.fx)).rejects.toThrow(/Applications folder/);
    }
    expect(m.snapshot()).toBe(before);
    // the command-line program is not held to it: Node may live on any disk
    await expect(installMenu({ node: '/Volumes/Tools/node', script: '/Volumes/Tools/files-direct.mjs' }, m.fx)).resolves.toBeTruthy();
  });

  it('on Windows: both keys start the launcher with one quoted %1, and Send to starts the launcher itself', async () => {
    const reg = windowsRegText(WAPP);
    expect(windowsVerbCommand(WAPP)).toBe('"C:\\Users\\Ann\\AppData\\Local\\Programs\\Files Direct\\Files Direct.exe" verb "%1"');
    expect(reg.match(/verb \\"%1\\"/g)).toHaveLength(2);
    expect(reg).not.toContain('node.exe');
    expect(windowsSendToArguments(WAPP)).toBe('sendto');
    const m = machine('win32');
    await installMenu(WAPP, m.fx);
    expect(m.files.get('C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\SendTo\\' + WIN_SENDTO)).toBe('shortcut ' + WAPP.launcher + ' sendto');
  });

  it('refuses a launcher path Explorer would change (a % in it) before anything is written', async () => {
    const m = machine('win32');
    const before = m.snapshot();
    await expect(installMenu({ ...WAPP, launcher: 'C:\\100%\\Files Direct.exe' }, m.fx)).rejects.toThrow(/%/);
    expect(m.snapshot()).toBe(before);
  });

  it('removes what it added, the same as for the program', async () => {
    const m = machine('win32');
    const before = m.snapshot();
    await installMenu(WAPP, m.fx);
    await removeMenu(m.fx);
    expect(m.snapshot()).toBe(before);
  });
});
