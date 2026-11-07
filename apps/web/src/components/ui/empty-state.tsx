import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * What a list or a page shows when it has nothing: a 20 px icon in Text 3,
 * one line that names what is empty ("No tasks waiting for you"), and the
 * one action that fills it, when there is one. It names the state; it does
 * not explain the page or reassure.
 */
export function EmptyState({
  icon,
  title,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-16 text-center', className)}>
      {icon ? (
        <span
          aria-hidden
          className="grid size-10 place-items-center rounded-full bg-surface text-ink-3 inset-ring inset-ring-border [&_svg]:size-5"
        >
          {icon}
        </span>
      ) : null}
      <p className="m-0 text-sm font-medium text-ink">{title}</p>
      {action}
    </div>
  );
}
