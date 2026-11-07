import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * A key, as a control shows the key that does its action: `C` beside New
 * task, `/` in the search field, `A` on an option. On a primary button the
 * button restyles it (button.tsx). `size="sm"` is for segmented options.
 */
export function Kbd({ className, size = 'md', ...props }: ComponentProps<'kbd'> & { size?: 'md' | 'sm' }) {
  return (
    <kbd
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-sm bg-background px-1 font-sans font-medium text-ink-3 inset-ring inset-ring-border-strong',
        size === 'md' ? 'h-4.5 min-w-4.5 text-kbd' : 'h-4 min-w-4 text-[10.5px] leading-4',
        className,
      )}
      {...props}
    />
  );
}
