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
  UserPlus,
} from 'lucide-react';
import { memo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CloseDoneForm } from '../../components/CloseResolution';
import { factMenuFooter, factMenuItems } from '../../components/Fact';
import { Avatar } from '../../components/ui/avatar';
import { Badge, Progress } from '../../components/ui/badge';
import { Button, IconButton } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/field';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { Row, RowActions, RowAge, RowAnswer, RowId, RowMeta, RowSpacer, RowTitle } from '../../components/ui/row';
import { ActivityMark, PriorityMark, StatusMark, TypeMark } from '../../components/ui/symbols';
import type { TasksCapabilities } from '../../api/types';
import { fieldAvailable, operationAvailable, useClaimTask, useUpdateTask, verbReason } from '../../hooks/useTasks';
import { copyText } from '../../lib/clipboard';
import { calendarDay, useTimeZone } from '../../lib/dates';
import { ageMs, formatAge, formatMinutes } from '../../lib/format';
import { activityOf } from '../../lib/live';
import {
  isAgentActor,
  isShortcut,
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
import { DroppedFact } from './relies-on-dropped';
import { closeOperation, declinedOnClose, useCloseAs } from './close-actions';
import { assigneeChange, assigneeEditor, priorityChange, priorityEditor, useFieldSave } from './task-facts';

const UNAVAILABLE = 'This sign-in cannot answer it.';

/** What a row needs from the board around it. */
export interface RowContext {
  /** What this sign-in may do, read once for every row. */
  capabilities: TasksCapabilities;
  statuses: ReadonlyMap<string, string>;
  /** The tasks a pending approval holds. */
  held: ReadonlySet<string>;
  epicProgress: ReadonlyMap<string, { closed: number; total: number }>;
  /** Its project's read answered and this sign-in may write, so its actions can run. */
  actionable: boolean;
  /** Who holds work on the board, offered first when a task is assigned. */
  people: readonly string[];
  /** How long ago the task changed, as `40m`, or in the waiting groups how long ago it was created. */
  age: string;
  /** What `age` counts from, in words, where it is not the last change: `Created 3d ago`. */
  ageTitle?: string;
  nowMs: number;
}

/** Whether two objects hold the same values under the same keys, each compared by identity. */
function sameFields(before: object, after: object): boolean {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * A row draws again only when its task or what the board says of it changes.
 * The board builds each row's context anew on every draw, so the context is
 * compared field by field.
 */
function sameRow<Props extends { context: RowContext }>(before: Props, after: Props): boolean {
  const { context: was, ...rest } = before;
  const { context: is, ...next } = after;
  return sameFields(was, is) && sameFields(rest, next);
}

/** The box under a row: what an action that needs more than a press asks for. */
function RowPanel({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-border bg-surface py-2.5 ps-[164px] pe-5 max-sm:px-4" data-row-panel="">
      {children}
    </div>
  );
}

/** The facts after a row's title: type, labels, epic progress, checks, comments, what it waits on, the dropped
 * tasks it relies on, when it
 * unparks, for a ready task its estimate, for a task someone holds the helper they work through and when
 * they last wrote to it, and for a closed task how it ended or where its change is. */
function RowFacts({ task, mark, context }: { task: BoardTask; mark: StatusMarkKey; context: RowContext }) {
  const type = typeMarkFor(task.issueType, task.awaitType, (task.steps ?? null) !== null);
  const labels = task.labels.filter((label) => label !== 'human').slice(0, 2);
  const progress = task.issueType === 'epic' ? context.epicProgress.get(task.id) : undefined;
  const checks = checklistCount(task.acceptance);
  const waits = mark === 'blocked' ? waitingOn(task, context.statuses) : [];
  const dropped = task.status === 'closed' ? [] : (task.reliesOnDropped ?? []);
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
      {dropped.length > 0 ? (
        <RowMeta data-row-dropped="">
          <DroppedFact dropped={dropped} />
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
export const TaskRow = memo(function TaskRow({ task, context }: { task: BoardTask; context: RowContext }) {
  const { capabilities } = context;
  const paths = usePaths();
  const claim = useClaimTask();
  const [form, setForm] = useState<null | 'park' | 'close'>(null);
  const [menu, setMenu] = useState<MenuList | null>(null);
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
  const can = {
    claim:
      context.actionable &&
      !done &&
      task.assignee === null &&
      fieldAvailable(capabilities, 'claim') &&
      !claim.isPending,
    park: context.actionable && !done && fieldAvailable(capabilities, 'defer'),
    closeDone: context.actionable && !done && !declinedOnClose(task) && operationAvailable(capabilities, 'close'),
    closeAs: context.actionable && !done && operationAvailable(capabilities, closeOperation(task)),
    assign: context.actionable && !done && fieldAvailable(capabilities, 'assignee'),
    priority: context.actionable && !done && fieldAvailable(capabilities, 'priority'),
  };
  const park = () => {
    closeAs.cancel();
    setForm('park');
  };
  // The action keys act on the row that holds focus; a key typed in its menu or a field is theirs.
  const keys: readonly (readonly [string, boolean, () => void])[] = [
    ['m', can.claim, () => void claimIt()],
    ['a', can.assign, () => setMenu('assign')],
    ['p', can.priority, () => setMenu('priority')],
    ['z', can.park, park],
  ];
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const hit = keys.find(([key, allowed]) => allowed && isShortcut(event, key));
    if (!hit) return;
    event.preventDefault();
    hit[2]();
  }

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
      <Row data-task-row={task.id} onKeyDown={onKeyDown}>
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
            list={menu}
            onList={setMenu}
            can={can}
            people={context.people}
            onClaim={() => void claimIt()}
            onPark={park}
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
}, sameRow);

/**
 * A row in Waiting for you: what it asks answered in place, an approval by
 * Approve or Did it myself, after the pull request whose auto-merge Approve
 * turns on, a decision by its options, a question by Answer.
 */
export const WaitingRow = memo(function WaitingRow({
  task,
  context,
  writable,
}: {
  task: BoardTask;
  context: RowContext;
  writable: boolean;
}) {
  const { capabilities } = context;
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
    pullRequest: task.pullRequest ?? null,
    canDecline: writable && capabilities.operations?.includes('decline') === true,
    disabledReason: verbReason(
      capabilities,
      writable &&
        operationAvailable(capabilities, askVerb(task) === 'do' ? 'step' : isGate(task) ? 'resolve' : 'respond'),
      UNAVAILABLE,
    ),
    chooseDisabledReason: verbReason(capabilities, writable && operationAvailable(capabilities, 'choose'), UNAVAILABLE),
    performedDisabledReason: verbReason(
      capabilities,
      writable && operationAvailable(capabilities, 'performed'),
      UNAVAILABLE,
    ),
  });
  const closable = writable && !isGate(task) && operationAvailable(capabilities, 'dismiss');
  const choosing = askVerb(task) === 'choose' && (task.choices ?? null) !== null;
  const gated = askVerb(task) === 'approve' && (task.pullRequest ?? null) !== null;
  const [menu, setMenu] = useState<MenuList | null>(null);
  return (
    <>
      <Row answer={choosing || gated ? 'wide' : true} data-inbox-row={task.id} data-task-row={task.id}>
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
            list={menu}
            onList={setMenu}
            can={{ claim: false, park: false, closeDone: false, closeAs: closable, assign: false, priority: false }}
            people={context.people}
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
}, sameRow);

/** The lists a row's menu shows: its actions, the ways a close ends, who to give the task to, its priorities. */
type MenuList = 'main' | 'close' | 'assign' | 'priority';

/** A row's menu: its task, the list it shows and what its items run. */
interface TaskMenuProps {
  task: BoardTask;
  /** The list shown, null while the menu is closed. */
  list: MenuList | null;
  onList: (list: MenuList | null) => void;
  can: { claim: boolean; park: boolean; closeDone: boolean; closeAs: boolean; assign: boolean; priority: boolean };
  people: readonly string[];
  onClaim?: () => void;
  onPark?: () => void;
  onCloseDone?: () => void;
  onCloseAs: (resolution: NotDone) => void;
}

/**
 * A row's menu: Open, Claim, Assign to, Priority, Park, then Close as, which
 * lists the ways a close can end, and Copy id. Assign to, Priority and Close
 * as show their list in the menu's place. An item this sign-in cannot run is
 * left out.
 */
function TaskMenu(props: TaskMenuProps) {
  const { task, list, onList } = props;
  return (
    <Menu open={list !== null} onOpenChange={(open) => onList(open ? 'main' : null)}>
      <MenuTrigger asChild>
        <IconButton size="sm" label={`Actions for ${task.id}`} icon={<Ellipsis aria-hidden />} />
      </MenuTrigger>
      {/* The lists, and the navigation and saves they run, mount only while the menu is open. */}
      {list === null ? null : <TaskMenuList {...props} list={list} />}
    </Menu>
  );
}

function TaskMenuList({
  task,
  list,
  onList,
  can,
  people,
  onClaim,
  onPark,
  onCloseDone,
  onCloseAs,
}: TaskMenuProps & { list: MenuList }) {
  const navigate = useNavigate();
  const paths = usePaths();
  const save = useFieldSave(task.id, task.project);
  const closable = can.closeDone || can.closeAs;
  const back = (
    <MenuItem key="back" icon={<ChevronLeft aria-hidden />} keepOpen onSelect={() => onList('main')}>
      Back
    </MenuItem>
  );
  const close = () => onList(null);
  const editor =
    list === 'assign' ? assigneeEditor(task, people, task.actors) : list === 'priority' ? priorityEditor(task) : null;
  const choose = (next: string) => {
    close();
    void save(list === 'assign' ? assigneeChange(task, next) : priorityChange(task, next));
  };
  const label =
    list === 'close'
      ? `Close ${task.id} as`
      : list === 'assign'
        ? `Assign ${task.id} to`
        : list === 'priority'
          ? `Priority of ${task.id}`
          : `Actions for ${task.id}`;
  return (
    <MenuContent
      label={label}
      align="end"
      panelKey={list}
      footer={editor ? factMenuFooter(label, editor, choose) : null}
    >
      {list === 'close'
        ? [
            back,
            <MenuSeparator key="separator" />,
            ...(can.closeDone
              ? [
                  <MenuItem key="done" icon={<Check aria-hidden />} onSelect={onCloseDone}>
                    Done
                  </MenuItem>,
                ]
              : []),
            ...(can.closeAs
              ? NOT_DONE.map((resolution) => (
                  <MenuItem key={resolution} onSelect={() => onCloseAs(resolution)}>
                    {RESOLUTION_LABELS[resolution]}
                  </MenuItem>
                ))
              : []),
          ]
        : editor
          ? [back, <MenuSeparator key="separator" />, ...factMenuItems(editor, choose)]
          : [
              <MenuItem
                key="open"
                icon={<ArrowUpRight aria-hidden />}
                shortcut="↵"
                onSelect={() => void navigate(paths.task(task.id))}
              >
                Open
              </MenuItem>,
              ...(can.claim && onClaim
                ? [
                    <MenuItem key="claim" icon={<Hand aria-hidden />} shortcut="M" onSelect={onClaim}>
                      Claim
                    </MenuItem>,
                  ]
                : []),
              ...(can.assign
                ? [
                    <MenuItem
                      key="assign"
                      icon={<UserPlus aria-hidden />}
                      shortcut="A"
                      keepOpen
                      onSelect={() => onList('assign')}
                    >
                      Assign to
                    </MenuItem>,
                  ]
                : []),
              ...(can.priority
                ? [
                    <MenuItem
                      key="priority"
                      icon={<PriorityMark priority={task.priority} label={null} />}
                      shortcut="P"
                      keepOpen
                      onSelect={() => onList('priority')}
                    >
                      Priority
                    </MenuItem>,
                  ]
                : []),
              ...(can.park && onPark
                ? [
                    <MenuItem key="park" icon={<Moon aria-hidden />} shortcut="Z" onSelect={onPark}>
                      Park
                    </MenuItem>,
                  ]
                : []),
              <MenuSeparator key="separator" />,
              ...(closable
                ? [
                    <MenuItem key="close" icon={<Check aria-hidden />} submenu onSelect={() => onList('close')}>
                      Close as
                    </MenuItem>,
                  ]
                : []),
              <MenuItem key="copy" icon={<Copy aria-hidden />} onSelect={() => void copyText(task.id, task.id)}>
                Copy id
              </MenuItem>,
            ]}
    </MenuContent>
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
