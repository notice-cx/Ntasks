import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * The one card shape: one border, no shadow, so hierarchy comes from scale.
 * A `kind` tints the card by its subject, never by a verdict: an open bug's
 * page has the alert tint whatever its priority.
 */
export type CardKind = 'money' | 'alert' | 'win' | 'neutral';

const KIND_CLASS: Record<CardKind, string> = {
  money: 'border-surface-money-line bg-linear-to-b from-surface-money to-card to-70% shadow-[inset_0_1px_0_0_var(--surface-highlight)]',
  alert: 'border-surface-alert-line bg-linear-to-b from-surface-alert to-card to-70% shadow-[inset_0_1px_0_0_var(--surface-highlight)]',
  win: 'border-surface-win-line bg-linear-to-b from-surface-win to-card to-70% shadow-[inset_0_1px_0_0_var(--surface-highlight)]',
  neutral: 'border-border bg-linear-to-b from-surface-neutral to-card to-60% shadow-[inset_0_1px_0_0_var(--surface-highlight)]',
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  kind?: CardKind;
}

export function Card({ className, kind, ...props }: CardProps) {
  return (
    <div
      data-surface-kind={kind}
      className={cn('rounded-[10px] border text-card-foreground', kind ? KIND_CLASS[kind] : 'border-border bg-card', className)}
      {...props}
    />
  );
}
