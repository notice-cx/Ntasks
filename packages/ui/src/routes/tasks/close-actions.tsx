import { useState, type ReactNode } from 'react';
import { CloseNoteForm } from '../../components/CloseResolution';
import { useInboxAnswer, type InboxAnswer } from '../../hooks/useTasks';
import type { NotDone } from '../../lib/task-model';

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
  proposalVersion = null,
  via,
  onOpen,
}: {
  id: string;
  title: string;
  project: string;
  /** The proposal version the page shows, which a decline sends. */
  proposalVersion?: string | null;
  via?: 'dismiss';
  onOpen?: () => void;
}): { box: ReactNode; picked: NotDone | null; cancel: () => void; pick: (resolution: NotDone) => void } {
  const [picked, setPicked] = useState<NotDone | null>(null);
  const box =
    picked === null ? null : (
      <CloseAsNote
        key={picked}
        close={{
          kind: 'close',
          id,
          title,
          project,
          proposalVersion,
          resolution: picked,
          ...(via === undefined ? {} : { via }),
        }}
        onDone={() => setPicked(null)}
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

/** The note of a close where nothing shipped. A component of its own, so a row reads the answers only while one is open. */
function CloseAsNote({ close, onDone }: { close: Extract<InboxAnswer, { kind: 'close' }>; onDone: () => void }) {
  const answer = useInboxAnswer();
  return (
    <CloseNoteForm
      id={close.id}
      resolution={close.resolution}
      onCancel={onDone}
      onSend={(note) => {
        answer({ ...close, ...note });
        onDone();
      }}
    />
  );
}
