import { Bot } from 'lucide-react';
import { Children, type CSSProperties, type ReactNode } from 'react';
import { avatarFace, avatarMarkSize } from '@/lib/symbols';
import { cn } from '@/lib/utils';
import { ClaudeMark, CodexMark } from './symbols';

/** The sizes an avatar is drawn at: 18 in the sidebar, 20 in rows, 28 in a heading, 40 on a person's own page. */
export type AvatarSize = 18 | 20 | 28 | 40;

export interface AvatarProps {
  /** The display name, or the actor id when the API sent no name. */
  name: string;
  /** The model the actor named, which marks it as an agent. */
  model?: string | null;
  /** Known to be an agent though it named no model. */
  agent?: boolean;
  size?: AvatarSize;
  /** Active now: a small Accent dot at the corner. */
  live?: boolean;
  /** Hide it from screen readers when the name is written beside it. */
  decorative?: boolean;
  className?: string;
}

/**
 * A person or an agent. A person is their initials on grey. Claude and Codex
 * are their marks on a ringed circle; any other agent is a plain agent icon
 * there. Every mark is drawn at the same share of the circle
 * (`avatarMarkSize`), so Codex's is never larger than Claude's.
 */
export function Avatar({ name, model, agent, size = 20, live = false, decorative = false, className }: AvatarProps) {
  const face = avatarFace({ name, model: model ?? null, agent: agent ?? false });
  const mark = avatarMarkSize(size);
  const circle = (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full',
        face.kind === 'person'
          ? 'bg-avatar font-semibold tracking-[-0.01em] text-avatar-ink'
          : 'bg-mark-bg inset-ring inset-ring-border',
        !live && className,
      )}
      style={{ width: size, height: size, fontSize: face.kind === 'person' ? size * 0.42 : undefined } as CSSProperties}
      data-avatar={face.kind}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
    >
      {face.kind === 'person' ? (
        <span aria-hidden className="leading-none">
          {face.initials}
        </span>
      ) : face.kind === 'claude' ? (
        <ClaudeMark size={mark} />
      ) : face.kind === 'codex' ? (
        <CodexMark size={mark} />
      ) : (
        <Bot aria-hidden size={mark} strokeWidth={1.75} className="text-ink-2" />
      )}
    </span>
  );
  if (!live) return circle;
  return (
    <span className={cn('relative inline-flex shrink-0', className)} data-live="">
      {circle}
      <span
        aria-hidden
        className="absolute -right-px -bottom-px size-[7px] rounded-full bg-accent ring-2 ring-canvas"
      />
    </span>
  );
}

/** Avatars that overlap by 6 px, each ringed in Background, for the people on one task. */
export function AvatarGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center', className)}>
      {Children.map(children, (child, index) => (
        <span className={cn('inline-flex rounded-full ring-2 ring-background', index > 0 && '-ml-1.5')}>{child}</span>
      ))}
    </span>
  );
}
