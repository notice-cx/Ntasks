/**
 * The states the task page and Focus share while their read is not in hand:
 * a read that failed, a visitor who must sign in, and loading.
 */
import { CircleAlert, LogIn, RotateCw } from 'lucide-react';
import { needsSignIn } from '../api/client';
import { useSignIn } from '../api/context';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

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

/**
 * The step a signed-out visitor takes: by default the Worker's sign-in page,
 * which returns here; inside a host, whatever its token source's sign-in does.
 */
export function SignIn() {
  const signIn = useSignIn();
  const label = (
    <>
      <LogIn aria-hidden />
      Sign in
    </>
  );
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-background p-4 inset-ring inset-ring-border"
      data-sign-in=""
    >
      <span className="text-sm font-medium text-ink">Sign in to see your tasks</span>
      {typeof signIn === 'string' ? (
        <Button variant="primary" asChild>
          {/* A full page load: the sign-in page is not one of this app's. */}
          <a href={signIn}>{label}</a>
        </Button>
      ) : (
        <Button variant="primary" type="button" onClick={() => signIn()}>
          {label}
        </Button>
      )}
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
