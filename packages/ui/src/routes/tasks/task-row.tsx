/**
 * One task on the board: its row, the actions its hover and its menu offer,
 * and the box under it where an action that needs words or a date is
 * finished. A row that waits on you answers in place.
 */
import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
  ChevronLeft,
  Clock,
  Copy,
  Ellipsis,
  Hand,
  Link as LinkIcon,
  ListChecks,
  MessageSquare,
  Moon,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CloseDoneForm } from '../../components/CloseResolution';
import { Avatar } from '../../components/ui/avatar';
import { Badge, Progress } from '../../components/ui/badge';
import { Button, IconButton } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/field';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { Row, RowActions, RowAge, RowAnswer, RowId, RowMeta, RowSpacer, RowTitle } from '../../components/ui/row';
import { ActivityMark, PriorityMark, StatusMark, TypeMark } from '../../components/ui/symbols';
import {
  fieldAvailable,
  operationAvailable,
  useCapabilities,
  useClaimTask,
  useCloseTask,
  useUpdateTask,
  verbReason,
} from '../../hooks/useTasks';
import { copyText } from '../../lib/clipboard';
import { calendarDay, useTimeZone } from '../../lib/dates';
import { ageMs, formatAge, formatMinutes } from '../../lib/format';
import { activityOf } from '../../lib/live';
import {
  isAgentActor,
  statusMarkFor,
  TYPE_MARK_LABELS,
  typeMarkFor,
  type StatusMark as StatusMarkKey,
} from '../../lib/symbols';
import {
  actorLabel,
  askVerb,
  checklistCount,
  claimedModel,
  isGate,
  NOT_DONE,
  RESOLUTION_LABELS,
  stageLabel,
  waitingOn,
  type BoardTask,
  type NotDone,
} from '../../lib/task-model';
import { usePaths } from '../../lib/paths';
import { useAskActions } from './ask-actions';
import { closeOperation, declinedOnClose, useCloseAs } from './close-actions';

const UNAVAILABLE = 'This sign-in cannot answer it.';

/** What a row needs from the board around it. */
export interface RowContext {
  statuses: ReadonlyMap<string, string>;
  /** The tasks a pending approval holds. */
  held: ReadonlySet<string>;
  epicProgress: ReadonlyMap<string, { closed: number; total: number }>;
  /** Its project's read answered and this sign-in may write, so its actions can run. */
  actionable: boolean;
  /** How long ago the task changed, as `40m`, or in the waiting groups how long ago it was created. */
  age: string;
  /** What `age` counts from, in words, where it is not the last change: `Created 3d ago`. */
  ageTitle?: string;
  nowMs: number;
}

/** The box under a row: what an action that needs more than a press asks for. */
function RowPanel({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-border bg-surface py-2.5 ps-[164px] pe-5 max-sm:px-4" data-row-panel="">
      {children}
    </div>
  );
}

/** The facts after a row's title: type, labels, epic progress, checks, comments, what it waits on, when it
 * unparks, for a ready task its estimate, for a task someone holds the helper they work through and when
 * they last wrote to it, and for a closed task how it ended or where its change is. */
function RowFacts({ task, mark, context }: { task: BoardTask; mark: StatusMarkKey; context: RowContext }) {
  const type = typeMarkFor(task.issueType, task.awaitType, (task.steps ?? null) !== null);
  const labels = task.labels.filter((label) => label !== 'human').slice(0, 2);
  const progress = task.issueType === 'epic' ? context.epicProgress.get(task.id) : undefined;
  const checks = checklistCount(task.acceptance);
  const waits = mark === 'blocked' ? waitingOn(task, context.statuses) : [];
  const zone = useTimeZone();
  // A park ends on the day the person picked, written as that day's start.
  const until =
    mark === 'parked' && task.deferUntil ? calendarDay(task.deferUntil.slice(0, 10), context.nowMs, zone) : null;
  // An epic's size is its children's, which its progress shows.
  const sized = mark === 'open' && task.ready && task.issueType !== 'epic';
  const resolution = task.status === 'closed' && task.resolution && task.resolution !== 'done' ? task.resolution : null;
  const stage = task.status === 'closed' ? (task.delivery?.stage ?? null) : null;
  const held = task.assignee !== null && task.status !== 'closed';
  const helper = held ? (task.for ?? null) : null;
  const active = held && task.lastActivityAt ? formatAge(ageMs(context.nowMs, task.lastActivityAt)) : null;
  const stalled = held && activityOf(task, context.nowMs) === 'stalled';
  return (
    <>
      {type !== 'task' && type !== 'other' ? (
        <Badge icon={<TypeMark type={type} size={12} label={null} />} className="max-sm:hidden">
          {TYPE_MARK_LABELS[type]}
        </Badge>
      ) : null}
      {labels.map((label) => (
        <Badge key={label} dot className="max-sm:hidden">
          {label}
        </Badge>
      ))}
      {progress ? <Progress done={progress.closed} total={progress.total} className="max-sm:hidden" /> : null}
      {checks && mark !== 'done' ? (
        <RowMeta aria-label={`${checks.done} of ${checks.total} checks done`}>
          <ListChecks aria-hidden />
          {checks.done}/{checks.total}
        </RowMeta>
      ) : null}
      {task.comments > 0 ? (
        <RowMeta aria-label={`${task.comments} ${task.comments === 1 ? 'comment' : 'comments'}`}>
          <MessageSquare aria-hidden />
          {task.comments}
        </RowMeta>
      ) : null}
      {waits.length > 0 ? (
        <RowMeta>
          <LinkIcon aria-hidden />
          Waits on <span className="text-ink-2">{waits.join(', ')}</span>
        </RowMeta>
      ) : null}
      {until ? (
        <RowMeta>
          <Moon aria-hidden />
          Until {until}
        </RowMeta>
      ) : null}
      {sized ? (
        // Below 1024 px the sidebar leaves the row too narrow for the title beside a badge, a checklist and this.
        <RowMeta data-row-estimate="" className="max-lg:hidden">
          <Clock aria-hidden />
          {task.estimateMinutes == null ? 'No estimate' : `Estimate ${formatMinutes(task.estimateMinutes)}`}
        </RowMeta>
      ) : null}
      {resolution ? <RowMeta>{RESOLUTION_LABELS[resolution]}</RowMeta> : null}
      {stage ? <RowMeta data-delivery-stage={stage}>{stageLabel(stage)}</RowMeta> : null}
      {task.status === 'closed' && task.proof === 'none' ? <RowMeta data-row-proof="none">No proof</RowMeta> : null}
      {helper ? (
        <RowMeta data-row-helper="">
          <Bot aria-hidden />
          For <span className="text-ink-2">{helper}</span>
        </RowMeta>
      ) : null}
      {stalled ? (
        <RowMeta data-row-activity="stalled">
          <ActivityMark activity="stalled" size={13} label={null} />
          {active ? `Stalled, last active ${active} ago` : 'Stalled, nothing recorded'}
        </RowMeta>
      ) : active ? (
        <RowMeta data-row-activity="">
          <Activity aria-hidden />
          Active {active} ago
        </RowMeta>
      ) : null}
    </>
  );
}

/** Who holds the task, as an avatar named for a screen reader. */
function Holder({ task }: { task: BoardTask }) {
  if (!task.assignee) return null;
  return (
    <Avatar
      name={actorLabel(task.assignee, task.actors)}
      agent={isAgentActor(task.assignee)}
      model={claimedModel(task)}
    />
  );
}

/** A task in one of the board's groups: its marks, id, title and facts, then its actions on hover, holder and age. */
export function TaskRow({ task, context }: { task: BoardTask; context: RowContext }) {
  const capabilities = useCapabilities();
  const navigate = useNavigate();
  const paths = usePaths();
  const claim = useClaimTask();
  const close = useCloseTask();
  const update = useUpdateTask();
  const [form, setForm] = useState<null | 'park' | 'close'>(null);
  const closeAs = useCloseAs({
    id: task.id,
    title: task.title,
    project: task.project,
    proposalVersion: task.proposalVersion ?? null,
    ...(declinedOnClose(task) ? { via: 'dismiss' as const } : {}),
    onOpen: () => setForm(null),
  });
  const mark = statusMarkFor(task, context.statuses, context.held);
  const done = task.status === 'closed';
  const busy = claim.isPending || close.isPending || update.isPending;
  const can = {
    claim: context.actionable && !done && task.assignee === null && fieldAvailable(capabilities, 'claim') && !busy,
    park: context.actionable && !done && fieldAvailable(capabilities, 'defer'),
    closeDone: context.actionable && !done && !declinedOnClose(task) && operationAvailable(capabilities, 'close'),
    closeAs: context.actionable && !done && operationAvailable(capabilities, closeOperation(task)),
  };

  async function claimIt() {
    try {
      await claim.mutateAsync({ id: task.id, project: task.project });
    } catch (error) {
      toast.error(error instanceof Error && error.message !== '' ? error.message : `Could not claim ${task.id}`);
      return;
    }
    toast.success(`Claimed ${task.id}`);
  }

  return (
    <>
      <Row data-task-row={task.id}>
        <PriorityMark priority={task.priority} />
        <RowId>{task.id}</RowId>
        <StatusMark status={mark} muted={done && (task.resolution ?? 'done') !== 'done'} />
        <RowTitle>
          <Link to={paths.task(task.id)} className="text-ink no-underline outline-none focus-visible:underline">
            {task.title}
          </Link>
        </RowTitle>
        <RowFacts task={task} mark={mark} context={context} />
        <RowSpacer />
        <RowActions>
          {can.claim ? (
            <Button size="sm" onClick={() => void claimIt()} data-task-action="claim">
              <Hand aria-hidden />
              Claim
            </Button>
          ) : null}
          <TaskMenu
            task={task}
            can={can}
            onOpen={() => void navigate(paths.task(task.id))}
            onClaim={() => void claimIt()}
            onPark={() => {
              closeAs.cancel();
              setForm('park');
            }}
            onCloseDone={() => {
              closeAs.cancel();
              setForm('close');
            }}
            onCloseAs={closeAs.pick}
          />
        </RowActions>
        <Holder task={task} />
        <RowAge title={context.ageTitle} data-row-age="">
          {context.age}
        </RowAge>
      </Row>
      {form === 'park' ? <ParkForm task={task} onDone={() => setForm(null)} /> : null}
      {form === 'close' ? (
        <RowPanel>
          <CloseDoneForm id={task.id} project={task.project} onDone={() => setForm(null)} />
        </RowPanel>
      ) : null}
      {closeAs.box ? <RowPanel>{closeAs.box}</RowPanel> : null}
    </>
  );
}

/**
 * A row in Waiting for you: what it asks answered in place, an approval by
 * Approve, a decision by its options, a question by Answer.
 */
export function WaitingRow({ task, context, writable }: { task: BoardTask; context: RowContext; writable: boolean }) {
  const capabilities = useCapabilities();
  const navigate = useNavigate();
  const paths = usePaths();
  const closeAs = useCloseAs({
    id: task.id,
    title: task.title,
    project: task.project,
    proposalVersion: task.proposalVersion ?? null,
    via: 'dismiss',
  });
  const { buttons, box } = useAskActions({
    ask: askVerb(task),
    id: task.id,
    title: task.title,
    project: task.project,
    proposalVersion: task.proposalVersion ?? null,
    choices: task.choices ?? null,
    steps: task.steps ?? null,
    disabledReason: verbReason(
      capabilities,
      writable &&
        operationAvailable(capabilities, askVerb(task) === 'do' ? 'step' : isGate(task) ? 'resolve' : 'respond'),
      UNAVAILABLE,
    ),
    chooseDisabledReason: verbReason(capabilities, writable && operationAvailable(capabilities, 'choose'), UNAVAILABLE),
  });
  const closable = writable && !isGate(task) && operationAvailable(capabilities, 'dismiss');
  const choosing = askVerb(task) === 'choose' && (task.choices ?? null) !== null;
  return (
    <>
      <Row answer={choosing ? 'wide' : true} data-inbox-row={task.id} data-task-row={task.id}>
        <PriorityMark priority={task.priority} />
        <RowId>{task.id}</RowId>
        <StatusMark status="waiting" />
        <RowTitle>
          <Link to={paths.task(task.id)} className="text-ink no-underline outline-none focus-visible:underline">
            {task.title}
          </Link>
        </RowTitle>
        <RowSpacer />
        <RowAnswer>{buttons}</RowAnswer>
        <RowActions className="ms-0">
          <TaskMenu
            task={task}
            can={{ claim: false, park: false, closeDone: false, closeAs: closable }}
            onOpen={() => void navigate(paths.task(task.id))}
            onCloseAs={closeAs.pick}
          />
        </RowActions>
        <RowAge title={context.ageTitle} data-row-age="">
          {context.age}
        </RowAge>
      </Row>
      {box ? <RowPanel>{box}</RowPanel> : null}
      {closeAs.box ? <RowPanel>{closeAs.box}</RowPanel> : null}
    </>
  );
}

/**
 * A row's menu: Open, Claim, Park, then Close as, which lists the ways a
 * close can end, and Copy id. An item this sign-in cannot run is left out.
 */
function TaskMenu({
  task,
  can,
  onOpen,
  onClaim,
  onPark,
  onCloseDone,
  onCloseAs,
}: {
  task: BoardTask;
  can: { claim: boolean; park: boolean; closeDone: boolean; closeAs: boolean };
  onOpen: () => void;
  onClaim?: () => void;
  onPark?: () => void;
  onCloseDone?: () => void;
  onCloseAs: (resolution: NotDone) => void;
}) {
  const [closing, setClosing] = useState(false);
  const closable = can.closeDone || can.closeAs;
  return (
    <Menu onOpenChange={(open) => (open ? undefined : setClosing(false))}>
      <MenuTrigger asChild>
        <IconButton size="sm" label={`Actions for ${task.id}`} icon={<Ellipsis aria-hidden />} />
      </MenuTrigger>
      {closing ? (
        <MenuContent key="close" label={`Close ${task.id} as`} align="end">
          <MenuItem icon={<ChevronLeft aria-hidden />} keepOpen onSelect={() => setClosing(false)}>
            Back
          </MenuItem>
          <MenuSeparator />
          {can.closeDone ? (
            <MenuItem icon={<Check aria-hidden />} onSelect={onCloseDone}>
              Done
            </MenuItem>
          ) : null}
          {can.closeAs
            ? NOT_DONE.map((resolution) => (
                <MenuItem key={resolution} onSelect={() => onCloseAs(resolution)}>
                  {RESOLUTION_LABELS[resolution]}
                </MenuItem>
              ))
            : null}
        </MenuContent>
      ) : (
        <MenuContent key="main" label={`Actions for ${task.id}`} align="end">
          <MenuItem icon={<ArrowUpRight aria-hidden />} shortcut="↵" onSelect={onOpen}>
            Open
          </MenuItem>
          {can.claim && onClaim ? (
            <MenuItem icon={<Hand aria-hidden />} shortcut="M" onSelect={onClaim}>
              Claim
            </MenuItem>
          ) : null}
          {can.park && onPark ? (
            <MenuItem icon={<Moon aria-hidden />} shortcut="Z" onSelect={onPark}>
              Park
            </MenuItem>
          ) : null}
          <MenuSeparator />
          {closable ? (
            <MenuItem icon={<Check aria-hidden />} submenu onSelect={() => setClosing(true)}>
              Close as
            </MenuItem>
          ) : null}
          <MenuItem icon={<Copy aria-hidden />} onSelect={() => void copyText(task.id, task.id)}>
            Copy id
          </MenuItem>
        </MenuContent>
      )}
    </Menu>
  );
}

/** Park a task until a date. */
function ParkForm({ task, onDone }: { task: BoardTask; onDone: () => void }) {
  const update = useUpdateTask();
  const [until, setUntil] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await update.mutateAsync({ id: task.id, project: task.project, edit: { defer: until } });
    } catch (error) {
      toast.error(error instanceof Error && error.message !== '' ? error.message : `Could not park ${task.id}`);
      return;
    }
    toast.success(`Parked ${task.id} until ${until}`);
    onDone();
  }
  return (
    <RowPanel>
      <form className="flex flex-wrap items-end gap-2" data-task-form="defer" onSubmit={(event) => void submit(event)}>
        <Field label="Park until" required className="w-44">
          <Input type="date" autoFocus value={until} onChange={(event) => setUntil(event.target.value)} />
        </Field>
        <Button variant="primary" type="submit" disabled={update.isPending || until === ''} data-task-confirm="defer">
          <Moon aria-hidden />
          Park
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </form>
    </RowPanel>
  );
}
