/** Reading a command's options: an unknown or malformed option exits 2, as wrong arguments do. */
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export function optionsOf<T extends ParseArgsOptionsConfig>(options: T, usage: string) {
  // pnpm passes the `--` before a script's own options through.
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  try {
    return parseArgs({ args, options }).values;
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    process.exit(2);
  }
}
