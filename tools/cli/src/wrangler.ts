/**
 * Runs wrangler, the Cloudflare CLI that this package depends on. Every
 * request to Cloudflare goes through it: its browser login, and the account,
 * D1 and Worker commands deploy.ts names.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/** The program that starts wrangler, and the arguments before wrangler's own, such as `node …/wrangler/bin/wrangler.js`. */
export interface WranglerCommand {
  readonly program: string;
  readonly args: readonly string[];
}

/**
 * The wrangler this package depends on, run with this Node.js. wrangler's
 * exports name only its package.json and its library, so its command is found
 * from the package.json's bin field.
 */
export function packagedWrangler(): WranglerCommand {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('wrangler/package.json');
  const { bin } = require(manifest) as { bin: { wrangler: string } };
  return { program: process.execPath, args: [path.join(path.dirname(manifest), bin.wrangler)] };
}

/** Where lines of text go: the terminal, or a test's lists. */
export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface Output {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class WranglerError extends Error {
  readonly output: Output;

  constructor(args: readonly string[], output: Output) {
    super(`\`wrangler ${args.join(' ')}\` stopped with exit code ${output.code}.`);
    this.output = output;
  }
}

export interface WranglerOptions {
  readonly command: WranglerCommand;
  /** The folder wrangler runs in: never the person's own, so a Wrangler configuration there is not read. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Where the output of a command run with `attach` goes. Left out, wrangler writes to the terminal itself and can ask the person questions there. */
  readonly terminal?: Io | undefined;
}

export class Wrangler {
  readonly #options: WranglerOptions;

  constructor(options: WranglerOptions) {
    this.#options = options;
  }

  /** The same wrangler with these environment variables set too. */
  withEnv(env: Readonly<Record<string, string>>): Wrangler {
    return new Wrangler({ ...this.#options, env: { ...this.#options.env, ...env } });
  }

  /**
   * Runs a command with its output captured and its input closed. Without a
   * terminal wrangler asks nothing: it takes each question's default answer,
   * which applies D1 migrations without a prompt.
   */
  capture(args: readonly string[]): Promise<Output> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#options.command.program, [...this.#options.command.args, ...args], {
        cwd: this.#options.cwd,
        env: this.#options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      );
    });
  }

  /** Runs a command that succeeds or stops the deploy, and answers its output. */
  async run(args: readonly string[]): Promise<Output> {
    const output = await this.capture(args);
    if (output.code !== 0) throw new WranglerError(args, output);
    return output;
  }

  /** Runs a command that prints JSON, and answers the value. */
  async json(args: readonly string[]): Promise<unknown> {
    return parseJson((await this.run(args)).stdout);
  }

  /** Runs a command in the person's terminal, where wrangler shows its progress and may ask a question, as login and deploy do. Answers the exit code. */
  attach(args: readonly string[]): Promise<number> {
    const terminal = this.#options.terminal;
    return new Promise((resolve, reject) => {
      const child = spawn(this.#options.command.program, [...this.#options.command.args, ...args], {
        cwd: this.#options.cwd,
        env: this.#options.env,
        stdio: terminal ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      });
      if (terminal) {
        child.stdout?.on('data', (chunk: Buffer) => terminal.out(chunk.toString('utf8').trimEnd()));
        child.stderr?.on('data', (chunk: Buffer) => terminal.err(chunk.toString('utf8').trimEnd()));
      }
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
  }
}

/** Wrangler prints a command's JSON on its own; a warning it writes first on the same stream is skipped. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/^[[{]/mu);
    if (start < 0) throw new Error(`Wrangler printed no JSON:\n${trimmed}`);
    return JSON.parse(trimmed.slice(start));
  }
}
