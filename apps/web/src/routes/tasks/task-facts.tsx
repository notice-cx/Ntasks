/**
 * A task page's side panel: each fact as its name and its value in plain
 * words, the ones this sign-in may change opening a menu of values, then
 * when the task was created and last changed.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Layers, Moon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { TASK_LIMITS } from '@ntasks/domain';
import type { LiveEpic, LiveTask, TaskActor, TaskEdit, TaskField, TaskFieldValue, TaskProject } from '@/api/types';
import { Fact, LinkedFact, type FactChoice, type FactEditor } from '@/components/Fact';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { PriorityMark, StatusMark, TypeMark } from '@/components/ui/symbols';
import { fieldAvailable, useCapabilities, useProjectFields, useUpdateTask } from '@/hooks/useTasks';
import { fieldEditable, parseFieldInput, toggledOptions } from '@/lib/custom-fields';
import {
  ageMs,
  calendarDay,
  fieldKeyName,
  fieldValueText,
  formatAge,
  formatMinutes,
  localDay,
  parseMinutes,
} from '@/lib/format';
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
import { cn } from '@/lib/utils';

export type FieldSave = (input: {
  label: string;
  edit: TaskEdit;
  undo?: TaskEdit;
  /** The toast's words, when not "Saved" and the label. */
  said?: string;
  /** The retry key of this submission, when a second attempt may follow a failed one. */
  idempotencyKey?: string;
}) => Promise<boolean>;

/** Save one field with a toast that offers Undo, the contract every editable fact keeps. */
export function useFieldSave(id: string, project: string): FieldSave {
  const update = useUpdateTask();
  return useCallback(
    async ({ label, edit, undo, said, idempotencyKey }) => {
      try {
        await update.mutateAsync({ id, project, edit, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Could not save ${label}`);
        return false;
      }
      toast.success(
        said ?? `Saved ${label}`,
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

function dayPresets(nowMs: number, today = false): FactChoice[] {
  return [
    ...(today ? [{ label: 'Today', value: localDay(nowMs) }] : []),
    { label: 'Tomorrow', value: localDay(nowMs, 1) },
    { label: 'In a week', value: localDay(nowMs, 7) },
    ...(today ? [] : [{ label: 'In a month', value: localDay(nowMs, 30) }]),
  ];
}

/** An estimate's presets, written as the fact shows them. */
const ESTIMATE_PRESETS: FactChoice[] = [30, 60, 120, 240, 480].map((minutes) => ({
  value: formatMinutes(minutes),
  label: formatMinutes(minutes),
}));

/** The word a cleared value takes, as an absent fact reads. */
const NONE = 'None';

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
  const estimate = task.estimateMinutes == null ? null : formatMinutes(task.estimateMinutes);
  const parentName = parent?.title ?? parentTitle ?? task.parent;
  const definitions = useProjectFields(project.logicalKey).data?.fields ?? [];
  const values = task.fields ?? {};
  // The project's fields in the order it defined them, each with its value; a
  // value whose field this page has not read is named from its key.
  const customFields: { key: string; field: TaskField | null; value: TaskFieldValue | undefined }[] = [
    ...definitions
      .filter((field) => values[field.key] !== undefined || (fieldEditable(field) && can('fields')))
      .map((field) => ({ key: field.key, field, value: values[field.key] })),
    ...Object.entries(values)
      .filter(([key]) => !definitions.some((field) => field.key === key))
      .map(([key, value]) => ({ key, field: null, value })),
  ];

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
            editor={can('defer') ? { kind: 'date', value: parked, presets: dayPresets(nowMs), clear: 'Unpark' } : null}
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
        {due !== '' || can('dueAt') ? (
          <Fact
            label="Due"
            valueText={due === '' ? NONE : calendarDay(due, nowMs)}
            muted={due === ''}
            editor={
              can('dueAt')
                ? { kind: 'date', value: due, presets: dayPresets(nowMs), clear: NONE, field: 'Due date' }
                : null
            }
            onSave={(next) =>
              save({
                label: 'the due date',
                edit: { dueAt: next === '' ? null : next },
                undo: { dueAt: due === '' ? null : due },
              })
            }
          >
            {due === '' ? NONE : <span className="nums">{calendarDay(due, nowMs)}</span>}
          </Fact>
        ) : null}
        {estimate !== null || can('estimateMinutes') ? (
          <Fact
            label="Estimate"
            valueText={estimate ?? NONE}
            muted={estimate === null}
            editor={
              can('estimateMinutes')
                ? {
                    kind: 'text',
                    value: estimate ?? '',
                    field: 'Estimate',
                    presets: ESTIMATE_PRESETS,
                    clear: NONE,
                    check: (text) =>
                      parseMinutes(text, TASK_LIMITS.estimateMinutes) === null ? 'Not a duration' : null,
                  }
                : null
            }
            onSave={(next) =>
              save({
                label: 'the estimate',
                edit: { estimateMinutes: next === '' ? null : parseMinutes(next, TASK_LIMITS.estimateMinutes) },
                undo: { estimateMinutes: task.estimateMinutes ?? null },
              })
            }
          >
            {estimate === null ? NONE : <span className="nums">{estimate}</span>}
          </Fact>
        ) : null}
        {customFields.map(({ key, field, value }) => (
          <CustomFieldFact
            key={key}
            fieldKey={key}
            field={field}
            value={value}
            editable={field !== null && fieldEditable(field) && can('fields')}
            nowMs={nowMs}
            onSave={(next, before) =>
              save({
                label: field?.name ?? fieldKeyName(key),
                edit: { fields: { [key]: next } },
                undo: { fields: { [key]: before ?? null } },
              })
            }
          />
        ))}
      </dl>
      <div className="mx-2 border-t border-border pt-3 text-meta leading-5.5 text-ink-3" data-task-stamps="">
        {task.createdAt ? <div>Created {formatAge(ageMs(nowMs, task.createdAt))} ago</div> : null}
        {task.updatedAt ? <div>Updated {formatAge(ageMs(nowMs, task.updatedAt))} ago</div> : null}
      </div>
    </aside>
  );
}

const YES_NO: FactChoice[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

/** A typed value's problem in words, or null when the field takes it. */
function typedCheck(type: string): (text: string) => string | null {
  return (text) => {
    const parsed = parseFieldInput(type, text);
    return parsed.ok ? null : parsed.error;
  };
}

/** The editor a custom field's type takes. A typed value is saved as its words; `CustomFieldFact` reads them back. */
function customFieldEditor(field: TaskField, value: TaskFieldValue | undefined, nowMs: number): FactEditor | null {
  const clear = value === undefined ? [] : [{ value: '', label: NONE }];
  switch (field.type) {
    case 'single-choice':
      return {
        kind: 'choice',
        value: typeof value === 'string' ? value : '',
        choices: [...(field.options ?? []).map((option) => ({ value: option, label: option })), ...clear],
      };
    case 'multiple-choice':
      return {
        kind: 'toggle',
        values: Array.isArray(value) ? value : [],
        choices: (field.options ?? []).map((option) => ({ value: option, label: option })),
      };
    case 'yes-no':
      return { kind: 'choice', value: typeof value === 'boolean' ? String(value) : '', choices: [...YES_NO, ...clear] };
    case 'date':
      return {
        kind: 'date',
        value: typeof value === 'string' ? value : '',
        presets: dayPresets(nowMs, true),
        clear: NONE,
        field: field.name,
      };
    case 'text':
    case 'number':
    case 'url':
      return {
        kind: 'text',
        value: value === undefined ? '' : String(value),
        field: field.name,
        inputType: field.type === 'text' ? 'text' : field.type,
        clear: NONE,
        check: typedCheck(field.type),
      };
    default:
      return null;
  }
}

/**
 * One custom field: its name (the field's own, or from its key until the
 * project's fields are read) and its value in words. A field in use opens
 * the editor its type takes; a retired field, or one of a type this build
 * does not know, is only its words.
 */
function CustomFieldFact({
  fieldKey,
  field,
  value,
  editable,
  nowMs,
  onSave,
}: {
  fieldKey: string;
  field: TaskField | null;
  value: TaskFieldValue | undefined;
  editable: boolean;
  nowMs: number;
  /** Saves `next`; `before` is the value it replaces, which Undo puts back. */
  onSave: (next: TaskFieldValue | null, before: TaskFieldValue | undefined) => Promise<boolean>;
}) {
  const label = field?.name ?? fieldKeyName(fieldKey);
  const type = field?.type ?? null;
  const text =
    value === undefined
      ? NONE
      : type === 'date' && typeof value === 'string'
        ? calendarDay(value, nowMs)
        : fieldValueText(value);
  const editor = editable && field ? customFieldEditor(field, value, nowMs) : null;
  // A multiple choice is saved whole, and its menu takes a second press before
  // the first save is read back, so each press builds on the value the last one sent.
  const sent = useRef(value);
  useEffect(() => {
    sent.current = value;
  }, [value]);

  function save(next: string, on?: boolean): Promise<boolean> {
    if (!field) return Promise.resolve(false);
    const before = sent.current;
    const send = async (value: TaskFieldValue | null) => {
      const intended = value ?? undefined;
      sent.current = intended;
      const saved = await onSave(value, before);
      // A refused save leaves the task as it was, and no new read will say so.
      if (!saved && sent.current === intended) sent.current = before;
      return saved;
    };
    if (next === '' && field.type !== 'multiple-choice') return send(null);
    switch (field.type) {
      case 'multiple-choice':
        return send(toggledOptions(field, before, next, on ?? true));
      case 'yes-no':
        return send(next === 'true');
      case 'text':
      case 'number':
      case 'url': {
        const parsed = parseFieldInput(field.type, next);
        return parsed.ok ? send(parsed.value) : Promise.resolve(false);
      }
      default:
        return send(next);
    }
  }

  return (
    <Fact
      label={label}
      valueText={text}
      muted={value === undefined}
      wrap={type === 'multiple-choice'}
      editor={editor}
      onSave={save}
    >
      {value === undefined ? (
        NONE
      ) : type === 'url' && typeof value === 'string' ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="relative z-10 min-w-0 truncate text-ink no-underline underline-offset-3 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
          data-task-field-value={fieldKey}
        >
          {value.replace(/^https?:\/\//, '')}
        </a>
      ) : (
        <span
          className={cn('[overflow-wrap:anywhere]', (type === 'number' || type === 'date') && 'nums')}
          data-task-field-value={fieldKey}
        >
          {text}
        </span>
      )}
    </Fact>
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
