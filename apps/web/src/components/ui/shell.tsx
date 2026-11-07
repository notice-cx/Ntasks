import { Slot, Slottable } from '@radix-ui/react-slot';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { NtasksLogo } from './symbols';

/**
 * The app's frame: a 236 px sidebar on Canvas and the page on Background,
 * divided by Border. On a phone the sidebar is hidden and the page takes the
 * width; the page's top bar opens it.
 */
export function AppShell({
  sidebar,
  children,
  className,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid min-h-screen grid-cols-[236px_minmax(0,1fr)] bg-canvas max-sm:grid-cols-1', className)}>
      {sidebar}
      <main className="min-w-0 border-l border-border bg-background max-sm:border-l-0">{children}</main>
    </div>
  );
}

export function Sidebar({ className, children, ...props }: ComponentProps<'nav'>) {
  return (
    <nav
      className={cn('sticky top-0 flex h-screen flex-col gap-0.5 px-2.5 pt-2.5 pb-4 max-sm:hidden', className)}
      {...props}
    >
      {children}
    </nav>
  );
}

/** The sidebar's first line: the logo, the workspace's name, and its search and new-task buttons. */
export function SidebarHeader({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <div className="mb-2 flex h-9 items-center gap-2 ps-2 pe-1.5">
      <NtasksLogo size={20} />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{name}</span>
      {children}
    </div>
  );
}

/** A heading over a part of the sidebar: Projects, People. */
export function NavSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5" aria-label={title}>
      <h2 aria-hidden className="mx-2 mt-4.5 mb-1 text-xs font-medium text-ink-3">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * One place in the sidebar: a 16 px icon or symbol, its name and its count.
 * The current one is on Hover in Text. Pass a router link as the child with
 * `asChild`, so the item is the link.
 */
export function NavItem({
  icon,
  count,
  active = false,
  asChild = false,
  className,
  children,
  ...props
}: ComponentProps<'a'> & {
  icon: ReactNode;
  /** The count at the end: a number, or a `Count` for the amber waiting count. */
  count?: ReactNode;
  active?: boolean;
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot : 'a';
  return (
    <Comp
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-7.5 items-center gap-2.25 rounded-md px-2 text-nav font-medium text-ink-2 no-underline',
        'transition-colors duration-120 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent',
        'aria-[current=page]:bg-hover aria-[current=page]:text-ink',
        '[&_svg]:shrink-0 [&>svg]:size-4 [&>svg]:text-ink-3 aria-[current=page]:[&>svg]:text-ink-2',
        className,
      )}
      {...props}
    >
      {icon}
      {/* With asChild the child is the link, and its text is the label. */}
      {asChild ? <Slottable>{children}</Slottable> : <span className="min-w-0 truncate">{children}</span>}
      {count === undefined || count === null ? null : typeof count === 'number' ? (
        <span className="nums ms-auto text-xs font-medium text-ink-3">{count}</span>
      ) : (
        <span className="ms-auto">{count}</span>
      )}
    </Comp>
  );
}

/** The first letter of a project's prefix (`web` is W) in a 16 px ringed square: the project's mark in the sidebar and in a page's path. */
export function ProjectBadge({ prefix, className }: { prefix: string; className?: string }) {
  const letter = (prefix.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-sm bg-background text-[10px] leading-4 font-semibold text-ink-2 inset-ring inset-ring-border-strong',
        className,
      )}
    >
      {letter}
    </span>
  );
}

/** Pushes what follows to the sidebar's foot, such as Settings. */
export function SidebarSpacer() {
  return <div aria-hidden className="flex-1" />;
}

/**
 * A page's top bar, 56 px: its title (or a path of links), then its views,
 * then its search and actions at the end.
 */
export function TopBar({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        'flex h-14 items-center gap-2.5 border-b border-border ps-6 pe-5 max-sm:h-13 max-sm:ps-4 max-sm:pe-3',
        className,
      )}
    >
      {typeof title === 'string' ? (
        <h1 className="m-0 me-2 text-page-title text-ink max-sm:text-lg">{title}</h1>
      ) : (
        title
      )}
      {children}
    </header>
  );
}

/** Takes the free width in a top bar, so what follows sits at its end. */
export function BarSpacer() {
  return <span aria-hidden className="flex-1" />;
}
