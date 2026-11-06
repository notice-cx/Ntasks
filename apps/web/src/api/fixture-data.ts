/**
 * Invented projects and tasks for the fixture API: every kind of task the
 * pages draw, with times relative to `nowMs` so ages read the same on any
 * day. Nothing here describes a real project, person or task.
 */
import type { LiveTask, TaskComment, TaskProject } from './types';

export interface FixtureTask extends LiveTask {
  /** The project's key. */
  project: string;
}

export interface FixtureSeed {
  projects: TaskProject[];
  tasks: FixtureTask[];
  comments: Map<string, TaskComment[]>;
}

/** Who the fixture API records as the sender of every change. */
export const FIXTURE_ACTOR = 'Example Owner';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function fixtureSeed(nowMs: number): FixtureSeed {
  const at = (ago: number) => new Date(nowMs - ago).toISOString();
  const day = (ahead: number) => new Date(nowMs + ahead * DAY).toISOString().slice(0, 10);

  const base = (project: string, id: string, title: string, fields: Partial<LiveTask> = {}): FixtureTask => ({
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

  const closed = (ago: number, by: string, reason: string, fields: Partial<LiveTask> = {}): Partial<LiveTask> => ({
    status: 'closed',
    closedAt: at(ago),
    updatedAt: at(ago),
    closeReason: reason,
    resolution: 'done',
    metadata: { noticeos_closed_by: by, noticeos_closed_model: 'example-model-1', noticeos_closed_at: at(ago) },
    ...fields,
  });

  const tasks: FixtureTask[] = [
    base('web', 'web-k3m9', 'Ship the new sign-in page', {
      issueType: 'epic',
      priority: 1,
      description: 'WHAT: Replace the sign-in page with the new form.\nWHY: 1 in 5 visitors who start signing in give up on the old form.\nWHERE: `src/pages/sign-in.tsx`',
      createdAt: at(12 * DAY),
    }),
    base('web', 'web-k3m9.1', 'Draw the sign-in form', {
      parent: 'web-k3m9',
      ...closed(2 * DAY, 'agent-one', 'Landed in 1a2b3c4: the form renders its fields and errors.'),
      acceptance: '- [x] The form shows email and password fields\n- [x] A wrong password shows its error under the field',
    }),
    base('web', 'web-k3m9.2', 'Check the sign-in form with a screen reader', {
      parent: 'web-k3m9',
      status: 'in_progress',
      priority: 1,
      assignee: 'agent-two',
      startedAt: at(3 * HOUR),
      updatedAt: at(40 * 60_000),
      metadata: { noticeos_claimed_model: 'example-model-2' },
      description: 'Walk the form with the keyboard and a screen reader, and fix what they cannot reach.',
      acceptance: '- [x] Every field is reachable with Tab\n- [ ] Every error is announced\n- [ ] The submit button names what it does',
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
      description: 'The new form can offer an email link, a password, or both. Each method we keep is one more path to test and support.',
      choices: {
        question: 'Which sign-in methods should the page offer?',
        options: [
          { key: 'a', label: 'Email link only', detail: 'One path to test. People without email access on this device wait for the link.', recommended: true },
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
      description: 'The reset link in the welcome email opens a page that says the link expired, even when it is new.\n\n## Steps to Reproduce\n1. Sign up with a new address.\n2. Open the welcome email and press **Reset password**.',
      acceptance: '- [ ] A new reset link opens the reset form\n- [ ] A test covers a link younger than an hour',
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
          { key: 'a', label: "In the repository's docs folder", detail: 'Reviewed with the code that changes it.', recommended: true },
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
      ...closed(3 * DAY, 'agent-one', 'Fixed in 9f8e7d6: every link now opens its page.'),
    }),
  ];

  const comments = new Map<string, TaskComment[]>([
    ['web-k3m9.2', [
      { id: 'c1', author: 'agent-two', text: 'Started with the keyboard order. Tab skips the **submit** button; fixing that first.', createdAt: at(2 * HOUR) },
    ]],
    ['web-d4x1', [
      { id: 'c2', author: 'agent-one', text: 'Support answered 31 password questions last month and 2 about email links.', createdAt: at(2 * DAY) },
    ]],
  ]);

  const projects: TaskProject[] = [
    { projectId: 'p-web', logicalKey: 'web', displayName: 'Example web app', prefix: 'web' },
    { projectId: 'p-docs', logicalKey: 'docs', displayName: 'Example docs', prefix: 'docs' },
  ];

  return { projects, tasks, comments };
}
