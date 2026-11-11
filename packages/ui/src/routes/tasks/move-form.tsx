/**
 * Move to…, from a task page's More menu: a project and one of its open
 * epics, or none. The task moves with every task under it; a move to another
 * project gives each of them a new id, and the page then opens the task's.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { LiveTask, TaskProject } from '../../api/types';
import { Button } from '../../components/ui/button';
import { Field, Select } from '../../components/ui/field';
import { useBoards, useMoveTasks, useRetryKey, useTaskProjects } from '../../hooks/useTasks';
import { usePaths } from '../../lib/paths';

type EpicRow = Pick<LiveTask, 'id' | 'title' | 'issueType' | 'status' | 'parent'>;

/** The open epics a task can move under, by title: neither the task itself nor a task under it. */
export function moveEpics(tasks: readonly EpicRow[], id: string): EpicRow[] {
  const parents = new Map(tasks.map((row) => [row.id, row.parent]));
  const underTask = (epic: string) => {
    // A parent chain that loops would otherwise never end.
    const seen = new Set<string>();
    for (let at: string | null | undefined = epic; typeof at === 'string' && !seen.has(at); at = parents.get(at)) {
      if (at === id) return true;
      seen.add(at);
    }
    return false;
  };
  return tasks
    .filter((row) => row.issueType === 'epic' && row.status !== 'closed' && !underTask(row.id))
    .toSorted((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

export function MoveForm({
  task,
  project,
  parentTitle,
  onDone,
}: {
  task: Pick<LiveTask, 'id' | 'parent'>;
  /** The task's own project. */
  project: TaskProject;
  parentTitle: string | null;
  onDone: () => void;
}) {
  const own = project.logicalKey;
  const here = task.parent ?? '';
  const catalog = useTaskProjects();
  const navigate = useNavigate();
  const paths = usePaths();
  const move = useMoveTasks();
  const retryKey = useRetryKey();
  const [destination, setDestination] = useState(own);
  const [epic, setEpic] = useState(here);
  const [board] = useBoards([destination]);

  // A disabled project takes no tasks; the task's own stays listed so the form can show where it is.
  const projects = (catalog.data ?? [project]).filter((row) => row.logicalKey === own || row.disabled !== true);
  const chosen = projects.find((row) => row.logicalKey === destination) ?? project;
  const epics = moveEpics(board?.data?.tasks ?? [], task.id);
  // The task's own parent, when the board's read does not list it among the open epics.
  const offered =
    destination === own && here !== '' && !epics.some((row) => row.id === here)
      ? [{ id: here, title: parentTitle ?? here }, ...epics]
      : epics;
  const unchanged = destination === own && epic === here;

  function pickProject(key: string) {
    setDestination(key);
    setEpic(key === own ? here : '');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (unchanged || move.isPending) return;
    const input = { ids: [task.id], project: destination, parent: epic === '' ? null : epic, withChildren: true };
    let moved: Readonly<Record<string, string>>;
    try {
      ({ moved } = await move.mutateAsync({ ...input, idempotencyKey: retryKey.keyFor(JSON.stringify(input)) }));
    } catch (error) {
      toast.error(error instanceof Error && error.message !== '' ? error.message : `Could not move ${task.id}`);
      return;
    }
    retryKey.done();
    const under = offered.find((row) => row.id === epic);
    toast.success(`Moved ${task.id} to ${under ? under.title : chosen.displayName}`);
    const next = moved[task.id];
    // Replaced, not pushed: Back from the new page goes where the person was before, not to the old id.
    if (next !== undefined && next !== task.id) void navigate(paths.task(next), { replace: true });
    else onDone();
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-task-form="move"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDone();
      }}
    >
      <Field label="Project" className="min-w-0 flex-1 basis-48">
        <Select
          autoFocus
          value={destination}
          disabled={move.isPending}
          onChange={(event) => pickProject(event.target.value)}
        >
          {projects.map((row) => (
            <option key={row.logicalKey} value={row.logicalKey}>
              {row.displayName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Epic" className="min-w-0 flex-1 basis-64">
        <Select value={epic} disabled={move.isPending} onChange={(event) => setEpic(event.target.value)}>
          <option value="">No epic</option>
          {offered.map((row) => (
            <option key={row.id} value={row.id}>
              {`${row.id} · ${row.title}`}
            </option>
          ))}
        </Select>
      </Field>
      <Button variant="primary" type="submit" disabled={unchanged || move.isPending} data-task-confirm="move">
        {move.isPending ? 'Moving…' : 'Move'}
      </Button>
      <Button type="button" variant="ghost" disabled={move.isPending} onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}
