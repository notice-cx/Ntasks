/**
 * The Live page's board: every task in progress, then the closed work whose
 * change is on its way or live, in three columns. Between two reads a card
 * travels to its new column instead of jumping there.
 */
import { GitBranch, GitMerge, GitPullRequest } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { ProjectIcon } from '../../components/ProjectIcon';
import { Avatar } from '../../components/ui/avatar';
import { StatusMark } from '../../components/ui/symbols';
import { Tooltip } from '../../components/ui/tooltip';
import { useRecentChanges } from '../../hooks/useBoard';
import type { RecentChange } from '../../hooks/useChangeFeed';
import { useMedia } from '../../hooks/useMedia';
import { pullRequestLabel } from '../../lib/wins';
import { httpUrl } from '../../lib/custom-fields';
import { ageMs, formatAge, formatInt } from '../../lib/format';
import type { BoardProject } from '../../lib/board-read';
import {
  ACTIVITY_LABELS,
  activityOf,
  STAGE_LABELS,
  STAGES,
  stageTime,
  type Activity,
  type LiveBoard,
  type Stage,
} from '../../lib/live';
import { usePaths } from '../../lib/paths';
import { isAgentActor } from '../../lib/symbols';
import { actorLabel, claimedModel, closeAttribution, type BoardTask } from '../../lib/task-model';
import { cn } from '../../lib/utils';

const PHONE = '(width < 40rem)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** The cards a column shows before its count of the rest. In progress is the column people watch, so it shows more. */
const SHOWN: Readonly<Record<'wide' | 'phone', Readonly<Record<Stage, number>>>> = {
  wide: { progress: 6, shipping: 5, live: 4 },
  phone: { progress: 3, shipping: 3, live: 2 },
};

/** What a column holds, where its heading has room to say it. Only Live's needs saying: it reaches back a week. */
const COLUMN_RULES: Readonly<Partial<Record<Stage, string>>> = { live: 'Last 7 days' };

const COLUMN_MARKS: Readonly<Record<Stage, ReactNode>> = {
  progress: <StatusMark status="in-progress" label={null} />,
  shipping: <GitMerge aria-hidden size={14} className="shrink-0 text-ink-3" />,
  live: <StatusMark status="done" label={null} />,
};

/**
 * How strongly a card in progress is tinted Accent, the colour of work in
 * progress, by how recently its holder worked on it: Active fully, Quiet
 * faintly, Stalled not at all. Closed cards keep the plain Background.
 */
const ACTIVITY_TINTS: Readonly<Record<Activity, string>> = {
  // A 2 px edge, 1 px less padding: Active reads apart from Quiet where colours are forced, as in high contrast.
  active: 'border-2 border-accent/40 bg-accent-soft p-[9px]',
  quiet: 'border-accent/15 bg-accent-soft/40',
  stalled: 'border-dashed border-border-strong bg-transparent shadow-none',
};

/** Moves that one read starts together leave this far apart, so the eye can follow each. */
const STAGGER_MS = 110;
const TRAVEL_MS = 700;
/** How long a card that changed column stays tinted. */
const LANDED_MS = 700;
const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export function LiveBoardView({
  columns,
  projects,
  nowMs,
}: {
  columns: LiveBoard;
  /** The projects in view, by key, whose icons lead their tasks' cards. */
  projects: ReadonlyMap<string, BoardProject>;
  nowMs: number;
}) {
  const phone = useMedia(PHONE);
  const reduced = useMedia(REDUCED_MOTION);
  const recent = useRecentChanges();
  const root = useRef<HTMLDivElement>(null);
  useCardMotion(root, reduced);
  const shown = SHOWN[phone ? 'phone' : 'wide'];
  return (
    <div className="@container">
      <div
        ref={root}
        className="relative grid grid-cols-1 items-start gap-3 p-4 max-sm:p-3 @2xl:grid-cols-3"
        data-live-board=""
      >
        {STAGES.map((stage) => (
          <Column
            key={stage}
            stage={stage}
            tasks={columns[stage]}
            shown={shown[stage]}
            nowMs={nowMs}
            recent={recent}
            projects={projects}
          />
        ))}
      </div>
    </div>
  );
}

function Column({
  stage,
  tasks,
  shown,
  nowMs,
  recent,
  projects,
}: {
  stage: Stage;
  tasks: readonly BoardTask[];
  shown: number;
  nowMs: number;
  recent: ReadonlyMap<string, RecentChange>;
  projects: ReadonlyMap<string, BoardProject>;
}) {
  const label = STAGE_LABELS[stage];
  const rule = COLUMN_RULES[stage];
  const more = tasks.length - Math.min(tasks.length, shown);
  return (
    <section
      aria-label={label}
      data-live-column={stage}
      className="flex min-w-0 flex-col gap-2 rounded-xl bg-canvas p-2"
    >
      <h2 className="flex h-6 min-w-0 items-center gap-2 px-1 text-label font-semibold text-ink">
        {COLUMN_MARKS[stage]}
        <span className="whitespace-nowrap">{label}</span>
        <span className="nums font-medium text-ink-3">{formatInt(tasks.length)}</span>
        {rule ? <span className="ms-auto truncate text-meta font-normal text-ink-3">{rule}</span> : null}
      </h2>
      {tasks.length === 0 ? <p className="px-1 pb-1 text-meta text-ink-3">None</p> : null}
      {tasks.slice(0, shown).map((task) => (
        <Card
          key={task.id}
          task={task}
          stage={stage}
          nowMs={nowMs}
          change={recent.get(task.id)}
          project={projects.get(task.project)}
        />
      ))}
      {more > 0 ? (
        <p className="nums px-1 pb-1 text-meta text-ink-3" data-live-more="">
          {formatInt(more)} more
        </p>
      ) : null}
    </section>
  );
}

/**
 * A task on the board: its project's icon, its id and pull request, its
 * title, then what is next for it and, at the end, the icon of who holds it
 * or closed it, whose name and model show in a tooltip, and how long it has
 * been in its column. A task in progress shows its holder's next step, or
 * else its branch, and its tint says how recently they worked on it.
 */
function Card({
  task,
  stage,
  nowMs,
  change,
  project,
}: {
  task: BoardTask;
  stage: Stage;
  nowMs: number;
  /** The task's latest change the feed brought, which the card names for a moment. */
  change: RecentChange | undefined;
  /** The project the task is in, whose icon leads the card. */
  project: BoardProject | undefined;
}) {
  const paths = usePaths();
  const held = stage === 'progress';
  const activity = held ? activityOf(task, nowMs) : null;
  // A pull request that is not an http or https address shows no link, as on the task page.
  const pr = httpUrl(held ? (task.work?.pr ?? '') : (task.delivery?.pullRequest ?? ''));
  const closer = held ? null : closeAttribution(task);
  // A closed task can keep its holder after someone else closes it, so only the close names its closer.
  const actor = held ? task.assignee : (closer?.by ?? null);
  const name = actor ? actorLabel(actor, task.actors) : null;
  const model = held ? claimedModel(task) : (closer?.model ?? null);
  const age = ageMs(nowMs, stageTime(task, stage));
  const next = held ? (task.work?.next ?? null) : null;
  const branch = held ? (task.work?.branch ?? null) : null;
  // What its holder recorded: the next step, else the branch where no pull request stands in for it.
  let context: ReactNode = null;
  if (next) context = <span className="truncate">Next: {next}</span>;
  else if (branch && !pr) {
    context = (
      <>
        <GitBranch aria-hidden size={12} className="shrink-0" />
        <span className="truncate">{branch}</span>
      </>
    );
  } else if (held && age === null) context = <span>Nothing recorded</span>;
  else if (stage === 'shipping') {
    context = <span>{shippingStep(task)}</span>;
  }
  return (
    <article
      data-board-card={task.id}
      data-column={stage}
      data-activity={activity ?? undefined}
      className={cn(
        'relative flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-background p-2.5 shadow-raise',
        'transition-colors duration-700 data-landed:border-accent data-landed:bg-accent-soft data-landed:duration-0',
        'data-moving:z-10 data-moving:border-accent data-moving:shadow-pop',
        activity === null ? null : ACTIVITY_TINTS[activity],
      )}
    >
      <ChangeLabel change={change} />
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-ink-3">
        {project ? (
          <>
            <ProjectIcon project={project} size={16} />
            <span className="sr-only">{project.name}</span>
          </>
        ) : null}
        <span className="nums whitespace-nowrap">{task.id}</span>
        {/* The tint shows how recently its holder worked on it; a screen reader hears it. */}
        {activity ? <span className="sr-only">{ACTIVITY_LABELS[activity]}</span> : null}
        <span className="flex-1" />
        {pr ? (
          <a
            href={pr}
            target="_blank"
            rel="noreferrer"
            className="nums inline-flex shrink-0 items-center gap-1 text-accent-text no-underline hover:underline"
          >
            <GitPullRequest aria-hidden size={12} />
            {pullRequestLabel(pr)}
          </a>
        ) : null}
      </div>
      <Link
        to={paths.task(task.id)}
        className={cn(
          'line-clamp-2 text-label font-medium no-underline outline-none focus-visible:underline',
          activity === 'stalled' ? 'text-ink-2' : 'text-ink',
        )}
      >
        {task.title}
      </Link>
      {context || name || age !== null ? (
        <div className="flex min-w-0 items-center gap-1.5 text-meta text-ink-3">
          <span className="flex min-w-0 flex-1 items-center gap-1" data-live-context={context ? '' : undefined}>
            {context}
          </span>
          {actor && name ? (
            <Tooltip content={model ? `${name} · ${model}` : name}>
              <button
                type="button"
                aria-label={name}
                className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Avatar name={name} agent={isAgentActor(actor)} model={model} size={18} decorative />
              </button>
            </Tooltip>
          ) : null}
          {age === null ? null : <span className="nums shrink-0">{formatAge(age)}</span>}
        </div>
      ) : null}
    </article>
  );
}

/**
 * The step a card waiting to ship has left: a merge, or for a task closed
 * with a commit and no pull request, as in a project that commits straight to
 * its default branch, a push; then a deploy.
 */
function shippingStep(task: BoardTask): string {
  if (task.delivery?.stage !== 'built') return 'Not deployed yet';
  return task.delivery.pullRequest === null ? 'Not pushed yet' : 'Not merged yet';
}

/** How long a change's label stays on its card. */
const LABEL_MS = 2_400;

/**
 * Who changed the task and what they did, such as "Claude commented", on the
 * card's top edge for a moment after the change arrives. A change that
 * arrived longer ago than that, such as while another page was open, shows
 * nothing.
 */
function ChangeLabel({ change }: { change: RecentChange | undefined }) {
  const [shown, setShown] = useState<{ label: string; on: boolean }>({ label: '', on: false });
  useEffect(() => {
    if (change === undefined) return;
    const left = LABEL_MS - (Date.now() - change.receivedAt);
    if (left <= 0) return;
    setShown({ label: change.label, on: true });
    const timer = setTimeout(() => setShown({ label: change.label, on: false }), left);
    return () => clearTimeout(timer);
  }, [change]);
  return (
    <span
      aria-hidden={!shown.on}
      data-live-label={shown.on ? '' : undefined}
      className={cn(
        'pointer-events-none absolute -top-2.5 right-2 max-w-[calc(100%-1rem)] truncate rounded-full bg-accent px-2 text-chip font-semibold text-on-accent shadow-raise',
        'transition-opacity duration-300 motion-reduce:transition-none',
        shown.on ? 'opacity-100' : 'opacity-0',
      )}
    >
      {shown.label}
    </span>
  );
}

/** Where a card sits in the board, without the transform an animation adds, and its column. */
interface Place {
  x: number;
  y: number;
  column: string;
}

/** A card's layout position relative to `root`: offsets ignore transforms, so a card in flight reads where it lands. */
function placeOf(card: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let node: HTMLElement | null = card; node !== null && node !== root;) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
  }
  return { x, y };
}

function animate(element: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  return typeof element.animate === 'function' ? element.animate(frames, options) : null;
}

/** Tints a card that changed column for a moment, then lets the tint fade. */
function land(card: HTMLElement): void {
  card.setAttribute('data-landed', '');
  setTimeout(() => card.removeAttribute('data-landed'), LANDED_MS);
}

/**
 * After each draw, compares every card with where it was in the draw before
 * and animates the difference: a card that changed column travels there,
 * lifted, one after another; a card that moved within its column slides; and
 * a new card fades in. With reduced motion nothing travels: a card that
 * changed column is only tinted. The first draw animates nothing.
 */
function useCardMotion(board: RefObject<HTMLElement | null>, reduced: boolean): void {
  const before = useRef<Map<string, Place> | null>(null);
  useLayoutEffect(() => {
    const root = board.current;
    if (root === null) return;
    const cards = [...root.querySelectorAll<HTMLElement>('[data-board-card]')];
    const now = new Map<string, Place>();
    for (const card of cards) {
      now.set(card.dataset.boardCard ?? '', {
        ...placeOf(card, root),
        column: card.dataset.column ?? '',
      });
    }
    const last = before.current;
    before.current = now;
    if (last === null) return;
    let moves = 0;
    for (const card of cards) {
      const id = card.dataset.boardCard ?? '';
      const was = last.get(id);
      const is = now.get(id);
      if (is === undefined) continue;
      if (was === undefined) {
        if (!reduced)
          animate(
            card,
            [
              { opacity: 0, transform: 'translateY(6px)' },
              { opacity: 1, transform: 'none' },
            ],
            { duration: 300, easing: EASE_OUT },
          );
        continue;
      }
      const dx = was.x - is.x;
      const dy = was.y - is.y;
      if (was.column !== is.column) {
        if (reduced) {
          land(card);
        } else {
          card.setAttribute('data-moving', '');
          const flight = animate(
            card,
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: `translate(${dx * 0.4}px, ${dy * 0.4 - 10}px) scale(1.03)`, offset: 0.55 },
              { transform: 'none' },
            ],
            {
              duration: TRAVEL_MS,
              delay: moves * STAGGER_MS,
              easing: 'cubic-bezier(0.3, 0.1, 0.2, 1)',
              fill: 'backwards',
            },
          );
          moves += 1;
          const done = () => {
            card.removeAttribute('data-moving');
            land(card);
          };
          if (flight === null) done();
          else {
            flight.onfinish = done;
            flight.oncancel = () => card.removeAttribute('data-moving');
          }
        }
      } else if (!reduced && (dx !== 0 || dy !== 0)) {
        animate(card, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
          duration: 350,
          easing: EASE_OUT,
        });
      }
    }
  });
}
