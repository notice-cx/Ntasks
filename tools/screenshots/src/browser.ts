/**
 * What the screenshots and the walkthroughs both start: the web app with its
 * invented tasks, served by Vite in fixture mode, and a headless Chrome or
 * Chromium driven over the Chrome DevTools Protocol, plus the Worker's own
 * pages, which they draw in place of the app's document.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DevTools, until, type PageSend } from './devtools.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const OUT = path.join(ROOT, 'docs/images');
const WEB = path.join(ROOT, 'apps/web');
const PORT = 5197;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const WAIT_MS = 30_000;

/** The two themes every picture is drawn in. */
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** The Worker's own pages (workers/api/src/access/pages.ts), as far as these scripts call them. */
export interface WorkerPages {
  signInPage(input: { signedInAs: string | null; oauthQuery: string | null; error: string | null }): Response;
  setupPage(input: { error: string | null }): Response;
  agentAccessPage(input: {
    personName: string;
    client: { name: string; uri: string | null };
    returnsTo: string;
    access: 'read' | 'write' | null;
    workspaces: readonly { id: string; name: string; projects: readonly { id: string; key: string; name: string }[] }[];
    oauthQuery: string;
    error: string | null;
  }): Response;
}

/**
 * The Worker's page module, loaded by its address so that this script's
 * typecheck does not reach into the Worker's source. The module imports no
 * Worker runtime, so Node runs it as it is.
 */
export async function workerPages(): Promise<WorkerPages> {
  return (await import(pathToFileURL(path.join(ROOT, 'workers/api/src/access/pages.ts')).href)) as WorkerPages;
}

/**
 * Draws one of the Worker's pages in place of the page's document, which
 * stays at the app's address, so the fonts the Worker's page loads from its
 * origin come from the app's server as they come from the Worker's static
 * files. Resolves once its text is in Inter.
 */
export async function drawWorkerPage(send: PageSend, response: Response): Promise<void> {
  const html = await response.text();
  const { frameTree } = await send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
  await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
  // The new document starts loading its fonts only once it lays out its text.
  await send('Runtime.evaluate', {
    expression: 'document.fonts.load(\'600 20px "Inter Variable"\')',
    awaitPromise: true,
  });
}

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

/** One browser tab: the client and the session its requests go to. */
export interface Tab {
  devtools: DevTools;
  sessionId: string;
  /** A request to this tab. */
  send: PageSend;
}

/** Opens a new tab with its Page domain enabled. */
export async function openTab(devtools: DevTools): Promise<Tab> {
  const { targetId } = await devtools.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await devtools.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const send: PageSend = (method, params = {}, signal) =>
    devtools.send(method, params, { sessionId, ...(signal ? { signal } : {}) });
  await send('Page.enable');
  return { devtools, sessionId, send };
}

/**
 * Serves the app, starts Chrome, runs `work` with one tab open, and stops
 * both and removes Chrome's profile however `work` ends.
 */
export async function withBrowser<T>(work: (tab: Tab) => Promise<T>): Promise<T> {
  const profile = await mkdtemp(path.join(tmpdir(), 'ntasks-screenshots-'));
  const running: ChildProcess[] = [];
  try {
    running.push(await startApp());
    const { chrome, endpoint } = await startChrome(profile);
    running.push(chrome);
    const devtools = await DevTools.connect(endpoint, { answerMs: WAIT_MS });
    try {
      return await work(await openTab(devtools));
    } finally {
      devtools.close();
    }
  } finally {
    await Promise.all(running.map(stop));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
