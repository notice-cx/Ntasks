import { useEffect, useRef } from 'react';
import { isShortcut } from '@/lib/symbols';

/**
 * Runs `action` when the page's single-key shortcut `key` is pressed, while
 * `enabled`. A press in a text field, or with Ctrl, Alt or Command, is left
 * alone (src/lib/symbols.ts `isShortcut`). The control the key belongs to
 * shows it in a `Kbd`.
 */
export function useShortcut(key: string, action: () => void, enabled = true): void {
  const latest = useRef(action);
  latest.current = action;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isShortcut(event, key)) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, enabled]);
}
