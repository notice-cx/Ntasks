/**
 * The page furniture the task page and Focus still share: a section's
 * eyebrow, and the empty, failed and loading states.
 */
import type { ReactNode } from 'react';
import { CircleAlert, LogIn, RotateCw } from 'lucide-react';
import { needsSignIn, SIGN_IN_PATH } from '@/api/client';
import { Button } from '@/components/ui/button';
import { eyebrowClass } from '@/components/ui/chrome';
import { cn } from '@/lib/utils';

/** A section's eyebrow, a quiet caption, and whatever belongs at the row's end. */
export function SectionLabel({
  title,
  caption,
  id,
  children,
  className,
}: {
  title: string;
  caption?: ReactNode;
  id?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-2.5 gap-y-1', className)}>
      <h2 id={id} className={cn('m-0', eyebrowClass)}>
        {title}
      </h2>
      {caption ? <span className="min-w-0 text-xs tabular-nums text-muted-foreground">{caption}</span> : null}
      {children ? <span className="ms-auto flex items-center gap-2">{children}</span> : null}
    </div>
  );
}

/** A designed empty state: what is empty, and the next step when there is one. */
export function EmptyState({ title, hint, className }: { title: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-start justify-center gap-1 py-2', className)} data-empty-state="">
      <span className="text-base font-medium text-foreground">{title}</span>
      {hint ? <span className="text-sm text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** A read that failed: what could not be read, the server's words, and Retry. */
export function ReadFailed({
  title,
  error,
  retrying,
  onRetry,
}: {
  title: string;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (needsSignIn(error)) return <SignIn />;
  const said = error instanceof Error && error.message !== '' ? error.message : null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background p-4 inset-ring inset-ring-border"
      data-read-failed=""
      role="alert"
    >
      <div className="flex min-w-0 items-start gap-2">
        <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-ink-2" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-ink">{title}</span>
          {said ? <span className="text-meta text-ink-3 [overflow-wrap:anywhere]">{said}</span> : null}
        </div>
      </div>
      <Button type="button" size="sm" disabled={retrying} onClick={onRetry}>
        <RotateCw aria-hidden className={cn(retrying && 'motion-safe:animate-spin')} />
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  );
}

/** The step a signed-out visitor takes: the Worker's sign-in page, which returns here. */
export function SignIn() {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background p-4 inset-ring inset-ring-border"
      data-sign-in=""
    >
      <span className="text-sm font-medium text-ink">Sign in to see your tasks</span>
      <Button variant="primary" asChild>
        {/* A full page load: the Worker serves the sign-in page, not this app. */}
        <a href={SIGN_IN_PATH}>
          <LogIn aria-hidden />
          Sign in
        </a>
      </Button>
    </div>
  );
}

/** A screen still loading shows its shape, never a value. */
export function PageSkeleton({ shape }: { shape: 'list' | 'page' }) {
  const rows = shape === 'list' ? 6 : 3;
  return (
    <div className="flex flex-col gap-3" role="status" data-page-skeleton={shape}>
      <span className="sr-only">Loading…</span>
      <div aria-hidden className="skeleton-group flex flex-col gap-3">
        <div className="skeleton h-8 w-2/3 rounded-md" />
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="skeleton h-10 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}
