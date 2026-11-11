#!/usr/bin/env node
// The ntasks command as npm installs it. The release sits in the package's
// folder, one level above this file's.
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { main } from './cli.ts';
import { packagedWrangler } from './wrangler.ts';

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

process.exitCode = await main(process.argv.slice(2), {
  packageDir: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  wrangler: packagedWrangler(),
  env: process.env,
  io: {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  ask: process.stdin.isTTY && process.stdout.isTTY ? ask : undefined,
});
