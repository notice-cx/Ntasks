import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Layers, Lock, Pencil, Plus, Snowflake, X } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { TaskResolution } from '@ntasks/domain';
import { ApiError } from '@/api/client';
import type { LiveEpic, LiveTask, TaskActor, TaskChoiceKey, TaskComment, TaskEdit, TaskProject } from '@/api/types';
import { ChoiceButtons } from '@/components/ChoiceButtons';
import { CloseNoteForm, RESOLUTION_GLYPH, ResolutionChips } from '@/components/CloseResolution';
import { FactChip, factChipClass, type FactChoice } from '@/components/FactChip';
import { TaskTimeline, type TimelineEntry } from '@/components/TaskTimeline';
import { EmptyState, PageSkeleton, ReadFailed, SectionLabel, STATE_TONE } from '@/components/surface';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { eyebrowClass, fieldClass, inlineLinkClass } from '@/components/ui/chrome';
import { useNow } from '@/hooks/useNow';
import {
  fieldAvailable,
  operationAvailable,
  useAnswerHides,
  useBoards,
  useCapabilities,
  useClaimTask,
  useCloseTask,
  useCommentOnTask,
  useInboxAnswer,
  useTask,
  useTaskProjects,
  useUpdateTask,
  verbReason,
} from '@/hooks/useTasks';
import { ageMs, calendarDay, formatAge, formatInt, localDay } from '@/lib/format';
import {
  actorLabel,
  choiceName,
  claimedModel,
  closeAttribution,
  closeNote,
  inboxAsk,
  isBlockingLink,
  PRIORITY_BANDS,
  RESOLUTION_LABELS,
  TASK_STATUSES,
} from '@/lib/task-model';
import { taskPath, taskPrefix } from '@/lib/task-path';
import { cn } from '@/lib/utils';
import { useAskActions } from './tasks/ask-actions';
import { PriorityMark, statusFace, TaskStatusGlyph } from './tasks/task-face';
import {
  ChoiceSummary,
  ClosedSummary,
  EpicProgress,
  TaskHead,
  type Crumb,
  type TaskHeadFacts,
} from './tasks/task-head';
import { MarkdownText, TaskPrefixesProvider, taskListItems, toggleTaskListLine } from './tasks/task-markdown';

const CONTENT_SECTION = 'flex min-w-0 flex-col gap-3 p-4 md:p-5';
const UNAVAILABLE = 'This sign-in cannot do this.';

/** `/tasks/:id`: one task, whole. Its project is the one whose prefix starts the id. */
export function TaskRoute() {
  const { id = '' } = useParams<{ id: string }>();
  const now = useNow();
  const catalog = useTaskProjects();
  const project = catalog.data?.find((row) => row.prefix === taskPrefix(id)) ?? null;
  const detail = useTask(id, project?.logicalKey ?? null);
  const [board] = useBoards(project ? [project.logicalKey] : []);
  const task = detail.data?.task ?? null;
  const actors = detail.data?.actors;
  const prefixes = useMemo(() => new Set((catalog.data ?? []).map((row) => row.prefix)), [catalog.data]);
  const siblings = board?.data?.tasks ?? [];
  const epics = board?.data?.epics ?? [];
  const notFound =
    (catalog.data !== undefined && project === null) ||
    (detail.error instanceof ApiError && detail.error.status === 404);

  let body: ReactNode;
  if (catalog.isError) {
    body = (
      <ReadFailed
        title="Couldn't load your projects"
        error={catalog.error}
        retrying={catalog.isFetching}
        onRetry={() => void catalog.refetch()}
      />
    );
  } else if (notFound) {
    body = (
      <Card className="p-4" data-task-not-found="">
        <EmptyState
          title="No task with this id"
          hint={
            <>
              <span className="font-mono">{id}</span> ·{' '}
              <Link to="/tasks" className={inlineLinkClass}>
                Back to Tasks
              </Link>
            </>
          }
        />
      </Card>
    );
  } else if (detail.isError) {
    body = (
      <ReadFailed
        title={`Couldn't load ${id}`}
        error={detail.error}
        retrying={detail.isFetching}
        onRetry={() => void detail.refetch()}
      />
    );
  } else if (task === null || project === null || detail.data === undefined) {
    body = <PageSkeleton shape="page" />;
  } else {
    const parent = task.parent ? (epics.find((epic) => epic.id === task.parent) ?? null) : null;
    const parentTitle = parent?.title ?? siblings.find((row) => row.id === task.parent)?.title ?? null;
    const crumbs: Crumb[] = [
      { label: 'Tasks', to: '/tasks' },
      { label: project.displayName, to: `/tasks?${new URLSearchParams({ project: project.logicalKey })}` },
      ...(task.parent ? [{ label: parentTitle ?? task.parent, to: taskPath(task.parent) }] : []),
    ];
    body = (
      <TaskPrefixesProvider value={prefixes}>
        <TaskPage
          task={task}
          project={project}
          readAt={detail.data.readAt}
          comments={detail.data.comments}
          actors={actors}
          crumbs={crumbs}
          parent={parent}
          parentTitle={parentTitle}
          epic={epics.find((epic) => epic.id === task.id) ?? null}
          siblings={siblings}
          epics={epics}
          nowMs={now}
        />
      </TaskPrefixesProvider>
    );
  }

  return (
    <div
      className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 p-4 md:p-6 motion-safe:[&_button:not(:disabled):active]:translate-y-px"
      data-task-page=""
    >
      {body}
    </div>
  );
}

function TaskPage({
  task,
  project,
  readAt,
  comments,
  actors,
  crumbs,
  parent,
  parentTitle,
  epic,
  siblings,
  epics,
  nowMs,
}: {
  task: LiveTask;
  project: TaskProject;
  readAt: string;
  comments: TaskComment[];
  actors: readonly TaskActor[] | undefined;
  crumbs: Crumb[];
  parent: LiveEpic | null;
  parentTitle: string | null;
  /** This task's own progress, when it is an epic. */
  epic: LiveEpic | null;
  siblings: readonly LiveTask[];
  epics: readonly LiveEpic[];
  nowMs: number;
}) {
  const key = project.logicalKey;
  const head: TaskHeadFacts = {
    title: task.title,
    issueType: task.issueType,
    awaitType: task.awaitType,
    status: task.status,
    priority: task.priority,
    holder:
      task.status !== 'closed' && task.assignee
        ? { name: actorLabel(task.assignee, actors), model: claimedModel(task), since: task.startedAt }
        : null,
    ask: inboxAsk(task),
    progress: epic ? { closed: epic.closed, total: epic.total } : null,
  };
  // A decision closed by a pick carries the pick as its reason; the choice under the header already says it.
  const closedByPick = task.choice
    ? task.closeReason?.trim() === `Chose ${choiceName(task.choice.option, task.choice.label)}`
    : false;
  const resolution: TaskResolution = task.resolution ?? 'done';
  const closer = closeAttribution(task);
  const note = closeNote(task.closeReason, resolution, task.duplicateOf ?? null);
  const blockers = task.dependencies.filter((edge) => isBlockingLink(edge.type));
  const blocked = siblings.filter((other) =>
    other.dependencies.some((edge) => isBlockingLink(edge.type) && edge.id === task.id),
  );
  const related = task.dependencies.filter((edge) => edge.type === 'related' || edge.type === 'discovered-from');
  const children = siblings.filter((row) => row.parent === task.id);

  return (
    <>
      <TaskHeader task={task} project={key} head={head} readAt={readAt} actors={actors} crumbs={crumbs} nowMs={nowMs}>
        {task.status === 'closed' && !closedByPick ? (
          <ClosedSummary
            by={closer ? [actorLabel(closer.by, actors), closer.model].filter(Boolean).join(' · ') : null}
            at={task.closedAt}
            nowMs={nowMs}
            resolution={resolution}
            duplicate={
              task.duplicateOf ? (
                <Link to={taskPath(task.duplicateOf)} className={cn(inlineLinkClass, 'font-mono')}>
                  {task.duplicateOf}
                </Link>
              ) : undefined
            }
          >
            {note ? <MarkdownText source={note} /> : null}
          </ClosedSummary>
        ) : null}
      </TaskHeader>
      {/* A laptop reads the work on the left and its facts on the right; a phone reads the facts first. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,22rem)] lg:items-start lg:gap-6">
        <Facts
          className="lg:col-start-2 lg:row-start-1"
          task={task}
          project={project}
          parent={parent}
          parentTitle={parentTitle}
          epics={epics}
          people={holders(siblings)}
          actors={actors}
          nowMs={nowMs}
        />
        <Card
          className="viz-arrive min-w-0 divide-y divide-border/70 shadow-raised lg:col-start-1 lg:row-start-1"
          data-task-content=""
        >
          <Body task={task} project={key} />
          {blockers.length > 0 || blocked.length > 0 ? (
            <section className={CONTENT_SECTION} data-task-dependencies="">
              <div className="grid gap-4 sm:grid-cols-2">
                <LinkList
                  title="Waits on"
                  empty="Nothing"
                  rows={blockers.map((edge) => ({ id: edge.id, title: edge.title, status: edge.status }))}
                />
                <LinkList
                  title="Holds back"
                  empty="Nothing"
                  rows={blocked.map((row) => ({ id: row.id, title: row.title, status: row.status }))}
                />
              </div>
            </section>
          ) : null}
          {related.length > 0 ? (
            <section className={CONTENT_SECTION}>
              <LinkList
                title="Related"
                empty="Nothing"
                rows={related.map((edge) => ({ id: edge.id, title: edge.title, status: edge.status }))}
              />
            </section>
          ) : null}
          {epic || children.length > 0 ? (
            <section className={CONTENT_SECTION} data-epic-tasks="">
              <SectionLabel
                title="Tasks in this epic"
                caption={epic ? <EpicProgress closed={epic.closed} total={epic.total} /> : undefined}
              />
              <LinkList
                empty="No tasks yet"
                rows={children.map((row) => ({ id: row.id, title: row.title, status: row.status }))}
              />
            </section>
          ) : null}
          <Activity task={task} project={key} comments={comments} actors={actors} nowMs={nowMs} />
        </Card>
      </div>
    </>
  );
}

// --- The header: identity, state, and the actions, the primary one first ----

/**
 * A task waiting on a person offers the verbs its decision row offers, never
 * Close. Once answered, the header offers nothing until the next read; the
 * toast holds the Undo, and a pressed option stays drawn as the pick.
 * Otherwise Claim leads while nobody holds the task, and Close once somebody does.
 */
function TaskHeader({
  task,
  project,
  head,
  readAt,
  actors,
  crumbs,
  nowMs,
  children,
}: {
  task: LiveTask;
  project: string;
  head: TaskHeadFacts;
  readAt: string;
  actors: readonly TaskActor[] | undefined;
  crumbs: Crumb[];
  nowMs: number;
  children?: ReactNode;
}) {
  const capabilities = useCapabilities();
  const hides = useAnswerHides();
  const [closing, setClosing] = useState(false);
  const [picked, setPicked] = useState<TaskChoiceKey | null>(null);
  const answered = hides(task.id, readAt);
  const closeReason = verbReason(capabilities, operationAvailable(capabilities, 'close'), UNAVAILABLE);
  const askReason = verbReason(
    capabilities,
    operationAvailable(capabilities, head.ask === 'approve' ? 'resolve' : 'respond'),
    UNAVAILABLE,
  );
  const chooseReason = verbReason(capabilities, operationAvailable(capabilities, 'choose'), UNAVAILABLE);
  const claimable = head.status === 'open' && head.holder === null;
  const closed = head.status === 'closed';
  const claimReason = verbReason(capabilities, fieldAvailable(capabilities, 'claim'), UNAVAILABLE);
  const reason =
    head.ask !== null
      ? answered
        ? null
        : head.ask === 'choose'
          ? (chooseReason ?? askReason)
          : askReason
      : closed || answered
        ? null
        : claimable
          ? claimReason
          : closeReason;
  const ask = useAskActions({
    ask: answered ? null : head.ask,
    id: task.id,
    title: task.title,
    project,
    choices: task.choices ?? null,
    disabledReason: askReason,
    chooseDisabledReason: chooseReason,
    placement: 'header',
    onChosen: setPicked,
  });
  const choiceRecord = task.choice ? (
    <ChoiceSummary
      choice={task.choice}
      choices={task.choices ?? null}
      by={actorLabel(task.choice.by, actors)}
      nowMs={nowMs}
    />
  ) : answered && head.ask === 'choose' && picked !== null && task.choices ? (
    <ChoiceButtons choices={task.choices} chosen={picked} />
  ) : null;

  return (
    <TaskHead
      id={task.id}
      facts={head}
      crumbs={crumbs}
      nowMs={nowMs}
      actions={
        <div className="flex flex-col items-start gap-1.5 sm:items-end" data-task-actions="">
          <div className="flex flex-wrap items-center gap-2">
            {head.ask !== null ? (
              ask.buttons
            ) : answered ? null : (
              <>
                {claimable ? <ClaimAction id={task.id} project={project} disabled={claimReason !== null} /> : null}
                {closed ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant={claimable ? 'outline' : 'default'}
                    disabled={closeReason !== null}
                    aria-expanded={closing}
                    onClick={() => setClosing((open) => !open)}
                    data-task-action="close"
                  >
                    Close
                  </Button>
                )}
              </>
            )}
          </div>
          {reason ? (
            <p className="m-0 inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-action-reason="">
              <Lock className="size-3.5 shrink-0" aria-hidden />
              {reason}
            </p>
          ) : null}
        </div>
      }
    >
      {children}
      {choiceRecord}
      {head.ask !== null ? (
        ask.box
      ) : closing && !answered ? (
        <CloseForm
          id={task.id}
          project={project}
          title={task.title}
          declined={task.labels.includes('human')}
          onDone={() => setClosing(false)}
        />
      ) : null}
    </TaskHead>
  );
}

function ClaimAction({ id, project, disabled }: { id: string; project: string; disabled: boolean }) {
  const claim = useClaimTask();
  return (
    <Button
      type="button"
      size="sm"
      disabled={disabled || claim.isPending}
      data-task-action="claim"
      onClick={() =>
        claim.mutate(
          { id, project },
          {
            onSuccess: () => toast.success(`Claimed ${id}`),
            onError: (error) => toast.error(error.message),
          },
        )
      }
    >
      {claim.isPending ? 'Claiming…' : 'Claim'}
    </Button>
  );
}

/**
 * Close, with the reason in front of it rather than behind a confirm, under
 * the ways a close ends, Done first. Done needs what shipped and is sent at
 * once; any other is one line, sent through the Undo window.
 */
function CloseForm({
  id,
  project,
  title,
  declined,
  onDone,
}: {
  id: string;
  project: string;
  title: string;
  declined: boolean;
  onDone: () => void;
}) {
  const fieldId = useId();
  const [resolution, setResolution] = useState<TaskResolution>('done');
  const [byKey, setByKey] = useState(false);
  const [reason, setReason] = useState('');
  const close = useCloseTask();
  const answer = useInboxAnswer();
  return (
    <div className="flex flex-col gap-2.5" data-task-form="close">
      <ResolutionChips
        value={resolution}
        onChange={(next, key) => {
          setResolution(next);
          setByKey(key);
        }}
      />
      {resolution !== 'done' ? (
        <CloseNoteForm
          key={resolution}
          id={id}
          resolution={resolution}
          named={false}
          autoFocus={!byKey}
          onCancel={onDone}
          onSend={(input) => {
            answer({
              kind: 'close',
              id,
              title,
              project,
              resolution,
              ...input,
              ...(declined ? { via: 'dismiss' as const } : {}),
            });
            onDone();
          }}
        />
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim() === '') return;
            close.mutate(
              { id, project, reason: reason.trim() },
              {
                onSuccess: () => {
                  toast.success(`Closed ${id}`);
                  onDone();
                },
                onError: (error) => toast.error(error.message),
              },
            );
          }}
        >
          <label htmlFor={fieldId} className="text-sm font-medium">
            What shipped, and the commit
            <span aria-hidden className="text-muted-foreground">
              {' '}
              *
            </span>
          </label>
          <textarea
            id={fieldId}
            rows={2}
            required
            aria-required="true"
            value={reason}
            placeholder="Landed in 1a2b3c4: the page shows the fields and the comments."
            onChange={(event) => setReason(event.target.value)}
            className={cn(fieldClass, 'w-full py-1.5')}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={reason.trim() === '' || close.isPending}
              data-task-confirm="close"
            >
              {close.isPending ? 'Closing…' : 'Close task'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// --- The work: description, Done when, links, epic tasks, activity -----------

type FieldSave = (input: { label: string; edit: TaskEdit; undo?: TaskEdit }) => Promise<boolean>;

/** Save one field with a toast that offers Undo, the contract every editable fact keeps. */
function useFieldSave(id: string, project: string): FieldSave {
  const update = useUpdateTask();
  return useCallback(
    async ({ label, edit, undo }) => {
      try {
        await update.mutateAsync({ id, project, edit });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Could not save ${label}`);
        return false;
      }
      toast.success(
        `Saved ${label}`,
        undo === undefined
          ? {}
          : {
              action: {
                label: 'Undo',
                onClick: () => {
                  update.mutate(
                    { id, project, edit: undo },
                    {
                      onSuccess: () => toast.success(`Reverted ${label}`),
                      onError: (error) => toast.error(error.message),
                    },
                  );
                },
              },
            },
      );
      return true;
    },
    [id, project, update],
  );
}

function Body({ task, project }: { task: LiveTask; project: string }) {
  const capabilities = useCapabilities();
  const save = useFieldSave(task.id, project);
  const [shown, setShown] = useState<string | null>(null);
  const [ticking, setTicking] = useState(false);
  useEffect(() => setShown(null), [task.acceptance]);
  const acceptance = shown ?? task.acceptance;
  const checklist = taskListItems(acceptance);
  const canTick = fieldAvailable(capabilities, 'acceptance');

  /** A ticked box writes the whole text with that one box flipped; the flipped text shows until the next read. */
  async function tick(line: number) {
    const next = toggleTaskListLine(acceptance, line);
    if (next === acceptance || ticking) return;
    setShown(next);
    setTicking(true);
    try {
      if (!(await save({ label: 'Done when', edit: { acceptance: next }, undo: { acceptance } }))) setShown(null);
    } finally {
      setTicking(false);
    }
  }

  return (
    <div className={cn(CONTENT_SECTION, 'gap-6')}>
      <LongTextField
        label="Description"
        field="description"
        addLabel="Add a description"
        value={task.description}
        view={<MarkdownText source={task.description} />}
        onCommit={(next) =>
          save({ label: 'the description', edit: { description: next }, undo: { description: task.description } })
        }
      />
      <LongTextField
        label="Done when"
        field="acceptance"
        addLabel="Add when it is done"
        value={task.acceptance}
        caption={checklist.total > 0 ? `${formatInt(checklist.done)} of ${formatInt(checklist.total)}` : undefined}
        view={
          <MarkdownText
            source={acceptance}
            toggleDisabled={ticking}
            {...(canTick && checklist.total > 0 ? { onToggleTask: (line: number) => void tick(line) } : {})}
          />
        }
        onCommit={(next) =>
          save({ label: 'Done when', edit: { acceptance: next }, undo: { acceptance: task.acceptance } })
        }
      />
    </div>
  );
}

/** One Markdown field, read and edited in place: the text with a quiet Edit, or one Add button where there is none. */
function LongTextField({
  label,
  field,
  addLabel,
  value,
  view,
  caption,
  onCommit,
}: {
  label: string;
  field: string;
  addLabel: string;
  value: string;
  view: ReactNode;
  caption?: string | undefined;
  onCommit: (next: string) => Promise<boolean>;
}) {
  const writable = fieldAvailable(useCapabilities(), field);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const empty = value.trim() === '';
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  return (
    <section className="flex min-w-0 flex-col gap-2" data-task-field={label}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className={eyebrowClass}>{label}</span>
          {caption ? <span className="text-xs tabular-nums text-muted-foreground">{caption}</span> : null}
        </div>
        {!empty && !editing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Edit ${label.toLowerCase()}`}
            disabled={!writable}
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden /> Edit
          </Button>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={label}
            rows={6}
            autoFocus
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            className={cn(fieldClass, 'w-full py-1.5 font-mono text-xs')}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={saving || draft.trim() === value.trim()}
              onClick={async () => {
                setSaving(true);
                try {
                  if (await onCommit(draft.trim())) setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDraft(value);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : empty ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={!writable}
          onClick={() => setEditing(true)}
        >
          <Plus aria-hidden /> {addLabel}
        </Button>
      ) : (
        view
      )}
    </section>
  );
}

/** Linked tasks, each with its state glyph and title as a link to its page. */
function LinkList({
  title,
  empty,
  rows,
}: {
  title?: string;
  empty: string;
  rows: readonly { id: string; title: string | null; status: string | null }[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {title ? <span className={eyebrowClass}>{title}</span> : null}
      {rows.length === 0 ? (
        <span className="text-xs text-muted-foreground">{empty}</span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-0 items-start gap-2 text-sm" data-linked-task={row.id}>
              {row.status === null ? (
                <span
                  aria-hidden
                  className="mt-1 size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground"
                />
              ) : (
                <TaskStatusGlyph status={row.status} className="mt-0.5" />
              )}
              <Link to={taskPath(row.id)} className={cn(inlineLinkClass, 'min-w-0 [overflow-wrap:anywhere]')}>
                <span className="me-1.5 font-mono text-xs text-muted-foreground">{row.id}</span>
                {row.title ?? ''}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Filing, the claim, every comment and the close on one time axis that ends at now, then the comment box. */
function Activity({
  task,
  project,
  comments,
  actors,
  nowMs,
}: {
  task: LiveTask;
  project: string;
  comments: TaskComment[];
  actors: readonly TaskActor[] | undefined;
  nowMs: number;
}) {
  const entries = useMemo(() => {
    const out: TimelineEntry[] = [];
    if (task.createdAt) out.push({ id: 'filed', at: task.createdAt, kind: 'filed', label: 'Filed' });
    if (task.startedAt) {
      const name = task.assignee ? actorLabel(task.assignee, actors) : null;
      const model = claimedModel(task);
      out.push({
        id: 'claimed',
        at: task.startedAt,
        kind: 'claimed',
        label: name ? (
          <>
            Claimed by <b className="font-semibold">{name}</b>
            {model ? <span className="text-muted-foreground"> · {model}</span> : null}
          </>
        ) : (
          'Claimed'
        ),
      });
    }
    for (const comment of comments) {
      out.push({
        id: `comment-${comment.id}`,
        at: comment.createdAt,
        kind: 'comment',
        label: (
          <>
            Comment from <b className="font-semibold">{actorLabel(comment.author, actors)}</b>
          </>
        ),
        body: <MarkdownText source={comment.text} />,
      });
    }
    if (task.closedAt) {
      const closer = closeAttribution(task);
      const resolution = task.resolution ?? 'done';
      const closedAs = resolution === 'done' ? 'Closed' : `Closed as ${RESOLUTION_LABELS[resolution]}`;
      const note = closeNote(task.closeReason, resolution, task.duplicateOf ?? null);
      out.push({
        id: 'closed',
        at: task.closedAt,
        kind: 'closed',
        label: closer ? (
          <>
            {closedAs} by <b className="font-semibold">{actorLabel(closer.by, actors)}</b>
            {closer.model ? <span className="text-muted-foreground"> · {closer.model}</span> : null}
          </>
        ) : (
          closedAs
        ),
        ...(note ? { body: <MarkdownText source={note} /> } : {}),
        ...(resolution === 'done' ? {} : { glyph: RESOLUTION_GLYPH[resolution] }),
      });
    }
    return out;
  }, [task, comments, actors]);
  return (
    <section className={CONTENT_SECTION} data-task-activity="">
      <SectionLabel
        title="Activity"
        caption={
          comments.length > 0
            ? `${formatInt(comments.length)} ${comments.length === 1 ? 'comment' : 'comments'}`
            : undefined
        }
      />
      <TaskTimeline entries={entries} nowMs={nowMs} composer={<CommentBox id={task.id} project={project} />} />
    </section>
  );
}

function CommentBox({ id, project }: { id: string; project: string }) {
  const writable = operationAvailable(useCapabilities(), 'comment');
  const comment = useCommentOnTask();
  const [text, setText] = useState('');
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() === '') return;
        comment.mutate(
          { id, project, text: text.trim() },
          {
            onSuccess: () => {
              setText('');
              toast.success('Comment added');
            },
            onError: (error) => toast.error(error.message),
          },
        );
      }}
    >
      <textarea
        aria-label="Add a comment"
        disabled={!writable}
        rows={2}
        value={text}
        placeholder="Comment · Markdown works; task ids become links"
        onChange={(event) => setText(event.target.value)}
        className={cn(fieldClass, 'w-full py-1.5')}
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!writable || text.trim() === '' || comment.isPending}
          data-task-comment=""
        >
          {comment.isPending ? 'Sending…' : 'Comment'}
        </Button>
      </div>
    </form>
  );
}

// --- The facts rail: each fact drawn as its value and edited in place --------

const STATUS_CHOICES: FactChoice[] = TASK_STATUSES.filter((status) => status.stored !== 'closed').map((status) => {
  const face = statusFace(status.stored);
  const Icon = face.icon;
  return {
    value: status.stored,
    label: status.label,
    mark: <Icon className={cn('size-3.5', STATE_TONE[face.tone].text)} />,
  };
});

const PRIORITY_CHOICES: FactChoice[] = PRIORITY_BANDS.map((band, index) => ({
  value: String(index),
  label: band,
  mark: <PriorityMark priority={index} size="chip" />,
}));

/** Who holds work in the project, offered as assignees. */
function holders(tasks: readonly LiveTask[]): string[] {
  return [...new Set(tasks.flatMap((task) => (task.assignee ? [task.assignee] : [])))].sort();
}

function parkPresets(nowMs: number): { label: string; value: string }[] {
  return [
    { label: 'Tomorrow', value: localDay(nowMs, 1) },
    { label: 'In a week', value: localDay(nowMs, 7) },
    { label: 'In a month', value: localDay(nowMs, 30) },
  ];
}

function Facts({
  className,
  task,
  project,
  parent,
  parentTitle,
  epics,
  people,
  actors,
  nowMs,
}: {
  className?: string;
  task: LiveTask;
  project: TaskProject;
  parent: LiveEpic | null;
  parentTitle: string | null;
  epics: readonly LiveEpic[];
  people: readonly string[];
  actors: readonly TaskActor[] | undefined;
  nowMs: number;
}) {
  const capabilities = useCapabilities();
  const save = useFieldSave(task.id, project.logicalKey);
  const can = (field: string) => fieldAvailable(capabilities, field);
  const status = statusFace(task.status);
  const StatusIcon = status.icon;
  const holder = task.assignee ? actorLabel(task.assignee, actors) : null;
  const model = task.assignee ? claimedModel(task) : null;
  const parked = (task.deferUntil ?? '').slice(0, 10);
  const parentName = parent?.title ?? parentTitle ?? task.parent;
  const closed = task.status === 'closed';
  const assignees: FactChoice[] = [
    ...[...new Set([...people, ...(task.assignee ? [task.assignee] : [])])].map((name) => ({
      value: name,
      label: actorLabel(name, actors),
    })),
    { value: '', label: 'Nobody' },
  ];

  return (
    <aside
      aria-label="Facts"
      className={cn(
        'viz-arrive min-w-0 px-1 max-lg:border-b max-lg:border-border/70 max-lg:pb-4 lg:border-s lg:border-border/70 lg:ps-5',
        className,
      )}
    >
      <dl className="m-0 flex flex-wrap gap-x-5 gap-y-3 lg:flex-col lg:flex-nowrap lg:gap-0" data-task-facts="">
        <Fact label="Project">
          <FactChip
            label="Project"
            valueText={project.displayName}
            to={`/tasks?${new URLSearchParams({ project: project.logicalKey })}`}
          >
            {project.displayName}
          </FactChip>
        </Fact>
        <Fact label="Parent epic" wide>
          <FactChip
            label="Parent epic"
            valueText={parentName ?? 'None'}
            {...(task.parent ? { to: taskPath(task.parent) } : {})}
            quiet={!task.parent}
            readOnly={!can('parent') || closed}
            editor={{
              kind: 'choice',
              value: task.parent ?? '',
              choices: [
                ...epics
                  .filter((row) => row.id !== task.id && row.status !== 'closed')
                  .map((row) => ({
                    value: row.id,
                    label: row.title,
                    mark: <Layers className="size-3.5 text-muted-foreground" />,
                  })),
                { value: '', label: 'No epic' },
              ],
              other: { label: 'Another task id', placeholder: `${project.prefix}-…` },
            }}
            onSave={(next) =>
              save({ label: 'the parent', edit: { parent: next }, undo: { parent: task.parent ?? '' } })
            }
          >
            {task.parent ? <Layers aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : null}
            {parentName ?? 'None'}
          </FactChip>
          {parent ? (
            <div className="basis-full pt-0.5">
              <EpicProgress closed={parent.closed} total={parent.total} />
            </div>
          ) : null}
        </Fact>
        <Fact label="Status">
          <FactChip
            label="Status"
            valueText={status.label}
            readOnly={!can('status') || closed}
            editor={{ kind: 'choice', value: task.status, choices: STATUS_CHOICES }}
            onSave={(next) => save({ label: 'the status', edit: { status: next }, undo: { status: task.status } })}
          >
            <StatusIcon aria-hidden className={cn('size-3.5 shrink-0', STATE_TONE[status.tone].text)} />
            <span className={STATE_TONE[status.tone].text}>{status.label}</span>
          </FactChip>
        </Fact>
        <Fact label="Priority">
          <FactChip
            label="Priority"
            valueText={PRIORITY_BANDS[Math.min(Math.max(task.priority, 0), 4)] ?? 'normal'}
            readOnly={!can('priority') || closed}
            editor={{ kind: 'choice', value: String(task.priority), choices: PRIORITY_CHOICES }}
            onSave={(next) =>
              save({ label: 'the priority', edit: { priority: Number(next) }, undo: { priority: task.priority } })
            }
          >
            <PriorityMark priority={task.priority} size="chip" />
            {PRIORITY_BANDS[Math.min(Math.max(task.priority, 0), 4)] ?? 'normal'}
          </FactChip>
        </Fact>
        <Fact label="Assignee">
          <FactChip
            label="Assignee"
            valueText={holder ?? 'Nobody'}
            quiet={holder === null}
            readOnly={!can('assignee') || closed}
            editor={{
              kind: 'choice',
              value: task.assignee ?? '',
              choices: assignees,
              other: { label: 'Someone else', placeholder: 'A name or an agent' },
            }}
            // A new holder owns an in-progress claim, so taking it back is theirs to agree to, not an Undo.
            onSave={(next) =>
              save({
                label: 'the assignee',
                edit: { assignee: next },
                ...(task.status === 'in_progress' && next !== '' && next !== task.assignee
                  ? {}
                  : { undo: { assignee: task.assignee ?? '' } }),
              })
            }
          >
            <span className="whitespace-nowrap">{holder ?? 'Nobody'}</span>
            {holder && model ? (
              <span className="whitespace-nowrap font-normal text-muted-foreground">· {model}</span>
            ) : null}
          </FactChip>
        </Fact>
        <Fact label="Labels" wide>
          <Labels
            labels={task.labels}
            writable={can('addLabels') && !closed}
            onAdd={(label) =>
              save({ label: `label ${label}`, edit: { addLabels: [label] }, undo: { removeLabels: [label] } })
            }
            onRemove={(label) =>
              save({ label: `label ${label}`, edit: { removeLabels: [label] }, undo: { addLabels: [label] } })
            }
          />
        </Fact>
        <Fact label="Parked until">
          <FactChip
            label="Parked until"
            valueText={parked === '' ? 'Not parked' : calendarDay(parked, nowMs)}
            quiet={parked === ''}
            readOnly={!can('defer') || closed}
            editor={{ kind: 'date', value: parked, presets: parkPresets(nowMs), clearLabel: 'Not parked' }}
            onSave={(next) => save({ label: 'the parked date', edit: { defer: next }, undo: { defer: parked } })}
          >
            {parked === '' ? null : <Snowflake aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className="tabular-nums">{parked === '' ? 'Not parked' : calendarDay(parked, nowMs)}</span>
          </FactChip>
        </Fact>
        <Fact label="Ages">
          <span className="text-xs text-muted-foreground">created {formatAge(ageMs(nowMs, task.createdAt))} ago</span>
          <span aria-hidden className="text-xs text-muted-foreground">
            ·
          </span>
          <span className="text-xs text-muted-foreground">updated {formatAge(ageMs(nowMs, task.updatedAt))} ago</span>
        </Fact>
      </dl>
    </aside>
  );
}

function Fact({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1.5 lg:grid lg:grid-cols-[6.5rem_minmax(0,1fr)] lg:items-baseline lg:gap-x-3',
        'lg:border-b lg:border-border/70 lg:py-2.5 lg:first:pt-0 lg:last:border-0 lg:last:pb-0',
        wide && 'basis-full',
      )}
    >
      <dt className={eyebrowClass}>{label}</dt>
      <dd className="m-0 flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  );
}

function Labels({
  labels,
  writable,
  onAdd,
  onRemove,
}: {
  labels: string[];
  writable: boolean;
  onAdd: (label: string) => Promise<boolean>;
  onRemove: (label: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      {labels.length === 0 && !writable ? <span className="text-xs text-muted-foreground">No labels</span> : null}
      {labels.map((label) => (
        <span
          key={label}
          className={cn(factChipClass, 'gap-1 font-normal', writable && 'pe-1')}
          data-task-label={label}
        >
          {label}
          {writable ? (
            <button
              type="button"
              aria-label={`Remove label ${label}`}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onRemove(label).finally(() => setBusy(false));
              }}
              className="grid size-5 place-items-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-sm:size-8"
            >
              <X className="size-3" aria-hidden />
            </button>
          ) : null}
        </span>
      ))}
      {writable ? (
        <FactChip
          label="Add a label"
          valueText=""
          quiet
          className="border-dashed"
          editor={{ kind: 'text', value: '', inputLabel: 'New label', placeholder: 'human, copy, docs…' }}
          onSave={onAdd}
        >
          <Plus aria-hidden className="size-3.5 shrink-0" />
          Label
        </FactChip>
      ) : null}
    </>
  );
}

export default TaskRoute;
