import { cleanup, configure } from '@testing-library/react';
import { toast } from 'sonner';
import { afterAll, afterEach } from 'vitest';

// A page's first render in a run loads its code for the first time, and the
// Markdown renderer alone can take more than a second to load cold, longer
// than the default one-second wait of findBy and waitFor.
configure({ asyncUtilTimeout: 5000 });

/** Longer than the toaster's own exit timer. */
const TOAST_EXIT_MS = 300;

// jsdom has no layout: Radix measures its anchor with ResizeObserver, and the
// toaster asks matchMedia for the system theme.
class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoResize as unknown as typeof ResizeObserver;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= () => false;

afterEach(() => {
  cleanup();
  // The toaster's list outlives a render; each test starts with none.
  toast.dismiss();
  // So does the workspace chosen last; each test opens the first.
  window.localStorage.clear();
});

// A dismissed toast removes itself on a timer about 200 ms later. Each file
// waits that out once, so no removal runs after jsdom's window is gone.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, TOAST_EXIT_MS));
});
