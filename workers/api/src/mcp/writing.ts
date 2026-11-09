/**
 * The title rule the guide states (guide.ts), checked on a write: a title an
 * agent files is advised on, never refused, since a title of up to 512
 * characters is valid and tasks imported from Beads carry long ones.
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
