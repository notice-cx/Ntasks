import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The type steps index.css adds to Tailwind's theme. tailwind-merge does not
 * read the CSS theme, so an unknown name such as `text-micro` would be taken
 * for a text colour and dropped beside `text-muted-foreground`. Listed here,
 * each is a font size, which conflicts only with other sizes.
 */
export const THEME_TEXT_SIZES = ['display', 'figure', 'figure-sm', 'micro'] as const;

const twMerge = extendTailwindMerge({ extend: { theme: { text: [...THEME_TEXT_SIZES] } } });

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
