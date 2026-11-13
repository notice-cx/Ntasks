/** The label a task carries while it is in Next. */
export const NEXT_LABEL = 'ntasks:next';

/** Whether this is work for an agent, regardless of its current status. */
export function canQueueNext({ type, labels }: { type: string; labels: readonly string[] }): boolean {
  return type !== 'epic' && type !== 'gate' && type !== 'decision' && !labels.includes('human');
}
