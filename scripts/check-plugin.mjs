// npm run check:plugin: the plugin folder's file rules (few, small, readable files; no binary, no link), and its version is the package's.
import { readFileSync } from 'node:fs';
import { pluginProblems } from './plugin-rules.mjs';

const problems = pluginProblems('plugin');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('plugin/.claude-plugin/plugin.json', 'utf8'));
if (manifest.version !== pkg.version) problems.push(`plugin.json is version ${manifest.version}, the package is ${pkg.version}`);
const pinned = JSON.stringify(manifest.mcpServers ?? {}).includes(`${pkg.name}@${pkg.version}`);
if (!pinned) problems.push(`the plugin does not run ${pkg.name}@${pkg.version} (the pinned version of this package)`);
if (problems.length) {
  for (const p of problems) console.error('plugin: ' + p);
  process.exit(1);
}
console.log('plugin folder: file rules pass');
