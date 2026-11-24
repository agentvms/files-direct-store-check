// The signed list of updates for the double-click app (files-direct-34).
//   node scripts/app-feed.mjs keygen                       prints a new Ed25519 key pair: {"secret": ..., "public": ...} (each the raw 32 bytes, base64). Keep the secret; the public half goes in shared/config.ts.
//   node scripts/app-feed.mjs sign <folder> <version>      reads the app's files from <folder> by their fixed names, writes feed.json and feed.json.sig there.
//                                                          The secret key is read from the environment variable FD_UPDATE_SIGNING_KEY (the raw 32 bytes, base64) and is never printed.
// The program (cli/src/update.ts) checks the signature with the public half, then the size and SHA-256 of each file against this list.
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PKCS8_PREFIX = '302e020100300506032b657004220420';
export const TARGETS = ['mac-arm64', 'mac-x64', 'win-x64'];

/** The names of the files of one version, by what they are for. "update" is what the program fetches by itself; "download" is what a person gets from the site first. */
export const fileNames = (version) => ({
  update: { 'mac-arm64': 'files-direct-' + version + '-mac-arm64.tar.xz', 'mac-x64': 'files-direct-' + version + '-mac-x64.tar.xz', 'win-x64': 'files-direct-setup-' + version + '-win-x64.exe' },
  download: { 'mac-arm64': 'files-direct-' + version + '-mac-arm64.dmg', 'mac-x64': 'files-direct-' + version + '-mac-x64.dmg', 'win-x64': 'files-direct-setup-' + version + '-win-x64.exe' },
});

export function keygen() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16).toString('base64');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  return { secret, public: pub };
}

export function privateKeyFrom(secret) {
  const seed = Buffer.from(String(secret ?? '').trim(), 'base64');
  if (seed.length !== 32) throw new Error('the update signing key must be the raw 32 bytes of an Ed25519 key, in base64');
  return createPrivateKey({ key: Buffer.concat([Buffer.from(PKCS8_PREFIX, 'hex'), seed]), format: 'der', type: 'pkcs8' });
}

export const entry = (name, bytes) => ({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

/** The list as text: same input, same bytes. files: what the program fetches; downloads: what the site offers (the page reads their sizes). */
export function makeFeed(version, files, downloads = {}) {
  const order = (m) => Object.fromEntries(TARGETS.filter((t) => m[t]).map((t) => [t, m[t]]));
  return JSON.stringify({ version, files: order(files), downloads: order(downloads) }, null, 2) + '\n';
}

/** The signature of the list's exact bytes, base64. */
export const signFeed = (text, secret) => sign(null, Buffer.from(text), privateKeyFrom(secret)).toString('base64');

export function signFolder(dir, version, secret) {
  const names = fileNames(version);
  const files = {};
  const downloads = {};
  for (const t of TARGETS) {
    files[t] = entry(names.update[t], readFileSync(join(dir, names.update[t])));
    downloads[t] = names.download[t] === names.update[t] ? files[t] : entry(names.download[t], readFileSync(join(dir, names.download[t])));
  }
  const text = makeFeed(version, files, downloads);
  writeFileSync(join(dir, 'feed.json'), text);
  writeFileSync(join(dir, 'feed.json.sig'), signFeed(text, secret) + '\n');
  return text;
}

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL('file://' + (process.platform === 'win32' ? '/' : '') + process.argv[1].replace(/\\/g, '/')).href) {
  const [cmd, dir, version] = process.argv.slice(2);
  try {
    if (cmd === 'keygen') console.log(JSON.stringify(keygen()));
    else if (cmd === 'sign' && dir && version) {
      if (!process.env.FD_UPDATE_SIGNING_KEY) throw new Error('The update signing key is not set (FD_UPDATE_SIGNING_KEY), so the desktop files are not published. Nothing else is held up by this.');
      signFolder(dir, version, process.env.FD_UPDATE_SIGNING_KEY);
      console.log('signed the list of updates for ' + version);
    } else throw new Error('usage: node scripts/app-feed.mjs keygen | sign <folder> <version>');
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
