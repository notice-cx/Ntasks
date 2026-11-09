/**
 * The symbols: status, priority and type marks, the brand marks, the Ntasks
 * logo and a workspace's icon. src/lib/symbols.ts decides which one a task, a
 * person or a workspace gets; this module only draws them. Each is coloured
 * by tokens, so it follows the theme.
 */
import {
  ClipboardCheck,
  Bug,
  Hourglass,
  Layers,
  Lightbulb,
  ListChecks,
  Split,
  SquareDashed,
  Stamp,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ReactElement, SVGProps } from 'react';
import { ACTIVITY_LABELS, type Activity } from '../../lib/live';
import { priorityBand } from '../../lib/task-model';
import {
  priorityBars,
  priorityLabel,
  STATUS_MARK_LABELS,
  TYPE_MARK_LABELS,
  workspaceMark,
  type StatusMark as StatusMarkKey,
  type TypeMark as TypeMarkKey,
} from '../../lib/symbols';
import { cn } from '../../lib/utils';
import { BLOSSOM_PATH, BLOSSOM_VIEWBOX, CLAUDE_ORANGE, CLAUDE_PATH, CLAUDE_VIEWBOX, GITHUB_PATH } from './brand-marks';

/** A mark's name for a screen reader, or `null` when words beside it already say it. */
type Labelled = { label?: string | null };

function a11y(label: string | null) {
  return label === null ? ({ 'aria-hidden': true } as const) : ({ role: 'img', 'aria-label': label } as const);
}

// --- Status: circles, 14 px in rows and 20 px in headings ---------------------

const STATUS_SHAPES: Readonly<Record<StatusMarkKey, (muted: boolean) => ReactElement>> = {
  open: () => <circle cx="7" cy="7" r="5.25" fill="none" className="stroke-ink-3" strokeWidth="1.5" />,
  'in-progress': () => (
    <>
      <circle cx="7" cy="7" r="5.25" fill="none" className="stroke-accent" strokeWidth="1.5" />
      <path d="M7 3.75a3.25 3.25 0 0 1 0 6.5z" className="fill-accent" />
    </>
  ),
  blocked: () => (
    <>
      <circle cx="7" cy="7" r="6" className="fill-block" />
      <rect x="3.6" y="6.15" width="6.8" height="1.7" rx=".85" className="fill-background" />
    </>
  ),
  waiting: () => (
    <>
      <circle cx="7" cy="7" r="5.25" fill="none" className="stroke-wait" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2.4" className="fill-wait" />
    </>
  ),
  parked: () => (
    <circle cx="7" cy="7" r="5.25" fill="none" className="stroke-ink-3" strokeWidth="1.5" strokeDasharray="2.4 1.72" />
  ),
  done: (muted) => (
    <>
      <circle cx="7" cy="7" r="6" className={muted ? 'fill-ink-3' : 'fill-done'} />
      <path
        d="M4.3 7.2l1.8 1.8 3.6-3.8"
        fill="none"
        className="stroke-background"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
};

/**
 * A task's status. `muted` draws Done in Text 3 instead of green, for a
 * close where nothing shipped (won't do, duplicate and the rest).
 */
export function StatusMark({
  status,
  size = 14,
  muted = false,
  label,
  className,
}: Labelled & { status: StatusMarkKey; size?: number; muted?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      className={cn('block shrink-0', className)}
      data-status-mark={status}
      {...a11y(label === undefined ? STATUS_MARK_LABELS[status] : label)}
    >
      {STATUS_SHAPES[status](muted && status === 'done')}
    </svg>
  );
}

// --- Activity: how recently a held task's holder worked on it -----------------

/** Active is a filled Accent disc in a faint ring; Quiet is the In progress mark; Stalled is that mark in Text 3. */
const ACTIVITY_SHAPES: Readonly<Record<Activity, ReactElement>> = {
  active: (
    <>
      <circle cx="7" cy="7" r="6.1" fill="none" className="stroke-accent" strokeOpacity=".35" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="3.6" className="fill-accent" />
    </>
  ),
  quiet: STATUS_SHAPES['in-progress'](false),
  stalled: (
    <>
      <circle cx="7" cy="7" r="5.25" fill="none" className="stroke-ink-3" strokeWidth="1.5" />
      <path d="M7 3.75a3.25 3.25 0 0 1 0 6.5z" className="fill-ink-3" />
    </>
  ),
};

/** How recently the holder of a task in progress worked on it (src/lib/live.ts). */
export function ActivityMark({
  activity,
  size = 14,
  label,
  className,
}: Labelled & { activity: Activity; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      className={cn('block shrink-0', className)}
      data-activity-mark={activity}
      {...a11y(label === undefined ? ACTIVITY_LABELS[activity] : label)}
    >
      {ACTIVITY_SHAPES[activity]}
    </svg>
  );
}

// --- Priority: signal bars; Top is a filled square ----------------------------

/** A priority, 0 (Top) to 4 (Lowest). Its colours are greys: priority ranks work, it is not an alarm. */
export function PriorityMark({
  priority,
  size = 14,
  label,
  className,
}: Labelled & { priority: number; size?: number; className?: string }) {
  const band = priorityBand(priority);
  const filled = priorityBars(priority);
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      className={cn('block shrink-0', className)}
      data-priority-mark={band}
      {...a11y(label === undefined ? `${priorityLabel(priority)} priority` : label)}
    >
      {band === 'top' ? (
        <>
          <rect x="1" y="1" width="12" height="12" rx="3" className="fill-ink" />
          <rect x="6.2" y="3.4" width="1.6" height="4.6" rx=".8" className="fill-background" />
          <circle cx="7" cy="10" r=".95" className="fill-background" />
        </>
      ) : band === 'lowest' ? (
        [0, 1, 2].map((i) => (
          <rect key={i} x={1.5 + i * 4.25} y="6.25" width="2.5" height="1.5" rx=".75" className="fill-border-strong" />
        ))
      ) : (
        [0, 1, 2].map((i) => (
          <rect
            key={i}
            x={1.5 + i * 4.25}
            y={10.5 - (i + 1) * 3}
            width="2.5"
            height={(i + 1) * 3}
            rx=".8"
            className={i < filled ? 'fill-ink-2' : 'fill-border-strong'}
          />
        ))
      )}
    </svg>
  );
}

// --- Type: a Lucide icon in Text 3 --------------------------------------------

export const TYPE_ICONS: Readonly<Record<TypeMarkKey, LucideIcon>> = {
  task: ListChecks,
  bug: Bug,
  feature: Lightbulb,
  epic: Layers,
  decision: Split,
  approval: Stamp,
  steps: ClipboardCheck,
  chore: Wrench,
  gate: Hourglass,
  other: SquareDashed,
};

export function TypeMark({
  type,
  size = 14,
  label,
  className,
}: Labelled & { type: TypeMarkKey; size?: number; className?: string }) {
  const Icon = TYPE_ICONS[type];
  const name = label === undefined ? (type === 'other' ? null : TYPE_MARK_LABELS[type]) : label;
  return (
    <Icon
      size={size}
      strokeWidth={1.75}
      className={cn('shrink-0 text-ink-3', className)}
      data-type-mark={type}
      {...a11y(name)}
    />
  );
}

// --- Brand marks and the logo ---------------------------------------------------

type MarkProps = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'width' | 'height'> & { size: number };

/** Claude's mark, in Claude's orange in both themes. */
export function ClaudeMark({ size, className, ...props }: MarkProps) {
  return (
    <svg
      viewBox={CLAUDE_VIEWBOX}
      width={size}
      height={size}
      className={cn('block shrink-0', className)}
      data-brand-mark="claude"
      aria-hidden
      {...props}
    >
      <path fill={CLAUDE_ORANGE} d={CLAUDE_PATH} />
    </svg>
  );
}

/** OpenAI's Blossom for Codex: black on light, white on dark. Drawn at Claude's size, never larger. */
export function CodexMark({ size, className, ...props }: MarkProps) {
  return (
    <svg
      viewBox={BLOSSOM_VIEWBOX}
      width={size}
      height={size}
      className={cn('block shrink-0', className)}
      data-brand-mark="codex"
      aria-hidden
      {...props}
    >
      <path className="fill-blossom" d={BLOSSOM_PATH} />
    </svg>
  );
}

/** GitHub's mark, in the text colour around it. */
export function GitHubMark({ size, className, ...props }: MarkProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn('block shrink-0', className)}
      aria-hidden
      {...props}
    >
      <path fill="currentColor" d={GITHUB_PATH} />
    </svg>
  );
}

/** The Ntasks logo: an N on Accent, 20 px in the sidebar and 28 to 32 px on a page of its own. */
export function NtasksLogo({ size = 20, className, ...props }: Omit<MarkProps, 'size'> & { size?: number }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      className={cn('block shrink-0', className)}
      aria-hidden
      {...props}
    >
      <rect width="20" height="20" rx="5.5" className="fill-accent" />
      <path
        d="M6.5 14V6l7 8V6"
        fill="none"
        className="stroke-on-accent"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A workspace's icon: the first letter of its name on the identity palette's
 * hue its id picks (`workspaceMark`), 20 px in the sidebar, 16 px in the
 * workspace menu and 32 px on Settings. The name always stands beside it, so
 * screen readers skip it.
 */
export function WorkspaceIcon({
  workspaceId,
  name,
  size = 20,
  className,
}: {
  workspaceId: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const { letter, hue } = workspaceMark(workspaceId, name);
  return (
    <span
      aria-hidden
      data-workspace-icon=""
      className={cn('inline-grid shrink-0 place-items-center leading-none font-semibold', className)}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.275,
        fontSize: size * 0.55,
        backgroundColor: `var(${hue.fill})`,
        color: `var(${hue.ink})`,
      }}
    >
      {letter}
    </span>
  );
}
