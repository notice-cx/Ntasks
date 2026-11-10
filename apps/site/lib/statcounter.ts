import { SITE_ORIGIN } from './site.ts';

// Statcounter counts the site's visits for the owner's project. The project
// id and security code are public: every page sends them.
const PROJECT = 13366041;
const SECURITY = 'daa19c1d';
const HOST = new URL(SITE_ORIGIN).hostname;

/**
 * The counter, which the landing page's build and both VitePress builds put
 * before `</body>` on every page. Its script loads only at the site's own
 * address, so a local build or preview counts no visit. The `<noscript>`
 * image, which counts visitors without JavaScript, has no such check: a local
 * preview opened with JavaScript off counts one.
 */
export const statcounterHtml = `<script>
  if (location.hostname === ${JSON.stringify(HOST)}) {
    var sc_project = ${PROJECT};
    var sc_invisible = 1;
    var sc_security = ${JSON.stringify(SECURITY)};
    const counter = document.createElement('script');
    counter.async = true;
    counter.src = 'https://www.statcounter.com/counter/counter.js';
    document.head.appendChild(counter);
  }
</script>
<noscript><div class="statcounter"><a title="Web Analytics Made Easy - Statcounter" href="https://statcounter.com/" target="_blank" rel="noopener"><img class="statcounter" src="https://c.statcounter.com/${PROJECT}/0/${SECURITY}/1/" alt="Web Analytics Made Easy - Statcounter" referrerpolicy="no-referrer-when-downgrade"></a></div></noscript>
`;

/** A page with the counter before its `</body>`. */
export function withStatcounter(html: string): string {
  // A function, so a `$` in the counter is never read as a replacement pattern.
  return html.replace('</body>', () => `${statcounterHtml}</body>`);
}

/**
 * Calls `record` each time the address's path changes from the last one
 * seen, starting from `start`. The counter counts the page a visitor loads;
 * the docs and the spec then open their other pages in place, and their
 * router's hook also runs on the first load and on a jump to a heading on the
 * same page, which are not new pages. A page left before the counter's script
 * loads is not counted: `record_pageview()` reads the current address, and the
 * script counts the page open when it loads.
 */
export function onNewPage(start: string, record: () => void): (path: string) => void {
  let last = start;
  return (path) => {
    if (path === last) return;
    last = path;
    record();
  };
}

/** Counts the page now open. Where the counter's script did not load, it does nothing. */
export function recordPageview(): void {
  (globalThis as { _statcounter?: { record_pageview?: () => void } })._statcounter?.record_pageview?.();
}
