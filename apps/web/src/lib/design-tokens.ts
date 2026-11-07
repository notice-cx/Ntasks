/**
 * The colour tokens with their names and roles, in the order the gallery
 * (/design) and docs/design.md list them. The values live only in
 * src/index.css; test/design.test.tsx checks that each token here is set
 * there for both themes.
 */
export interface ColourToken {
  /** The CSS variable, and after `--` the Tailwind colour: `--ink-3` is `text-ink-3`. */
  variable: `--${string}`;
  name: string;
  role: string;
}

export const COLOUR_TOKENS: readonly ColourToken[] = [
  { variable: '--background', name: 'Background', role: 'Main content' },
  { variable: '--canvas', name: 'Canvas', role: 'Sidebar, page edges' },
  { variable: '--surface', name: 'Surface', role: 'Group headers, code, panels' },
  { variable: '--hover', name: 'Hover', role: 'Row and item hover' },
  { variable: '--border', name: 'Border', role: 'Dividers, inputs' },
  { variable: '--border-strong', name: 'Border strong', role: 'Inactive marks, keys' },
  { variable: '--ink', name: 'Text', role: 'Titles, values' },
  { variable: '--ink-2', name: 'Text 2', role: 'Body, labels' },
  { variable: '--ink-3', name: 'Text 3', role: 'Meta, ages, ids' },
  { variable: '--accent', name: 'Accent', role: 'Primary buttons, focus, in progress' },
  { variable: '--on-accent', name: 'On accent', role: 'Text on accent' },
  { variable: '--accent-text', name: 'Accent text', role: 'Links' },
  { variable: '--accent-soft', name: 'Accent soft', role: 'Selected item' },
  { variable: '--wait', name: 'Waiting for you', role: 'Decisions and approvals' },
  { variable: '--wait-text', name: 'Waiting text', role: 'Amber labels' },
  { variable: '--wait-soft', name: 'Waiting soft', role: 'Waiting group' },
  { variable: '--block', name: 'Blocked', role: 'Blocked only' },
  { variable: '--done', name: 'Success', role: 'Done' },
];

/** The tokens behind avatars and marks, set in both themes like the colours above. */
export const MARK_TOKENS: readonly ColourToken[] = [
  { variable: '--avatar', name: 'Avatar', role: "A person's circle" },
  { variable: '--avatar-ink', name: 'Avatar text', role: 'Initials' },
  { variable: '--mark-bg', name: 'Mark ground', role: "An agent's circle" },
  { variable: '--blossom', name: 'Blossom', role: "Codex's mark" },
];
