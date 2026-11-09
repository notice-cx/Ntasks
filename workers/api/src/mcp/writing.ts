/**
 * The rules the guide states (guide.ts) for a title and for the commands in a
 * description, checked on a write. A task that breaks them is advised on,
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
