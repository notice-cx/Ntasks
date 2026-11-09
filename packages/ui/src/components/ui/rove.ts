import type { KeyboardEvent } from 'react';

/**
 * Arrow keys, Home and End move focus among the items `selector` finds in a
 * list, wrapping at the ends, as a menu or a listbox promises a keyboard
 * user. Returns whether the key was one it handled.
 */
export function roveFocus(event: KeyboardEvent<HTMLElement>, selector: string): boolean {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)].filter(
    (item) => !item.hasAttribute('disabled'),
  );
  if (items.length === 0) return false;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  const to =
    event.key === 'ArrowDown'
      ? at < 0 || at === last
        ? 0
        : at + 1
      : event.key === 'ArrowUp'
        ? at <= 0
          ? last
          : at - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : null;
  if (to === null) return false;
  event.preventDefault();
  items[to]?.focus();
  return true;
}

/** The item to start on when a list opens: the picked one, else the first. */
export function focusStart(container: HTMLElement | null, selector: string, picked?: string): void {
  if (!container) return;
  const start =
    (picked ? container.querySelector<HTMLElement>(picked) : null) ?? container.querySelector<HTMLElement>(selector);
  start?.focus();
}
