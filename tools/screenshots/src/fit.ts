/**
 * Checks that the web app's pages fit a phone's screen. Each page is opened
 * 320 and 390 pixels wide on an emulated touch screen, over the invented
 * tasks, and passes when:
 *
 * - the page is no wider than the screen, as drawn and again after the text
 *   people and agents write is made as long as real tasks hold (a decision's
 *   option labels, a task's id), since the invented tasks keep theirs short;
 * - every text field draws its text at 16 px or more, since Safari on a phone
 *   zooms in on a smaller one when it takes focus and the page then scrolls
 *   sideways.
 *
 * `pnpm screenshots fit` runs it from the repository root. It prints each
 * page that fails with what runs past the screen's edge, and exits with 1
 * when one fails. It needs Chrome as the screenshots do, so CI never runs it.
 */
import { ORIGIN, WAIT_MS, withBrowser, type Tab } from './browser.ts';
import { navigate, until } from './devtools.ts';

/** The smallest phone screen still in use, and the width of most phones. */
const WIDTHS = [320, 390] as const;

const SETTINGS_TABS = ['workspace', 'projects', 'members', 'github', 'apps', 'you'];

/** The pages with fixed addresses; each task's page is added from the board's links. */
const PAGES = [
  '/tasks',
  '/tasks?view=waiting',
  '/tasks?view=active',
  '/tasks?view=done',
  '/tasks/live',
  '/tasks/focus',
  '/tasks/productivity',
  '/tasks/projects/web',
  '/tasks/projects/web/tasks',
  ...SETTINGS_TABS.map((tab) => `/tasks/settings/${tab}`),
];

/** As long as a decision's option and a task's id run in real workspaces. */
const LONG_OPTION = 'Keep both checks open until the restore drill runs on the new host';
const LONG_ID = 'web-k3m9.12.34';

/** What the page reports: its width, what runs past the screen's edge, and its text fields under 16 px. */
interface Measure {
  width: number;
  coarse: boolean;
  past: string[];
  small: string[];
}

/**
 * Runs in the page. An element counts as past the edge when its right side is
 * beyond the screen and no box around it clips or scrolls it; only the
 * innermost of a run of such elements is named.
 */
const MEASURE = `(() => {
  const screen = document.documentElement.clientWidth;
  const clipped = (element) => {
    for (let box = element.parentElement; box && box !== document.body; box = box.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(box).overflowX) && box.getBoundingClientRect().right <= screen + 0.5) return true;
    }
    return false;
  };
  const beyond = (element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().right > screen + 0.5;
  const past = [...document.querySelectorAll('body *')]
    .filter((element) => beyond(element) && !clipped(element) && ![...element.children].some(beyond))
    .slice(0, 5)
    .map((element) => element.tagName.toLowerCase() + ' "' + (element.textContent || '').trim().slice(0, 40) + '" ends at ' + Math.round(element.getBoundingClientRect().right) + ' px');
  const small = [...document.querySelectorAll('input:not([type=checkbox], [type=radio], [type=range], [type=color], [type=file], [type=hidden]), textarea, select')]
    .filter((field) => parseFloat(getComputedStyle(field).fontSize) < 16)
    .map((field) => field.tagName.toLowerCase() + ' "' + (field.getAttribute('aria-label') || field.getAttribute('placeholder') || field.name || '') + '" at ' + getComputedStyle(field).fontSize);
  return { width: document.documentElement.scrollWidth, coarse: matchMedia('(pointer: coarse)').matches, past, small };
})()`;

/** Runs in the page: makes the text people and agents write as long as real tasks hold it. */
const LENGTHEN = `(() => {
  for (const option of document.querySelectorAll('[data-choice-option]')) {
    const words = [...option.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '');
    if (words) words.textContent = ${JSON.stringify(LONG_OPTION)};
  }
  const id = document.querySelector('nav[aria-label="Path"] [aria-current="page"]');
  if (id) id.textContent = ${JSON.stringify(LONG_ID)};
})()`;

async function evaluate<T>({ send }: Tab, expression: string): Promise<T> {
  const answer = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  if (answer.exceptionDetails) throw new Error(`The page could not run a check: ${answer.exceptionDetails.text}`);
  return answer.result.value;
}

/** Opens `address` and resolves once the app has drawn it: no loading blocks left and its fonts in. */
async function open(tab: Tab, address: string): Promise<void> {
  await navigate(tab.send, `${ORIGIN}${address}`, { waitMs: WAIT_MS });
  const drawn = `document.querySelector('[data-ntasks] header') !== null && document.querySelector('.skeleton') === null && document.fonts.status === 'loaded'`;
  await until(`${address} to draw`, async () => (await evaluate<boolean>(tab, drawn)) === true, { waitMs: WAIT_MS });
  // One frame for what the last answer drew.
  await tab.send('Runtime.evaluate', {
    expression: 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))',
    awaitPromise: true,
  });
}

/** Each task's page the board links to. */
async function taskPages(tab: Tab): Promise<string[]> {
  await open(tab, '/tasks');
  const links = await evaluate<string[]>(
    tab,
    `[...new Set([...document.querySelectorAll('[data-task-row] a[href]')].map((link) => new URL(link.href).pathname))]`,
  );
  return links.filter((address) => /^\/tasks\/[a-z]+-[a-z0-9.]+$/.test(address));
}

/** The failures on one page at one width, as lines to print; none when it fits. */
async function check(tab: Tab, address: string, width: number): Promise<string[]> {
  await open(tab, address);
  const failures: string[] = [];
  const drawn = await evaluate<Measure>(tab, MEASURE);
  if (!drawn.coarse)
    throw new Error('Chrome did not emulate a touch screen, so the text field sizes cannot be checked.');
  if (drawn.width > width) failures.push(`${drawn.width} px wide: ${drawn.past.join('; ')}`);
  for (const field of drawn.small) failures.push(`zooms in on ${field}`);
  await evaluate(tab, LENGTHEN);
  const lengthened = await evaluate<Measure>(tab, MEASURE);
  if (lengthened.width > width && drawn.width <= width) {
    failures.push(`${lengthened.width} px wide with long text: ${lengthened.past.join('; ')}`);
  }
  return failures;
}

/** Checks every page at every width; true when all of them fit. */
export async function checkFit(): Promise<boolean> {
  return withBrowser(async (tab) => {
    await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    let fits = true;
    for (const width of WIDTHS) {
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
      const pages = [...PAGES, ...(await taskPages(tab))];
      for (const address of pages) {
        const failures = await check(tab, address, width);
        if (failures.length === 0) continue;
        fits = false;
        for (const failure of failures) console.log(`${width} ${address}: ${failure}`);
      }
      console.log(`${width} px: ${pages.length} pages checked`);
    }
    return fits;
  });
}
