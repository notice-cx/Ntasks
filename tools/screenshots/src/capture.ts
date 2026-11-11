/**
 * Captures the screenshots of the web app in docs/images/: the pictures in
 * the README and docs/web-app.md, and the design gallery. It serves the app with its invented tasks
 * (Vite's fixture mode, no API), draws each page in a headless Chrome or
 * Chromium in light and in dark, and writes them as WebP.
 *
 * Run it from the repository root with `pnpm screenshots`, or name the shots
 * to take: `pnpm screenshots design`. `pnpm screenshots walkthroughs` records
 * the animated walkthroughs instead (walkthroughs.ts). It needs Chrome or
 * Chromium on this machine; set CHROME_PATH to one that is not in a usual
 * place. It drives the browser over the Chrome DevTools Protocol with Node's
 * own WebSocket, so it adds no dependency, and CI never runs it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  drawWorkerPage,
  ORIGIN,
  OUT,
  ROOT,
  THEMES,
  WAIT_MS,
  withBrowser,
  workerPages,
  type Tab,
  type Theme,
  type WorkerPages,
} from './browser.ts';
import { navigate, until, type PageSend } from './devtools.ts';

interface Shot {
  /** The file name, before `-light.webp` or `-dark.webp`. */
  name: string;
  /** The page's address in the app. */
  address: string;
  width: number;
  height: number;
  /** Image pixels per page pixel. The docs show a desktop shot 800 pixels wide and the phone shot 320, so 1.5
   * and 2 keep their text sharp on a high-density screen without making the files larger than that needs. */
  scale: number;
  /** An element that is on the page once it has drawn what the shot shows. */
  ready: string;
  /** Capture the whole page, however tall, instead of `height` pixels of it. */
  fullPage?: boolean;
  /**
   * Draw the picture inside a rounded, bordered frame with a transparent
   * margin, so its edges show on a page of the same colour as the app.
   */
  framed?: boolean;
  /**
   * A page the Worker writes, drawn in place of the app's document at
   * `address`, so the fonts it loads from its origin come from the app's
   * server as they come from the Worker's static files.
   */
  workerPage?: (pages: WorkerPages) => Response;
}

// The desktop shots are 1100 pixels wide, so the README's 800-pixel pictures keep their text readable.
const SHOTS: readonly Shot[] = [
  // The README's one picture: the top of the board, Waiting for you to the end of Open.
  { name: 'hero', address: '/tasks', width: 1100, height: 590, scale: 1.5, ready: '[data-task-row]', framed: true },
  // Tall enough to show every group, Waiting for you to Done.
  { name: 'board', address: '/tasks', width: 1100, height: 960, scale: 1.5, ready: '[data-task-row]' },
  {
    name: 'task',
    address: '/tasks/web-b2r6',
    width: 1100,
    height: 1120,
    scale: 1.5,
    ready: '[data-markdown] pre .hljs-keyword',
  },
  // A decision with options, so the card shows its keys, Note, Not now and Answer.
  {
    name: 'focus',
    address: '/tasks/focus?task=web-d4x1',
    width: 1100,
    height: 760,
    scale: 1.5,
    ready: '[data-focus-decision] [role="radio"]',
  },
  // The board: the example data's tasks in progress, then one each built, merged and live.
  { name: 'live', address: '/tasks/live', width: 1100, height: 520, scale: 1.5, ready: '[data-board-card]' },
  { name: 'phone', address: '/tasks', width: 390, height: 844, scale: 2, ready: '[data-task-row]' },
  {
    name: 'sign-in',
    address: '/',
    width: 560,
    height: 440,
    scale: 1.5,
    ready: 'main h1',
    workerPage: (pages) => pages.signInPage({ signedInAs: null, oauthQuery: null, error: null }),
  },
  {
    name: 'agent-access',
    address: '/',
    width: 560,
    height: 700,
    scale: 1.5,
    ready: 'main h1',
    workerPage: (pages) =>
      pages.agentAccessPage({
        personName: 'Example Owner',
        client: { name: 'Example Agent', uri: 'https://agent.example.com' },
        returnsTo: 'https://agent.example.com',
        access: 'write',
        workspaces: [
          {
            id: '0f6c2a52-6d1e-4c39-9a57-2f1b8e4d7a10',
            name: 'Example',
            projects: [
              { id: 'p-web', key: 'web', name: 'Example web app' },
              { id: 'p-docs', key: 'docs', name: 'Example docs' },
            ],
          },
        ],
        oauthQuery: 'client_id=example',
        error: null,
      }),
  },
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
/** WebP quality: small files with no visible loss in flat interface colours. */
const QUALITY = 82;

/** A framed shot's margin and corner radius, in page pixels; the margin leaves room for the shadow. */
const FRAME = { margin: 32, radius: 12 } as const;
const FRAME_STYLE: Record<Theme, string> = {
  light: 'border: 1px solid rgb(0 0 0 / 0.12); box-shadow: 0 6px 20px rgb(0 0 0 / 0.12);',
  dark: 'border: 1px solid rgb(255 255 255 / 0.16); box-shadow: 0 6px 20px rgb(0 0 0 / 0.5);',
};

/** Draws `png`, a shot's picture, in its frame on a transparent page, and returns that picture as WebP. */
async function frame(send: PageSend, shot: Shot, theme: Theme, png: string): Promise<string> {
  await send('Emulation.setDeviceMetricsOverride', {
    width: shot.width + 2 * (FRAME.margin + 1),
    height: shot.height + 2 * (FRAME.margin + 1),
    deviceScaleFactor: shot.scale,
    mobile: false,
  });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  try {
    const style = `html, body { margin: 0; background: transparent; } img { display: block; margin: ${FRAME.margin}px; width: ${shot.width}px; height: ${shot.height}px; border-radius: ${FRAME.radius}px; ${FRAME_STYLE[theme]} }`;
    const html = `<!doctype html><style>${style}</style><img alt="" src="data:image/png;base64,${png}">`;
    const { frameTree } = await send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await send('Runtime.evaluate', { expression: 'document.images[0].decode()', awaitPromise: true });
    const { data } = await send<{ data: string }>('Page.captureScreenshot', { format: 'webp', quality: QUALITY });
    return data;
  } finally {
    // With no colour, the override ends and the next shot draws on the page's own background.
    await send('Emulation.setDefaultBackgroundColorOverride', {});
  }
}

async function capture({ send }: Tab, shot: Shot, theme: Theme) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: shot.width,
    height: shot.height,
    deviceScaleFactor: shot.scale,
    mobile: shot.width < 480,
  });
  // The app follows the system's theme; reduced motion skips its arrival animations.
  await send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  // The readiness check below must read the new document, not the one the previous shot left.
  await navigate(send, `${ORIGIN}${shot.address}`, { waitMs: WAIT_MS });
  if (shot.workerPage) await drawWorkerPage(send, shot.workerPage(await workerPages()));
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
  // A framed shot is captured without loss, so it is compressed once, in its frame.
  const { data: page } = await send<{ data: string }>(
    'Page.captureScreenshot',
    shot.framed ? { format: 'png' } : { format: 'webp', quality: QUALITY },
  );
  const data = shot.framed ? await frame(send, shot, theme, page) : page;
  const file = path.join(OUT, `${shot.name}-${theme}.webp`);
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}

/** The shots named on the command line, or every shot when none is named. */
function chosenShots(names: readonly string[]): readonly Shot[] {
  if (names.length === 0) return SHOTS;
  const unknown = names.filter((name) => !SHOTS.some((shot) => shot.name === name));
  if (unknown.length > 0) {
    throw new Error(
      `No shot named ${unknown.join(', ')}. The shots are ${SHOTS.map((shot) => shot.name).join(', ')}, and walkthroughs records the animations.`,
    );
  }
  return SHOTS.filter((shot) => names.includes(shot.name));
}

async function main(names: readonly string[]) {
  // `walkthroughs` first records the animated walkthroughs instead, all of them or the ones named after it.
  if (names[0] === 'walkthroughs') {
    const { recordWalkthroughs } = await import('./walkthroughs.ts');
    await recordWalkthroughs(names.slice(1));
    return;
  }
  // `fit` checks that every page fits a phone's screen instead, and draws nothing (fit.ts).
  if (names[0] === 'fit') {
    const { checkFit } = await import('./fit.ts');
    if (!(await checkFit())) process.exitCode = 1;
    return;
  }
  const shots = chosenShots(names);
  await mkdir(OUT, { recursive: true });
  await withBrowser(async (tab) => {
    for (const shot of shots) {
      for (const theme of THEMES) {
        const file = await capture(tab, shot, theme);
        console.log(path.relative(ROOT, file));
      }
    }
  });
}

await main(process.argv.slice(2));
