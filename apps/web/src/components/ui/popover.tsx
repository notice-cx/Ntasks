import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * An anchored panel on Radix: Radix owns focus, Escape and outside-press
 * closing, and placement. It is the popover elevation: Background, 8 px
 * corners and `shadow-pop`, whose first ring is its edge. Menus (menu.tsx)
 * are built on it.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  align = 'start',
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 max-h-(--radix-popover-content-available-height) w-72 overflow-auto rounded-lg bg-background p-3 text-ink shadow-pop outline-none motion-safe:animate-pop-in',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
