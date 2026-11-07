import { useState, type ReactNode } from 'react';
import { CloseNoteForm } from '@/components/CloseResolution';
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
 * A close where nothing shipped: once one is picked through `pick`, its
 * one-line note in `box`, sent through the Undo window.
 */
export function useCloseAs({
  id,
  title,
  project,
  via,
  onOpen,
}: {
  id: string;
  title: string;
  project: string;
  via?: 'dismiss';
  onOpen?: () => void;
}): { box: ReactNode; picked: NotDone | null; cancel: () => void; pick: (resolution: NotDone) => void } {
  const [picked, setPicked] = useState<NotDone | null>(null);
  const answer = useInboxAnswer();
  const box =
    picked === null ? null : (
      <CloseNoteForm
        key={picked}
        id={id}
        resolution={picked}
        onCancel={() => setPicked(null)}
        onSend={(close) => {
          answer({
            kind: 'close',
            id,
            title,
            project,
            resolution: picked,
            ...close,
            ...(via === undefined ? {} : { via }),
          });
          setPicked(null);
        }}
      />
    );
  return {
    box,
    picked,
    cancel: () => setPicked(null),
    pick: (resolution) => {
      setPicked(resolution);
      onOpen?.();
    },
  };
}
