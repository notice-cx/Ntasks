import { Slot } from '@radix-ui/react-slot';
import { type VariantProps, cva } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Buttons. `primary` is the one action a view is for (New task, Approve,
 * Answer); `secondary` is every other labelled action; `ghost` sits in a bar
 * or a row where a border would be noise. `md` is 30 px tall and `sm` 26 px,
 * for rows and dense bars. On a touch screen each grows one step. Icons
 * inside are Text 3 (on accent, white), 15 px in `md` and 14 px in `sm`.
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium',
    'transition-[background-color,color,filter] duration-120 ease-out',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45',
    '[&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-on-accent hover:brightness-108 [&_kbd]:bg-white/18 [&_kbd]:text-on-accent [&_kbd]:inset-ring-0 [&_svg]:text-on-accent',
        secondary: 'bg-background text-ink shadow-raise inset-ring inset-ring-border hover:bg-hover [&_svg]:text-ink-3',
        ghost: 'bg-transparent text-ink-2 hover:bg-hover hover:text-ink [&_svg]:text-ink-3',
      },
      size: {
        md: 'h-7.5 gap-1.5 px-2.5 text-label pointer-coarse:h-9 [&_svg]:size-[15px]',
        sm: 'h-6.5 gap-1.25 px-2 text-meta pointer-coarse:h-7.5 [&_svg]:size-3.5',
      },
      icon: { true: 'px-0', false: '' },
    },
    compoundVariants: [
      { size: 'md', icon: true, className: 'w-7.5 pointer-coarse:w-9 [&_svg]:size-4' },
      { size: 'sm', icon: true, className: 'w-6.5 pointer-coarse:w-7.5 [&_svg]:size-[15px]' },
    ],
    defaultVariants: { variant: 'secondary', size: 'md', icon: false },
  },
);

type ButtonVariants = Omit<VariantProps<typeof buttonVariants>, 'icon'>;

export interface ButtonProps extends ComponentProps<'button'>, ButtonVariants {
  /** Draw the child element (a link) with the button's look. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'aria-label' | 'children'>, ButtonVariants {
  /** The action's name. It is the button's accessible name and its tooltip, since nothing else on screen says it. */
  label: string;
  /** The action's key, added to the tooltip. */
  shortcut?: string;
  icon: ReactNode;
}

/** A square button with only an icon. It must have a label: a screen reader reads it, and a pointer shows it on hover. */
export function IconButton({
  label,
  shortcut,
  icon,
  className,
  variant = 'ghost',
  size,
  title,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? (shortcut ? `${label} (${shortcut})` : label)}
      className={cn(buttonVariants({ variant, size, icon: true, className }))}
      {...props}
    >
      {icon}
    </button>
  );
}
