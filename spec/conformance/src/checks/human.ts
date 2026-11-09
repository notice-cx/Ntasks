/**
 * The checks of the Human decisions and approvals level. A person's own
 * answers go through the HTTP binding, the server's own interface; an
 * answer over MCP is relayed whoever sends it (mcp-profile.md 11.3), so a
 * check of approving or answering exercises the person on HTTP and a relay
 * on MCP.
 */
import { MissingSender, type Outcome, type Relay } from '../api.ts';
import { answered, expect, refused, same, snapshot, unchanged, type Check, type Context } from '../check.ts';
import { actorOf, file, linksTo, taskOf } from './steps.ts';

const CHOICES = {
  question: 'Which page ships first?',
  options: [
    { key: 'a', label: 'The sign-in page', recommended: true },
    { key: 'b', label: 'The billing page' },
  ],
} as const;

let sources = 0;
/** Where a person said something, as a relaying sender names it: unique, so a dispute of one never touches another. */
const source = () => `conformance:conversation/${Date.now()}-${(sources += 1)}`;

async function proposalOf(context: Context, task: string): Promise<string> {
  const read = answered(await context.setup().read(task), `reading ${task}`);
  expect(typeof read.proposalVersion === 'string', `${task}'s read answers no proposal version`);
  return read.proposalVersion;
}

/** A task and the approval it waits on, asked through the setup binding. */
async function withApproval(context: Context, labels: readonly string[] = []): Promise<{ task: string; gate: string }> {
  const task = await file(context, { labels });
  const asked = answered(
    await context.setup().requestApproval(task, `Deploy ${task} to staging.example.com`),
    `asking for ${task}'s approval`,
  );
  return { task, gate: asked.approval };
}

/** A person's answer relayed through the setup binding. */
async function relayApproval(context: Context, gate: string, from = source()): Promise<void> {
  answered(
    await context.setup().relay(gate, {
      action: 'answer',
      proposalVersion: await proposalOf(context, gate),
      quote: 'Yes, deploy it.',
      source: from,
    }),
    `relaying the approval of ${gate}`,
  );
}

/** Approves through the binding under test: the person over HTTP, a relayed answer over MCP. */
async function approveUnderTest(context: Context, gate: string): Promise<Outcome<unknown>> {
  if (context.binding === 'http') return asPerson(context).decide(gate, { kind: 'approve' });
  return context.api().relay(gate, {
    action: 'answer',
    proposalVersion: await proposalOf(context, gate),
    quote: 'Approved.',
    source: source(),
  });
}

function asPerson(context: Context) {
  if (!context.target.senders.person) throw new MissingSender('person');
  return context.api('person');
}

const STEPS = [
  { text: 'On the staging host, update to the merged commit.', command: './update.sh --commit a1b2c3d' },
  { text: 'Open the staging site and sign in.' },
  { text: 'Check that the new page shows.' },
] as const;

/** A task labelled human and the request to do steps it waits on, asked through the setup binding. */
async function withSteps(context: Context): Promise<{ task: string; request: string }> {
  const task = await file(context, { labels: ['human'] });
  const asked = answered(
    await context.setup().requestSteps(task, {
      title: 'Update the staging site',
      context: 'Staging runs the old release. The agent confirms by reading the new page.',
      steps: STEPS,
    }),
    `asking for ${task}'s steps`,
  );
  return { task, request: asked.request };
}

const CRITERIA = '- The new page is live.\n- An accountant confirms the tax treatment.\n- The docs say how to give.';
const CRITERION_TEXTS = [
  'The new page is live.',
  'An accountant confirms the tax treatment.',
  'The docs say how to give.',
];

/** Accepts as done through the binding under test: the person over HTTP, a relayed acceptance over MCP. */
async function acceptUnderTest(
  context: Context,
  task: string,
  met: readonly number[],
  proposalVersion?: string,
): Promise<Outcome<unknown>> {
  const shown = proposalVersion ?? (await proposalOf(context, task));
  if (context.binding === 'http')
    return asPerson(context).decide(task, {
      kind: 'accept',
      met,
      proposalVersion: shown,
      reason: 'I accept the tax risk.',
    });
  return context.api().relay(task, {
    action: 'accepted',
    met,
    proposalVersion: shown,
    quote: 'Close it. I accept the tax risk.',
    source: source(),
  });
}

async function decision(context: Context, labels: readonly string[] = ['human']): Promise<string> {
  return file(context, { type: 'decision', labels, choices: CHOICES });
}

const stepsOf = async (context: Context, request: string) => (await taskOf(context.api(), request)).steps ?? [];

export const human: readonly Check[] = [
  {
    id: 'state-10-approval-asked-once',
    rule: 'STATE-10',
    level: 'human',
    title: 'Asking again for the same approval while it is open returns the open one, so a person is asked once',
    async run(context) {
      const task = await file(context);
      const request = `Deploy ${task} to staging.example.com`;
      const first = answered(await context.api().requestApproval(task, request), 'asking for an approval');
      same(first.created, true, 'the first request opened an approval');
      const second = answered(await context.api().requestApproval(task, request), 'asking again');
      same(second.created, false, 'the same request asked again opened an approval');
      same(second.approval, first.approval, 'the approval the same request answers');
      const gate = await taskOf(context.api(), first.approval);
      same(gate.type, 'gate', `${first.approval}'s type`);
      same(linksTo(await taskOf(context.api(), task), first.approval), ['blocks'], `${task}'s link to its approval`);
    },
  },
  {
    id: 'state-3-open-approval-holds',
    rule: 'STATE-3',
    level: 'human',
    title: 'A task that waits on an open approval is not ready, and an approval is never ready work',
    async run(context) {
      const { task, gate } = await withApproval(context);
      const api = context.api();
      same((await taskOf(api, task)).ready, false, `${task}'s readiness while ${gate} is open`);
      const ready = answered(await api.ready(), 'listing ready work');
      expect(!ready.includes(task), `${task} is listed as ready work while ${gate} is open`);
      expect(!ready.includes(gate), `the approval ${gate} is listed as ready work`);
      same((await taskOf(api, gate)).ready ?? false, false, `${gate}'s readiness`);
    },
  },
  {
    id: 'state-10-approval-hands-back-a-human-task',
    rule: 'STATE-10',
    level: 'human',
    title: 'An approved approval closes as done, and a waiting task labelled human goes back to agents with a comment',
    async run(context) {
      const { task, gate } = await withApproval(context, ['human']);
      const comments = answered(await context.setup().read(task), 'reading').comments.length;
      answered(await approveUnderTest(context, gate), `approving ${gate}`);
      const approval = await taskOf(context.api(), gate);
      same([approval.status, approval.resolution], ['closed', 'done'], `${gate}'s status and resolution`);
      const read = answered(await context.api().read(task), `reading ${task}`);
      same(read.task.status, 'open', `${task}'s status after the approval`);
      same(read.task.assignee ?? null, null, `${task}'s holder after the approval`);
      expect(!(read.task.labels ?? []).includes('human'), `${task} still carries the human label`);
      expect(read.comments.length > comments, `${task} got no comment to keep within the approval`);
    },
  },
  {
    id: 'state-10-relayed-decline',
    rule: 'STATE-10',
    level: 'human',
    title:
      "A person's refusal, relayed, closes the approval as wont-do and tells each waiting task the action must not happen",
    async run(context) {
      const { task, gate } = await withApproval(context);
      const comments = answered(await context.setup().read(task), 'reading').comments.length;
      answered(
        await context.api().relay(gate, {
          action: 'declined',
          proposalVersion: await proposalOf(context, gate),
          quote: 'No, not this week.',
          source: source(),
        }),
        `relaying the refusal of ${gate}`,
      );
      const approval = await taskOf(context.api(), gate);
      same([approval.status, approval.resolution], ['closed', 'wont-do'], `${gate}'s status and resolution`);
      expect(
        answered(await context.api().read(task), 'reading').comments.length > comments,
        `${task} was not told that the action must not happen`,
      );
    },
  },
  {
    id: 'state-10-closed-approval-takes-only-the-report',
    rule: 'STATE-10',
    level: 'human',
    title: "A closed approval takes no further answer but the person's report that they did the action",
    async run(context) {
      const { gate } = await withApproval(context);
      await relayApproval(context, gate);
      const api = context.api();
      const before = await snapshot(api, gate);
      const proposalVersion = await proposalOf(context, gate);
      for (const action of ['answer', 'declined'] as const)
        refused(
          await api.relay(gate, { action, proposalVersion, quote: 'Changed my mind.', source: source() }),
          `relaying ${action} on the closed approval ${gate}`,
        );
      await unchanged(api, gate, before, 'the refused answers');
      answered(
        await api.relay(gate, {
          action: 'owner_performed',
          proposalVersion,
          quote: 'I deployed it myself.',
          source: source(),
        }),
        "relaying the person's report that they did it",
      );
    },
  },
  {
    id: 'state-7-human-requests-close-only-by-answer',
    rule: 'STATE-7',
    level: 'human',
    title: 'A close is refused on a task waiting on an open approval, on an approval and on a task labelled human',
    async run(context) {
      const api = context.api();
      const { task, gate } = await withApproval(context);
      const labelled = await file(context, { labels: ['human'] });
      for (const [id, what] of [
        [task, `closing ${task}, which waits on the open approval ${gate}`],
        [gate, `an agent closing the approval ${gate}`],
        [labelled, `an agent closing ${labelled}, which is labelled human`],
      ] as const) {
        const before = await snapshot(api, id);
        refused(await api.close(id, { reason: 'Done', link: 'https://example.com/done' }), what);
        await unchanged(api, id, before, what);
      }
    },
  },
  {
    id: 'state-11-pick-closes-the-decision',
    rule: 'STATE-11',
    level: 'human',
    title:
      "A person's pick closes the decision as done with the reason Chose (<key>) <label>, and a second pick is refused",
    senders: ['person'],
    async run(context) {
      const person = asPerson(context);
      const id = await decision(context);
      answered(await person.decide(id, { kind: 'choose', option: 'b' }), 'the person picking (b)');
      const task = await taskOf(context.api(), id);
      same([task.status, task.resolution], ['closed', 'done'], `${id}'s status and resolution`);
      same(task.closeReason, 'Chose (b) The billing page', `${id}'s close reason`);
      same(task.choice?.option, 'b', `${id}'s recorded pick`);
      const before = await snapshot(context.api(), id);
      refused(await person.decide(id, { kind: 'choose', option: 'a' }), 'a second pick');
      await unchanged(context.api(), id, before, 'the refused second pick');
    },
  },
  {
    id: 'state-11-answer-in-words',
    rule: 'STATE-11',
    level: 'human',
    title: 'An answer in words closes a decision as done, and hands any other task labelled human back to agents',
    senders: ['person'],
    async run(context) {
      const person = asPerson(context);
      const id = await decision(context);
      answered(await person.decide(id, { kind: 'respond', response: 'Neither yet; ask me Friday.' }), 'answering');
      const closed = await taskOf(context.api(), id);
      same([closed.status, closed.resolution], ['closed', 'done'], `${id}'s status and resolution`);
      const other = await file(context, { labels: ['human'] });
      answered(await person.decide(other, { kind: 'respond', response: 'Use the staging keys.' }), 'answering');
      const handed = await taskOf(context.api(), other);
      same(handed.status, 'open', `${other}'s status after the answer`);
      same(handed.assignee ?? null, null, `${other}'s holder after the answer`);
      expect(!(handed.labels ?? []).includes('human'), `${other} still carries the human label`);
    },
  },
  {
    id: 'state-11-dismissal',
    rule: 'STATE-11',
    level: 'human',
    title: 'A person may dismiss a task labelled human, closing it with a resolution other than done',
    senders: ['person'],
    async run(context) {
      const id = await file(context, { labels: ['human'] });
      answered(await asPerson(context).decide(id, { kind: 'dismiss', reason: 'Not needed' }), 'dismissing');
      const task = await taskOf(context.api(), id);
      same(task.status, 'closed', `${id}'s status`);
      expect(task.resolution !== 'done', `${id} closed as done on a dismissal`);
    },
  },
  {
    id: 'state-14-steps-asked-once',
    rule: 'STATE-14',
    level: 'human',
    title:
      'Asking again for the same steps while the request is open returns it, and the request keeps each step as filed',
    async run(context) {
      const task = await file(context);
      const request = { title: 'Update the staging site', context: 'Staging runs the old release.', steps: STEPS };
      const first = answered(await context.api().requestSteps(task, request), 'asking for steps');
      same(first.created, true, 'the first request opened one');
      const again = answered(await context.api().requestSteps(task, request), 'asking again');
      same([again.created, again.request], [false, first.request], 'the request the same steps asked again answer');
      same((await taskOf(context.api(), task)).ready, false, `${task}'s readiness while it waits on the steps`);
      same(
        (await stepsOf(context, first.request)).map((step) => [step.text, step.command ?? null]),
        STEPS.map((step) => [step.text, 'command' in step ? step.command : null]),
        `${first.request}'s steps and commands`,
      );
    },
  },
  {
    id: 'state-14-ticks-in-any-order-close-on-the-last',
    rule: 'STATE-14',
    level: 'human',
    title:
      "A person's ticks, in any order and undone while open, each name the person and close the request on the last",
    senders: ['person'],
    async run(context) {
      const person = asPerson(context);
      const { task, request } = await withSteps(context);
      for (const [step, done] of [
        [3, true],
        [1, true],
        [1, false],
        [1, true],
      ] as const) {
        answered(await person.decide(request, { kind: 'step', step, done }), `marking step ${step} ${done}`);
        same((await taskOf(context.api(), request)).status, 'open', `${request}'s status before its last tick`);
      }
      const marked = await stepsOf(context, request);
      expect(
        typeof marked[0]?.done?.by === 'string' && !Number.isNaN(Date.parse(marked[0].done.at)),
        'a tick does not record the person and the time',
      );
      same(marked[1]?.done ?? null, null, 'the step not yet ticked');
      answered(await person.decide(request, { kind: 'step', step: 2, done: true }), 'ticking the last step');
      const closed = await taskOf(context.api(), request);
      same([closed.status, closed.resolution], ['closed', 'done'], `${request}'s status and resolution`);
      const waiting = await taskOf(context.api(), task);
      same(waiting.status, 'open', `${task}'s status once the steps are done`);
      same(waiting.assignee ?? null, null, `${task}'s holder once the steps are done`);
      expect(!(waiting.labels ?? []).includes('human'), `${task} still carries the human label`);
    },
  },
  {
    id: 'state-14-stuck-mark-tells-the-waiting-task',
    rule: 'STATE-14',
    level: 'human',
    title: "A stuck mark clears the step's tick and tells the waiting task why, and a tick clears the mark",
    senders: ['person'],
    async run(context) {
      const person = asPerson(context);
      const { task, request } = await withSteps(context);
      const comments = answered(await context.api().read(task), 'reading').comments.length;
      answered(await person.decide(request, { kind: 'step', step: 1, done: true }), 'ticking step 1');
      const reason = 'The host asks for a password.';
      answered(await person.decide(request, { kind: 'step', step: 1, stuck: reason }), 'marking step 1 stuck');
      const stuck = (await stepsOf(context, request))[0];
      same([stuck?.done ?? null, stuck?.stuck?.reason], [null, reason], "step 1's tick and stuck mark");
      const told = answered(await context.api().read(task), 'reading');
      expect(
        told.comments.length > comments && told.comments.some((comment) => comment.text.includes(reason)),
        `${task} was not told which step stopped the person and why`,
      );
      answered(await person.decide(request, { kind: 'step', step: 1, done: true }), 'ticking step 1 again');
      same((await stepsOf(context, request))[0]?.stuck ?? null, null, "step 1's stuck mark after the tick");
    },
  },
  {
    id: 'state-14-takes-no-approval-or-option',
    rule: 'STATE-14',
    level: 'human',
    title: 'A request to do steps takes no approval and no option',
    async run(context) {
      const { request } = await withSteps(context);
      const api = context.binding === 'http' ? asPerson(context) : context.api();
      const before = await snapshot(context.api(), request);
      if (context.binding === 'http') {
        refused(await api.decide(request, { kind: 'approve' }), `approving the request to do steps ${request}`);
      } else {
        const proposalVersion = await proposalOf(context, request);
        refused(
          await api.relay(request, { action: 'answer', proposalVersion, quote: 'Yes.', source: source() }),
          `relaying an approval of ${request}`,
        );
        refused(
          await api.relay(request, { action: 'answer', option: 'a', proposalVersion, quote: 'A.', source: source() }),
          `relaying an option on ${request}`,
        );
      }
      await unchanged(context.api(), request, before, 'the refused answers');
    },
  },
  {
    id: 'state-14-relayed-report-and-refusal',
    rule: 'STATE-14',
    level: 'human',
    title:
      'A relayed report that the person did the steps closes the request as done, unticked; a relayed refusal as wont-do',
    async run(context) {
      const done = await withSteps(context);
      answered(
        await context.api().relay(done.request, {
          action: 'owner_performed',
          proposalVersion: await proposalOf(context, done.request),
          quote: 'Ran it, all good.',
          source: source(),
        }),
        'relaying the report that the person did the steps',
      );
      const reported = await taskOf(context.api(), done.request);
      same([reported.status, reported.resolution], ['closed', 'done'], `${done.request}'s status and resolution`);
      same(
        (reported.steps ?? []).map((step) => step.done ?? null),
        STEPS.map(() => null),
        `${done.request}'s ticks after the relayed report`,
      );
      const declined = await withSteps(context);
      answered(
        await context.api().relay(declined.request, {
          action: 'declined',
          proposalVersion: await proposalOf(context, declined.request),
          quote: 'Not this week.',
          source: source(),
        }),
        'relaying the refusal',
      );
      const refusal = await taskOf(context.api(), declined.request);
      same([refusal.status, refusal.resolution], ['closed', 'wont-do'], `${declined.request}'s status and resolution`);
    },
  },
  {
    id: 'state-14-relayed-report-can-be-disputed',
    rule: 'STATE-14',
    level: 'human',
    title: 'Disputing a relayed report that the person did the steps opens the request again',
    senders: ['person'],
    async run(context) {
      const { request } = await withSteps(context);
      answered(
        await context.setup().relay(request, {
          action: 'owner_performed',
          proposalVersion: await proposalOf(context, request),
          quote: 'Done.',
          source: source(),
        }),
        'relaying the report',
      );
      answered(await asPerson(context).decide(request, { kind: 'dispute' }), `disputing ${request}`);
      same((await taskOf(context.api(), request)).status, 'open', `${request}'s status after the dispute`);
    },
  },
  {
    id: 'state-15-acceptance-records-each-criterion',
    rule: 'STATE-15',
    level: 'human',
    title:
      'An acceptance as done closes the task, recording each criterion as met or waived, even when someone else holds it',
    async run(context) {
      const id = await file(context, { acceptance: CRITERIA }, 'otherAgent');
      answered(await context.setup('otherAgent').claim(id), `another agent claiming ${id}`);
      answered(await acceptUnderTest(context, id, [3, 1]), `accepting ${id} as done`);
      const task = await taskOf(context.api(), id);
      same([task.status, task.resolution], ['closed', 'done'], `${id}'s status and resolution`);
      same(
        task.closeAcceptance?.criteria,
        [
          { text: CRITERION_TEXTS[0], met: true },
          { text: CRITERION_TEXTS[1], met: false },
          { text: CRITERION_TEXTS[2], met: true },
        ],
        `${id}'s criteria, met and waived`,
      );
      expect(typeof task.closeAcceptance?.by === 'string', `${id}'s acceptance names nobody as having accepted it`);
      expect(task.proof !== 'none', `${id}, accepted as done, is marked proof: none`);
      same([task.delivery ?? null, task.closeLink ?? null], [null, null], `${id}'s delivery and close link`);
    },
  },
  {
    id: 'state-15-refuses-an-unknown-criterion-or-an-old-proposal',
    rule: 'STATE-15',
    level: 'human',
    title: 'An acceptance naming a criterion the task lacks, or a proposal version older than the task, is refused',
    async run(context) {
      const id = await file(context, { acceptance: CRITERIA });
      const old = await proposalOf(context, id);
      const before = await snapshot(context.api(), id);
      refused(await acceptUnderTest(context, id, [4]), `accepting ${id} with a criterion it lacks`);
      await unchanged(context.api(), id, before, 'the refused acceptance');
      answered(await context.setup().update(id, { description: 'Changed after the person read it.' }), 'editing');
      const edited = await snapshot(context.api(), id);
      refused(await acceptUnderTest(context, id, [1], old), `accepting ${id} as it stood before the edit`);
      await unchanged(context.api(), id, edited, 'the refused acceptance of the old proposal');
    },
  },
  {
    id: 'state-15-refused-where-it-does-not-apply',
    rule: 'STATE-15',
    level: 'human',
    title:
      'An acceptance is refused on a closed task, an approval, a request to do steps, a task waiting on an approval and a parent with open children',
    async run(context) {
      const closed = await file(context, { acceptance: CRITERIA });
      answered(await context.setup().close(closed, { reason: 'Dropped', resolution: 'wont-do' }), 'closing');
      const { task: waiting, gate } = await withApproval(context);
      const { request } = await withSteps(context);
      const parent = await file(context, { type: 'epic', acceptance: CRITERIA });
      await file(context, { parent });
      for (const [id, what] of [
        [closed, 'a closed task'],
        [gate, 'an approval'],
        [request, 'a request to do steps'],
        [waiting, 'a task waiting on an open approval'],
        [parent, 'a parent with an open child'],
      ] as const) {
        const before = await snapshot(context.api(), id);
        refused(await acceptUnderTest(context, id, []), `accepting ${what}, ${id}`);
        await unchanged(context.api(), id, before, `the refused acceptance of ${what}`);
      }
    },
  },
  {
    id: 'auth-11-only-a-person-accepts',
    rule: 'AUTH-11',
    level: 'human',
    title: 'An acceptance as done sent directly by an agent or a service is refused and changes nothing',
    senders: ['service'],
    async run(context) {
      const id = await file(context, { acceptance: CRITERIA });
      const proposalVersion = await proposalOf(context, id);
      for (const role of ['agent', 'service'] as const) {
        const before = await snapshot(context.setup(), id);
        refused(
          await context.api(role).decide(id, { kind: 'accept', met: [1], proposalVersion }),
          `the ${role} accepting ${id} as done directly`,
        );
        await unchanged(context.setup(), id, before, `the ${role}'s refused acceptance`);
      }
    },
  },
  {
    id: 'auth-11-agent-close-waives-nothing',
    rule: 'AUTH-11',
    level: 'human',
    title: "An agent's close as done records no criterion as waived; it names its proof",
    async run(context) {
      const id = await file(context, { acceptance: CRITERIA });
      answered(await context.api().close(id, { reason: 'Shipped', link: 'https://example.com/shipped' }), 'closing');
      same(
        (await taskOf(context.api(), id)).closeAcceptance ?? null,
        null,
        `${id}'s acceptance after an agent's close`,
      );
    },
  },
  {
    id: 'auth-11-relayed-acceptance-names-the-relay',
    rule: 'AUTH-11',
    level: 'human',
    title:
      'A relayed acceptance records the person as accepting it and the sender as relaying it; one from a service is refused',
    senders: ['service'],
    async run(context) {
      const id = await file(context, { acceptance: CRITERIA });
      const relay = {
        action: 'accepted',
        met: [1],
        proposalVersion: await proposalOf(context, id),
        quote: 'Close it. I accept the tax risk.',
        source: source(),
      } as const;
      const other = await file(context, { acceptance: CRITERIA });
      const before = await snapshot(context.api(), other);
      refused(
        await context.api('service').relay(other, { ...relay, proposalVersion: await proposalOf(context, other) }),
        'a service relaying an acceptance',
      );
      await unchanged(context.api(), other, before, "the service's refused relay");
      answered(await context.api().relay(id, relay), 'the agent relaying an acceptance');
      const accepted = (await taskOf(context.api(), id)).closeAcceptance;
      const agent = await actorOf(context, 'agent');
      same(
        [accepted?.relayed?.by, accepted?.relayed?.source, accepted?.relayed?.quote],
        [agent, relay.source, relay.quote],
        `who relayed ${id}'s acceptance, from where, and the person's words`,
      );
      expect(
        typeof accepted?.by === 'string' && accepted.by !== agent,
        `${id}'s acceptance names ${accepted?.by}, not the person, as having accepted it`,
      );
    },
  },
  {
    id: 'auth-11-dispute-reopens-a-relayed-acceptance',
    rule: 'AUTH-11',
    level: 'human',
    title:
      'Disputing a relayed acceptance opens the task again, tells the waiting task, refuses the same source, and changes nothing a second time',
    senders: ['person'],
    async run(context) {
      const person = asPerson(context);
      const id = await file(context, { acceptance: CRITERIA });
      const waiting = await file(context, { dependsOn: [id] });
      const from = source();
      const relay = { action: 'accepted', met: [1], quote: 'Close it.', source: from } as const;
      answered(
        await context.setup().relay(id, { ...relay, proposalVersion: await proposalOf(context, id) }),
        'relaying an acceptance',
      );
      const comments = answered(await context.setup().read(waiting), 'reading').comments.length;
      answered(await person.decide(id, { kind: 'dispute' }), `disputing ${id}'s acceptance`);
      const reopened = await taskOf(context.api(), id);
      same(reopened.status, 'open', `${id}'s status after the dispute`);
      same(reopened.closeAcceptance ?? null, null, `${id}'s acceptance after the dispute`);
      expect(
        JSON.stringify(answered(await context.api().history(id), 'reading history')).includes(relay.quote),
        `${id}'s history no longer holds the disputed close`,
      );
      const told = answered(await context.api().read(waiting), 'reading').comments.length;
      expect(told > comments, `${waiting}, which waits on ${id}, was not told of the dispute`);
      refused(
        await context.setup().relay(id, { ...relay, proposalVersion: await proposalOf(context, id) }),
        'an acceptance relayed again from the disputed source',
      );
      const before = await snapshot(context.api(), waiting);
      await person.decide(id, { kind: 'dispute' });
      await unchanged(context.api(), waiting, before, 'the second dispute');
    },
  },
  {
    id: 'auth-11-own-acceptance-not-disputable',
    rule: 'AUTH-11',
    level: 'human',
    title: "A person's own acceptance as done cannot be disputed",
    senders: ['person'],
    async run(context) {
      const person = asPerson(context);
      const id = await file(context, { acceptance: CRITERIA });
      answered(
        await person.decide(id, { kind: 'accept', met: [1, 2, 3], proposalVersion: await proposalOf(context, id) }),
        `accepting ${id}`,
      );
      const before = await snapshot(context.api(), id);
      refused(await person.decide(id, { kind: 'dispute' }), `disputing the person's own acceptance of ${id}`);
      await unchanged(context.api(), id, before, 'the refused dispute');
    },
  },
  {
    id: 'auth-1-only-a-person-answers',
    rule: 'AUTH-1',
    level: 'human',
    title:
      'A direct answer, approval, dispute or mark on a step from an agent or a service is refused and changes nothing',
    senders: ['service'],
    async run(context) {
      const id = await decision(context);
      const { gate } = await withApproval(context);
      const relayed = await withApproval(context);
      await relayApproval(context, relayed.gate);
      const steps = await withSteps(context);
      for (const role of ['agent', 'service'] as const) {
        const api = context.api(role);
        for (const [task, decide] of [
          [id, { kind: 'choose', option: 'a' }],
          [id, { kind: 'respond', response: 'The sign-in page.' }],
          [id, { kind: 'dismiss' }],
          [gate, { kind: 'approve' }],
          [relayed.gate, { kind: 'dispute' }],
          [steps.request, { kind: 'step', step: 1, done: true }],
        ] as const) {
          const before = await snapshot(context.setup(), task);
          refused(await api.decide(task, decide), `the ${role} sending a person's ${decide.kind}`);
          await unchanged(context.setup(), task, before, `the ${role}'s refused ${decide.kind}`);
        }
      }
    },
  },
  {
    id: 'auth-3-relayed-answer-recorded-as-relayed',
    rule: 'AUTH-3',
    level: 'human',
    title:
      'A relayed answer is recorded as relayed, by the sender, with the quote, source and proposal version it names',
    senders: ['service'],
    async run(context) {
      for (const role of ['agent', 'service'] as const) {
        const id = await decision(context);
        const relay = {
          action: 'answer',
          option: 'a',
          proposalVersion: await proposalOf(context, id),
          quote: 'Ship the sign-in page first.',
          source: source(),
        } as const;
        answered(await context.api(role).relay(id, relay), `the ${role} relaying an answer`);
        const answer = (await taskOf(context.api(), id)).answer;
        same(answer?.relayed, true, `${id}'s answer, relayed by the ${role}, is recorded as relayed`);
        same(
          [answer?.option, answer?.quote, answer?.source, answer?.proposalVersion],
          [relay.option, relay.quote, relay.source, relay.proposalVersion],
          `${id}'s recorded option, quote, source and proposal version`,
        );
        const sender = await actorOf(context, role);
        same(answer?.recordedBy, sender, `who ${id}'s answer names as having recorded it`);
      }
    },
  },
  {
    id: 'auth-3-relay-needs-quote-and-source',
    rule: 'AUTH-3',
    level: 'human',
    title: "A relayed answer that leaves out the person's words or where they said them is refused",
    async run(context) {
      const id = await decision(context);
      const proposalVersion = await proposalOf(context, id);
      const api = context.api();
      const before = await snapshot(api, id);
      const full: Relay = {
        action: 'answer',
        option: 'a',
        proposalVersion,
        quote: 'The sign-in page.',
        source: source(),
      };
      for (const left of ['quote', 'source'] as const) {
        const { [left]: _left, ...relay } = full;
        refused(await api.relay(id, relay), `a relayed answer with no ${left}`);
      }
      await unchanged(api, id, before, 'the refused relays');
    },
  },
  {
    id: 'auth-3-stale-proposal-refused',
    rule: 'AUTH-3',
    level: 'human',
    title: 'An answer naming a proposal version older than the task is refused, so an edited task cannot borrow it',
    async run(context) {
      const id = await decision(context);
      const old = await proposalOf(context, id);
      answered(
        await context.setup().update(id, { description: 'The question changed after the person read it.' }),
        'editing',
      );
      const api = context.binding === 'http' ? asPerson(context) : context.api();
      const before = await snapshot(context.api(), id);
      const outcome =
        context.binding === 'http'
          ? await api.decide(id, { kind: 'choose', option: 'a', proposalVersion: old })
          : await api.relay(id, { action: 'answer', option: 'a', proposalVersion: old, quote: 'A.', source: source() });
      refused(outcome, 'an answer to the proposal as it stood before the edit');
      await unchanged(context.api(), id, before, 'the refused answer');
    },
  },
  {
    id: 'auth-4-quote-recorded-as-given',
    rule: 'AUTH-4',
    level: 'human',
    title: 'The option recorded is the one the sender names, and the quote is kept as given, whatever it says',
    async run(context) {
      const id = await decision(context);
      const quote = 'maybe? (a) sounds fine too';
      answered(
        await context.api().relay(id, {
          action: 'answer',
          option: 'b',
          proposalVersion: await proposalOf(context, id),
          quote,
          source: source(),
        }),
        'relaying an answer',
      );
      const answer = (await taskOf(context.api(), id)).answer;
      same([answer?.option, answer?.quote], ['b', quote], `${id}'s recorded option and quote`);
    },
  },
  {
    id: 'auth-5-dispute-reopens-a-relayed-approval',
    rule: 'AUTH-5',
    level: 'human',
    title:
      'Disputing a relayed approval opens it again, tells the waiting task, refuses the same source, and changes nothing a second time',
    senders: ['person'],
    async run(context) {
      const person = asPerson(context);
      const { task, gate } = await withApproval(context);
      const from = source();
      await relayApproval(context, gate, from);
      const comments = answered(await context.setup().read(task), 'reading').comments.length;
      answered(await person.decide(gate, { kind: 'dispute' }), `disputing ${gate}`);
      const disputed = await taskOf(context.api(), gate);
      same(disputed.status, 'open', `${gate}'s status after the dispute`);
      expect(typeof disputed.answer?.disputedBy === 'string', `${gate}'s answer does not name who disputed it`);
      const told = answered(await context.api().read(task), 'reading');
      expect(told.comments.length > comments, `${task} was not told to stop`);
      refused(
        await context.setup().relay(gate, {
          action: 'answer',
          proposalVersion: await proposalOf(context, gate),
          quote: 'Yes, deploy it.',
          source: from,
        }),
        'an answer relayed again from the disputed source',
      );
      const before = await snapshot(context.api(), task);
      await person.decide(gate, { kind: 'dispute' });
      await unchanged(context.api(), task, before, 'the second dispute');
    },
  },
  {
    id: 'auth-5-direct-approval-not-disputable',
    rule: 'AUTH-5',
    level: 'human',
    title: "A person's own direct approval cannot be disputed",
    senders: ['person'],
    async run(context) {
      const person = asPerson(context);
      const { gate } = await withApproval(context);
      answered(await person.decide(gate, { kind: 'approve' }), `approving ${gate}`);
      const before = await snapshot(context.api(), gate);
      refused(await person.decide(gate, { kind: 'dispute' }), `disputing the direct approval of ${gate}`);
      await unchanged(context.api(), gate, before, 'the refused dispute');
    },
  },
  {
    id: 'auth-6-each-approval-held-separately',
    rule: 'AUTH-6',
    level: 'human',
    title: 'A task that waits on two approvals stays held until each is approved',
    async run(context) {
      const task = await file(context);
      const gates: string[] = [];
      for (const where of ['staging.example.com', 'app.example.com'])
        gates.push(
          answered(await context.setup().requestApproval(task, `Deploy ${task} to ${where}`), 'asking').approval,
        );
      answered(await approveUnderTest(context, gates[0]!), `approving ${gates[0]}`);
      same((await taskOf(context.api(), task)).ready, false, `${task}'s readiness with ${gates[1]} still open`);
      answered(await approveUnderTest(context, gates[1]!), `approving ${gates[1]}`);
      same((await taskOf(context.api(), task)).ready, true, `${task}'s readiness once both are approved`);
    },
  },
  {
    id: 'auth-7-retiring-grants-nothing',
    rule: 'AUTH-7',
    level: 'human',
    title:
      'A retired approval records no permission and its waiting task is told; nothing completes an approval or a decision from evidence',
    async run(context) {
      const api = context.api();
      const retired = await withApproval(context);
      const comments = answered(await context.setup().read(retired.task), 'reading').comments.length;
      answered(
        await api.relay(retired.gate, {
          action: 'obsolete',
          proposalVersion: await proposalOf(context, retired.gate),
          explanation: 'The deploy moved to another task.',
          evidence: 'https://example.com/plan',
        }),
        `retiring ${retired.gate}`,
      );
      const gate = await taskOf(api, retired.gate);
      same(gate.status, 'closed', `${retired.gate}'s status after it was retired`);
      expect(gate.resolution !== 'done', `${retired.gate} was retired as done`);
      expect(
        answered(await api.read(retired.task), 'reading').comments.length > comments,
        `${retired.task} was not told that the action must not happen without a new approval`,
      );
      const open = await withApproval(context);
      const id = await decision(context);
      for (const task of [open.gate, id]) {
        const before = await snapshot(api, task);
        refused(
          await api.relay(task, {
            action: 'completed',
            proposalVersion: await proposalOf(context, task),
            explanation: 'The work shipped.',
            evidence: 'https://example.com/pull/7',
          }),
          `completing ${task} from implementation evidence`,
        );
        await unchanged(api, task, before, `the refused completion of ${task}`);
      }
    },
  },
  {
    id: 'auth-8-agents-keep-human-requests',
    rule: 'AUTH-8',
    level: 'human',
    title: "An agent cannot take the human label off a human request, nor replace a task's choices once a person chose",
    async run(context) {
      const api = context.api();
      const labelled = await file(context, { labels: ['human'] });
      const before = await snapshot(api, labelled);
      refused(await api.update(labelled, { removeLabels: ['human'] }), `taking the human label off ${labelled}`);
      await unchanged(api, labelled, before, 'the refused label change');
      const chosen = await file(context, { labels: ['human'], choices: CHOICES });
      answered(
        await context.setup().relay(chosen, {
          action: 'answer',
          option: 'a',
          proposalVersion: await proposalOf(context, chosen),
          quote: 'The sign-in page.',
          source: source(),
        }),
        'relaying the pick',
      );
      const picked = await snapshot(api, chosen);
      refused(
        await api.update(chosen, { choices: { ...CHOICES, question: 'Which page ships last?' } }),
        `replacing ${chosen}'s choices after the person chose`,
      );
      await unchanged(api, chosen, picked, 'the refused choices');
    },
  },
];
