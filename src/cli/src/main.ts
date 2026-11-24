import { realpathSync } from 'node:fs';
import ndc from 'node-datachannel';
import { runCli } from './cli.ts';
import { runMcp } from './mcp.ts';

const argv = process.argv.slice(2);
const code =
  argv[0] === 'mcp'
    ? await runMcp(argv.slice(1), process.env)
    : await runCli(argv, {
        out: (t) => process.stdout.write(t.endsWith('\r') ? t : t + '\n'),
        err: (t) => process.stderr.write(t + '\n'),
        tty: Boolean(process.stdout.isTTY),
        env: process.env,
        program: { node: process.execPath, script: realpathSync(process.argv[1]!) },
        onInterrupt(handler) {
          let n = 0;
          const on = () => (++n === 1 ? handler() : process.exit(7));
          process.on('SIGINT', on);
          process.on('SIGTERM', on);
          return () => {
            process.off('SIGINT', on);
            process.off('SIGTERM', on);
          };
        },
      });
ndc.cleanup();
process.exit(code);
