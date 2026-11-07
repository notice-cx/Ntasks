import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { COLOUR_TOKENS, MARK_TOKENS } from '@/lib/design-tokens';
import { PRIORITY_LABELS, STATUS_MARK_LABELS, TYPE_MARK_LABELS } from '@/lib/symbols';
import { renderApp } from './render';

const CSS = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `index.css has a rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('the tokens', () => {
  it('sets every listed token in the light theme and in the dark theme', () => {
    const light = rule(':root,\n.light');
    const dark = rule('.dark');
    for (const { variable } of [...COLOUR_TOKENS, ...MARK_TOKENS]) {
      expect(light, `${variable} in light`).toMatch(new RegExp(`\\n\\s*${variable}:\\s*#[0-9a-f]{6};`));
      expect(dark, `${variable} in dark`).toMatch(new RegExp(`\\n\\s*${variable}:\\s*#[0-9a-f]{6};`));
    }
  });

  it('gives every listed colour a Tailwind name', () => {
    for (const { variable } of [...COLOUR_TOKENS, ...MARK_TOKENS]) {
      expect(CSS).toContain(`--color-${variable.slice(2)}: var(${variable});`);
    }
  });
});

describe('the gallery at /design', () => {
  it('opens without signing in and shows every symbol by name', async () => {
    renderApp('/design');
    const gallery = await screen.findByRole('heading', { name: 'Ntasks design' });
    expect(gallery).toBeTruthy();
    for (const word of [...Object.values(STATUS_MARK_LABELS), ...PRIORITY_LABELS, ...Object.values(TYPE_MARK_LABELS)]) {
      expect(screen.getAllByText(word).length, word).toBeGreaterThan(0);
    }
    for (const palette of ['light', 'dark']) {
      const swatches = document.querySelectorAll(`[data-palette="${palette}"] [data-swatch]`);
      expect(swatches).toHaveLength(COLOUR_TOKENS.length);
    }
  });

  it('keeps the link to the source code', async () => {
    renderApp('/design');
    await screen.findByRole('heading', { name: 'Ntasks design' });
    expect(document.querySelector('[data-source-link]')?.getAttribute('href')).toBe(
      'https://github.com/notice-cx/Ntasks',
    );
  });

  it('draws the page in the theme chosen', async () => {
    renderApp('/design');
    await screen.findByRole('heading', { name: 'Ntasks design' });
    const page = document.querySelector('[data-design-gallery]');
    fireEvent.click(within(screen.getByRole('group', { name: 'Theme' })).getByRole('button', { name: 'Dark' }));
    expect(page?.classList.contains('dark')).toBe(true);
    fireEvent.click(within(screen.getByRole('group', { name: 'Theme' })).getByRole('button', { name: 'System' }));
    expect(page?.classList.contains('dark')).toBe(false);
  });

  it("opens its menus in the theme chosen, whichever way it differs from the system's", async () => {
    const root = document.documentElement;
    try {
      for (const [systemDark, chosen] of [
        [false, 'dark'],
        [true, 'light'],
      ] as const) {
        root.classList.toggle('dark', systemDark);
        const view = renderApp('/design');
        await screen.findByRole('heading', { name: 'Ntasks design' });
        const themes = within(screen.getByRole('group', { name: 'Theme' }));
        fireEvent.click(themes.getByRole('button', { name: chosen === 'dark' ? 'Dark' : 'Light' }));
        fireEvent.click(screen.getByRole('button', { name: 'Open a menu' }));
        await waitFor(() =>
          expect(document.querySelector('[data-radix-popper-content-wrapper] [role="menu"]')).not.toBeNull(),
        );
        const menu = document.querySelector('[data-radix-popper-content-wrapper] [role="menu"]');
        const scope = menu?.closest('.light, .dark');
        expect(
          scope?.hasAttribute('data-design-gallery'),
          `menu inside the gallery when the system is ${systemDark ? 'dark' : 'light'}`,
        ).toBe(true);
        expect(scope?.classList.contains(chosen)).toBe(true);
        view.unmount();
      }
    } finally {
      root.classList.remove('dark');
    }
  });
});
