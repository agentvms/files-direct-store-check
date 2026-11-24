// npm run build: the program as one readable file (no minifying) in dist/, with the packages that carry native or large code left out of it.
// The version comes from package.json and the site's address from site.json, never from the source.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const origin = process.env.FD_BUILD_ORIGIN ?? JSON.parse(readFileSync('site.json', 'utf8')).origin;

await build({
  entryPoints: ['src/cli/src/main.ts'],
  outfile: 'dist/files-direct.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  external: ['node-datachannel', 'node-datachannel/polyfill', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'zod'],
  banner: { js: '#!/usr/bin/env node' },
  define: { __FD_VERSION__: JSON.stringify(pkg.version), __FD_ORIGIN__: JSON.stringify(origin) },
  logLevel: 'info',
});
