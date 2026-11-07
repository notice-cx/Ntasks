/**
 * Captures the screenshots of the web app in docs/images/: the README's
 * pictures and the design gallery. It serves the app with its invented tasks
 * (Vite's fixture mode, no API), draws each page in a headless Chrome or
 * Chromium in light and in dark, and writes them as WebP.
 *
 * Run it from the repository root with `pnpm screenshots`, or name the shots
 * to take: `pnpm screenshots design`. It needs Chrome or Chromium on this
 * machine; set CHROME_PATH to one that is not in a usual place. It drives the
 * browser over the Chrome DevTools Protocol with Node's own WebSocket, so it
 * adds no dependency, and CI never runs it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevTools, until } from './devtools.ts';

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
  /** Image pixels per page pixel. The README shows a desktop shot 800 pixels wide and the phone shot 320, so 1.5
   * and 2 keep their text sharp on a high-density screen without making the files larger than that needs. */
  scale: number;
  /** An element that is on the page once it has drawn what the shot shows. */
  ready: string;
  /** Capture the whole page, however tall, instead of `height` pixels of it. */
  fullPage?: boolean;
}

const SHOTS: readonly Shot[] = [
  // Tall enough to reach past the decisions into the first rows of the task list.
  { name: 'board', address: '/tasks', width: 1280, height: 1520, scale: 1.5, ready: '[data-task-row]' },
  {
    name: 'task',
    address: '/tasks/web-b2r6',
    width: 1280,
    height: 1040,
    scale: 1.5,
    ready: '[data-markdown] pre .hljs-keyword',
  },
  { name: 'phone', address: '/tasks', width: 390, height: 844, scale: 2, ready: '[data-page-answer]' },
  // docs/design.md shows it 800 pixels wide, as the README shows the desktop shots.
  {
    name: 'design',
    address: '/design',
    width: 1440,
    height: 900,
    scale: 1.5,
    ready: '[data-palette="dark"] [data-swatch]',
    fullPage: true,
  },
];
const THEMES = ['light', 'dark'] as const;
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

/** Stops a child process and resolves once it has exited, so nothing still writes to its files. */
function stop(child: ChildProcess): Promise<void> {
  // A process that never started (no pid) or has ended has nothing to wait for.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  return exited;
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
  // Vite exiting before it serves, as it does when the port is taken, ends the wait at once.
  const exited = new Promise<never>((_, reject) => {
    app.once('error', reject);
    app.once('exit', (code) => reject(new Error(`Vite exited with ${code} before it served the app.`)));
  });
  // A later exit is the one stop() causes.
  exited.catch(() => undefined);
  try {
    // Until Vite listens, a request is refused: that is "not yet", not a failure.
    await Promise.race([
      until('the web app', async (signal) => (await fetch(ORIGIN, { signal })).ok, {
        waitMs: WAIT_MS,
        retryFailures: true,
      }),
      exited,
    ]);
  } catch (error) {
    await stop(app);
    throw error;
  }
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let said = '';
      timer = setTimeout(
        () => reject(new Error(`Chrome gave no DevTools address within ${WAIT_MS} ms:\n${said}`)),
        WAIT_MS,
      );
      // A CHROME_PATH that names no program, or one that cannot run, fails here with the system's own error.
      chrome.once('error', reject);
      chrome.stderr?.on('data', (chunk: Buffer) => {
        said += chunk.toString();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(said);
        if (match?.[1]) resolve(match[1]);
      });
      chrome.once('exit', (code) => reject(new Error(`Chrome exited with ${code}:\n${said}`)));
    });
    return { chrome, endpoint };
  } catch (error) {
    // Chrome may still be running, as when a policy turns off remote debugging.
    await stop(chrome);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function capture(devtools: DevTools, session: string, shot: Shot, theme: (typeof THEMES)[number]) {
  const send = <T>(method: string, params: object = {}, signal?: AbortSignal) =>
    devtools.send<T>(method, params, { sessionId: session, ...(signal ? { signal } : {}) });
  await send('Emulation.setDeviceMetricsOverride', {
    width: shot.width,
    height: shot.height,
    deviceScaleFactor: shot.scale,
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
  // A failed request, as when Chrome exits, ends the wait at once.
  await until(
    `${shot.address} to draw`,
    async (signal) => {
      const answer = await send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        { expression: drawn, returnByValue: true },
        signal,
      );
      return answer.result.value === true;
    },
    { waitMs: WAIT_MS },
  );
  if (shot.fullPage) {
    const tall = await send<{ result: { value: number } }>('Runtime.evaluate', {
      expression: 'document.documentElement.scrollHeight',
      returnByValue: true,
    });
    await send('Emulation.setDeviceMetricsOverride', {
      width: shot.width,
      height: tall.result.value,
      deviceScaleFactor: shot.scale,
      mobile: false,
    });
    // One frame at the new size before the picture.
    await send('Runtime.evaluate', {
      expression: 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))',
      awaitPromise: true,
    });
  }
  const { data } = await send<{ data: string }>('Page.captureScreenshot', { format: 'webp', quality: QUALITY });
  const file = path.join(OUT, `${shot.name}-${theme}.webp`);
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}

/** The shots named on the command line, or every shot when none is named. */
function chosenShots(names: readonly string[]): readonly Shot[] {
  if (names.length === 0) return SHOTS;
  const unknown = names.filter((name) => !SHOTS.some((shot) => shot.name === name));
  if (unknown.length > 0) {
    throw new Error(`No shot named ${unknown.join(', ')}. The shots are ${SHOTS.map((shot) => shot.name).join(', ')}.`);
  }
  return SHOTS.filter((shot) => names.includes(shot.name));
}

async function main() {
  const shots = chosenShots(process.argv.slice(2));
  await mkdir(OUT, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'ntasks-screenshots-'));
  const running: ChildProcess[] = [];
  try {
    running.push(await startApp());
    const { chrome, endpoint } = await startChrome(profile);
    running.push(chrome);
    const devtools = await DevTools.connect(endpoint, { answerMs: WAIT_MS });
    const { targetId } = await devtools.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await devtools.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await devtools.send('Page.enable', {}, { sessionId });
    for (const shot of shots) {
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
