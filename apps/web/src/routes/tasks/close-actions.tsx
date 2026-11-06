import { useState, type ReactNode } from 'react';
import { CloseAsMenu, CloseNoteForm } from '@/components/CloseResolution';
import { useInboxAnswer } from '@/hooks/useTasks';
import type { NotDone } from '@/lib/task-model';

/** A task waiting on a person (labelled `human`) is declined with the resolution; any other task is closed with it. */
export function declinedOnClose(task: { readonly labels: readonly string[] }): boolean {
  return task.labels.includes('human');
}

/** The API operation a close of this task needs. */
export function closeOperation(task: { readonly labels: readonly string[] }): 'dismiss' | 'close' {
  return declinedOnClose(task) ? 'dismiss' : 'close';
}

/**
 * A close where nothing shipped, on a task's row: the Close as menu and, once
 * one is picked, its one-line note, sent through the Undo window.
 */
export function useCloseAs({ id, title, project, via, disabledReason = null, onOpen }: {
  id: string;
  title: string;
  project: string;
  via?: 'dismiss';
  disabledReason?: string | null;
  onOpen?: () => void;
}): { menu: ReactNode; box: ReactNode; cancel: () => void } {
  const [picked, setPicked] = useState<NotDone | null>(null);
  const answer = useInboxAnswer();
  const menu = (
    <CloseAsMenu
      subject={title}
      disabledReason={disabledReason}
      onPick={(resolution) => {
        setPicked(resolution);
        onOpen?.();
      }}
    />
  );
  const box = picked === null ? null : (
    <CloseNoteForm
      key={picked}
      id={id}
      resolution={picked}
      onCancel={() => setPicked(null)}
      onSend={(close) => {
        answer({ kind: 'close', id, title, project, resolution: picked, ...close, ...(via === undefined ? {} : { via }) });
        setPicked(null);
      }}
    />
  );
  return { menu, box, cancel: () => setPicked(null) };
}
