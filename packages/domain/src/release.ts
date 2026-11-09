/**
 * The comment a person's free of a held task leaves. Freeing clears the
 * holder's work details, so the comment keeps where the work stopped. The
 * Worker writes it and the web app's fixture writes the same, so both show
 * one record.
 */
import { sameActor } from './actors.ts';
import { TASK_LIMITS, type TaskWork, type WorkDetail } from './task.ts';

/** The work details the comment keeps, in the order it lists them. */
const KEPT_WORK: readonly [WorkDetail, string][] = [
  ['next', 'Next step'],
  ['branch', 'Branch'],
  ['pr', 'Pull request'],
  ['commit', 'Commit'],
  ['worktree', 'Worktree'],
  ['session', 'Session'],
];

/** The most characters of one work detail the comment keeps: six of them at
 * this length, with the lines above them, fit in one comment. */
const KEPT_DETAIL_MOST = 500;

/** `text` cut to `most` characters, its end marked when cut. */
function cut(text: string, most: number): string {
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`;
}

/** What the comment reads of the task as it stood before the free. */
export interface FreedTask {
  readonly id: string;
  readonly holder: string;
  /** The helper agent the holder worked through, or null. */
  readonly helper: string | null;
  readonly lastActivityAt: string | null;
  readonly work: TaskWork;
}

/**
 * Who freed the task and where its work stopped: the holder and its helper,
 * its last activity, its work details and its last comment. A long work
 * detail and the last comment are cut to what one comment holds; the task's
 * history keeps every work detail whole.
 */
export function releaseComment(
  task: FreedTask,
  comments: readonly { readonly author: string; readonly text: string; readonly createdAt: string | null }[],
  person: string,
): string {
  const lines = [
    `${person} freed ${task.id} on their own call. Where it stopped:`,
    `- Held by: ${task.holder}${task.helper === null ? '' : ` for ${task.helper}`}`,
    `- Last activity: ${task.lastActivityAt ?? 'none recorded'}`,
    ...KEPT_WORK.flatMap(([detail, label]) => {
      const value = task.work[detail];
      return value === undefined ? [] : [`- ${label}: ${cut(value, KEPT_DETAIL_MOST)}`];
    }),
  ];
  const head = lines.join('\n');
  const last = comments.findLast((comment) => sameActor(comment.author, task.holder));
  if (last === undefined) return head;
  const intro = `\n- Last comment, ${last.createdAt ?? 'at a time not recorded'}: `;
  const room = TASK_LIMITS.comment - head.length - intro.length;
  if (room < 2) return head;
  return `${head}${intro}${cut(last.text.replace(/\s+/gu, ' ').trim(), room)}`;
}
