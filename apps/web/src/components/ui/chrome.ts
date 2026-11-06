import { cn } from '@/lib/utils';

/**
 * The control chrome every page shares, declared once as class strings
 * because the call sites are different elements with different props.
 */

/** Every `<input>`, `<select>` and `<textarea>`: the box, the thumb floor on a
 * phone and the disabled dim. A select keeps its end padding for its chevron. */
export const fieldClass =
  'rounded-md border border-input bg-background px-2 py-1 text-sm outline-none max-sm:min-h-11 focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-60 [&:is(select)]:pe-9';

/** No native outline, a visible focus ring, and 44px under a thumb. */
export const pillControlClass = 'outline-none max-sm:min-h-11 focus-visible:ring-[3px] focus-visible:ring-ring';

export const pillClass = 'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs';

/** A picker: only the picked option has edges. */
export function pillPickerStateClass(picked: boolean): string {
  return picked
    ? 'border-primary/30 bg-accent-soft font-medium text-primary'
    : 'border-transparent text-muted-foreground hover:bg-muted';
}

/** A row of choices where every option keeps its border, so a press never reflows the row. */
export const pillChoiceClass = cn(
  pillClass,
  pillControlClass,
  'whitespace-nowrap rounded-full px-2.5 font-medium transition-colors',
);

export function pillChoiceStateClass(selected: boolean): string {
  return selected
    ? 'border-primary/30 bg-accent-soft text-primary'
    : 'border-border text-muted-foreground hover:bg-muted/60';
}

/** A section's eyebrow: small, tracked, uppercase. */
export const eyebrowClass = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

/** A link in running text. */
export const inlineLinkClass = cn('text-foreground underline-offset-4 hover:underline', pillControlClass);
