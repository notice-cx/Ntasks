import { createContext, useContext, useSyncExternalStore } from 'react';

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

/** The theme of the nearest `ThemeScope`: the app's root sets the one the app draws in, and a part of a page drawn in another theme, as the design gallery's palettes are, sets its own. */
export const ScopeTheme = createContext<Theme>('system');

/** The theme the page around this component is drawn in, light or dark: the app's own, not only the system's. */
export function useScopeTheme(): 'light' | 'dark' {
  return useResolvedTheme(useContext(ScopeTheme));
}
