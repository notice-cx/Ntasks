/**
 * A task page's side panel: each fact as its name and its value in plain
 * words, the ones this sign-in may change opening a menu of values, then
 * when the task was created and last changed.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Layers, Moon, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { actorKey, NEXT_LABEL, TASK_LIMITS } from '@ntasks/domain';
import type { LiveEpic, LiveTask, TaskActor, TaskEdit, TaskField, TaskFieldValue, TaskProject } from '../../api/types';
import {
  Fact,
  factMenuFooter,
  factMenuItems,
  LinkedFact,
  type FactChoice,
  type FactEditor,
} from '../../components/Fact';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/ui/menu';
import { Avatar } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { PriorityMark, StatusMark, TypeMark } from '../../components/ui/symbols';
import { fieldAvailable, useCapabilities, useProjectFields, useUpdateTask } from '../../hooks/useTasks';
import { fieldEditable, httpUrl, parseFieldInput, toggledOptions } from '../../lib/custom-fields';
import { calendarDay, dayFrom, useTimeZone } from '../../lib/dates';
import { ageMs, fieldKeyName, fieldValueText, formatAge, formatMinutes, parseMinutes } from '../../lib/format';
import {
  isAgentActor,
  priorityLabel,
  PRIORITY_LABELS,
  statusMarkOfStored,
  typeLabel,
  typeMarkFor,
} from '../../lib/symbols';
import { actorLabel, claimedModel, TASK_STATUSES } from '../../lib/task-model';
import { usePaths } from '../../lib/paths';
import { cn } from '../../lib/utils';
import type { TaskPageStatus } from './task-head';
import { canAddToNext, canUseNext, isInNext, NextTaskAction } from './next';

export type FieldSave = (input: {
  label: string;
  edit: TaskEdit;
  undo?: TaskEdit;
  /** The toast's words, when not "Saved" and the label. */
  said?: string;
  /** The retry key of this submission, when a second attempt may follow a failed one. */
  idempotencyKey?: string;
}) => Promise<boolean>;

/** The priorities to pick from, the task's own ticked. */
export function priorityEditor(task: Pick<LiveTask, 'priority'>): FactEditor {
  return { kind: 'choice', value: String(task.priority), choices: PRIORITY_CHOICES };
}

export function priorityChange(task: Pick<LiveTask, 'priority'>, next: string): Parameters<FieldSave>[0] {
  return { label: 'the priority', edit: { priority: Number(next) }, undo: { priority: task.priority } };
}

/** Who to give the task to: the people who hold work beside it, Nobody, or someone else typed. */
export function assigneeEditor(
  task: Pick<LiveTask, 'assignee'>,
  people: readonly string[],
  actors: readonly TaskActor[] | undefined,
): FactEditor {
  return {
    kind: 'choice',
    value: task.assignee ?? '',
    choices: [
      ...oneSpellingEach(people, task.assignee).map((actor) => actorChoice(actor, actors)),
      { value: '', label: 'Nobody' },
    ],
    other: 'Someone else',
  };
}

/** Gives the task to `next`, or with "" releases it. */
export function assigneeChange(task: Pick<LiveTask, 'status' | 'assignee'>, next: string): Parameters<FieldSave>[0] {
  return {
    label: 'the assignee',
    edit: { assignee: next },
    // A new holder owns an in-progress claim, so taking it back is theirs to agree to, not an Undo.
    ...(task.status === 'in_progress' && next !== '' && next !== task.assignee
      ? {}
      : { undo: { assignee: task.assignee ?? '' } }),
  };
}

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
                // The menu that saved may have closed by now, and a mutation calls back only while its component is mounted.
                onClick: () => {
                  update.mutateAsync({ id, project, edit: undo }).then(
                    () => toast.success(`Reverted ${label}`),
                    (error: Error) => toast.error(error.message),
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

/** Days a date's menu offers, counted from today in the person's time zone. */
function dayPresets(nowMs: number, zone: string, today = false): FactChoice[] {
  return [
    ...(today ? [{ label: 'Today', value: dayFrom(nowMs, zone) }] : []),
    { label: 'Tomorrow', value: dayFrom(nowMs, zone, 1) },
    { label: 'In a week', value: dayFrom(nowMs, zone, 7) },
    ...(today ? [] : [{ label: 'In a month', value: dayFrom(nowMs, zone, 30) }]),
  ];
}

/** An estimate's presets, written as the fact shows them. */
const ESTIMATE_PRESETS: FactChoice[] = [30, 60, 120, 240, 480].map((minutes) => ({
  value: formatMinutes(minutes),
  label: formatMinutes(minutes),
}));

/** The word a cleared value takes, as an absent fact reads. */
const NONE = 'None';

/**
 * Who the assignee picker offers: one spelling for each sender a reader sees,
 * the holder's own for the holder, else the one current sign-ins write (with
 * a prefix) over an imported one.
 */
function oneSpellingEach(actors: readonly string[], holder: string | null): string[] {
  const chosen = new Map<string, string>();
  for (const actor of [...new Set(actors)].sort()) {
    const key = actorKey(actor);
    const kept = chosen.get(key);
    if (kept === undefined || (!kept.includes(':') && actor.includes(':'))) chosen.set(key, actor);
  }
  if (holder) chosen.set(actorKey(holder), holder);
  return [...chosen.values()].sort();
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
  status,
  project,
  parent,
  parentTitle,
  epics,
  siblings,
  actors,
  nowMs,
}: {
  task: LiveTask;
  status: TaskPageStatus;
  project: TaskProject;
  parent: LiveEpic | null;
  parentTitle: string | null;
  epics: readonly LiveEpic[];
  /** The project's other tasks: who holds work there and which labels it uses. */
  siblings: readonly LiveTask[];
  actors: readonly TaskActor[] | undefined;
  nowMs: number;
}) {
  const paths = usePaths();
  const zone = useTimeZone();
  const capabilities = useCapabilities();
  const save = useFieldSave(task.id, project.logicalKey);
  const closed = task.status === 'closed';
  const can = (field: string) => !closed && fieldAvailable(capabilities, field);
  const canManageNext = canAddToNext(task) && canUseNext(capabilities);

  const holder = task.assignee ? actorLabel(task.assignee, actors) : null;
  const model = task.assignee ? claimedModel(task) : null;
  const helper = task.assignee ? (task.for ?? null) : null;
  const people = siblings.flatMap((row) => (row.assignee ? [row.assignee] : []));

  const taskLabels = task.labels.filter((label) => label !== NEXT_LABEL);
  const labels = [...new Set([...siblings.flatMap((row) => row.labels), ...taskLabels])]
    .filter((label) => label !== NEXT_LABEL)
    .sort();
  const parked = (task.deferUntil ?? '').slice(0, 10);
  const due = (task.dueAt ?? '').slice(0, 10);
  const estimate = task.estimateMinutes == null ? null : formatMinutes(task.estimateMinutes);
  const parentName = parent?.title ?? parentTitle ?? task.parent;
  const definitions = useProjectFields(project.logicalKey).data?.fields ?? [];
  const values = task.fields ?? {};
  // The fields the task holds a value for, in the order the project defined
  // them; a value whose field this page has not read is named from its key.
  const customFields: { key: string; field: TaskField | null; value: TaskFieldValue }[] = [
    ...definitions.flatMap((field) => {
      const value = values[field.key];
      return value === undefined ? [] : [{ key: field.key, field, value }];
    }),
    ...Object.entries(values)
      .filter(([key]) => !definitions.some((field) => field.key === key))
      .map(([key, value]) => ({ key, field: null, value })),
  ];
  const addable = can('fields') ? definitions.filter(fieldEditable) : [];
  const saveField = (field: TaskField | null, key: string) => (next: TaskFieldValue | null, before?: TaskFieldValue) =>
    save({
      label: field?.name ?? fieldKeyName(key),
      edit: { fields: { [key]: next } },
      undo: { fields: { [key]: before ?? null } },
    });

  return (
    <aside aria-label="Facts" className="flex flex-col gap-3" data-task-facts="">
      <div className="flex flex-col gap-px">
        <dl className="m-0 flex flex-col gap-px">
          <Fact
            label="Status"
            valueText={status.label}
            editor={can('status') ? { kind: 'choice', value: task.status, choices: STATUS_CHOICES } : null}
            onSave={(next) => save({ label: 'the status', edit: { status: next }, undo: { status: task.status } })}
          >
            <StatusMark status={status.mark} muted={status.muted} label={null} />
            <span data-task-status={status.mark}>{status.label}</span>
          </Fact>
          <Fact
            label="Priority"
            shortcut="p"
            valueText={priorityLabel(task.priority)}
            editor={can('priority') ? priorityEditor(task) : null}
            onSave={(next) => save(priorityChange(task, next))}
          >
            <PriorityMark priority={task.priority} label={null} />
            {priorityLabel(task.priority)}
          </Fact>
          <Fact
            label="Assignee"
            shortcut="a"
            valueText={holder === null ? 'Nobody' : helper ? `${holder} for ${helper}` : holder}
            muted={holder === null}
            editor={can('assignee') ? assigneeEditor(task, people, actors) : null}
            onSave={(next) => save(assigneeChange(task, next))}
          >
            {task.assignee && holder ? (
              <>
                <Avatar name={holder} agent={isAgentActor(task.assignee)} model={model} decorative />
                {/* The name keeps its room; the helper and the model give way first. */}
                <span>{holder}</span>
                {helper ? <span className="shrink-[100] font-normal text-ink-2">for {helper}</span> : null}
                {model ? <span className="shrink-[100] font-normal text-ink-3">{model}</span> : null}
              </>
            ) : (
              'Nobody'
            )}
          </Fact>
          {task.assignee && !closed ? <WorkFacts task={task} nowMs={nowMs} /> : null}
          <Fact label="Type" valueText={typeLabel(task.issueType, task.awaitType, (task.steps ?? null) !== null)}>
            <TypeMark
              type={typeMarkFor(task.issueType, task.awaitType, (task.steps ?? null) !== null)}
              size={14}
              label={null}
            />
            {typeLabel(task.issueType, task.awaitType, (task.steps ?? null) !== null)}
          </Fact>
          <Fact label="Project" valueText={project.displayName}>
            <FactLink to={project.disabled === true ? paths.projects : paths.project(project.logicalKey)}>
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
            {task.parent ? <FactLink to={paths.task(task.parent)}>{parentName}</FactLink> : 'None'}
          </LinkedFact>
          <Fact
            label="Labels"
            valueText={taskLabels.length > 0 ? taskLabels.join(', ') : 'None'}
            muted={taskLabels.length === 0}
            wrap
            editor={
              can('addLabels')
                ? {
                    kind: 'toggle',
                    values: taskLabels,
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
            {taskLabels.length > 0
              ? taskLabels.map((label) => (
                  <Badge key={label} dot>
                    <span data-task-label={label}>{label}</span>
                  </Badge>
                ))
              : 'None'}
          </Fact>
          {parked !== '' || can('defer') ? (
            <Fact
              label="Parked until"
              shortcut="z"
              valueText={parked === '' ? 'None' : calendarDay(parked, nowMs, zone)}
              muted={parked === ''}
              editor={
                can('defer') ? { kind: 'date', value: parked, presets: dayPresets(nowMs, zone), clear: 'Unpark' } : null
              }
              onSave={(next) => save({ label: 'the parked date', edit: { defer: next }, undo: { defer: parked } })}
            >
              {parked === '' ? (
                'None'
              ) : (
                <>
                  <Moon aria-hidden size={14} className="text-ink-3" />
                  <span className="nums">{calendarDay(parked, nowMs, zone)}</span>
                </>
              )}
            </Fact>
          ) : null}
          {due !== '' || can('dueAt') ? (
            <Fact
              label="Due"
              valueText={due === '' ? NONE : calendarDay(due, nowMs, zone)}
              muted={due === ''}
              editor={
                can('dueAt')
                  ? { kind: 'date', value: due, presets: dayPresets(nowMs, zone), clear: NONE, field: 'Due date' }
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
              {due === '' ? NONE : <span className="nums">{calendarDay(due, nowMs, zone)}</span>}
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
              onSave={saveField(field, key)}
            />
          ))}
        </dl>
        <AddField
          fields={addable}
          values={values}
          nowMs={nowMs}
          onSave={(field, next, before) => saveField(field, field.key)(next, before)}
        />
      </div>
      {canManageNext || isInNext(task) ? (
        <section aria-label="Next" className="mx-2 border-t border-border pt-3">
          {canManageNext ? <NextTaskAction task={task} project={project.logicalKey} /> : <Badge>In Next</Badge>}
        </section>
      ) : null}
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
function customFieldEditor(
  field: TaskField,
  value: TaskFieldValue | undefined,
  nowMs: number,
  zone: string,
): FactEditor | null {
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
        presets: dayPresets(nowMs, zone, true),
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
 * Saves a pick or a typed value from `field`'s editor. A multiple choice is
 * saved whole, and its menu takes a second press before the first save is
 * read back, so each press builds on the value the last one sent, and the
 * saves run in the order pressed, so an earlier one never lands over a later one.
 * Each save's Undo puts back what the task held when that save ran. Add field
 * shows one field after another through the same hook, so what it keeps
 * belongs to the field it names.
 */
function useFieldPick(
  field: TaskField | null,
  value: TaskFieldValue | undefined,
  onSave: (next: TaskFieldValue | null, before: TaskFieldValue | undefined) => Promise<boolean>,
): (next: string, on?: boolean) => Promise<boolean> {
  const key = field?.key ?? null;
  // By field: the value last read, what the last press sent, and what the task last held, read back or saved since.
  const read = useRef(new Map<string, TaskFieldValue | undefined>());
  const sent = useRef(new Map<string, TaskFieldValue | undefined>());
  const held = useRef(new Map<string, TaskFieldValue | undefined>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    // Only a new read replaces what saves since the last one recorded, so showing a field again keeps them.
    if (key === null || (read.current.has(key) && read.current.get(key) === value)) return;
    read.current.set(key, value);
    sent.current.set(key, value);
    held.current.set(key, value);
  }, [key, value]);

  return (next, on) => {
    if (!field) return Promise.resolve(false);
    const own = (kept: Map<string, TaskFieldValue | undefined>) => (kept.has(field.key) ? kept.get(field.key) : value);
    const pending = own(sent.current);
    const send = async (value: TaskFieldValue | null) => {
      const intended = value ?? undefined;
      sent.current.set(field.key, intended);
      const run = queue.current.then(async () => {
        const saved = await onSave(value, own(held.current));
        if (saved) held.current.set(field.key, intended);
        return saved;
      });
      queue.current = run.catch(() => undefined);
      const saved = await run;
      // A refused save leaves the task as it was, and no new read will say so.
      if (!saved && sent.current.get(field.key) === intended) sent.current.set(field.key, own(held.current));
      return saved;
    };
    if (next === '' && field.type !== 'multiple-choice') return send(null);
    switch (field.type) {
      case 'multiple-choice':
        return send(toggledOptions(field, pending, next, on ?? true));
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
  };
}

/**
 * The fields of the project the task holds no value for, in one menu under
 * the custom fields. Picking one shows its editor in the same menu, and the
 * value saved gives the field its own line above. It takes no room when every
 * field holds a value.
 */
function AddField({
  fields,
  values,
  nowMs,
  onSave,
}: {
  /** The fields this sign-in may set, in the order the project defined them. */
  fields: readonly TaskField[];
  values: Readonly<Record<string, TaskFieldValue>>;
  nowMs: number;
  onSave: (field: TaskField, next: TaskFieldValue | null, before: TaskFieldValue | undefined) => Promise<boolean>;
}) {
  const zone = useTimeZone();
  const [open, setOpen] = useState(false);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const unset = fields.filter((field) => values[field.key] === undefined);
  const picked = fields.find((field) => field.key === pickedKey) ?? null;
  const value = picked ? values[picked.key] : undefined;
  const pick = useFieldPick(picked, value, (next, before) =>
    picked ? onSave(picked, next, before) : Promise.resolve(false),
  );
  // A multiple choice keeps its menu open after its first option is set, when the field has left `unset`.
  if (unset.length === 0 && !open) return null;
  const editor = picked ? customFieldEditor(picked, value, nowMs, zone) : null;
  const toggle = (next: boolean) => {
    setOpen(next);
    if (!next) setPickedKey(null);
  };
  const choose = (next: string, on?: boolean) => {
    if (editor?.kind !== 'toggle') toggle(false);
    void pick(next, on);
  };
  return (
    <Menu open={open} onOpenChange={toggle}>
      <MenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-meta font-medium text-ink-3 outline-none',
            'transition-colors duration-120 hover:bg-hover hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-accent aria-expanded:bg-hover',
          )}
          data-add-field=""
        >
          <Plus aria-hidden size={14} />
          Add field
        </button>
      </MenuTrigger>
      <MenuContent
        label={picked?.name ?? 'Add field'}
        panelKey={picked?.key ?? ''}
        footer={picked && editor ? factMenuFooter(picked.name, editor, choose) : null}
      >
        {picked && editor
          ? factMenuItems(editor, choose)
          : unset.map((field) => (
              <MenuItem key={field.key} submenu onSelect={() => setPickedKey(field.key)}>
                {field.name}
              </MenuItem>
            ))}
      </MenuContent>
    </Menu>
  );
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
  value: TaskFieldValue;
  editable: boolean;
  nowMs: number;
  /** Saves `next`; `before` is the value it replaces, which Undo puts back. */
  onSave: (next: TaskFieldValue | null, before: TaskFieldValue | undefined) => Promise<boolean>;
}) {
  const zone = useTimeZone();
  const label = field?.name ?? fieldKeyName(fieldKey);
  const type = field?.type ?? null;
  const text = type === 'date' && typeof value === 'string' ? calendarDay(value, nowMs, zone) : fieldValueText(value);
  const editor = editable && field ? customFieldEditor(field, value, nowMs, zone) : null;
  const save = useFieldPick(field, value, onSave);

  return (
    <Fact label={label} valueText={text} wrap={type === 'multiple-choice'} editor={editor} onSave={save}>
      {type === 'url' && typeof value === 'string' ? (
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

/** The holder's work in hand: when they last wrote to the task, then each work detail they recorded. */
function WorkFacts({ task, nowMs }: { task: LiveTask; nowMs: number }) {
  const work = task.work ?? {};
  const line = (label: string, value: string | undefined, link = false) => {
    if (value === undefined) return null;
    const url = link ? httpUrl(value) : null;
    return (
      <Fact label={label} valueText={value} wrap={label === 'Next step'}>
        {url ? <ExternalFactLink href={url} /> : <span className="[overflow-wrap:anywhere]">{value}</span>}
      </Fact>
    );
  };
  const active = task.lastActivityAt ? `${formatAge(ageMs(nowMs, task.lastActivityAt))} ago` : null;
  return (
    <>
      {active ? (
        <Fact label="Last activity" valueText={active}>
          <span className="nums">{active}</span>
        </Fact>
      ) : null}
      {line('Next step', work.next)}
      {line('Branch', work.branch)}
      {line('Pull request', work.pr, true)}
      {line('Commit', work.commit)}
      {line('Worktree', work.worktree)}
      {line('Session', work.session, true)}
      {work.touches && work.touches.length > 0 ? (
        <Fact label="Touches" valueText={work.touches.join(', ')} wrap>
          <ul className="m-0 flex list-none flex-col p-0" data-work-touches="">
            {work.touches.map((entry) => (
              <li key={entry} className="nums [overflow-wrap:anywhere]">
                {entry}
              </li>
            ))}
          </ul>
        </Fact>
      ) : null}
    </>
  );
}

/** A fact's value that is a page outside Ntasks, opening in a new tab, shown without its scheme. */
function ExternalFactLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="relative z-10 min-w-0 truncate text-ink no-underline underline-offset-3 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-accent"
    >
      {href.replace(/^https?:\/\//, '')}
    </a>
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
