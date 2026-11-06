import { cleanup } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach } from 'vitest';

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
});
