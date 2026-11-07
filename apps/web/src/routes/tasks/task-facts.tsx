/**
 * A task page's side panel: each fact as its name and its value in plain
 * words, the ones this sign-in may change opening a menu of values, then
 * when the task was created and last changed.
 */
import { useCallback, type ReactNode } from 'react';
import { Layers, Moon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { LiveEpic, LiveTask, TaskActor, TaskEdit, TaskProject } from '@/api/types';
import { Fact, LinkedFact, type FactChoice } from '@/components/Fact';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { PriorityMark, StatusMark, TypeMark } from '@/components/ui/symbols';
import { fieldAvailable, useCapabilities, useUpdateTask } from '@/hooks/useTasks';
import { ageMs, calendarDay, fieldKeyName, fieldValueText, formatAge, formatMinutes, localDay } from '@/lib/format';
import {
  isAgentActor,
  priorityLabel,
  PRIORITY_LABELS,
  statusMarkFor,
  statusMarkOfStored,
  STATUS_MARK_LABELS,
  typeLabel,
  typeMarkFor,
} from '@/lib/symbols';
import { actorLabel, claimedModel, RESOLUTION_LABELS, TASK_STATUSES } from '@/lib/task-model';
import { taskPath } from '@/lib/task-path';

export type FieldSave = (input: { label: string; edit: TaskEdit; undo?: TaskEdit }) => Promise<boolean>;

/** Save one field with a toast that offers Undo, the contract every editable fact keeps. */
export function useFieldSave(id: string, project: string): FieldSave {
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

const STATUS_CHOICES: FactChoice[] = TASK_STATUSES.filter((status) => status.stored !== 'closed').map((status) => ({
  value: status.stored,
  label: status.label,
  mark: <StatusMark status={statusMarkOfStored(status.stored)} label={null} />,
}));

const PRIORITY_CHOICES: FactChoice[] = PRIORITY_LABELS.map((word, priority) => ({
  value: String(priority),
  label: word,
  mark: <PriorityMark priority={priority} label={null} />,
}));

function parkPresets(nowMs: number): FactChoice[] {
  return [
    { label: 'Tomorrow', value: localDay(nowMs, 1) },
    { label: 'In a week', value: localDay(nowMs, 7) },
    { label: 'In a month', value: localDay(nowMs, 30) },
  ];
}

/** An actor as a menu draws them: their avatar, and their name. */
function actorChoice(actor: string, actors: readonly TaskActor[] | undefined): FactChoice {
  const name = actorLabel(actor, actors);
  return {
    value: actor,
    label: name,
    mark: <Avatar name={name} agent={isAgentActor(actor)} size={18} decorative />,
  };
}

export function TaskFacts({
  task,
  project,
  parent,
  parentTitle,
  epics,
  siblings,
  actors,
  nowMs,
}: {
  task: LiveTask;
  project: TaskProject;
  parent: LiveEpic | null;
  parentTitle: string | null;
  epics: readonly LiveEpic[];
  /** The project's other tasks: who holds work there, which labels it uses, what a link's status is. */
  siblings: readonly LiveTask[];
  actors: readonly TaskActor[] | undefined;
  nowMs: number;
}) {
  const capabilities = useCapabilities();
  const save = useFieldSave(task.id, project.logicalKey);
  const closed = task.status === 'closed';
  const can = (field: string) => !closed && fieldAvailable(capabilities, field);

  const statuses = new Map(siblings.map((row) => [row.id, row.status]));
  const mark = statusMarkFor(task, statuses);
  const resolution = closed ? (task.resolution ?? 'done') : null;
  const statusWord = resolution ? RESOLUTION_LABELS[resolution] : STATUS_MARK_LABELS[mark];

  const holder = task.assignee ? actorLabel(task.assignee, actors) : null;
  const model = task.assignee ? claimedModel(task) : null;
  const people = [...new Set([...siblings.flatMap((row) => (row.assignee ? [row.assignee] : [])), task.assignee ?? ''])]
    .filter(Boolean)
    .sort();

  const labels = [...new Set([...siblings.flatMap((row) => row.labels), ...task.labels])].sort();
  const parked = (task.deferUntil ?? '').slice(0, 10);
  const due = (task.dueAt ?? '').slice(0, 10);
  const parentName = parent?.title ?? parentTitle ?? task.parent;
  const fields = Object.entries(task.fields ?? {});

  return (
    <aside aria-label="Facts" className="flex flex-col gap-3" data-task-facts="">
      <dl className="m-0 flex flex-col gap-px">
        <Fact
          label="Status"
          valueText={statusWord}
          editor={can('status') ? { kind: 'choice', value: task.status, choices: STATUS_CHOICES } : null}
          onSave={(next) => save({ label: 'the status', edit: { status: next }, undo: { status: task.status } })}
        >
          <StatusMark status={mark} muted={resolution !== null && resolution !== 'done'} label={null} />
          <span data-task-status={mark}>{statusWord}</span>
        </Fact>
        <Fact
          label="Priority"
          valueText={priorityLabel(task.priority)}
          editor={can('priority') ? { kind: 'choice', value: String(task.priority), choices: PRIORITY_CHOICES } : null}
          onSave={(next) =>
            save({ label: 'the priority', edit: { priority: Number(next) }, undo: { priority: task.priority } })
          }
        >
          <PriorityMark priority={task.priority} label={null} />
          {priorityLabel(task.priority)}
        </Fact>
        <Fact
          label="Assignee"
          valueText={holder ?? 'Nobody'}
          muted={holder === null}
          editor={
            can('assignee')
              ? {
                  kind: 'choice',
                  value: task.assignee ?? '',
                  choices: [...people.map((actor) => actorChoice(actor, actors)), { value: '', label: 'Nobody' }],
                  other: 'Someone else',
                }
              : null
          }
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
          {task.assignee && holder ? (
            <>
              <Avatar name={holder} agent={isAgentActor(task.assignee)} model={model} decorative />
              {/* The name keeps its room; the model gives way first. */}
              <span className="shrink-0">{holder}</span>
              {model ? <span className="font-normal text-ink-3">{model}</span> : null}
            </>
          ) : (
            'Nobody'
          )}
        </Fact>
        <Fact label="Type" valueText={typeLabel(task.issueType, task.awaitType)}>
          <TypeMark type={typeMarkFor(task.issueType, task.awaitType)} size={14} label={null} />
          {typeLabel(task.issueType, task.awaitType)}
        </Fact>
        <Fact label="Project" valueText={project.displayName}>
          <FactLink to={`/tasks?${new URLSearchParams({ project: project.logicalKey })}`}>
            {project.displayName}
          </FactLink>
        </Fact>
        <LinkedFact
          label="Epic"
          valueText={parentName ?? 'None'}
          muted={!task.parent}
          editor={
            can('parent')
              ? {
                  kind: 'choice',
                  value: task.parent ?? '',
                  choices: [
                    ...epics
                      .filter((row) => row.id !== task.id && row.status !== 'closed')
                      .map((row) => ({ value: row.id, label: row.title, mark: <Layers aria-hidden /> })),
                    { value: '', label: 'None' },
                  ],
                  other: 'Another task id',
                }
              : null
          }
          onSave={(next) => save({ label: 'the epic', edit: { parent: next }, undo: { parent: task.parent ?? '' } })}
        >
          {task.parent ? <FactLink to={taskPath(task.parent)}>{parentName}</FactLink> : 'None'}
        </LinkedFact>
        <Fact
          label="Labels"
          valueText={task.labels.length > 0 ? task.labels.join(', ') : 'None'}
          muted={task.labels.length === 0}
          wrap
          editor={
            can('addLabels')
              ? {
                  kind: 'toggle',
                  values: task.labels,
                  choices: labels.map((label) => ({ value: label, label })),
                  other: 'New label',
                }
              : null
          }
          onSave={(label, on = true) =>
            on
              ? save({ label: `label ${label}`, edit: { addLabels: [label] }, undo: { removeLabels: [label] } })
              : save({ label: `label ${label}`, edit: { removeLabels: [label] }, undo: { addLabels: [label] } })
          }
        >
          {task.labels.length > 0
            ? task.labels.map((label) => (
                <Badge key={label} dot>
                  <span data-task-label={label}>{label}</span>
                </Badge>
              ))
            : 'None'}
        </Fact>
        {parked !== '' || can('defer') ? (
          <Fact
            label="Parked until"
            valueText={parked === '' ? 'None' : calendarDay(parked, nowMs)}
            muted={parked === ''}
            editor={can('defer') ? { kind: 'date', value: parked, presets: parkPresets(nowMs), clear: 'Unpark' } : null}
            onSave={(next) => save({ label: 'the parked date', edit: { defer: next }, undo: { defer: parked } })}
          >
            {parked === '' ? (
              'None'
            ) : (
              <>
                <Moon aria-hidden size={14} className="text-ink-3" />
                <span className="nums">{calendarDay(parked, nowMs)}</span>
              </>
            )}
          </Fact>
        ) : null}
        {due !== '' ? (
          <Fact label="Due" valueText={calendarDay(due, nowMs)}>
            <span className="nums">{calendarDay(due, nowMs)}</span>
          </Fact>
        ) : null}
        {task.estimateMinutes != null ? (
          <Fact label="Estimate" valueText={formatMinutes(task.estimateMinutes)}>
            <span className="nums">{formatMinutes(task.estimateMinutes)}</span>
          </Fact>
        ) : null}
        {fields.map(([key, value]) => (
          <Fact key={key} label={fieldKeyName(key)} valueText={fieldValueText(value)}>
            <span className="[overflow-wrap:anywhere]" data-task-field-value={key}>
              {fieldValueText(value)}
            </span>
          </Fact>
        ))}
      </dl>
      <div className="mx-2 border-t border-border pt-3 text-meta leading-5.5 text-ink-3" data-task-stamps="">
        {task.createdAt ? <div>Created {formatAge(ageMs(nowMs, task.createdAt))} ago</div> : null}
        {task.updatedAt ? <div>Updated {formatAge(ageMs(nowMs, task.updatedAt))} ago</div> : null}
      </div>
    </aside>
  );
}

/** A fact's value that is a page of its own: Text, underlined while pointed at, above the line's own press area. */
function FactLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="relative z-10 min-w-0 truncate text-ink no-underline underline-offset-3 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </Link>
  );
}
