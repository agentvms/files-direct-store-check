// The plugin folder's file rules, in one place: used by the export's test and, copied into the public repository, by its check workflow.
// Claude's directory reads a plugin folder, so it holds few, small, readable files: no binary, no link, no leftover of a Mac, no submodule.
// A picture (the icon) is the one kind of non-text file a plugin may carry, and it must be what its name says.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const PLUGIN_LIMITS = { maxFiles: 512, maxBytes: 256 * 1024, maxLine: 700 };
const IMAGE = /\.(png|svg|jpg|jpeg|gif|webp|ico)$/i;
const MAGIC = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46], webp: [0x52, 0x49, 0x46, 0x46], ico: [0, 0, 1, 0] };

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Every way the folder breaks the rules, one plain sentence each. Empty means it passes. */
export function pluginProblems(dir) {
  const problems = [];
  const files = listFiles(dir);
  if (files.length > PLUGIN_LIMITS.maxFiles) problems.push(`${files.length} files, at most ${PLUGIN_LIMITS.maxFiles} are allowed`);
  for (const f of files) {
    const name = relative(dir, f);
    const st = lstatSync(f);
    if (st.isSymbolicLink()) problems.push(`${name}: a link`);
    if (/\.DS_Store|\.gitmodules|\.mcpb$|(^|\/)node_modules(\/|$)/.test(name)) problems.push(`${name}: a file that does not belong in a plugin`);
    if (st.size >= PLUGIN_LIMITS.maxBytes) problems.push(`${name}: ${st.size} bytes, at most ${PLUGIN_LIMITS.maxBytes - 1} are allowed`);
    const bytes = readFileSync(f);
    const ext = name.split('.').pop().toLowerCase();
    if (IMAGE.test(name) && ext !== 'svg') {
      const magic = MAGIC[ext];
      if (!magic || !magic.every((b, i) => bytes[i] === b)) problems.push(`${name}: not the kind of picture its name says`);
      continue;
    }
    if (bytes.includes(0)) {
      problems.push(`${name}: a binary file`);
      continue;
    }
    // readable source: no minified or packed line
    const long = bytes.toString('utf8').split('\n').findIndex((l) => l.length >= PLUGIN_LIMITS.maxLine);
    if (long >= 0) problems.push(`${name}:${long + 1}: a very long line (packed or minified?)`);
  }
  return problems;
}
