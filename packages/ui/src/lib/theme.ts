import { useSyncExternalStore } from 'react';

/** The app's theme: light, dark, or the one the system prefers, followed while the page is open. */
export type Theme = 'light' | 'dark' | 'system';

const PREFERS_DARK = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(PREFERS_DARK);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function prefersDark(): boolean {
  return window.matchMedia(PREFERS_DARK).matches;
}

/** `theme` as light or dark, reading the system's preference for `system`. */
export function useResolvedTheme(theme: Theme): 'light' | 'dark' {
  const dark = useSyncExternalStore(subscribe, prefersDark);
  if (theme !== 'system') return theme;
  return dark ? 'dark' : 'light';
}
