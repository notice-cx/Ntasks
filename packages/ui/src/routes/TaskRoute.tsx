import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Check,
  Copy,
  Ellipsis,
  FileText,
  GitPullRequest,
  Hand,
  Link as LinkIcon,
  Pencil,
  Plus,
  Reply,
  SearchX,
  Undo2,
  X,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ACCEPTED_REASON, type TaskResolution } from '@ntasks/domain';
import { ApiError } from '../api/client';
import type {
  LiveEpic,
  LiveTask,
  ParentContext,
  TaskActor,
  TaskChoiceKey,
  TaskComment,
  TaskProject,
} from '../api/types';
import { AcceptForm, CloseDoneForm, CloseMenu } from '../components/CloseResolution';
import { TaskTimeline, type TimelineEntry } from '../components/TaskTimeline';
import { PageSkeleton, ReadFailed } from '../components/surface';
import { Badge, Progress } from '../components/ui/badge';
import { LinkedText } from '../components/ui/linked-text';
import { Button, IconButton } from '../components/ui/button';
import { OptionList } from '../components/ui/choice';
import { EmptyState } from '../components/ui/empty-state';
import { Field, Input, Select, Textarea } from '../components/ui/field';
import { Kbd } from '../components/ui/kbd';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../components/ui/menu';
import { BarSpacer, TopBar } from '../components/ui/shell';
import { StatusMark } from '../components/ui/symbols';
import { useNow } from '../hooks/useNow';
import { useShortcut } from '../hooks/useShortcut';
import {
  fieldAvailable,
  operationAvailable,
  useAnswerHides,
  useBoards,
  useCapabilities,
  useClaimTask,
  useDisputeTask,
  useCommentOnTask,
  useInboxAnswer,
  useRetryKey,
  useTask,
  useTaskProjects,
  verbReason,
} from '../hooks/useTasks';
import { copyText } from '../lib/clipboard';
import { httpUrl } from '../lib/custom-fields';
import { isAgentActor, statusMarkOfStored } from '../lib/symbols';
import {
  actorLabel,
  choiceName,
  claimedModel,
  closeAttribution,
  closeNote,
  filedAttribution,
  inboxAsk,
  isGate,
  isBlockingLink,
  RESOLUTION_LABELS,
  type NotDone,
} from '../lib/task-model';
import { ageMs, formatAge } from '../lib/format';
import { usePaths } from '../lib/paths';
import { activityOf } from '../lib/live';
import { taskPrefix } from '../lib/task-path';
import { cn } from '../lib/utils';
import { AnswerForm } from './tasks/ask-actions';
import { closeOperation, declinedOnClose, useCloseAs } from './tasks/close-actions';
import { cardOptions, DecisionAnswer } from './tasks/decision-card';
import { StepList } from './tasks/step-list';
import { TaskFacts, useFieldSave } from './tasks/task-facts';
import { AnswerSummary, ChoiceSummary, ClosedSummary, TaskPath, type Actor } from './tasks/task-head';
import { WhereItStopped } from './tasks/where-it-stopped';
import { MarkdownText, TaskPrefixesProvider, taskListItems, toggleTaskListLine } from './tasks/task-markdown';
import { usePageTitle } from '../lib/page-title';

const UNAVAILABLE = 'This sign-in cannot do this.';

/** The reading column: 720 px of text, with room either side. */
const COLUMN = 'mx-auto w-full max-w-[832px] px-14 max-lg:max-w-[760px] max-md:px-4';

/** A task's page, `<base>/<id>`: one task, whole. Its project is the one whose prefix starts the id. */
export function TaskRoute() {
  const { id = '' } = useParams<{ id: string }>();
  const paths = usePaths();
  const now = useNow();
  const catalog = useTaskProjects();
  const project = catalog.data?.find((row) => row.prefix === taskPrefix(id)) ?? null;
  const detail = useTask(id, project?.logicalKey ?? null);
  const [board] = useBoards(project ? [project.logicalKey] : []);
  const task = detail.data?.task ?? null;
  const prefixes = useMemo(() => new Set((catalog.data ?? []).map((row) => row.prefix)), [catalog.data]);
  const siblings = board?.data?.tasks ?? [];
  const epics = board?.data?.epics ?? [];
  const notFound =
    (catalog.data !== undefined && project === null) ||
    (detail.error instanceof ApiError && detail.error.status === 404);
  // The id leads: people find a tab, a bookmark or a page in their history by it.
  usePageTitle(id, notFound ? 'Not found' : task?.title);
  const path = (parent: { id: string; title: string | null } | null) => (
    <TaskPath
      id={id}
      project={
        project
          ? {
              name: project.displayName,
              prefix: project.prefix,
              icon: project.icon ?? null,
              to: `${paths.board}?${new URLSearchParams({ project: project.logicalKey })}`,
            }
          : null
      }
      parent={parent}
    />
  );

  if (task !== null && project !== null && detail.data !== undefined && !notFound && !detail.isError) {
    const parent = task.parent ? (epics.find((epic) => epic.id === task.parent) ?? null) : null;
    const parentTitle = parent?.title ?? siblings.find((row) => row.id === task.parent)?.title ?? null;
    return (
      <TaskPrefixesProvider value={prefixes}>
        {/* Keyed by the task, so a draft, an open form or a pick never carries over to the next task. */}
        <TaskPage
          key={task.id}
          task={task}
          project={project}
          path={path(task.parent ? { id: task.parent, title: parentTitle } : null)}
          fetchedAt={detail.dataUpdatedAt || null}
          comments={detail.data.comments}
          parentContext={detail.data.parent ?? null}
          actors={detail.data.actors}
          shown={detail.data.proposalVersion ?? task.proposalVersion ?? null}
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
      <div className="py-10" data-task-not-found="">
        <EmptyState
          icon={<SearchX />}
          title="No task with this id"
          action={
            <Button asChild>
              <Link to={paths.board}>Back to Tasks</Link>
            </Button>
          }
        />
      </div>
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
  } else {
    body = <PageSkeleton shape="page" />;
  }
  return (
    <>
      <TopBar title={path(null)} />
      <div className={cn(COLUMN, 'py-9')} data-task-page="">
        {body}
      </div>
    </>
  );
}

/** The panel under the title where an action that needs words is finished. */
type Panel = { kind: 'close-done' } | { kind: 'accept' } | { kind: 'answer' } | null;

/** The task's Markdown fields, each read and edited in place. */
type TextField = 'description' | 'acceptance' | 'design' | 'notes';

function TaskPage({
  task,
  project,
  path,
  fetchedAt,
  comments,
  parentContext,
  actors,
  shown,
  parent,
  parentTitle,
  epic,
  siblings,
  epics,
  nowMs,
}: {
  task: LiveTask;
  project: TaskProject;
  path: ReactNode;
  /** When this browser received the task's read, by its own clock. */
  fetchedAt: number | null;
  comments: TaskComment[];
  /** What the task's parent holds for it, from the task's read; null when it has no parent. */
  parentContext: ParentContext | null;
  actors: readonly TaskActor[] | undefined;
  /** The proposal version the task's read returned, which an acceptance names. */
  shown: string | null;
  parent: LiveEpic | null;
  parentTitle: string | null;
  /** This task's own progress, when it is an epic. */
  epic: LiveEpic | null;
  siblings: readonly LiveTask[];
  epics: readonly LiveEpic[];
  nowMs: number;
}) {
  const key = project.logicalKey;
  const paths = usePaths();
  const capabilities = useCapabilities();
  const hides = useAnswerHides();
  const answer = useInboxAnswer();
  const [panel, setPanel] = useState<Panel>(null);
  const [editing, setEditing] = useState<TextField | null>(null);
  const [addingLink, setAddingLink] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [option, setOption] = useState<TaskChoiceKey | null>(null);
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<TaskChoiceKey | null>(null);
  const closeAs = useCloseAs({
    id: task.id,
    title: task.title,
    project: key,
    proposalVersion: task.proposalVersion ?? null,
    ...(declinedOnClose(task) ? { via: 'dismiss' as const } : {}),
    onOpen: () => setPanel(null),
  });

  const closed = task.status === 'closed';
  const answered = hides(task.id, fetchedAt);
  const ask = answered ? null : inboxAsk(task);
  const choices = ask === 'choose' ? (task.choices ?? null) : null;
  const scope = { id: task.id, title: task.title, project: key, proposalVersion: task.proposalVersion ?? null };
  const reasonFor = (available: boolean) => verbReason(capabilities, available, UNAVAILABLE);
  const askReason = reasonFor(
    operationAvailable(capabilities, ask === 'approve' ? 'resolve' : ask === 'do' ? 'step' : 'respond'),
  );
  const steps = task.steps ?? null;
  const chooseReason = reasonFor(operationAvailable(capabilities, 'choose'));
  const closeReason = reasonFor(operationAvailable(capabilities, closeOperation(task)));
  const claimReason = reasonFor(fieldAvailable(capabilities, 'claim'));
  // An approval, or a report that the steps are done, an agent relayed closed this gate, and nobody has disputed it yet.
  const disputable =
    isGate(task) &&
    closed &&
    task.answer?.relayed === true &&
    (task.answer.option === 'approve' || task.answer.option === 'done') &&
    task.answer.disputedBy === null;
  const disputeReason = reasonFor(operationAvailable(capabilities, 'dispute'));
  const claimable = task.status === 'open' && task.assignee === null;
  const doneOffered = !declinedOnClose(task) && operationAvailable(capabilities, 'close');
  const acceptOffered = !isGate(task) && operationAvailable(capabilities, 'accept');
  // A person's acceptance that an agent recorded for them, which they can withdraw.
  const acceptanceDisputable = closed && task.closeAcceptance?.relayed !== undefined;

  function pickClose(resolution: TaskResolution) {
    if (resolution === 'done') {
      closeAs.cancel();
      setPanel({ kind: 'close-done' });
    } else closeAs.pick(resolution as NotDone);
  }

  function sendAnswer() {
    const words = answerText.trim();
    if (words === '') return;
    answer({ kind: 'answer', ...scope, text: words });
    setAnswerText('');
    setPanel(null);
  }

  function choose(key: TaskChoiceKey) {
    const label = choices?.options.find((entry) => entry.key === key)?.label;
    const said = note.trim();
    answer({
      kind: 'choose',
      ...scope,
      option: key,
      ...(label === undefined ? {} : { label }),
      ...(said === '' ? {} : { note: said }),
    });
    setPicked(key);
  }

  const closeMenu = (label: string, done: boolean, variant: 'primary' | 'secondary') => (
    <CloseMenu
      label={label}
      subject={task.id}
      done={done}
      variant={variant}
      iconOnPhone={variant === 'secondary'}
      disabledReason={closeReason}
      onPick={pickClose}
      {...(acceptOffered
        ? {
            onAccept: () => {
              closeAs.cancel();
              setPanel({ kind: 'accept' });
            },
          }
        : {})}
    />
  );

  // A request to do steps is answered by its steps, under the description, so it offers no button here.
  let actions: ReactNode = null;
  if (ask === 'approve') {
    actions = (
      <Button
        variant="primary"
        disabled={askReason !== null}
        title={askReason ?? undefined}
        onClick={() => answer({ kind: 'approve', ...scope })}
        data-task-action="approve"
      >
        <Check aria-hidden strokeWidth={2} />
        Approve
      </Button>
    );
  } else if (ask !== null && ask !== 'do') {
    actions = (
      <>
        {closeMenu('Close as', false, 'secondary')}
        {ask === 'answer' ? (
          <Button
            variant="primary"
            aria-expanded={panel?.kind === 'answer'}
            disabled={askReason !== null}
            title={askReason ?? undefined}
            onClick={() => {
              closeAs.cancel();
              setPanel(panel?.kind === 'answer' ? null : { kind: 'answer' });
            }}
            data-task-action="answer"
          >
            <Reply aria-hidden />
            Answer
          </Button>
        ) : null}
      </>
    );
  } else if (ask === null && !closed && !answered) {
    actions = (
      <>
        {closeMenu('Close', doneOffered, claimable ? 'secondary' : 'primary')}
        {claimable ? <ClaimAction id={task.id} project={key} disabledReason={claimReason} /> : null}
      </>
    );
  }

  const panelBody =
    closeAs.box ??
    (panel?.kind === 'close-done' ? (
      <CloseDoneForm id={task.id} project={key} multiline onDone={() => setPanel(null)} />
    ) : panel?.kind === 'accept' ? (
      <AcceptForm
        id={task.id}
        project={key}
        acceptance={task.acceptance}
        proposalVersion={shown}
        onDone={() => setPanel(null)}
      />
    ) : panel?.kind === 'answer' && ask === 'answer' ? (
      <AnswerForm
        id={task.id}
        text={answerText}
        onText={setAnswerText}
        onSend={sendAnswer}
        onCancel={() => setPanel(null)}
      />
    ) : null);

  // A decision closed by a pick carries the pick as its reason; the record of the choice already says it.
  const closedByPick = task.choice
    ? task.closeReason?.trim() === `Chose ${choiceName(task.choice.option, task.choice.label)}`
    : false;
  const resolution: TaskResolution = task.resolution ?? 'done';
  const closer = closeAttribution(task);
  // A person's acceptance with no reason of their own closes with the API's words for it, which its line already says.
  const closeWords =
    task.closeAcceptance && task.closeReason === ACCEPTED_REASON
      ? null
      : closeNote(task.closeReason, resolution, task.duplicateOf ?? null);
  const acceptance = task.closeAcceptance
    ? {
        acceptance: task.closeAcceptance,
        person: actorOf(task.closeAcceptance.by, null, actors).name,
        relayer: task.closeAcceptance.relayed ? actorOf(task.closeAcceptance.relayed.by, null, actors).name : null,
      }
    : null;
  const writable = (field: string) => !closed && fieldAvailable(capabilities, field);

  return (
    <>
      <TopBar title={path}>
        <BarSpacer />
        <div className="flex items-center gap-1.5" data-task-actions="">
          <IconButton
            label="Copy link"
            icon={<LinkIcon aria-hidden />}
            onClick={() => void copyText(window.location.href, 'the link')}
            className="max-sm:hidden"
          />
          <MoreMenu task={task} onEdit={setEditing} onAddLink={() => setAddingLink(true)} canEdit={writable} />
          {actions ? <span className="ms-1 flex items-center gap-2">{actions}</span> : null}
        </div>
      </TopBar>
      <div
        className="grid min-h-[calc(100vh-56px)] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] lg:grid-rows-[auto_1fr]"
        data-task-page=""
      >
        <header className={cn(COLUMN, 'flex flex-col gap-4 pt-9 lg:col-start-1 max-md:pt-5')}>
          <h1 className="m-0 text-task-title text-ink [overflow-wrap:anywhere] max-sm:text-[22px] max-sm:leading-7">
            <LinkedText text={task.title} />
          </h1>
          {panelBody ? (
            <div className="rounded-xl bg-surface px-4 py-3.5 inset-ring inset-ring-border" data-task-panel="">
              {panelBody}
            </div>
          ) : null}
          {!closed && task.assignee && activityOf(task, nowMs) === 'stalled' ? (
            <WhereItStopped
              task={task}
              heldBy={task.assignee}
              holder={actorOf(task.assignee, null, actors).name}
              comments={comments}
              project={key}
              nowMs={nowMs}
              disabledReason={reasonFor(operationAvailable(capabilities, 'release'))}
            />
          ) : null}
          {closed && !closedByPick ? (
            <ClosedSummary
              by={closer ? actorOf(closer.by, closer.model, actors) : null}
              at={task.closedAt}
              nowMs={nowMs}
              resolution={resolution}
              delivery={task.delivery ?? null}
              link={task.closeLink ?? null}
              proof={task.proof ?? null}
              acceptance={acceptance}
              duplicate={
                task.duplicateOf ? (
                  <Link
                    to={paths.task(task.duplicateOf)}
                    className="nums text-accent-text no-underline hover:underline"
                  >
                    {task.duplicateOf}
                  </Link>
                ) : undefined
              }
            >
              {closeWords ? <MarkdownText source={closeWords} /> : null}
              {acceptanceDisputable ? (
                <DisputeAction id={task.id} project={key} disabledReason={disputeReason} />
              ) : null}
            </ClosedSummary>
          ) : null}
          {task.answer?.relayed ? (
            <AnswerSummary
              answer={task.answer}
              choices={task.choices ?? null}
              by={actorOf(task.answer.recordedBy, null, actors)}
              nowMs={nowMs}
            >
              {disputable ? <DisputeAction id={task.id} project={key} disabledReason={disputeReason} /> : null}
            </AnswerSummary>
          ) : null}
        </header>
        <div
          className="border-border bg-canvas px-4 py-5 max-lg:border-y lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-s"
          data-task-side=""
        >
          <TaskFacts
            task={task}
            project={project}
            parent={parent}
            parentTitle={parentTitle}
            epics={epics}
            siblings={siblings}
            actors={actors}
            nowMs={nowMs}
          />
        </div>
        <div className={cn(COLUMN, 'flex flex-col gap-8 pt-5 pb-16 lg:col-start-1 lg:row-start-2')}>
          <TaskText
            task={task}
            project={key}
            editing={editing}
            onEditing={setEditing}
            decision={
              steps !== null ? (
                <StepList
                  id={task.id}
                  project={key}
                  steps={steps}
                  proposalVersion={task.proposalVersion ?? null}
                  open={ask === 'do'}
                  disabledReason={askReason}
                  actors={actors}
                  nowMs={nowMs}
                />
              ) : choices ? (
                <section aria-label="Decision" className="flex flex-col gap-3" data-task-decision="">
                  <h2 className="m-0 text-sm font-semibold text-ink">{choices.question}</h2>
                  <DecisionAnswer
                    choices={choices}
                    value={option}
                    onChange={setOption}
                    note={note}
                    onNote={setNote}
                    onAnswer={choose}
                    disabledReason={chooseReason}
                  />
                </section>
              ) : task.choice ? (
                <ChoiceSummary
                  choice={task.choice}
                  choices={task.choices ?? null}
                  by={actorOf(task.choice.by, null, actors)}
                  nowMs={nowMs}
                />
              ) : answered && picked !== null && task.choices ? (
                <OptionList
                  question={task.choices.question}
                  options={cardOptions(task.choices)}
                  value={picked}
                  readOnly
                />
              ) : null
            }
          />
          <TaskLinks
            task={task}
            project={key}
            siblings={siblings}
            adding={addingLink}
            onAdding={setAddingLink}
            canAdd={writable('addExternalLinks')}
            canRemove={writable('removeExternalLinks')}
          />
          {epic || siblings.some((row) => row.parent === task.id) ? (
            <EpicTasks epic={epic} tasks={siblings.filter((row) => row.parent === task.id)} />
          ) : null}
          {parentContext ? <FromTheEpic parent={parentContext} actors={actors} nowMs={nowMs} /> : null}
          <Activity task={task} project={key} comments={comments} actors={actors} nowMs={nowMs} />
        </div>
      </div>
    </>
  );
}

/** An actor id as an avatar draws it: their name, whether they are an agent, the model they named. */
function actorOf(actor: string, model: string | null, actors: readonly TaskActor[] | undefined): Actor {
  return { name: actorLabel(actor, actors), agent: isAgentActor(actor), model };
}

function ClaimAction({ id, project, disabledReason }: { id: string; project: string; disabledReason: string | null }) {
  const claim = useClaimTask();
  const enabled = disabledReason === null && !claim.isPending;
  const take = () =>
    claim.mutate(
      { id, project },
      {
        onSuccess: () => toast.success(`Claimed ${id}`),
        onError: (error) => toast.error(error.message),
      },
    );
  useShortcut('m', take, enabled);
  return (
    <Button
      variant="primary"
      disabled={!enabled}
      title={disabledReason ?? undefined}
      aria-keyshortcuts="M"
      data-task-action="claim"
      onClick={take}
    >
      <Hand aria-hidden />
      {claim.isPending ? 'Claiming…' : 'Claim'}
      <Kbd className="max-sm:hidden">M</Kbd>
    </Button>
  );
}

/** Withdraws an approval, or an acceptance as done, that an agent relayed: it opens again and the tasks waiting on it are told. */
function DisputeAction({
  id,
  project,
  disabledReason,
}: {
  id: string;
  project: string;
  disabledReason: string | null;
}) {
  const dispute = useDisputeTask();
  return (
    <div>
      <Button
        disabled={disabledReason !== null || dispute.isPending}
        title={disabledReason ?? undefined}
        data-task-action="dispute"
        onClick={() =>
          dispute.mutate(
            { id, project },
            {
              onSuccess: () => toast.success(`Disputed ${id}`),
              onError: (error) => toast.error(error.message),
            },
          )
        }
      >
        <Undo2 aria-hidden />
        {dispute.isPending ? 'Disputing…' : 'Dispute'}
      </Button>
    </div>
  );
}

/** The words a Markdown field goes by in the More menu, after Add or Edit. */
const TEXT_WORDS: Readonly<Record<TextField, string>> = {
  description: 'description',
  acceptance: 'Done when',
  design: 'design',
  notes: 'notes',
};

/** The top bar's menu: adding or editing the task's text and links, which a pointer also reaches on the page, and copying. */
function MoreMenu({
  task,
  onEdit,
  onAddLink,
  canEdit,
}: {
  task: Pick<LiveTask, 'id' | 'description' | 'acceptance' | 'design' | 'notes'>;
  onEdit: (field: TextField) => void;
  onAddLink: () => void;
  canEdit: (field: string) => boolean;
}) {
  const fields: TextField[] = ['description', 'acceptance', 'design', 'notes'];
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton label="More" icon={<Ellipsis aria-hidden />} />
      </MenuTrigger>
      <MenuContent label={`Actions for ${task.id}`} align="end">
        {fields
          .filter((field) => canEdit(field))
          .map((field) => {
            const empty = (task[field] ?? '').trim() === '';
            return (
              <MenuItem
                key={field}
                icon={empty ? <Plus aria-hidden /> : <Pencil aria-hidden />}
                onSelect={() => onEdit(field)}
              >
                {empty ? 'Add' : 'Edit'} {TEXT_WORDS[field]}
              </MenuItem>
            );
          })}
        {canEdit('addExternalLinks') ? (
          <MenuItem icon={<Plus aria-hidden />} onSelect={onAddLink}>
            Add link
          </MenuItem>
        ) : null}
        <MenuItem icon={<Copy aria-hidden />} onSelect={() => void copyText(task.id, task.id)}>
          Copy id
        </MenuItem>
        <MenuItem icon={<LinkIcon aria-hidden />} onSelect={() => void copyText(window.location.href, 'the link')}>
          Copy link
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

// --- The text: description, the decision, Done when, design, notes ----------

/** A section's heading: 14 px semibold, a count in Text 3 after it, and whatever its end holds. */
function SectionHeading({ title, count, children }: { title: string; count?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <h2 className="m-0 text-sm font-semibold text-ink">{title}</h2>
      {count !== undefined ? <span className="nums text-sm font-medium text-ink-3">{count}</span> : null}
      {children}
    </div>
  );
}

function TaskText({
  task,
  project,
  editing,
  onEditing,
  decision,
}: {
  task: LiveTask;
  project: string;
  editing: TextField | null;
  onEditing: (field: TextField | null) => void;
  decision: ReactNode;
}) {
  const capabilities = useCapabilities();
  const save = useFieldSave(task.id, project);
  const closed = task.status === 'closed';
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
    <>
      <LongText
        label="Description"
        field="description"
        value={task.description}
        writable={!closed && fieldAvailable(capabilities, 'description')}
        editing={editing === 'description'}
        onEditing={(on) => onEditing(on ? 'description' : null)}
        onCommit={(next) =>
          save({ label: 'the description', edit: { description: next }, undo: { description: task.description } })
        }
      >
        <MarkdownText source={task.description} />
      </LongText>
      {decision}
      <LongText
        label="Done when"
        field="acceptance"
        value={task.acceptance}
        heading
        count={checklist.total > 0 ? `${checklist.done}/${checklist.total}` : undefined}
        writable={!closed && fieldAvailable(capabilities, 'acceptance')}
        editing={editing === 'acceptance'}
        onEditing={(on) => onEditing(on ? 'acceptance' : null)}
        onCommit={(next) =>
          save({ label: 'Done when', edit: { acceptance: next }, undo: { acceptance: task.acceptance } })
        }
      >
        <MarkdownText
          source={acceptance}
          toggleDisabled={ticking}
          {...(canTick && checklist.total > 0 ? { onToggleTask: (line: number) => void tick(line) } : {})}
        />
      </LongText>
      {(['design', 'notes'] as const).map((field) => {
        const label = field === 'design' ? 'Design' : 'Notes';
        const value = task[field] ?? '';
        return (
          <LongText
            key={field}
            label={label}
            field={field}
            value={value}
            heading
            writable={!closed && fieldAvailable(capabilities, field)}
            editing={editing === field}
            onEditing={(on) => onEditing(on ? field : null)}
            onCommit={(next) => save({ label: `the ${field}`, edit: { [field]: next }, undo: { [field]: value } })}
          >
            <MarkdownText source={value} />
          </LongText>
        );
      })}
    </>
  );
}

/**
 * One Markdown field, read and edited in place. A pointer finds its Edit
 * beside it on hover, and the top bar's menu offers it too, and adds the
 * field when it is empty.
 */
function LongText({
  label,
  field,
  value,
  heading = false,
  count,
  writable,
  editing,
  onEditing,
  onCommit,
  children,
}: {
  label: string;
  field: string;
  value: string;
  /** Whether the field shows its name above it; the description is the page's text and shows none. */
  heading?: boolean;
  count?: string | undefined;
  writable: boolean;
  editing: boolean;
  onEditing: (on: boolean) => void;
  onCommit: (next: string) => Promise<boolean>;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const empty = value.trim() === '';
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  // An empty field takes no room; the top bar's menu adds it.
  if (empty && !editing) return null;

  async function commit() {
    if (saving || draft.trim() === value.trim()) return;
    setSaving(true);
    try {
      if (await onCommit(draft.trim())) onEditing(false);
    } finally {
      setSaving(false);
    }
  }

  const edit =
    writable && !empty && !editing ? (
      <IconButton
        size="sm"
        label={`Edit ${label.toLowerCase()}`}
        icon={<Pencil aria-hidden />}
        onClick={() => onEditing(true)}
        className="opacity-0 group-hover/text:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      />
    ) : null;

  return (
    <section className="group/text relative flex min-w-0 flex-col gap-2" data-task-field={label}>
      {heading ? (
        <SectionHeading title={label} count={count}>
          {edit}
        </SectionHeading>
      ) : (
        <>
          <h2 className="sr-only">{label}</h2>
          {edit ? <span className="absolute -end-10 top-0.5 max-md:hidden">{edit}</span> : null}
        </>
      )}
      {editing ? (
        <form
          className="flex flex-col gap-2"
          data-task-form={field}
          onSubmit={(event) => {
            event.preventDefault();
            void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onEditing(false);
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void commit();
            }
          }}
        >
          <Textarea
            aria-label={label}
            rows={8}
            autoFocus
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            className="font-mono text-code"
          />
          <div className="flex items-center gap-2">
            <Button variant="primary" type="submit" disabled={saving || draft.trim() === value.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" variant="ghost" disabled={saving} onClick={() => onEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        children
      )}
    </section>
  );
}

// --- Links, the epic's tasks, activity ----------------------------------------

/** The words for a link between two tasks, by the link's type; a type this build does not know is shown as itself. */
const LINK_WORDS: Readonly<Record<string, string>> = {
  related: 'Related',
  'discovered-from': 'Found during',
  duplicates: 'Duplicates',
  supersedes: 'Replaces',
  'merges-after': 'Merges after',
};

/** An external link's words, by its kind. */
const EXTERNAL_WORDS: Readonly<Record<string, string>> = { 'pull-request': 'Pull request', document: 'Document' };

type LinkRow =
  | { kind: 'task'; id: string; title: string | null; status: string | null }
  | { kind: 'external'; url: string; title: string; linkKind: string | null };

/** The task's links in groups, each named once: what it waits on, what it holds back, the rest, then pages outside. */
export function linkGroups(
  task: Pick<LiveTask, 'id' | 'dependencies' | 'externalLinks' | 'dependents'>,
  siblings: readonly Pick<LiveTask, 'id' | 'title' | 'status' | 'dependencies'>[],
): { label: string; rows: LinkRow[] }[] {
  const groups = new Map<string, LinkRow[]>();
  const add = (label: string, row: LinkRow) => groups.set(label, [...(groups.get(label) ?? []), row]);
  for (const edge of task.dependencies) {
    if (edge.type === 'parent-child') continue;
    const label = isBlockingLink(edge.type)
      ? 'Waits on'
      : (LINK_WORDS[edge.type] ?? edge.type.charAt(0).toUpperCase() + edge.type.slice(1).replace(/-/g, ' '));
    add(label, { kind: 'task', id: edge.id, title: edge.title, status: edge.status });
  }
  // The other end of a link: the task's own dependents, which reach across projects, or, from a
  // server that sends none, the links its board's tasks hold onto it.
  const theirs =
    task.dependents ??
    siblings.flatMap((other) =>
      other.dependencies
        .filter((edge) => edge.id === task.id)
        .map((edge) => ({ id: other.id, type: edge.type, title: other.title, status: other.status })),
    );
  for (const edge of theirs) {
    const row: LinkRow = { kind: 'task', id: edge.id, title: edge.title, status: edge.status };
    if (isBlockingLink(edge.type)) add('Holds back', row);
    // That task's pull request lands after this one's.
    if (edge.type === 'merges-after') add('Merges before', row);
  }
  for (const link of task.externalLinks ?? []) {
    add(EXTERNAL_WORDS[link.kind ?? ''] ?? 'Link', {
      kind: 'external',
      url: link.url,
      title: link.title,
      linkKind: link.kind,
    });
  }
  const order = ['Waits on', 'Holds back'];
  return [...groups.entries()]
    .sort(([a], [b]) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1))
    .map(([label, rows]) => ({ label, rows }));
}

/** The host a link goes to, shown after its title; nothing when the address cannot be read. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** A control shown while its line or section is pointed at or holds focus, and always on a touch screen. */
const ON_HOVER = 'opacity-0 focus-visible:opacity-100 pointer-coarse:opacity-100';

function TaskLinks({
  task,
  project,
  siblings,
  adding,
  onAdding,
  canAdd,
  canRemove,
}: {
  task: LiveTask;
  project: string;
  siblings: readonly LiveTask[];
  /** The form that adds a page is open. */
  adding: boolean;
  onAdding: (on: boolean) => void;
  canAdd: boolean;
  canRemove: boolean;
}) {
  const save = useFieldSave(task.id, project);
  const groups = linkGroups(task, siblings);
  // An empty section takes no room; the top bar's menu adds a link.
  if (groups.length === 0 && !(adding && canAdd)) return null;

  function remove(row: Extract<LinkRow, { kind: 'external' }>) {
    void save({
      label: 'the link',
      said: 'Removed the link',
      edit: { removeExternalLinks: [row.url] },
      undo: {
        addExternalLinks: [{ url: row.url, title: row.title, ...(row.linkKind ? { kind: row.linkKind } : {}) }],
      },
    });
  }

  return (
    <section className="group/links flex flex-col gap-1" data-task-links="">
      <SectionHeading title="Links">
        {canAdd && !adding ? (
          <IconButton
            size="sm"
            label="Add link"
            icon={<Plus aria-hidden />}
            onClick={() => onAdding(true)}
            className={cn(ON_HOVER, 'group-hover/links:opacity-100')}
          />
        ) : null}
      </SectionHeading>
      {groups.length > 0 ? (
        <dl className="m-0 flex flex-col">
          {groups.map((group) => (
            <div key={group.label} className="flex gap-2.5 max-sm:flex-col max-sm:gap-0">
              <dt className="w-28 shrink-0 pt-1.5 text-meta font-medium text-ink-3">{group.label}</dt>
              <div className="flex min-w-0 flex-1 flex-col">
                {group.rows.map((row) => (
                  <dd
                    key={row.kind === 'task' ? row.id : row.url}
                    className="group/link m-0 flex min-h-8 min-w-0 items-center gap-1"
                    {...(row.kind === 'task' ? { 'data-linked-task': row.id } : { 'data-external-link': row.url })}
                  >
                    {row.kind === 'task' ? <TaskLinkRow row={row} /> : <ExternalLinkRow row={row} />}
                    {row.kind === 'external' && canRemove ? (
                      <IconButton
                        size="sm"
                        label={`Remove ${row.title}`}
                        icon={<X aria-hidden />}
                        onClick={() => remove(row)}
                        className={cn(ON_HOVER, 'ms-auto shrink-0 group-hover/link:opacity-100')}
                      />
                    ) : null}
                  </dd>
                ))}
              </div>
            </div>
          ))}
        </dl>
      ) : null}
      {adding && canAdd ? <LinkForm task={task} project={project} onDone={() => onAdding(false)} /> : null}
    </section>
  );
}

/** What a new link's Kind offers, in the words the Links section groups pages under. */
const LINK_KINDS: readonly { value: string; label: string }[] = [
  { value: 'other', label: 'Link' },
  { value: 'pull-request', label: 'Pull request' },
  { value: 'document', label: 'Document' },
];

/** Add a page the task links to: its address and title, both required, and its kind. Enter adds, Escape cancels. */
function LinkForm({ task, project, onDone }: { task: LiveTask; project: string; onDone: () => void }) {
  const save = useFieldSave(task.id, project);
  const retryKey = useRetryKey();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('other');
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const address = httpUrl(url);
  const urlError = checked && url.trim() !== '' && address === null ? 'Not an http or https address' : null;
  const ready = address !== null && title.trim() !== '' && !saving;

  async function add() {
    setChecked(true);
    if (!ready || address === null) return;
    const link = { url: address, title: title.trim(), kind };
    const held = task.externalLinks?.find((existing) => existing.url === address);
    setSaving(true);
    try {
      const saved = await save({
        label: 'the link',
        said: 'Added the link',
        edit: { addExternalLinks: [link] },
        // A page the task linked to already keeps its old title and kind on Undo.
        undo: held
          ? { addExternalLinks: [{ url: held.url, title: held.title, ...(held.kind ? { kind: held.kind } : {}) }] }
          : { removeExternalLinks: [address] },
        idempotencyKey: retryKey.keyFor(JSON.stringify(link)),
      });
      if (saved) {
        retryKey.done();
        onDone();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="mt-1 flex flex-col gap-3 rounded-xl bg-surface px-4 py-3.5 inset-ring inset-ring-border"
      data-task-form="link"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDone();
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px] gap-2 max-sm:grid-cols-1">
        <Field label="URL" required error={urlError}>
          <Input
            type="url"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            value={url}
            disabled={saving}
            onChange={(event) => setUrl(event.target.value)}
            onBlur={() => setChecked(true)}
          />
        </Field>
        <Field label="Title" required>
          <Input value={title} disabled={saving} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Kind">
          <Select value={kind} disabled={saving} onChange={(event) => setKind(event.target.value)}>
            {LINK_KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" type="submit" disabled={!ready} data-task-confirm="link">
          {saving ? 'Adding…' : 'Add link'}
        </Button>
        <Button type="button" variant="ghost" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const ROW_LINK =
  'flex min-w-0 items-center gap-2 rounded-sm text-sm text-ink-2 no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-accent';

function TaskLinkRow({ row }: { row: Extract<LinkRow, { kind: 'task' }> }) {
  const paths = usePaths();
  return (
    <Link to={paths.task(row.id)} className={ROW_LINK}>
      {row.status === null ? (
        <span aria-hidden className="size-3.5 shrink-0 rounded-full border border-dashed border-ink-3" />
      ) : (
        <StatusMark status={statusMarkOfStored(row.status)} />
      )}
      <span className="nums shrink-0 text-meta text-ink-3">{row.id}</span>
      <span className="truncate">{row.title ?? ''}</span>
    </Link>
  );
}

function ExternalLinkRow({ row }: { row: Extract<LinkRow, { kind: 'external' }> }) {
  const host = hostOf(row.url);
  const Icon = row.linkKind === 'pull-request' ? GitPullRequest : row.linkKind === 'document' ? FileText : LinkIcon;
  return (
    <a href={row.url} target="_blank" rel="noopener noreferrer" className={ROW_LINK}>
      <Icon aria-hidden size={14} className="shrink-0 text-ink-3" />
      <span className="truncate">{row.title}</span>
      {host ? <span className="shrink-0 text-meta text-ink-3">{host}</span> : null}
    </a>
  );
}

function EpicTasks({ epic, tasks }: { epic: LiveEpic | null; tasks: readonly LiveTask[] }) {
  return (
    <section className="flex flex-col gap-1" data-epic-tasks="">
      <SectionHeading title="Tasks">{epic ? <Progress done={epic.closed} total={epic.total} /> : null}</SectionHeading>
      {tasks.length === 0 ? (
        <p className="m-0 text-sm text-ink-3">None</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {tasks.map((row) => (
            <li key={row.id} className="flex min-h-8 items-center" data-linked-task={row.id}>
              <TaskLinkRow row={{ kind: 'task', id: row.id, title: row.title, status: row.status }} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What the task's epic holds for it: the facts its tasks pinned for each
 * other, newest first, and the tasks of the epic that closed, each with why
 * and what proves it. Nothing shows while the epic holds neither.
 */
function FromTheEpic({
  parent,
  actors,
  nowMs,
}: {
  parent: ParentContext;
  actors: readonly TaskActor[] | undefined;
  nowMs: number;
}) {
  const paths = usePaths();
  if (parent.pinnedTotal === 0 && parent.closedSiblingsTotal === 0) return null;
  const more = (shown: number, total: number) =>
    total > shown ? (
      <Link to={paths.task(parent.id)} className="text-sm text-accent-text no-underline hover:underline">
        {total - shown} more on {parent.id}
      </Link>
    ) : null;
  return (
    <section aria-label="From the epic" className="flex flex-col gap-4" data-parent-context="">
      <SectionHeading title="From the epic">
        <Link to={paths.task(parent.id)} className="nums text-sm text-ink-3 no-underline hover:underline">
          {parent.title}
        </Link>
      </SectionHeading>
      {parent.pinned.length > 0 ? (
        <div className="flex flex-col gap-2" data-parent-pinned="">
          <h3 className="m-0 text-xs font-semibold text-ink-2">Pinned for its tasks</h3>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {parent.pinned.map((comment) => (
              <li key={comment.id} className="flex flex-col gap-1" data-pinned-comment={comment.id}>
                <MarkdownText source={comment.text} />
                <span className="text-xs text-ink-3">
                  {actorOf(comment.author, null, actors).name}
                  {comment.createdAt ? ` · ${formatAge(ageMs(nowMs, comment.createdAt))}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {more(parent.pinned.length, parent.pinnedTotal)}
        </div>
      ) : null}
      {parent.closedSiblings.length > 0 ? (
        <div className="flex flex-col gap-2" data-parent-closed="">
          <h3 className="m-0 text-xs font-semibold text-ink-2">Closed in this epic</h3>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {parent.closedSiblings.map((sibling) => (
              <li key={sibling.id} className="flex flex-col" data-closed-sibling={sibling.id}>
                <div className="flex min-h-8 items-center">
                  <TaskLinkRow row={{ kind: 'task', id: sibling.id, title: sibling.title, status: 'closed' }} />
                </div>
                {sibling.closeReason ? (
                  <div className="ps-6 text-sm text-ink-2">
                    <MarkdownText source={sibling.closeReason} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {more(parent.closedSiblings.length, parent.closedSiblingsTotal)}
        </div>
      ) : null}
    </section>
  );
}

/** Filing, the claim, every comment and the close, oldest first, then the comment box. */
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
    if (task.createdAt) {
      const filer = filedAttribution(task);
      const who = filer ? actorOf(filer.by, filer.model, actors) : null;
      out.push({
        id: 'filed',
        at: task.createdAt,
        kind: 'filed',
        actor: who,
        icon: <Plus />,
        label: who ? (
          <>
            <b>{who.name}</b> filed this
          </>
        ) : (
          'Filed'
        ),
      });
    }
    if (task.startedAt && task.assignee) {
      const who = actorOf(task.assignee, claimedModel(task), actors);
      out.push({
        id: 'claimed',
        at: task.startedAt,
        kind: 'claimed',
        actor: who,
        label: (
          <>
            <b>{who.name}</b> claimed this
          </>
        ),
      });
    }
    for (const comment of comments) {
      const who = actorOf(comment.author, null, actors);
      out.push({
        id: `comment-${comment.id}`,
        at: comment.createdAt,
        kind: 'comment',
        actor: who,
        label: (
          <>
            <b>{who.name}</b> commented
            {comment.pinned ? (
              <span className="ms-2" data-comment-pinned="">
                <Badge>Pinned</Badge>
              </span>
            ) : null}
          </>
        ),
        body: <MarkdownText source={comment.text} />,
      });
    }
    if (task.closedAt) {
      const closer = closeAttribution(task);
      const resolution = task.resolution ?? 'done';
      const how = resolution === 'done' ? '' : ` as ${RESOLUTION_LABELS[resolution]}`;
      const who = closer ? actorOf(closer.by, closer.model, actors) : null;
      const accepted = task.closeAcceptance ?? null;
      // A close an agent relayed names the person whose acceptance it records.
      const person =
        accepted && accepted.by !== closer?.by ? (
          <>
            , accepted as done by <b>{actorOf(accepted.by, null, actors).name}</b>
          </>
        ) : accepted ? (
          ' as done on their own call'
        ) : null;
      out.push({
        id: 'closed',
        at: task.closedAt,
        kind: 'closed',
        actor: who,
        icon: <Check />,
        label: who ? (
          <>
            <b>{who.name}</b> closed this{how}
            {person}
          </>
        ) : (
          `Closed${how}`
        ),
      });
    }
    return out;
  }, [task, comments, actors]);
  return (
    <section className="flex flex-col gap-1" data-task-activity="">
      <SectionHeading title="Activity" />
      <TaskTimeline entries={entries} nowMs={nowMs} composer={<CommentBox id={task.id} project={project} />} />
    </section>
  );
}

function CommentBox({ id, project }: { id: string; project: string }) {
  const writable = operationAvailable(useCapabilities(), 'comment');
  const comment = useCommentOnTask();
  const retryKey = useRetryKey();
  const [text, setText] = useState('');
  function send() {
    const words = text.trim();
    if (words === '' || comment.isPending) return;
    comment.mutate(
      { id, project, text: words, idempotencyKey: retryKey.keyFor(`${id}\n${words}`) },
      {
        onSuccess: () => {
          retryKey.done();
          setText('');
          toast.success('Comment added');
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }
  return (
    <form
      className={cn(
        'mt-2 flex flex-col rounded-lg bg-background inset-ring inset-ring-border',
        'transition-[box-shadow] duration-120 focus-within:inset-ring-accent focus-within:ring-3 focus-within:ring-accent-soft',
        !writable && 'opacity-45',
      )}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        aria-label="Comment"
        placeholder="Comment"
        disabled={!writable}
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          send();
        }}
        className="max-h-80 min-h-14 w-full resize-none border-0 bg-transparent px-3.5 pt-3 text-sm text-ink outline-none field-sizing-content placeholder:text-ink-3 disabled:cursor-not-allowed"
      />
      <div className="flex items-center justify-end px-2.5 pb-2.5">
        <Button
          type="submit"
          size="sm"
          disabled={!writable || text.trim() === '' || comment.isPending}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          data-task-comment=""
        >
          {comment.isPending ? 'Sending…' : 'Comment'}
          <Kbd>⌘↵</Kbd>
        </Button>
      </div>
    </form>
  );
}

export default TaskRoute;
