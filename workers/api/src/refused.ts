/**
 * A call the API refuses, with the sentences its sender reads. An MCP tool
 * returns `message`, written for an agent and naming the tools to use next;
 * an HTTP route answers with the status for `kind` and `detail`, written for
 * a person, so the web app can show it as it is.
 */
export type RefusalKind =
  /** An argument breaks a rule; the sentence names it. */
  | 'invalid'
  /** The project or a task the call names does not exist, or the sender cannot reach it. */
  | 'not_found'
  /** The sender may read the project but not change it. */
  | 'forbidden'
  /** The task's own state refuses the change, such as a claim on a task someone holds. */
  | 'state'
  /** The idempotency key was first used for a different change. */
  | 'retry_conflict'
  /** The change did not land, for a reason the task's state does not show; a retry may land it. */
  | 'unavailable';

/** An agent's sentence starts with the kind of answer it is; a person's does not. */
const AGENT_PREFIX = /^(?:invalid arguments|refused|conflict|unavailable): /u;

export class Refused extends Error {
  override name = 'Refused';
  readonly kind: RefusalKind;
  readonly detail: string;
  /** The body field at fault, which an HTTP answer names in `field`. */
  readonly field: string | undefined;
  constructor(kind: RefusalKind, message: string, detail?: string, field?: string) {
    super(message);
    this.kind = kind;
    this.detail = detail ?? message.replace(AGENT_PREFIX, '');
    this.field = field;
  }
}
