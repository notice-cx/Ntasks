import type { CSSProperties } from 'react';
import { Toaster } from 'sonner';

/** Where the app's toasts show: bottom right, each with a close button, in the page's own tokens so they follow its theme. */
export function AppToaster() {
  return (
    <Toaster
      position="bottom-right"
      closeButton
      style={
        {
          '--normal-bg': 'var(--background)',
          '--normal-text': 'var(--ink)',
          '--normal-border': 'var(--border)',
        } as CSSProperties
      }
      toastOptions={{ className: 'font-sans' }}
    />
  );
}
