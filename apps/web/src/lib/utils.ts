import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The type steps index.css adds to Tailwind's theme. tailwind-merge does not
 * read the CSS theme, so an unknown name such as `text-meta` would be taken
 * for a text colour and dropped beside `text-ink-3`. Listed here, each is a
 * font size, which conflicts only with other sizes.
 */
export const THEME_TEXT_SIZES = [
  'kbd',
  'chip',
  'meta',
  'label',
  'nav',
  'body',
  'code',
  'heading',
  'page-title',
  'task-title',
] as const;

/** The elevations index.css defines; unlisted, `shadow-pop` would be read as a shadow colour. */
export const THEME_SHADOWS = ['raise', 'pop'] as const;

const twMerge = extendTailwindMerge({
  extend: { theme: { text: [...THEME_TEXT_SIZES], shadow: [...THEME_SHADOWS] } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
