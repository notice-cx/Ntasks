/**
 * How a task looks, defined once for every page that draws one: its
 * priority, its type, its status and what it asks of a person.
 */
import {
  Ban,
  Bug,
  Check,
  Circle,
  CircleDot,
  CircleHelp,
  Hourglass,
  Layers,
  Scale,
  Snowflake,
  Sparkles,
  Square,
  Stamp,
  Ticket,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { STATE_TONE, StateChip, type StateTone } from '@/components/surface';
import { isGate, priorityBand, TASK_STATUSES, type PriorityBand, type StatusKey } from '@/lib/task-model';
import { cn } from '@/lib/utils';

// --- Priority: a rank, never a severity -------------------------------------

/** Red and amber say something is failing; a top-priority task is not. So
 * priority ranks by ink weight: a filled `!` at top, a ringed `!` at high,
 * and a quiet `◦` below. */
export function priorityFace(priority: number): { band: PriorityBand; glyph: '!' | '◦'; ink: string } {
  const band = priorityBand(priority);
  if (priority <= 0) return { band, glyph: '!', ink: 'border-foreground bg-foreground text-background' };
  if (priority === 1) return { band, glyph: '!', ink: 'text-foreground' };
  return { band, glyph: '◦', ink: 'text-muted-foreground' };
}

export function markRingClass(size: 'row' | 'chip'): string {
  return cn(
    'grid shrink-0 place-items-center rounded-full border-current font-semibold leading-none',
    size === 'row' ? 'size-4.5 border-[1.5px] text-[11px]' : 'size-3.5 border text-[9px]',
  );
}

export function PriorityMark({
  priority,
  size = 'row',
  className,
}: {
  priority: number;
  size?: 'row' | 'chip';
  className?: string;
}) {
  const face = priorityFace(priority);
  return (
    <span aria-hidden data-priority-mark={face.band} className={cn(markRingClass(size), face.ink, className)}>
      {face.glyph}
    </span>
  );
}

export function PriorityChip({ priority }: { priority: number }) {
  return (
    <StateChip
      tone={priority <= 2 ? 'neutral' : 'na'}
      glyph={<PriorityMark priority={priority} size="chip" />}
      label={`${priorityFace(priority).band} priority`}
    />
  );
}

// --- Type: what kind of task it is ------------------------------------------

const TYPE_WORDS: Readonly<Record<string, string>> = {
  task: 'Task',
  bug: 'Bug',
  feature: 'Feature',
  chore: 'Chore',
  epic: 'Epic',
  decision: 'Decision',
};

const TYPE_ICONS: Readonly<Record<string, LucideIcon>> = {
  task: Ticket,
  bug: Bug,
  feature: Sparkles,
  chore: Wrench,
  epic: Layers,
  decision: Scale,
};

/** A type as the pages word it. An approval a person answers is an Approval; a type this build does not know is shown as itself. */
export function taskTypeWord(issueType: string, awaitType: string | null = null): string {
  if (issueType === 'gate') return (awaitType ?? 'human') === 'human' ? 'Approval' : 'Gate';
  return TYPE_WORDS[issueType] ?? issueType.charAt(0).toUpperCase() + issueType.slice(1);
}

/** A type's mark: a shape per type in neutral ink, because a type is not a
 * state. An open bug is the one problem among them, so its mark and its
 * page's header wear the alert surface; closed, it is ink again. */
export function typeFace(issueType: string, awaitType: string | null, status: string | null) {
  const icon =
    issueType === 'gate' ? ((awaitType ?? 'human') === 'human' ? Stamp : Hourglass) : (TYPE_ICONS[issueType] ?? Square);
  const problem = issueType === 'bug' && status !== 'closed';
  return {
    word: taskTypeWord(issueType, awaitType),
    icon,
    surface: problem ? ('alert' as const) : ('neutral' as const),
    tile: problem
      ? 'bg-error-soft text-error ring-error/40'
      : status === 'closed'
        ? 'bg-muted text-muted-foreground ring-border'
        : 'bg-card text-foreground ring-border',
  };
}

export function TypeMark({
  issueType,
  awaitType,
  status,
}: {
  issueType: string;
  awaitType: string | null;
  status: string | null;
}) {
  const face = typeFace(issueType, awaitType, status);
  const Icon = face.icon;
  return (
    <span
      aria-hidden
      data-task-type-mark={issueType}
      className={cn('grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset', face.tile)}
    >
      <Icon className="size-[1.125rem]" strokeWidth={2} />
    </span>
  );
}

// --- An ask: a task waiting on a person --------------------------------------

/** Every ask is `warn` at every priority: a person being the next step is not
 * a failure. An approval keeps the `△` that says it holds other work. */
export function askGlyph(task: Parameters<typeof isGate>[0]): '!' | '△' {
  return isGate(task) ? '△' : '!';
}

// --- Status: one glyph, one tone, one word, on every page --------------------

/** Read left to right: an empty circle nobody has taken, a circle with
 * something in it, a barred circle, a parked snowflake, a tick. A closed task
 * wears no green: closing records what shipped, not a measured outcome. Only
 * Blocked is an attention tone. */
const STATUS_LOOK: Readonly<Record<StatusKey, { icon: LucideIcon; tone: StateTone }>> = {
  open: { icon: Circle, tone: 'neutral' },
  'in-progress': { icon: CircleDot, tone: 'affirmative' },
  blocked: { icon: Ban, tone: 'caution' },
  parked: { icon: Snowflake, tone: 'na' },
  closed: { icon: Check, tone: 'na' },
};

export interface StatusFace {
  key: string;
  stored: string;
  label: string;
  icon: LucideIcon;
  tone: StateTone;
}

/** A stored status as its face. A status this build does not know is shown as itself behind a question mark. */
export function statusFace(stored: string): StatusFace {
  const known = TASK_STATUSES.find((status) => status.stored === stored);
  if (!known) return { key: 'unknown', stored, label: stored, icon: CircleHelp, tone: 'neutral' };
  return { key: known.key, stored: known.stored, label: known.label, ...STATUS_LOOK[known.key] };
}

export function TaskStatusGlyph({ status, className }: { status: string; className?: string }) {
  const face = statusFace(status);
  const Icon = face.icon;
  return (
    <Icon
      role="img"
      aria-label={`State: ${face.label}`}
      data-task-status-glyph={face.key}
      className={cn('size-3.5 shrink-0', STATE_TONE[face.tone].text, className)}
    />
  );
}

/** A status compact, for a table cell: glyph and word, no pill. */
export function TaskStatusMark({ status }: { status: string }) {
  const face = statusFace(status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <TaskStatusGlyph status={status} />
      <span className={cn('text-xs', STATE_TONE[face.tone].text)} data-task-status={face.key}>
        {face.label}
      </span>
    </span>
  );
}

export function TaskStatusChip({ status }: { status: string }) {
  const face = statusFace(status);
  const Icon = face.icon;
  return (
    <StateChip
      tone={face.tone}
      glyph={<Icon className="size-3.5" />}
      label={<span data-task-status={face.key}>{face.label}</span>}
    />
  );
}

/** A closed or parked task's row mark: its status glyph in the priority mark's ring. */
export function RestingMark({ status, className }: { status: string; className?: string }) {
  const face = statusFace(status);
  const Icon = face.icon;
  return (
    <span
      aria-hidden
      data-task-rest-mark={face.key}
      className={cn(markRingClass('row'), STATE_TONE[face.tone].text, className)}
    >
      <Icon className="size-2.5" strokeWidth={3} />
    </span>
  );
}
