/**
 * How the Worker's own pages look: the design system's tokens, type and
 * marks (docs/design.md), written out for pages the web app's build never
 * touches. The values are copies: packages/ui/test/design.test.tsx fails when
 * one differs from packages/ui/src/index.css or the app's brand marks. This
 * module imports nothing, so that test can read it.
 */

/** Each colour the pages use, light then dark. */
export const PAGE_COLOURS = {
  background: ['#ffffff', '#111216'],
  canvas: ['#f6f6f8', '#0b0c0f'],
  hover: ['#f1f1f4', '#1d1e24'],
  border: ['#e8e8ed', '#25262d'],
  ink: ['#17171c', '#ededf1'],
  'ink-2': ['#474852', '#b3b5bf'],
  'ink-3': ['#696b76', '#8a8d98'],
  accent: ['#2745d4', '#4565ef'],
  'on-accent': ['#ffffff', '#ffffff'],
} as const satisfies Record<string, readonly [string, string]>;

/** The elevations the pages use, light then dark. */
export const PAGE_SHADOWS = {
  'shadow-raise': ['0 1px 2px rgb(15 15 30 / 0.06)', '0 0 0 1px rgb(255 255 255 / 0.04)'],
  'shadow-pop': [
    '0 0 0 1px rgb(15 15 30 / 0.06), 0 4px 12px rgb(15 15 30 / 0.08), 0 16px 32px -8px rgb(15 15 30 / 0.12)',
    '0 0 0 1px rgb(255 255 255 / 0.07), 0 8px 24px rgb(0 0 0 / 0.5)',
  ],
} as const satisfies Record<string, readonly [string, string]>;

/**
 * The font files the pages load, at addresses that never change: the web
 * app's build copies each from its pinned @fontsource package
 * (packages/ui/server-fonts.config.ts). Latin only; other scripts fall back
 * to the system's sans serif.
 */
export const PAGE_FONT_FILES = ['/fonts/inter-latin-opsz-normal.woff2'] as const;

/** The Octicons "mark-github" path (MIT), as packages/ui/src/components/ui/brand-marks.ts holds it. */
export const GITHUB_PATH =
  'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';

/** The Ntasks logo, an N on Accent, as the app's `NtasksLogo` draws it. */
export const LOGO_SVG =
  '<svg class="logo" viewBox="0 0 20 20" width="32" height="32" aria-hidden="true"><rect width="20" height="20" rx="5.5" fill="var(--accent)"/><path d="M6.5 14V6l7 8V6" fill="none" stroke="var(--on-accent)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function githubSvg(size: number): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${GITHUB_PATH}"/></svg>`;
}

/** Lucide's circle-alert, which leads an error's words; errors are never red. */
export const ALERT_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>';

function theme(index: 0 | 1): string {
  return [...Object.entries(PAGE_COLOURS), ...Object.entries(PAGE_SHADOWS)]
    .map(([name, values]) => `--${name}: ${values[index]};`)
    .join(' ');
}

/** The pages' style sheet: the tokens for light and dark, Inter, a card on Canvas, fields and buttons. */
export const PAGE_STYLE = `
:root { color-scheme: light; ${theme(0)} }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; ${theme(1)} } }
@font-face { font-family: "Inter Variable"; font-style: normal; font-display: swap; font-weight: 100 900; src: url(${PAGE_FONT_FILES[0]}) format("woff2-variations"); unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 16px; background: var(--canvas); color: var(--ink); font-family: "Inter Variable", ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 14px; line-height: 20px; font-feature-settings: "cv05" 1, "cv08" 1; font-optical-sizing: auto; -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 400px; padding: 28px; border-radius: 12px; background: var(--background); box-shadow: var(--shadow-pop); }
.logo { display: block; }
h1 { margin: 14px 0 0; font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.012em; }
.sub { margin: 4px 0 0; color: var(--ink-2); }
.alert { display: flex; align-items: center; gap: 6px; margin: 12px 0 0; font-size: 12.5px; line-height: 16px; color: var(--ink); }
.alert svg { flex: none; color: var(--ink-2); }
dl { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 6px 8px; margin: 20px 0 0; }
dt { font-size: 12.5px; line-height: 20px; font-weight: 500; color: var(--ink-3); }
dd { margin: 0; min-width: 0; font-size: 13.5px; line-height: 20px; font-weight: 500; overflow-wrap: anywhere; }
.quiet { color: var(--ink-3); font-weight: 400; }
fieldset { margin: 20px 0 0; padding: 0; border: 0; min-width: 0; }
legend { padding: 0; margin-bottom: 6px; font-size: 13px; font-weight: 500; color: var(--ink-2); }
.options { border-radius: 8px; box-shadow: inset 0 0 0 1px var(--border); }
.options label { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 12px; font-size: 14px; font-weight: 500; cursor: pointer; }
.options label + label { border-top: 1px solid var(--border); }
.options label:hover { background: var(--hover); }
.options label:first-child { border-radius: 8px 8px 0 0; }
.options label:last-child { border-radius: 0 0 8px 8px; }
.options .key { margin-left: auto; font-size: 12.5px; font-weight: 400; color: var(--ink-3); font-variant-numeric: tabular-nums; font-feature-settings: "calt" 0, "cv05" 1, "cv08" 1; }
input[type="checkbox"] { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
.field { display: flex; flex-direction: column; gap: 6px; margin: 20px 0 0; font-size: 13px; font-weight: 500; color: var(--ink-2); }
.field input { height: 36px; padding: 0 10px; border: 0; border-radius: 6px; background: var(--background); color: var(--ink); font: inherit; font-size: 14px; font-weight: 400; box-shadow: inset 0 0 0 1px var(--border); }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin: 24px 0 0; }
.button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 10px; border: 0; border-radius: 6px; font: inherit; font-size: 13px; font-weight: 500; text-decoration: none; white-space: nowrap; cursor: pointer; transition: background-color 120ms ease-out, filter 120ms ease-out; }
.button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.primary { background: var(--accent); color: var(--on-accent); }
.primary:hover { filter: brightness(1.08); }
.secondary { background: var(--background); color: var(--ink); box-shadow: inset 0 0 0 1px var(--border), var(--shadow-raise); }
.secondary:hover { background: var(--hover); }
.wide { width: 100%; height: 36px; margin-top: 16px; font-size: 14px; }
.wide svg { flex: none; }
footer a { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; line-height: 16px; color: var(--ink-3); text-decoration: none; }
footer a:hover { color: var(--ink); }
@media (prefers-reduced-motion: reduce) { .button { transition: none; } }
@media (pointer: coarse) { .button { height: 36px; } .wide { height: 40px; } }
`;
