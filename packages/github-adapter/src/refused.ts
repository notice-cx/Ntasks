/**
 * A refused call: its first line says what kind of refusal it is, as the MCP
 * profile's refusals start (mcp-profile.md MCP-3), and its last line whether
 * a retry is safe.
 */
export type RefusalKind = 'invalid' | 'refused' | 'conflict' | 'unavailable';

export class Refused extends Error {
  readonly kind: RefusalKind;

  constructor(kind: RefusalKind, sentence: string) {
    super(sentence);
    this.kind = kind;
  }

  /** The text the tool result carries. */
  text(): string {
    return this.kind === 'unavailable'
      ? `${this.message}\nThe change may have been written; read the task before retrying.`
      : `${this.message}\nNothing was written; retrying is safe.`;
  }
}

export const refuse = (sentence: string): never => {
  throw new Refused('refused', `refused: ${sentence}`);
};

export const invalid = (sentence: string): never => {
  throw new Refused('invalid', `invalid arguments: ${sentence}`);
};
