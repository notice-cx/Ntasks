/**
 * The ledger: what GitHub cannot hold for a task, kept by the adapter in one
 * JSON file. Each write runs as a transaction on a copy of the ledger and
 * replaces the file by renaming a complete new one over it, so a change and
 * its history event are kept together or not at all. One adapter process
 * owns a ledger file.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type LinkType = 'blocks' | 'related' | 'discovered-from' | 'duplicates' | 'supersedes' | 'merges-after';

export interface TaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  version: number;
  title: string;
  description: string;
  acceptance: string;
  notes: string;
  design: string;
  type: string;
  status: string;
  priority: number;
  labels: string[];
  parent: string | null;
  deferUntil: string | null;
  assignee: string | null;
  assigneeModel: string | null;
  for: string | null;
  work: Record<string, string>;
  lastActivityAt: string | null;
  metadata: Record<string, unknown>;
  readonly createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
  closeLink: string | null;
  closeCommit: string | null;
  closePullRequest: string | null;
  resolution: string | null;
  duplicateOf: string | null;
  filedBy: string;
}

export interface LinkRecord {
  readonly from: string;
  readonly to: string;
  readonly type: LinkType;
}

export interface HistoryRecord {
  readonly revision: number;
  readonly task: string;
  readonly at: string;
  readonly actor: string;
  readonly model: string | null;
  readonly actions: readonly string[];
  readonly fields: Readonly<Record<string, { readonly old: unknown; readonly new: unknown }>>;
}

/** A comment the adapter posted to GitHub, with the sender it was posted for. */
export interface CommentRecord {
  readonly githubId: number;
  readonly task: string;
  readonly author: string;
  readonly text: string;
  readonly createdAt: string;
}

/** A write's first answer, kept under its idempotency key. */
export interface RetryRecord {
  readonly request: string;
  readonly answer: unknown;
  /** The version each task the write changed had after it. */
  readonly tasks: Readonly<Record<string, number>>;
  readonly at: string;
}

export interface LedgerData {
  revision: number;
  tasks: Record<string, TaskRecord>;
  links: LinkRecord[];
  history: HistoryRecord[];
  comments: Record<string, CommentRecord>;
  retries: Record<string, RetryRecord>;
}

const empty = (): LedgerData => ({ revision: 0, tasks: {}, links: [], history: [], comments: {}, retries: {} });

export class Ledger {
  private readonly path: string | null;
  data: LedgerData;

  constructor(path: string | null) {
    this.path = path;
    this.data = path !== null && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LedgerData) : empty();
  }

  /**
   * Runs `change` on a copy of the ledger and keeps the copy only when it
   * returns and the file is written; a throw leaves the ledger as it was.
   */
  async transaction<T>(change: (draft: LedgerData) => Promise<T> | T): Promise<T> {
    const draft = structuredClone(this.data);
    const result = await change(draft);
    if (this.path !== null) {
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(draft));
      renameSync(temporary, this.path);
    }
    this.data = draft;
    return result;
  }
}
