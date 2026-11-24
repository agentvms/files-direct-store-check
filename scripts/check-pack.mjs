// npm run check:pack: lists what `npm pack` would put in the package and fails on anything but the built program, the README, the licence and package.json.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(1);
}
const [pack] = JSON.parse(run.stdout);
const names = pack.files.map((f) => f.path).sort();
for (const f of pack.files) console.log(`${String(f.size).padStart(8)}  ${f.path}`);
console.log(`${pack.filename}: ${pack.files.length} files, ${pack.size} bytes packed`);
const want = ['LICENSE', 'README.md', 'dist/files-direct.mjs', 'package.json'];
const problems = [];
if (JSON.stringify(names) !== JSON.stringify(want)) problems.push(`the package holds ${names.join(', ')}; it should hold exactly ${want.join(', ')}`);
const program = readFileSync('dist/files-direct.mjs', 'utf8');
if (!program.startsWith('#!/usr/bin/env node')) problems.push('dist/files-direct.mjs does not start with the node line');
if (program.split('\n').some((l) => l.length > 1000)) problems.push('dist/files-direct.mjs has a packed line');
for (const p of problems) console.error('pack: ' + p);
if (problems.length) process.exit(1);
