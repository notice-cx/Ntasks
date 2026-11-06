/**
 * Captures the README's screenshots of the web app. It serves the app with its
 * invented tasks (Vite's fixture mode, no API), draws each page in a headless
 * Chrome or Chromium in light and in dark, and writes them to docs/images/ as
 * WebP.
 *
 * Run it from the repository root with `pnpm screenshots`. It needs Chrome or
 * Chromium on this machine; set CHROME_PATH to one that is not in a usual
 * place. It drives the browser over the Chrome DevTools Protocol with Node's
 * own WebSocket, so it adds no dependency, and CI never runs it.
 *
 * The pictures use the fonts this machine has: Inter when it is installed,
 * otherwise the system's sans-serif.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WEB = path.join(ROOT, 'apps/web');
const OUT = path.join(ROOT, 'docs/images');
const PORT = 5197;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WAIT_MS = 30_000;

interface Shot {
  /** The file name, before `-light.webp` or `-dark.webp`. */
  name: string;
  /** The page's address in the app. */
  address: string;
  width: number;
  height: number;
  /** An element that is on the page once it has drawn what the shot shows. */
  ready: string;
}

const SHOTS: readonly Shot[] = [
  { name: 'board', address: '/tasks', width: 1280, height: 860, ready: '[data-page-answer]' },
  { name: 'task', address: '/tasks/web-b2r6', width: 1280, height: 1040, ready: '[data-markdown] pre .hljs-keyword' },
  { name: 'phone', address: '/tasks', width: 390, height: 844, ready: '[data-page-answer]' },
];
const THEMES = ['light', 'dark'] as const;
/** Twice the page's pixels, so text stays sharp on a high-density screen. */
const SCALE = 2;
/** WebP quality: small files with no visible loss in flat interface colours. */
const QUALITY = 82;

/** A Chrome or Chromium on this machine. */
function findChrome(): string {
  const named = process.env.CHROME_PATH;
  if (named) return named;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].flatMap((command) =>
      (process.env.PATH ?? '').split(path.delimiter).map((folder) => path.join(folder, command)),
    ),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('No Chrome or Chromium found. Set CHROME_PATH to one.');
  return found;
}

/** Resolves once `predicate` holds, checking every 100 ms; rejects after `WAIT_MS` with `what` in its message. */
async function until(what: string, predicate: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + WAIT_MS;
  while (!(await predicate().catch(() => false))) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The web app with its invented tasks, served by Vite. */
async function startApp(): Promise<ChildProcess> {
  const require = createRequire(path.join(WEB, 'package.json'));
  const vitePackage = require.resolve('vite/package.json');
  const viteBin = (JSON.parse(await readFile(vitePackage, 'utf8')) as { bin: { vite: string } }).bin.vite;
  const app = spawn(
    process.execPath,
    [
      path.join(path.dirname(vitePackage), viteBin),
      '--mode',
      'fixture',
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--strictPort',
    ],
    { cwd: WEB, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  await until('the web app', async () => (await fetch(ORIGIN)).ok);
  return app;
}

/** A headless browser, and the address of its DevTools Protocol endpoint. */
async function startChrome(profile: string): Promise<{ chrome: ChildProcess; endpoint: string }> {
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const endpoint = await new Promise<string>((resolve, reject) => {
    let said = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${said}`)), WAIT_MS);
    chrome.stderr?.on('data', (chunk: Buffer) => {
      said += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(said);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on('exit', (code) => reject(new Error(`Chrome exited with ${code}:\n${said}`)));
  });
  return { chrome, endpoint };
}

/** A minimal DevTools Protocol client: one request, one answer, matched by id. */
class DevTools {
  readonly #socket: WebSocket;
  #next = 1;
  readonly #waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiting = this.#waiting.get(message.id);
      this.#waiting.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
    });
  }

  static async connect(endpoint: string): Promise<DevTools> {
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not reach Chrome.')), { once: true });
    });
    return new DevTools(socket);
  }

  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => {
      this.#waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }

  close(): void {
    this.#socket.close();
  }
}

async function capture(devtools: DevTools, session: string, shot: Shot, theme: (typeof THEMES)[number]) {
  const send = <T>(method: string, params: object = {}) => devtools.send<T>(method, params, session);
  await send('Emulation.setDeviceMetricsOverride', {
    width: shot.width,
    height: shot.height,
    deviceScaleFactor: SCALE,
    mobile: shot.width < 768,
  });
  // The app follows the system's theme; reduced motion skips its arrival animations.
  await send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  await send('Page.navigate', { url: `${ORIGIN}${shot.address}` });
  const drawn = `document.querySelector(${JSON.stringify(shot.ready)}) !== null && document.querySelector('.skeleton') === null && document.fonts.status === 'loaded'`;
  await until(`${shot.address} to draw`, async () => {
    const answer = await send<{ result: { value: unknown } }>('Runtime.evaluate', {
      expression: drawn,
      returnByValue: true,
    });
    return answer.result.value === true;
  });
  const { data } = await send<{ data: string }>('Page.captureScreenshot', { format: 'webp', quality: QUALITY });
  const file = path.join(OUT, `${shot.name}-${theme}.webp`);
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}

/** Stops a child process and resolves once it has exited, so nothing still writes to its files. */
function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  return exited;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'ntasks-screenshots-'));
  const running: ChildProcess[] = [];
  try {
    running.push(await startApp());
    const { chrome, endpoint } = await startChrome(profile);
    running.push(chrome);
    const devtools = await DevTools.connect(endpoint);
    const { targetId } = await devtools.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await devtools.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await devtools.send('Page.enable', {}, sessionId);
    for (const shot of SHOTS) {
      for (const theme of THEMES) {
        const file = await capture(devtools, sessionId, shot, theme);
        console.log(path.relative(ROOT, file));
      }
    }
    devtools.close();
  } finally {
    await Promise.all(running.map(stop));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

await main();
