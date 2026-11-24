/**
 * The right-click menu entries (files-direct-30): what "menu install" puts where, as plain data, so a test can read it before anything is written,
 * and the two steps (install, remove) that run it through a small set of effects (cli/src/menu-node.ts holds the real ones).
 *
 * The one rule: the chosen files reach the program as separate arguments, after "--", and are never pasted into a command line.
 *  - Mac: a Finder Quick Action ("Run Shell Script", input "as arguments") hands them to the script as "$@", always inside double quotes.
 *  - Windows: the registry entry names %1 inside double quotes (a file name cannot hold one), and the Send to shortcut gets each file from Explorer as its own quoted argument.
 * The program's own two paths are written into the entry quoted too (they can hold spaces, quotes and "&").
 */
export interface Launch {
  /** The node program, as an absolute path. */
  node: string;
  /** The program's own file, as an absolute path. */
  script: string;
  /** The double-click app (files-direct-34): the entries say so (--app), and the room says it comes from the app. */
  app?: boolean;
  /** Windows, the app: the launcher program (no console window) every entry starts. It hands the chosen paths to the engine on its standard input, so no path is ever pasted into a command line. */
  launcher?: string;
}

export const MENU_TEXT = 'Send with Files Direct';
export const MAC_WORKFLOW = MENU_TEXT + '.workflow';
export const WIN_VERB = 'FilesDirect';
export const WIN_SENDTO = 'Files Direct.lnk';
/** The two registry keys the entry is made of (each with a "command" key below it), and nothing else. */
/** The folders the entry's keys sit in, innermost first. They are made by the install when they were not there; they go again when nothing else is in them. */
export const WIN_PARENTS = ['HKCU\\Software\\Classes\\*\\shell', 'HKCU\\Software\\Classes\\*', 'HKCU\\Software\\Classes\\Directory\\shell', 'HKCU\\Software\\Classes\\Directory'] as const;
export const WIN_KEYS = [`HKCU\\Software\\Classes\\*\\shell\\${WIN_VERB}`, `HKCU\\Software\\Classes\\Directory\\shell\\${WIN_VERB}`] as const;

/** One word in single quotes for a POSIX shell: a single quote inside it is closed, escaped and opened again. */
export const shellQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const NOTE_GONE = 'Files Direct is no longer installed here. Remove this entry from the Services folder in your Library.';

/** The shell script the Finder Quick Action runs. The chosen files and folders reach it as its arguments. */
export function quickActionScript(l: Launch): string {
  return [
    `node=${shellQuote(l.node)}`,
    `script=${shellQuote(l.script)}`,
    'if [ ! -x "$node" ] || [ ! -f "$script" ]; then',
    `  /usr/bin/osascript -e ${shellQuote(`display notification "${NOTE_GONE}" with title "Files Direct"`)} >/dev/null 2>&1`,
    '  exit 0',
    'fi',
    `"$node" "$script" open${l.app ? ' --app' : ''} -- "$@" >/dev/null 2>&1 &`,
    '',
  ].join('\n');
}

/** One argument for a Windows command line: in double quotes, with the rules the C runtime reads them by. */
export function windowsQuote(s: string): string {
  if (/[\n\r\0]/.test(s)) throw new Error('a path with a line break cannot be used');
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

function windowsPaths(l: Launch): [string, string] {
  // Explorer changes %1, %L, %V and the like wherever it finds them in the command, so a program path with a % in it cannot be written there
  for (const p of [l.node, l.script, ...(l.launcher ? [l.launcher] : [])]) if (p.includes('%')) throw new Error('The program is in a folder with a % in its name. Move it to a folder without one, then run menu install again.');
  return [windowsQuote(l.node), windowsQuote(l.script)];
}

/**
 * The command line of the registry entry: Windows fills in the chosen file where it finds %1.
 * "--detach": node is a console program, so Windows draws a console window for it. The program starts its real run in a child that has no window and ends
 * at once, so the console is on screen for a moment only (a window of our own would need a signed program: rung 2). "--gather": see cli/src/gather.ts.
 */
export function windowsVerbCommand(l: Launch): string {
  const [node, script] = windowsPaths(l);
  if (l.launcher) return `${windowsQuote(l.launcher)} verb "%1"`;
  return `${node} ${script} open${l.app ? ' --app' : ''} --detach --gather -- "%1"`;
}

/** The arguments of the Send to shortcut (its target is node itself): Explorer adds the chosen files after them, each as its own quoted argument. */
export function windowsSendToArguments(l: Launch): string {
  const [, script] = windowsPaths(l);
  if (l.launcher) return 'sendto';
  return `${script} open${l.app ? ' --app' : ''} --detach --`;
}

// ---- the Mac workflow ---------------------------------------------------------------------------------------------------------------------

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PLIST_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';

/** Info.plist of the workflow: one Service, shown for files and folders in Finder. */
export function macInfoPlist(): string {
  return `${PLIST_HEAD}<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSBackgroundColorName</key>
			<string>background</string>
			<key>NSIconName</key>
			<string>NSActionTemplate</string>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>${xml(MENU_TEXT)}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.item</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
`;
}

/** document.wflow: one "Run Shell Script" action that takes the chosen files as arguments. */
export function macWorkflow(l: Launch): string {
  const script = xml(quickActionScript(l));
  const arg = (n: number, name: string, type: string) => `
					<key>${n}</key>
					<dict>
						<key>default value</key>
						<${type === '0' ? 'integer>0</integer' : 'string></string'}>
						<key>name</key>
						<string>${name}</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>${type}</string>
						<key>uuid</key>
						<string>${n}</string>
					</dict>`;
  return `${PLIST_HEAD}<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>${script}</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/bash</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>0D5B6E0A-6C7E-4B7B-9C55-5F1E1C2A0A01</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>0D5B6E0A-6C7E-4B7B-9C55-5F1E1C2A0A02</string>
				<key>UUID</key>
				<string>0D5B6E0A-6C7E-4B7B-9C55-5F1E1C2A0A03</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>${arg(0, 'inputMethod', '0')}${arg(1, 'COMMAND_STRING', '2')}${arg(2, 'source', '2')}${arg(3, 'shell', '2')}
				</dict>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:253.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleIDsByPath</key>
		<dict/>
		<key>applicationPaths</key>
		<array/>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>15</integer>
		<key>processesInput</key>
		<integer>0</integer>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`;
}

// ---- the Windows registry file ----------------------------------------------------------------------------------------------------------------

const regString = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** What `reg import` reads: the two keys, each with its text and its command. Only HKCU (the person's own part of the registry): no administrator. */
export function windowsRegText(l: Launch): string {
  const command = windowsVerbCommand(l);
  const lines = ['Windows Registry Editor Version 5.00', ''];
  for (const key of WIN_KEYS) {
    lines.push(`[${key.replace('HKCU', 'HKEY_CURRENT_USER')}]`, `@=${regString(MENU_TEXT)}`, '', `[${key.replace('HKCU', 'HKEY_CURRENT_USER')}\\command]`, `@=${regString(command)}`, '');
  }
  return lines.join('\r\n');
}

// ---- install, remove, status --------------------------------------------------------------------------------------------------------------

/** The part of the machine the steps touch. The real one is cli/src/menu-node.ts; a test uses a made-up machine. */
export interface MenuEffects {
  platform: string;
  /** The person's own folders: ~ on a Mac; the Send to folder on Windows. */
  home: string;
  sendToDir?: string;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Deletes a file or a folder with what is in it; nothing happens when it is not there. */
  removePath(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  regImport(text: string): Promise<void>;
  /** Deletes the key and everything below it; nothing happens when it is not there. */
  regDelete(key: string): Promise<void>;
  /** Deletes the key only when it holds nothing at all (no subkey, no value); nothing happens otherwise or when it is not there. */
  regPruneEmpty(key: string): Promise<void>;
  regExists(key: string): Promise<boolean>;
  shortcut(path: string, target: string, args: string): Promise<void>;
  /** Tells the system that the list of Services changed. May do nothing. */
  refreshServices(): Promise<void>;
}

export class MenuUnsupported extends Error {}

const macDir = (fx: MenuEffects): string => `${fx.home}/Library/Services/${MAC_WORKFLOW}`;
const sendToPath = (fx: MenuEffects): string => {
  if (!fx.sendToDir) throw new Error('no Send to folder');
  return fx.sendToDir.replace(/[\\/]+$/, '') + '\\' + WIN_SENDTO;
};

function kind(fx: MenuEffects): 'mac' | 'windows' {
  if (fx.platform === 'darwin') return 'mac';
  if (fx.platform === 'win32') return 'windows';
  throw new MenuUnsupported('The right-click menu is for a Mac or a Windows computer.');
}

/** Puts the entry in. Run again, it replaces what it put before. Returns what was written, in words. */
export async function installMenu(l: Launch, fx: MenuEffects): Promise<string[]> {
  if (kind(fx) === 'mac') {
    // the app run from a download or a disk image is not where it will stay (macOS runs it from a copy that goes away): the entry would point at nothing
    if (l.app && (l.script.includes('/AppTranslocation/') || l.script.startsWith('/Volumes/'))) throw new Error('Files Direct is running from a download or a disk image. Drag it into your Applications folder (or any folder of your own), open it from there, then add the menu entry.');
    const dir = macDir(fx);
    await fx.removePath(dir);
    await fx.writeFile(`${dir}/Contents/Info.plist`, macInfoPlist());
    await fx.writeFile(`${dir}/Contents/document.wflow`, macWorkflow(l));
    await fx.refreshServices();
    return [`Added the Finder Quick Action "${MENU_TEXT}" in ${dir}.`];
  }
  const text = windowsRegText(l); // refuses a program path Windows would change, before anything is written
  const args = windowsSendToArguments(l);
  await fx.regImport(text);
  await fx.shortcut(sendToPath(fx), l.launcher ?? l.node, args);
  return [`Added "${MENU_TEXT}" to the menu for files and for folders (in the registry, for you only).`, `Added "Files Direct" to Send to.`];
}

/** Takes out exactly what installMenu puts in, whether or not the program is still where it was. Returns what was removed. */
export async function removeMenu(fx: MenuEffects): Promise<string[]> {
  const gone: string[] = [];
  if (kind(fx) === 'mac') {
    const dir = macDir(fx);
    if (await fx.exists(dir)) gone.push(`Removed the Finder Quick Action "${MENU_TEXT}".`);
    await fx.removePath(dir);
    await fx.refreshServices();
    return gone;
  }
  for (const key of WIN_KEYS) {
    if (await fx.regExists(key)) {
      await fx.regDelete(key);
      gone.push(`Removed ${key}.`);
    }
  }
  for (const parent of WIN_PARENTS) await fx.regPruneEmpty(parent);
  const lnk = sendToPath(fx);
  if (await fx.exists(lnk)) {
    await fx.removePath(lnk);
    gone.push('Removed "Files Direct" from Send to.');
  }
  return gone;
}

/** What is in place, in words; `installed` when every part is there. */
export async function menuStatus(fx: MenuEffects): Promise<{ installed: boolean; lines: string[] }> {
  if (kind(fx) === 'mac') {
    const ok = (await fx.exists(`${macDir(fx)}/Contents/Info.plist`)) && (await fx.exists(`${macDir(fx)}/Contents/document.wflow`));
    return { installed: ok, lines: [ok ? `The Finder Quick Action "${MENU_TEXT}" is installed.` : 'The Finder Quick Action is not installed.'] };
  }
  const parts = [...(await Promise.all(WIN_KEYS.map((k) => fx.regExists(k)))), await fx.exists(sendToPath(fx))];
  const names = ['the menu for files', 'the menu for folders', 'Send to'];
  const lines = parts.map((p, i) => `${names[i]}: ${p ? 'installed' : 'not installed'}`);
  return { installed: parts.every(Boolean), lines };
}
