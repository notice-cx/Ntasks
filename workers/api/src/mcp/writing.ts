/**
 * The rules the guide states (guide.ts) for a title, the commands in a
 * description and an ask to a person, checked on a write. A task that breaks them is advised on,
 * never refused: a title of up to 512 characters is valid, and tasks imported
 * from Beads carry long titles and inline commands.
 */

/** The most characters a title has: what a list row shows whole. */
export const TITLE_MOST = 70;

/** What a title can hold that belongs in the description. */
export type TitleHold = 'command' | 'file path' | 'commit hash';

const HOLDS: readonly (readonly [TitleHold, RegExp])[] = Object.freeze([
  [
    'command',
    // Code in backticks, a shell operator, a flag, or a tool run with a
    // subcommand or a package script; a tool merely named is not a command.
    /`|&&|\|\||\$\(|(?:^|\s)--?[a-z][\w-]*(?=[\s=]|$)|\b(?:pnpm|npm|npx|yarn|git|gh|wrangler|docker|curl|sudo)\s+(?:[a-z][\w-]*:[\w:-]+|run|install|add|exec|dlx|deploy|push|pull|merge|rebase|checkout|commit|apply|migrate|build|test|compose)\b/u,
  ],
  [
    'file path',
    // From the root, the home folder or the current one; a file in a folder;
    // or three names joined by slashes. owner/repo#123 and "read/write" are not.
    /(?:^|\s)(?:\.{1,2}\/|~\/|\/[\w.-])|[\w.-]+\/[\w./-]*\.[a-z]{1,5}\b|[\w-]+\/[\w-]+\/[\w./-]+/u,
  ],
  [
    'commit hash',
    // 7 to 40 lowercase hexadecimal characters with a digit and a letter, so
    // neither a number nor a word such as "facade" is one.
    /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/u,
  ],
]);

/** What a title holds that belongs in the description, in the order above. */
export function titleHolds(title: string): readonly TitleHold[] {
  return HOLDS.filter(([, test]) => test.test(title)).map(([hold]) => hold);
}

/** The parts of a list joined as a sentence: "a, b and c". */
function joined(parts: readonly string[]): string {
  return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}

/** Advice on a title that breaks the rule: a line for its length, and one for what it holds. */
export function titleAdvice(title: string): readonly string[] {
  const holds = titleHolds(title);
  return [
    ...(title.length > TITLE_MOST
      ? [
          `title: ${title.length} characters; keep it to ${TITLE_MOST}: the outcome, or for a person the ask, in plain words starting with a verb.`,
        ]
      : []),
    ...(holds.length > 0
      ? [
          `title: it holds ${joined(holds.map((hold) => `a ${hold}`))}; move ${holds.length > 1 ? 'them' : 'it'} to the description, in backticks or a bash block, and keep the title to the outcome.`,
        ]
      : []),
  ];
}

/** How a description breaks the rule for what a person runs or pastes. */
export type DescriptionHold = 'inline command' | 'untagged block' | 'prompt';

/** A command a person runs: a tool with arguments, a script with arguments, or an SQL statement. */
const RUN =
  /^(?:sudo\s+)?(?:pnpm|npm|npx|yarn|bun|git|gh|curl|wget|wrangler|docker|kubectl|node|psql|sqlite3|bash|sh|make|brew)\s+\S|^\.{1,2}\/\S+\s+\S|^(?:select\s.+\sfrom|insert\s+into|update\s+\S+\s+set|delete\s+from)\s/iu;

/** A fence's opening or closing line: its marker, and the info string after an opening one. */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/u;

/** A description's prose lines, and each fenced block's info string and lines. */
function parts(markdown: string): {
  readonly prose: readonly string[];
  readonly blocks: readonly { readonly info: string; readonly lines: readonly string[] }[];
} {
  const prose: string[] = [];
  const blocks: { info: string; lines: string[] }[] = [];
  let open: { marker: string; info: string; lines: string[] } | null = null;
  for (const line of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    const fence = FENCE.exec(line);
    if (open === null) {
      if (fence === null) prose.push(line);
      else open = { marker: fence[1]!, info: fence[2]!.trim(), lines: [] };
    } else if (
      fence !== null &&
      fence[1]![0] === open.marker[0] &&
      fence[1]!.length >= open.marker.length &&
      fence[2]!.trim() === ''
    ) {
      blocks.push(open);
      open = null;
    } else open.lines.push(line);
  }
  if (open !== null) blocks.push(open);
  return { prose, blocks };
}

/** The inline code spans of prose lines that hold a command. */
function inlineCommands(prose: readonly string[]): string[] {
  return prose
    .flatMap((line) => [...line.matchAll(/`([^`]+)`/gu)].map((span) => span[1]!.trim()))
    .filter((code) => RUN.test(code));
}

/** How a description breaks the rule for commands, in the order of DescriptionHold. */
export function descriptionHolds(description: string): readonly DescriptionHold[] {
  const { prose, blocks } = parts(description);
  return [
    ...(inlineCommands(prose).length > 0 ? (['inline command'] as const) : []),
    ...(blocks.some((block) => block.info === '') ? (['untagged block'] as const) : []),
    ...(blocks.some((block) => block.lines.some((line) => /^\s*\$\s/u.test(line))) ? (['prompt'] as const) : []),
  ];
}

/** Advice on a description that breaks the rule for commands: a line for each way it does. */
export function descriptionAdvice(description: string): readonly string[] {
  const holds = descriptionHolds(description);
  const first = inlineCommands(parts(description).prose)[0];
  return holds.map((hold) =>
    hold === 'inline command'
      ? `description: it writes \`${first!.length > 60 ? `${first!.slice(0, 59)}…` : first!}\` inline; put each command a person runs or pastes in its own fenced block with a language tag, such as bash or sql.`
      : hold === 'untagged block'
        ? 'description: a fenced block has no language tag; name one after the opening fence, such as bash, sql or json.'
        : 'description: a fenced block has a $ prompt; leave it out, so the block pastes as it is.',
  );
}

/** Text as a reader compares it: lowercase, one space between words, no Markdown marks around it and no full stop after it. */
function plain(text: string): string {
  return text
    .replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)*/u, '')
    .replace(/[*_`]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/[\s.!?:;,]+$/u, '')
    .trim()
    .toLowerCase();
}

/** Whether a description's first line that is not blank says only what the title says. */
export function repeatsTitle(title: string, description: string): boolean {
  const first = description.split(/\r?\n/u).find((line) => line.trim() !== '');
  return first !== undefined && plain(first) === plain(title);
}

/** Advice on a description that opens with its title again. */
export function repeatAdvice(title: string, description: string): readonly string[] {
  return repeatsTitle(title, description)
    ? [
        'description: its first line repeats the title; use it for what the title leaves out: for work, what and why; for a person, the ask and where to act.',
      ]
    : [];
}

/** Words that send a person to a control on the page; "choose" or "pick" name the decision, not where to make it. */
const CONTROL = /\b(?:press|click|tap|tick)\b|\bbutton\b|\bon this (?:task|approval)\b/iu;

/** The language tags of a block a person runs, as against data such as JSON or YAML. */
const RUNNABLE = /^(?:bash|sh|shell|zsh|fish|console|terminal|powershell|pwsh|ps1|cmd|bat|sql|psql)$/iu;

/** Whether a fenced block is a command or query to run: by its tag, or by a line that starts like a command. */
function runs(block: { readonly info: string; readonly lines: readonly string[] }): boolean {
  return RUNNABLE.test(block.info.split(/\s+/u)[0] ?? '') || block.lines.some((line) => RUN.test(line.trim()));
}

/** Whether a description names a place for a person to act: a link, a command to run, or a control to press. */
export function namesPlaceToAct(description: string): boolean {
  const { prose, blocks } = parts(description);
  return (
    blocks.some(runs) ||
    inlineCommands(prose).length > 0 ||
    prose.some((line) => /https?:\/\/\S|\]\(/u.test(line) || CONTROL.test(line))
  );
}

/**
 * Advice on an ask to a person, an approval or a task labelled human, that
 * names no place to act. A task with choices has one, a button per option,
 * and so does a request to do steps: a tick per step.
 */
export function placeAdvice(task: {
  readonly id: string;
  readonly type: string;
  readonly labels: readonly string[];
  readonly description: string;
  readonly choices: unknown;
  readonly steps?: readonly unknown[] | null;
}): readonly string[] {
  const asks = task.type === 'gate' || task.labels.includes('human');
  if (!asks || task.choices || (task.steps?.length ?? 0) > 0 || namesPlaceToAct(task.description)) return [];
  return [
    task.type === 'gate'
      ? `description: it names no place to act; say where the person answers, such as "press Approve on this task" (its page in Ntasks is /tasks/${task.id}), with a link to what the approval covers.`
      : `description: it names no place to act; say where the person acts: the button to press on its page in Ntasks, /tasks/${task.id}, a link, or the command to run.`,
  ];
}
