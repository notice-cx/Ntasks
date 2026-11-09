/**
 * The animated walkthroughs in docs/images/: each shows one feature of the
 * web app, or the Worker's setup page, with a cursor that does what a person
 * would, recorded in light and in dark from the app's invented tasks.
 * `pnpm screenshots walkthroughs` records them all; names after it record
 * only those.
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
} from './browser.ts';
import { navigate } from './devtools.ts';
import { Recorder, type Point } from './recorder.ts';

/** The page's size: wide enough for the task page's facts beside its text, the frame's shape. */
const VIEWPORT = { width: 1120, height: 630 };
/** Every frame's size. The closest zoom draws 2 of its pixels for each CSS pixel, so text stays sharp. */
const FRAME = { width: 960, height: 540 };
const FPS = 15;
/** How long the last frame stays before the walkthrough starts again. */
const END_MS = 1500;
/**
 * WebP quality of a frame the camera holds still and of one it moves
 * through. A moving frame is on screen for 1/15 of a second, so it can lose
 * more detail; together they keep each file under 1.5 MB.
 */
const QUALITY = { still: 0.8, moving: 0.5 };

/** Waits until `selector` is on the page, nothing is still loading and the fonts are in. */
function drawn(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)}) !== null && document.querySelector('.skeleton') === null && document.fonts.status === 'loaded'`;
}

/** Moves the app to another of its addresses without loading the page again, so what the page holds stays. */
function goWithin(address: string): string {
  return `history.pushState(null, '', ${JSON.stringify(address)}); dispatchEvent(new PopStateEvent('popstate'));`;
}

interface Walkthrough {
  /** The file name, before `-light.webp` or `-dark.webp`. */
  name: string;
  /** The app's address it starts on. */
  address: string;
  /** The page's size in CSS pixels, the frame's shape; VIEWPORT unless given. */
  viewport?: { width: number; height: number };
  /** Sets the page up before the recording starts: what it does is in no frame. */
  prepare?: (tab: Tab, recorder: Recorder) => Promise<void>;
  /** An element on the page once it shows what the walkthrough starts on. */
  ready: string;
  /** Where the cursor starts. */
  cursor: Point;
  record: (recorder: Recorder, tab: Tab) => Promise<void>;
}

const WALKTHROUGHS: readonly Walkthrough[] = [
  {
    // A decision on the docs board, answered by one press, which releases the task that waited on it.
    name: 'decide',
    address: '/tasks?project=docs',
    // Narrow enough that a row, from its id to its Claim, fills a zoomed frame.
    viewport: { width: 1008, height: 567 },
    ready: '[data-task-row="docs-r4s9"] [data-choice-option="a"]',
    cursor: { x: 760, y: 560 },
    record: async (recorder) => {
      const row = '[data-task-row="docs-r4s9"]';
      const held = '[data-task-row="docs-k8f2"]';
      await recorder.hold(500);
      // The filter, the decision's title and options, and the task it holds, without the rows' empty right-hand side.
      const area = await recorder.around('[data-active-filters]', `${row} [data-choice-option="b"]`, held);
      await recorder.move({
        camera: recorder.frame({ ...area, width: area.width * 0.7 }, { margin: 12 }),
        to: await recorder.point(`${row} [data-choice-option="a"]`, { x: 0.45, y: 0.6 }),
        ms: 1000,
      });
      await recorder.hold(400);
      await recorder.click();
      await recorder.hold(900);
      // The answer waits out its Undo window before it is sent.
      await recorder.skipUntil('the released task to be open', drawn(`section[data-group="open"] ${held}`));
      await recorder.hold(300);
      // Pointing at the released task shows its Claim, at the row's far end.
      await recorder.move({
        camera: recorder.frame(await recorder.box('section[data-group="open"]'), { margin: 12 }),
        to: await recorder.point(`${held} a`, { x: 0.7, y: 0.55 }),
        ms: 800,
      });
      await recorder.move({
        to: await recorder.point(`${held} [data-task-action="claim"]`, { x: 0.4, y: 0.6 }),
        ms: 600,
      });
    },
  },
  {
    // A held task's row names the helper its holder works through; its page shows the work in hand.
    name: 'live-work',
    address: '/tasks',
    // Below 1024 pixels the task page puts its facts under the title at the column's full width, where the
    // assignee's line has room for its helper.
    viewport: { width: 1008, height: 567 },
    ready: '[data-task-row="web-k3m9.2"] [data-row-helper]',
    cursor: { x: 640, y: 500 },
    record: async (recorder) => {
      const row = '[data-task-row="web-k3m9.2"]';
      await recorder.hold(500);
      await recorder.move({
        camera: recorder.frame(await recorder.around(row, 'section[data-group="in-progress"] [data-group-header]'), {
          margin: 8,
        }),
        to: await recorder.point(`${row} [data-row-helper]`, { x: 0.5, y: 0.7 }),
        ms: 1000,
      });
      await recorder.hold(700);
      // The title is cut short at this width, so the press lands on its first words.
      await recorder.move({ to: await recorder.point(`${row} a`, { x: 0.12, y: 0.55 }), ms: 600 });
      await recorder.hold(200);
      await recorder.click();
      await recorder.skipUntil('the task page', drawn('[data-task-facts]'));
      await recorder.hold(300);
      // The task's path and title, then the holder, the helper it works for and the work in hand, without the facts'
      // empty right-hand side.
      const facts = await recorder.around('nav[aria-label="Path"]', 'h1', '[data-fact="Pull request"]');
      const title = await recorder.box('h1');
      await recorder.move({
        camera: recorder.frame({ ...facts, width: title.x + title.width - facts.x }, { margin: 16 }),
        to: await recorder.point(
          { selector: '[data-fact="Assignee"] span', text: 'for a11y-check-1' },
          { x: 0.95, y: 1.05 },
        ),
        ms: 1000,
      });
    },
  },
  {
    // Waiting for you lists the work waiting for a merge and a deploy; the Done view shows each stage and a close with no proof.
    name: 'shipped',
    address: '/tasks/projects',
    // The docs project goes live by a deploy, so its merged work waits for one.
    prepare: async ({ send }, recorder) => {
      const box = `document.querySelector('[data-project-deploys="docs"] input')`;
      await recorder.waitFor('the projects', drawn('[data-project-deploys="docs"] input'));
      await send('Runtime.evaluate', { expression: `${box}.click()` });
      await recorder.waitFor('the docs project to deploy', `${box}.checked && !${box}.disabled`);
      await send('Runtime.evaluate', { expression: goWithin('/tasks?view=waiting') });
    },
    ready: 'section[data-group="delivery-deploy"] [data-task-row]',
    cursor: { x: 720, y: 560 },
    record: async (recorder) => {
      await recorder.hold(500);
      const groups = await recorder.around(
        'section[data-group="delivery-merge"]',
        'section[data-group="delivery-deploy"] [data-delivery-stage]',
      );
      await recorder.move({
        camera: recorder.frame({ ...groups, width: groups.width * 0.62 }, { margin: 16 }),
        to: await recorder.point('section[data-group="delivery-deploy"] [data-delivery-stage]', { x: 0.5, y: 1.3 }),
        ms: 1000,
      });
      await recorder.hold(1100);
      await recorder.move({
        camera: recorder.wide(),
        to: await recorder.point({ selector: '[role="group"][aria-label="View"] button', text: 'Done' }),
        ms: 900,
      });
      await recorder.click();
      await recorder.skipUntil('the Done view', drawn('[data-row-proof]'));
      await recorder.hold(200);
      const rows = await recorder.around('[data-task-row="docs-y5u2"]', '[data-task-row="docs-p3t6"]');
      await recorder.move({
        camera: recorder.frame({ ...rows, width: rows.width * 0.6 }, { margin: 16 }),
        to: await recorder.point('[data-row-proof]', { x: 1.2, y: 1.5 }),
        ms: 1000,
      });
    },
  },
  {
    // An approval names its action, environment, scope and verification; approving it records the answer.
    // Then an approval an agent relayed, which the person can dispute.
    name: 'approve',
    address: '/tasks/web-g7p2',
    ready: '[data-task-action="approve"]',
    cursor: { x: 640, y: 560 },
    record: async (recorder, tab) => {
      await recorder.hold(400);
      const asked = await recorder.around('h1', '[data-markdown]');
      await recorder.move({
        camera: recorder.frame(asked, { margin: 20 }),
        to: await recorder.point('[data-markdown]', { x: 0.9, y: 1.15 }),
        ms: 900,
      });
      await recorder.hold(1300);
      const approve = '[data-task-action="approve"]';
      await recorder.move({
        camera: recorder.frame(await recorder.around('h1', '[data-markdown]', approve), { margin: 16 }),
        to: await recorder.point(approve, { x: 0.45, y: 0.6 }),
        ms: 900,
      });
      await recorder.hold(200);
      await recorder.click();
      await recorder.hold(500);
      // The approval waits out its Undo window before it is sent.
      await recorder.skipUntil('the approval to close', drawn('[data-task-closed]'));
      await recorder.move({
        camera: recorder.frame(await recorder.around('h1', '[data-task-closed]'), { margin: 20 }),
        to: await recorder.point('[data-task-closed]', { x: 0.85, y: 0.75 }),
        ms: 800,
      });
      await recorder.hold(900);
      await recorder.cut(async () => {
        await navigate(tab.send, `${ORIGIN}/tasks/web-r2v9`, { waitMs: WAIT_MS });
        await recorder.waitFor('the relayed approval', drawn('[data-task-action="dispute"]'));
      });
      await recorder.hold(300);
      await recorder.move({
        camera: recorder.frame(await recorder.around('h1', '[data-task-answer]'), { margin: 20 }),
        to: await recorder.point('[data-task-action="dispute"]', { x: 0.82, y: 0.78 }),
        ms: 1000,
      });
    },
  },
  {
    // The Worker's setup page on a new deployment: AUTH_SECRET, then the button that has GitHub create the app.
    name: 'setup',
    address: '/',
    prepare: async ({ send }) => drawWorkerPage(send, (await workerPages()).setupPage({ error: null })),
    ready: 'main input[type="password"]',
    cursor: { x: 820, y: 520 },
    record: async (recorder) => {
      await recorder.hold(500);
      const field = 'main input[type="password"]';
      await recorder.move({
        camera: recorder.frame(await recorder.box('main'), { margin: 8 }),
        to: await recorder.point(field, { x: 0.3, y: 0.55 }),
        ms: 1000,
      });
      await recorder.click();
      // An invented value of the 32 characters AUTH_SECRET needs at least; the field shows it masked.
      await recorder.type('example-secret-for-walkthroughs!', 2);
      await recorder.hold(400);
      await recorder.move({ to: await recorder.point('main button', { x: 0.55, y: 0.55 }), ms: 700 });
      await recorder.hold(150);
      // GitHub's own pages are not part of the walkthrough, so it ends on the press.
      await recorder.click({ release: false });
      await recorder.hold(400);
    },
  },
];

async function record(tab: Tab, walkthrough: Walkthrough, theme: Theme): Promise<void> {
  const { send } = tab;
  const viewport = walkthrough.viewport ?? VIEWPORT;
  await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
  // The app follows the system's theme; reduced motion keeps its arrival animations out of the frames.
  await send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  // A new document for each recording, so the invented tasks start as the fixture writes them.
  await navigate(send, `${ORIGIN}${walkthrough.address}`, { waitMs: WAIT_MS });
  const recorder = new Recorder(send, { viewport, frame: FRAME, fps: FPS, quality: QUALITY });
  await walkthrough.prepare?.(tab, recorder);
  await recorder.waitFor(`${walkthrough.name} to draw`, drawn(walkthrough.ready), WAIT_MS);
  await recorder.start(recorder.wide(), walkthrough.cursor);
  await walkthrough.record(recorder, tab);
  const { webp, frames, durationMs } = await recorder.encode({ endMs: END_MS });
  const file = path.join(OUT, `walkthrough-${walkthrough.name}-${theme}.webp`);
  await writeFile(file, webp);
  const size = `${(webp.byteLength / 1_048_576).toFixed(2)} MB`;
  console.log(`${path.relative(ROOT, file)}  ${size}, ${frames} frames, ${(durationMs / 1000).toFixed(1)} s`);
}

/** Records the walkthroughs named, or every one when none is named, in light and dark. */
export async function recordWalkthroughs(names: readonly string[]): Promise<void> {
  const unknown = names.filter((name) => !WALKTHROUGHS.some((walkthrough) => walkthrough.name === name));
  if (unknown.length > 0) {
    throw new Error(
      `No walkthrough named ${unknown.join(', ')}. The walkthroughs are ${WALKTHROUGHS.map((walkthrough) => walkthrough.name).join(', ')}.`,
    );
  }
  const chosen =
    names.length === 0 ? WALKTHROUGHS : WALKTHROUGHS.filter((walkthrough) => names.includes(walkthrough.name));
  await mkdir(OUT, { recursive: true });
  await withBrowser(async (tab) => {
    for (const walkthrough of chosen) {
      for (const theme of THEMES) await record(tab, walkthrough, theme);
    }
  });
}
