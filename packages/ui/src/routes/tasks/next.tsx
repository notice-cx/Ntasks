import { ListPlus, ListX } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { canQueueNext, NEXT_LABEL, TASK_LIMITS } from '@ntasks/domain';
import type { LiveTask, TaskEdit, TasksCapabilities } from '../../api/types';
import { Button, IconButton } from '../../components/ui/button';
import { Field, Textarea } from '../../components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { operationAvailable, useRetryKey, useUpdateTask } from '../../hooks/useTasks';
import { isGate } from '../../lib/task-model';

export function canUseNext(capabilities: TasksCapabilities): boolean {
  return operationAvailable(capabilities, 'next') && capabilities.operations?.includes('next') === true;
}

export function canAddToNext(task: LiveTask): boolean {
  return task.status !== 'in_progress' && !isGate(task) && canQueueNext({ type: task.issueType, labels: task.labels });
}

export function isInNext(task: LiveTask): boolean {
  return task.status !== 'closed' && canAddToNext(task) && task.labels.includes(NEXT_LABEL);
}

function useSaveNext(id: string, project: string) {
  const update = useUpdateTask();
  const retry = useRetryKey();
  return {
    pending: update.isPending,
    async save(next: NonNullable<TaskEdit['next']>, message: string) {
      try {
        await update.mutateAsync({
          id,
          project,
          edit: { next },
          idempotencyKey: retry.keyFor(JSON.stringify(next)),
        });
        retry.done();
        toast.success(message);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not update Next');
        return false;
      }
    },
  };
}

export function NextRowAction({ task, project }: { task: LiveTask; project: string }) {
  const { pending, save } = useSaveNext(task.id, project);
  const queued = isInNext(task);
  const label = queued ? 'Remove from Next' : 'Add to Next';
  return (
    <IconButton
      label={`${label}: ${task.id}`}
      title={label}
      icon={queued ? <ListX aria-hidden /> : <ListPlus aria-hidden />}
      size="sm"
      className={queued ? 'shrink-0' : 'shrink-0 text-ink-3'}
      disabled={pending}
      onClick={() => void save({ queued: !queued }, queued ? 'Removed from Next' : 'Added to Next')}
    />
  );
}

export function NextTaskAction({ task, project }: { task: LiveTask; project: string }) {
  const removeButton = useRef<HTMLButtonElement>(null);
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState('');
  const { pending, save } = useSaveNext(task.id, project);
  const queued = isInNext(task);
  const reopen = task.status === 'closed';
  const addLabel = reopen ? 'Reopen and add to Next' : 'Add to Next';
  function cancel() {
    setShowNote(false);
    setNote('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || queued) return;
    const words = note.trim();
    const saved = await save(
      { queued: true, ...(reopen ? { reopen } : {}), ...(words ? { note: words } : {}) },
      'Added to Next',
    );
    if (saved) cancel();
  }
  return queued ? (
    <Button
      ref={removeButton}
      type="button"
      disabled={pending}
      onClick={() => void save({ queued: false }, 'Removed from Next')}
    >
      <ListX aria-hidden />
      Remove from Next
    </Button>
  ) : (
    <Popover open={showNote} onOpenChange={(open) => (open ? setShowNote(true) : cancel())}>
      <PopoverTrigger asChild>
        <Button type="button" variant="primary" aria-label={addLabel} disabled={pending}>
          <ListPlus aria-hidden />
          <span>
            {reopen ? <span className="max-sm:sr-only">Reopen and </span> : null}
            {reopen ? 'add to Next' : addLabel}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={addLabel}
        onCloseAutoFocus={(event) => {
          if (removeButton.current) {
            event.preventDefault();
            removeButton.current.focus();
          }
        }}
      >
        <form className="flex w-full flex-col gap-2" onSubmit={(event) => void submit(event)}>
          <Field label="Note for the agent">
            <Textarea
              rows={3}
              disabled={pending}
              maxLength={TASK_LIMITS.comment}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" type="submit" disabled={pending}>
              {addLabel}
            </Button>
            <Button variant="ghost" size="sm" type="button" disabled={pending} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
