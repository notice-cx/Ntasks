import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { COLOUR_TOKENS, IDENTITY_HUES, MARK_TOKENS } from '@/lib/design-tokens';
import { PRIORITY_LABELS, STATUS_MARK_LABELS, TYPE_MARK_LABELS } from '@/lib/symbols';
import { cn, THEME_SHADOWS, THEME_TEXT_SIZES } from '@/lib/utils';
import { GITHUB_PATH } from '@/components/ui/brand-marks';
import { NtasksLogo } from '@/components/ui/symbols';
import { DesignGallery } from '@/NtasksApp';
import {
  GITHUB_PATH as PAGE_GITHUB_PATH,
  LOGO_SVG,
  PAGE_COLOURS,
  PAGE_SHADOWS,
} from '../../../workers/api/src/access/page-look.ts';

const CSS = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `index.css has a rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return CSS.slice(at, CSS.indexOf('}', at));
}

/** A token's value in one theme's rule, with its whitespace made single spaces. */
function value(theme: string, name: string): string | undefined {
  const found = new RegExp(`--${name}:\\s*([^;]+);`).exec(theme)?.[1];
  return found?.replace(/\s+/g, ' ').trim();
}

/** WCAG 2's contrast ratio between two `#rrggbb` colours. */
function contrast(one: string, two: string): number {
  const luminance = (hex: string) => {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
      const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [luminance(one), luminance(two)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('the tokens', () => {
  it('sets every listed token in the light theme and in the dark theme', () => {
    const light = rule(':root,\n.light');
    const dark = rule('.dark');
    const variables = [
      ...[...COLOUR_TOKENS, ...MARK_TOKENS].map((token) => token.variable),
      ...IDENTITY_HUES.flatMap((hue) => [hue.fill, hue.ink]),
    ];
    for (const variable of variables) {
      expect(light, `${variable} in light`).toMatch(new RegExp(`\\n\\s*${variable}:\\s*#[0-9a-f]{6};`));
      expect(dark, `${variable} in dark`).toMatch(new RegExp(`\\n\\s*${variable}:\\s*#[0-9a-f]{6};`));
    }
  });

  it("draws each identity hue's letter at 4.5:1 or more on its fill, in both themes", () => {
    // #767676 on white is the lightest grey that passes AA, at 4.54:1.
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    for (const [theme, css] of [
      ['light', rule(':root,\n.light')],
      ['dark', rule('.dark')],
    ] as const) {
      for (const hue of IDENTITY_HUES) {
        const fill = value(css, hue.fill.slice(2)) ?? '';
        const ink = value(css, hue.ink.slice(2)) ?? '';
        expect(contrast(fill, ink), `${hue.name} in ${theme}: ${ink} on ${fill}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // Text needs 4.5:1. A mark that shows a state, such as the focus outline on
  // Background or the selected option's ring on Accent soft, needs 3:1.
  it('keeps Accent readable as text and as a mark, in both themes', () => {
    for (const [theme, css] of [
      ['light', rule(':root,\n.light')],
      ['dark', rule('.dark')],
    ] as const) {
      for (const [ink, fill, least] of [
        ['on-accent', 'accent', 4.5],
        ['accent-text', 'background', 4.5],
        ['accent', 'background', 3],
        ['accent', 'accent-soft', 3],
      ] as const) {
        const [one, two] = [value(css, ink) ?? '', value(css, fill) ?? ''];
        expect(contrast(one, two), `${ink} on ${fill} in ${theme}: ${one} on ${two}`).toBeGreaterThanOrEqual(least);
      }
    }
  });

  // The Top tag's figure is text on Priority, the High tag's is Priority text
  // on Priority soft; the Top tag is also a mark on Background and on a
  // hovered row.
  it('keeps the priority tags readable, in both themes', () => {
    for (const [theme, css] of [
      ['light', rule(':root,\n.light')],
      ['dark', rule('.dark')],
    ] as const) {
      for (const [ink, fill, least] of [
        ['on-priority', 'priority', 4.5],
        ['priority-text', 'priority-soft', 4.5],
        ['priority', 'background', 3],
        ['priority', 'hover', 3],
      ] as const) {
        const [one, two] = [value(css, ink) ?? '', value(css, fill) ?? ''];
        expect(contrast(one, two), `${ink} on ${fill} in ${theme}: ${one} on ${two}`).toBeGreaterThanOrEqual(least);
      }
    }
  });

  it('gives every listed colour a Tailwind name', () => {
    for (const { variable } of [...COLOUR_TOKENS, ...MARK_TOKENS]) {
      expect(CSS).toContain(`--color-${variable.slice(2)}: var(${variable});`);
    }
  });

  // tailwind-merge does not read index.css: a size or shadow it is not told
  // about is taken for a colour, and `cn` then drops the real colour beside it.
  it('tells the class merge every type size and shadow the theme defines', () => {
    const theme = [...CSS.matchAll(/@theme inline \{([^}]*)\}/g)].map((block) => block[1] ?? '').join('\n');
    const names = (family: string) =>
      [...theme.matchAll(new RegExp(`^\\s*--${family}-([a-z0-9]+(?:-[a-z0-9]+)*):`, 'gm'))]
        .map((match) => match[1])
        .sort();
    expect(names('text')).toEqual([...THEME_TEXT_SIZES].sort());
    expect(names('shadow')).toEqual([...THEME_SHADOWS].sort());
    expect(cn('text-ink-3 text-meta')).toBe('text-ink-3 text-meta');
    expect(cn('shadow-raise shadow-pop')).toBe('shadow-pop');
  });
});

describe("the Worker's own pages", () => {
  it('use the colours and elevations the app defines, in both themes', () => {
    const themes = [rule(':root,\n.light'), rule('.dark')] as const;
    for (const [name, values] of Object.entries({ ...PAGE_COLOURS, ...PAGE_SHADOWS })) {
      themes.forEach((theme, index) => expect(values[index], `${name} in theme ${index}`).toBe(value(theme, name)));
    }
  });

  it("draw the app's logo and GitHub mark", () => {
    expect(PAGE_GITHUB_PATH).toBe(GITHUB_PATH);
    const { container } = render(<NtasksLogo />);
    const page = new DOMParser().parseFromString(LOGO_SVG, 'image/svg+xml');
    for (const [selector, attribute] of [
      ['rect', 'rx'],
      ['path', 'd'],
      ['path', 'stroke-width'],
      ['svg', 'viewBox'],
    ] as const) {
      expect(page.querySelector(selector)?.getAttribute(attribute), `${selector} ${attribute}`).toBe(
        container.querySelector(selector)?.getAttribute(attribute),
      );
    }
  });
});

/** The system prefers dark while `dark` holds, until the returned function restores it. */
function systemPrefersDark(dark: boolean): () => void {
  const media = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    ...media(query),
    matches: dark && query === '(prefers-color-scheme: dark)',
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = media;
  };
}

describe('the gallery', () => {
  it('opens without signing in and shows every symbol by name', async () => {
    render(<DesignGallery />);
    const gallery = await screen.findByRole('heading', { name: 'Ntasks design' });
    expect(gallery).toBeTruthy();
    for (const word of [...Object.values(STATUS_MARK_LABELS), ...PRIORITY_LABELS, ...Object.values(TYPE_MARK_LABELS)]) {
      expect(screen.getAllByText(word).length, word).toBeGreaterThan(0);
    }
    for (const palette of ['light', 'dark']) {
      const swatches = document.querySelectorAll(`[data-palette="${palette}"] [data-swatch]`);
      expect(swatches).toHaveLength(COLOUR_TOKENS.length);
      const hues = document.querySelectorAll(`[data-palette="${palette}"] [data-identity-swatch]`);
      expect(hues).toHaveLength(IDENTITY_HUES.length);
    }
  });

  it('keeps the link to the source code', async () => {
    render(<DesignGallery />);
    await screen.findByRole('heading', { name: 'Ntasks design' });
    expect(document.querySelector('[data-source-link]')?.getAttribute('href')).toBe(
      'https://github.com/notice-cx/Ntasks',
    );
  });

  it('draws the page in the theme chosen', async () => {
    render(<DesignGallery />);
    await screen.findByRole('heading', { name: 'Ntasks design' });
    const page = document.querySelector('[data-design-gallery]');
    fireEvent.click(within(screen.getByRole('group', { name: 'Theme' })).getByRole('button', { name: 'Dark' }));
    expect(page?.classList.contains('dark')).toBe(true);
    fireEvent.click(within(screen.getByRole('group', { name: 'Theme' })).getByRole('button', { name: 'System' }));
    expect(page?.classList.contains('dark')).toBe(false);
  });

  it("opens its menus in the theme chosen, whichever way it differs from the system's", async () => {
    for (const [systemDark, chosen] of [
      [false, 'dark'],
      [true, 'light'],
    ] as const) {
      const restore = systemPrefersDark(systemDark);
      try {
        const view = render(<DesignGallery />);
        expect(document.querySelector('[data-ntasks]')?.classList.contains(systemDark ? 'dark' : 'light')).toBe(true);
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
      } finally {
        restore();
      }
    }
  });
});
