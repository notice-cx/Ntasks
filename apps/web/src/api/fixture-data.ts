/**
 * Invented workspaces, projects and tasks for the fixture API: every kind of
 * task the pages draw, with times relative to `nowMs` so ages read the same
 * on any day. Nothing here describes a real project, person or task.
 */
import type {
  LiveTask,
  TaskActor,
  TaskComment,
  TaskField,
  TaskProject,
  Workspace,
  WorkspaceInvitation,
  WorkspaceMember,
} from './types';

export interface FixtureTask extends LiveTask {
  /** The project's key. */
  project: string;
}

export interface FixtureSeed {
  projects: TaskProject[];
  tasks: FixtureTask[];
  comments: Map<string, TaskComment[]>;
  /** Each project's custom fields, by the project's key, in the order they were defined. */
  fields: Map<string, TaskField[]>;
}

/** A workspace with what it holds: its projects and tasks, its members and its pending invitations. */
export interface FixtureWorkspace extends Workspace {
  seed: FixtureSeed;
  members: WorkspaceMember[];
  invitations: WorkspaceInvitation[];
}

/** A workspace with no projects. */
export function emptySeed(): FixtureSeed {
  return { projects: [], tasks: [], comments: new Map(), fields: new Map() };
}

/** Who the fixture API records as the sender of every change. */
export const FIXTURE_ACTOR = 'Example Owner';

/** The two agents, as the API records them, and the names a read gives them. */
const CLAUDE = 'agent:claude';
const CODEX = 'agent:codex';
const MODELS: Readonly<Record<string, string>> = { [CLAUDE]: 'claude-example', [CODEX]: 'codex-example' };
export const FIXTURE_ACTORS: readonly TaskActor[] = [
  { principalId: CLAUDE, displayName: 'Claude' },
  { principalId: CODEX, displayName: 'Codex' },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An open task, filed six days before `nowMs`, with `fields` set over it. */
function taskAt(nowMs: number) {
  const at = (ago: number) => new Date(nowMs - ago).toISOString();
  return (project: string, id: string, title: string, fields: Partial<LiveTask> = {}): FixtureTask => ({
    project,
    id,
    title,
    status: 'open',
    priority: 2,
    issueType: 'task',
    assignee: null,
    updatedAt: at(2 * DAY),
    closedAt: null,
    createdAt: at(6 * DAY),
    parent: null,
    deferUntil: null,
    choices: null,
    choice: null,
    resolution: null,
    duplicateOf: null,
    description: '',
    acceptance: '',
    labels: [],
    ready: false,
    dependencies: [],
    comments: 0,
    metadata: {},
    startedAt: null,
    closeReason: null,
    awaitType: null,
    ...fields,
  });
}

export function fixtureSeed(nowMs: number): FixtureSeed {
  const at = (ago: number) => new Date(nowMs - ago).toISOString();
  const day = (ahead: number) => new Date(nowMs + ahead * DAY).toISOString().slice(0, 10);
  const base = taskAt(nowMs);

  const closed = (ago: number, by: string, reason: string, fields: Partial<LiveTask> = {}): Partial<LiveTask> => ({
    status: 'closed',
    closedAt: at(ago),
    updatedAt: at(ago),
    closeReason: reason,
    resolution: 'done',
    metadata: {
      noticeos_closed_by: by,
      ...(MODELS[by] === undefined ? {} : { noticeos_closed_model: MODELS[by] }),
      noticeos_closed_at: at(ago),
    },
    ...fields,
  });

  const tasks: FixtureTask[] = [
    base('web', 'web-k3m9', 'Ship the new sign-in page', {
      issueType: 'epic',
      priority: 1,
      description:
        'WHAT: Replace the sign-in page with the new form.\nWHY: 1 in 5 visitors who start signing in give up on the old form.\nWHERE: `src/pages/sign-in.tsx`',
      design: 'One form, two steps: the email address first, then the way to sign in.',
      createdAt: at(12 * DAY),
    }),
    base('web', 'web-k3m9.1', 'Draw the sign-in form', {
      parent: 'web-k3m9',
      ...closed(2 * DAY, CLAUDE, 'Landed in 1a2b3c4: the form renders its fields and errors.', {
        delivery: {
          stage: 'built',
          commit: '1a2b3c4',
          pullRequest: 'https://github.com/example/web/pull/42',
          mergeCommit: null,
          builtAt: at(2 * DAY),
          mergedAt: null,
          liveAt: null,
        },
      }),
      acceptance:
        '- [x] The form shows email and password fields\n- [x] A wrong password shows its error under the field',
    }),
    base('web', 'web-k3m9.2', 'Check the sign-in form with a screen reader', {
      parent: 'web-k3m9',
      status: 'in_progress',
      priority: 1,
      assignee: CODEX,
      for: 'a11y-check-1',
      work: {
        branch: 'codex/sign-in-a11y',
        pr: 'https://github.example.com/example/web/pull/42',
        next: 'Announce the password error to screen readers',
      },
      lastActivityAt: at(12 * 60_000),
      startedAt: at(3 * HOUR),
      updatedAt: at(40 * 60_000),
      metadata: { noticeos_claimed_model: MODELS[CODEX] },
      description: 'Walk the form with the keyboard and a screen reader, and fix what they cannot reach.',
      acceptance:
        '- [x] Every field is reachable with Tab\n- [ ] Every error is announced\n- [ ] The submit button names what it does',
      notes: 'Tab order fixed. The error under the password field is not announced yet.',
      estimateMinutes: 90,
      dueAt: at(-2 * DAY),
      externalLinks: [
        {
          url: 'https://github.example.com/example/web/pull/42',
          title: 'Fix the tab order on the sign-in form',
          kind: 'pull-request',
        },
      ],
      fields: {
        area: 'Accessibility',
        story_points: 3,
        platforms: ['Web', 'iOS'],
        customer_facing: true,
        sprint: 'Sprint 14',
      },
      comments: 1,
    }),
    base('web', 'web-k3m9.3', 'Send the new sign-in page to every visitor', {
      parent: 'web-k3m9',
      priority: 1,
      dependencies: [
        { id: 'web-k3m9.2', type: 'blocks', title: null, status: null },
        { id: 'web-g7p2', type: 'blocks', title: null, status: null },
      ],
      description: 'Switch the route to the new page once the checks pass and the release is approved.',
      acceptance: '- [ ] /sign-in serves the new page\n- [ ] The old page redirects to it',
    }),
    base('web', 'web-k3m9.4', 'Remove the old sign-in page', {
      parent: 'web-k3m9',
      priority: 3,
      dependencies: [{ id: 'web-k3m9.3', type: 'blocks', title: null, status: null }],
    }),
    base('web', 'web-g7p2', 'Approve sending the new sign-in page to every visitor', {
      issueType: 'gate',
      awaitType: 'human',
      priority: 1,
      ready: true,
      createdAt: at(26 * HOUR),
      updatedAt: at(26 * HOUR),
      description: 'Approve only the switch of /sign-in to the new page. Rolling back is one revert.',
    }),
    base('web', 'web-d4x1', 'Choose the sign-in methods the page offers', {
      issueType: 'decision',
      priority: 1,
      labels: ['human'],
      ready: true,
      createdAt: at(3 * DAY),
      updatedAt: at(3 * DAY),
      description:
        'The new form can offer an email link, a password, or both. Each method we keep is one more path to test and support.',
      choices: {
        question: 'Which sign-in methods should the page offer?',
        options: [
          {
            key: 'a',
            label: 'Email link only',
            detail: 'One path to test. People without email access on this device wait for the link.',
            recommended: true,
          },
          { key: 'b', label: 'Email link and password', detail: 'Two paths to test and support.' },
          { key: 'c', label: 'Password only', detail: 'The current behaviour.' },
        ],
      },
      comments: 1,
    }),
    base('web', 'web-q8n5', 'Confirm the support address on the error page', {
      priority: 2,
      labels: ['human', 'copy'],
      ready: true,
      createdAt: at(5 * DAY),
      updatedAt: at(5 * DAY),
      description: 'The error page tells people to write to support. Which address should it name?',
    }),
    base('web', 'web-b2r6', 'Fix the broken reset link in the welcome email', {
      issueType: 'bug',
      priority: 0,
      ready: true,
      updatedAt: at(9 * HOUR),
      description: [
        'The reset link in the welcome email opens a page that says the link expired, even when it is new. It started after web-k3m9.1 moved the sign-in routes.',
        '',
        '## Steps to Reproduce',
        '1. Sign up with a new address.',
        '2. Open the welcome email and press **Reset password**.',
        '',
        '## Cause',
        'The email still builds the link from the old host:',
        '',
        '```ts',
        "const resetUrl = new URL('/reset', 'https://old.example.com');",
        "resetUrl.searchParams.set('token', token);",
        '```',
        '',
        '- The token is valid; only the host is wrong.',
        '- Links sent before the move still expire after an hour.',
      ].join('\n'),
      acceptance: '- [ ] A new reset link opens the reset form\n- [ ] A test covers a link younger than an hour',
      estimateMinutes: 45,
      fields: { area: 'Email', story_points: 2, customer_facing: true },
    }),
    base('web', 'web-t5w3', 'Rename the Settings tab to Account', {
      priority: 3,
      labels: ['copy'],
      ready: true,
    }),
    base('web', 'web-p9c4', 'Review how the fonts load', {
      priority: 3,
      status: 'deferred',
      deferUntil: day(5),
    }),
    base('web', 'web-h1z8', 'Remove the old landing page', {
      priority: 3,
      ...closed(1 * DAY, FIXTURE_ACTOR, 'The new home page replaced it.', { resolution: 'no-longer-needed' }),
    }),

    base('docs', 'docs-m2v7', 'Write the guide to claiming a task', {
      ready: true,
      description: 'A short guide: what a claim is, how to take one, and how to hand one back.',
      acceptance: '- [ ] The guide shows one claim from start to close',
    }),
    base('docs', 'docs-n6j1', 'Explain approvals on the concepts page', {
      status: 'in_progress',
      assignee: FIXTURE_ACTOR,
      startedAt: at(1 * DAY),
      updatedAt: at(5 * HOUR),
    }),
    base('docs', 'docs-r4s9', 'Choose where the API reference lives', {
      issueType: 'decision',
      priority: 2,
      labels: ['human'],
      ready: true,
      createdAt: at(9 * DAY),
      updatedAt: at(9 * DAY),
      choices: {
        question: 'Where should the API reference live?',
        options: [
          {
            key: 'a',
            label: "In the repository's docs folder",
            detail: 'Reviewed with the code that changes it.',
            recommended: true,
          },
          { key: 'b', label: 'In a separate docs project', detail: 'Easier to search; needs its own deploy.' },
        ],
      },
    }),
    base('docs', 'docs-w8e3', 'Publish the guide on docs.example.com', {
      status: 'blocked',
      priority: 2,
      description: 'Waiting on the credentials for the documentation host.',
    }),
    base('docs', 'docs-y5u2', 'Fix the broken links in the README', {
      ...closed(3 * DAY, CLAUDE, 'Fixed in 9f8e7d6: every link now opens its page.', {
        delivery: {
          stage: 'merged',
          commit: '9f8e7d6',
          pullRequest: null,
          mergeCommit: '9f8e7d6',
          builtAt: at(3 * DAY),
          mergedAt: at(3 * DAY - HOUR),
          liveAt: null,
        },
      }),
    }),
  ];

  const comments = new Map<string, TaskComment[]>([
    [
      'web-k3m9.2',
      [
        {
          id: 'c1',
          author: CODEX,
          text: 'Started with the keyboard order. Tab skips the **submit** button; fixing that first.',
          createdAt: at(2 * HOUR),
        },
      ],
    ],
    [
      'web-d4x1',
      [
        {
          id: 'c2',
          author: CLAUDE,
          text: 'Support answered 31 password questions last month and 2 about email links.',
          createdAt: at(2 * DAY),
        },
      ],
    ],
  ]);

  const projects: TaskProject[] = [
    { projectId: 'p-web', logicalKey: 'web', displayName: 'Example web app', prefix: 'web', deploys: true },
    { projectId: 'p-docs', logicalKey: 'docs', displayName: 'Example docs', prefix: 'docs', deploys: false },
  ];

  // One field of every type, and one retired, whose values tasks keep.
  const field = (key: string, name: string, type: string, options: string[] | null = null): TaskField => ({
    key,
    name,
    type,
    options,
    createdAt: at(30 * DAY),
    retiredAt: null,
  });
  const fields = new Map<string, TaskField[]>([
    [
      'web',
      [
        { ...field('sprint', 'Sprint', 'text'), retiredAt: at(10 * DAY) },
        field('area', 'Product area', 'single-choice', ['Accessibility', 'Email', 'Sign-in', 'Performance']),
        field('story_points', 'Points', 'number'),
        field('platforms', 'Platforms', 'multiple-choice', ['Web', 'iOS', 'Android']),
        field('release_date', 'Release date', 'date'),
        field('spec', 'Spec', 'url'),
        field('customer_facing', 'Customer facing', 'yes-no'),
        field('team', 'Team', 'text'),
      ],
    ],
    ['docs', []],
  ]);

  return { projects, tasks, comments, fields };
}

/** Who signs in to the fixture API, as a member of a workspace. */
export const FIXTURE_USER: WorkspaceMember = {
  userId: 'u-example-owner',
  name: FIXTURE_ACTOR,
  githubLogin: 'example-owner',
  role: 'owner',
};

/**
 * The workspaces the fixture API's sign-in reaches: Example, which it owns,
 * with `seed`'s projects (by default `fixtureSeed`'s), two other members and
 * an invitation; and Example Labs, where it is a member, with one project.
 */
export function fixtureWorkspaces(nowMs: number, seed: FixtureSeed = fixtureSeed(nowMs)): FixtureWorkspace[] {
  const at = (ago: number) => new Date(nowMs - ago).toISOString();
  const task = taskAt(nowMs);
  const labs: FixtureSeed = {
    projects: [{ projectId: 'p-lab', logicalKey: 'lab', displayName: 'Example research', prefix: 'lab' }],
    tasks: [
      task('lab', 'lab-r2k8', 'Compare search ranking on the sample queries', { ready: true, priority: 1 }),
      task('lab', 'lab-t5w1', 'Write up the indexing benchmark', {
        status: 'in_progress',
        assignee: CLAUDE,
        startedAt: at(3 * HOUR),
        updatedAt: at(HOUR),
      }),
    ],
    comments: new Map(),
    fields: new Map([['lab', []]]),
  };
  return [
    {
      workspaceId: '0f6c2a52-6d1e-4c39-9a57-2f1b8e4d7a10',
      name: 'Example',
      role: 'owner',
      seed,
      members: [
        FIXTURE_USER,
        { userId: 'u-example-member', name: 'Example Member', githubLogin: 'example-member', role: 'member' },
        { userId: 'u-example-lead', name: 'Example Lead', githubLogin: 'example-lead', role: 'owner' },
      ],
      invitations: [
        { invitationId: 'i-example-invitee', githubLogin: 'example-invitee', role: 'member', createdAt: at(2 * DAY) },
      ],
    },
    {
      workspaceId: '5b3e9d84-1c27-4f60-8e2a-7c4d1a9b6e35',
      name: 'Example Labs',
      role: 'member',
      seed: labs,
      members: [
        { userId: 'u-example-lead', name: 'Example Lead', githubLogin: 'example-lead', role: 'owner' },
        { ...FIXTURE_USER, role: 'member' },
      ],
      invitations: [],
    },
  ];
}
