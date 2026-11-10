/** The checks of the Core level (protocol.md section 7). */
import { MissingSender, NotOffered, type HistoryEvent, type Outcome, type Written } from '../api.ts';
import { answered, expect, fail, refused, same, snapshot, unchanged, type Check } from '../check.ts';
import { actorOf, file, linksTo, nextYear, taskOf, together } from './steps.ts';

const STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'];
const TYPES = ['task', 'bug', 'feature', 'chore', 'epic', 'decision', 'gate'];
const RESOLUTIONS = ['done', 'wont-do', 'duplicate', 'cant-reproduce', 'already-handled', 'no-longer-needed'];
const ACTIONS = ['created', 'updated', 'claimed', 'status_changed', 'closed', 'reopened', 'commented'];
const LINK_TYPES = ['blocks', 'related', 'discovered-from', 'duplicates', 'supersedes'];

const claimsIn = (history: readonly HistoryEvent[]) => history.filter((event) => event.actions.includes('claimed'));

export const core: readonly Check[] = [
  {
    id: 'state-1-close-records-its-close',
    rule: 'STATE-1',
    level: 'core',
    title: 'A task reaches closed only through a close, which records its resolution and reason',
    async run(context) {
      const api = context.api();
      const id = await file(context);
      const before = await snapshot(api, id);
      refused(await api.update(id, { status: 'closed' }), `setting ${id}'s status to closed without a close`);
      await unchanged(api, id, before, 'the refused status change');
      answered(await api.close(id, { reason: 'Not needed after all', resolution: 'wont-do' }), `closing ${id}`);
      const task = await taskOf(api, id);
      same(task.status, 'closed', `${id}'s status after the close`);
      same(task.resolution, 'wont-do', `${id}'s resolution`);
      same(task.closeReason, 'Not needed after all', `${id}'s close reason`);
    },
  },
  {
    id: 'state-2-waiting-stays-open',
    rule: 'STATE-2',
    level: 'core',
    title: 'A task waiting on another through a blocks link keeps the status open',
    async run(context) {
      const blocker = await file(context);
      const waiting = await file(context, { dependsOn: [blocker] });
      const task = await taskOf(context.api(), waiting);
      same(task.status, 'open', `${waiting}'s status while it waits on ${blocker}`);
      same(task.ready, false, `${waiting}'s readiness while it waits on ${blocker}`);
    },
  },
  {
    id: 'state-3-blocks-hold-until-closed',
    rule: 'STATE-3',
    level: 'core',
    title: 'A task is ready only once every task it waits on through a blocks link is closed',
    async run(context) {
      const api = context.api();
      const blocker = await file(context);
      const waiting = await file(context, { dependsOn: [blocker] });
      same((await taskOf(api, waiting)).ready, false, `${waiting}'s readiness while it waits on ${blocker}`);
      expect(
        !answered(await api.ready(), 'listing ready work').includes(waiting),
        `${waiting} is listed as ready work while it waits on ${blocker}`,
      );
      answered(await context.setup().close(blocker, { reason: 'Done', link: 'https://example.com/done' }), 'closing');
      same((await taskOf(api, waiting)).ready, true, `${waiting}'s readiness once ${blocker} closed`);
      expect(
        answered(await api.ready(), 'listing ready work').includes(waiting),
        `${waiting} is not listed as ready work once ${blocker} closed`,
      );
    },
  },
  {
    id: 'inv-8-every-sender-reads-the-same-readiness',
    rule: 'INV-8',
    level: 'core',
    title:
      'The server works out readiness, so every sender reads the same answer for a task, before and after it changes',
    async run(context) {
      const blocker = await file(context);
      const waiting = await file(context, { dependsOn: [blocker] });
      const roles = ['agent', 'otherAgent', ...(context.target.senders.service ? (['service'] as const) : [])] as const;
      const readiness = async () => {
        const seen: string[] = [];
        for (const role of roles) {
          const api = context.api(role);
          const listed = answered(await api.ready(), `listing ready work as ${role}`).includes(waiting);
          seen.push(`${(await taskOf(api, waiting)).ready === true} ${listed}`);
        }
        return seen;
      };
      same(
        await readiness(),
        roles.map(() => 'false false'),
        `${waiting}'s readiness for each sender while it waits`,
      );
      answered(await context.setup().close(blocker, { reason: 'Done', link: 'https://example.com/done' }), 'closing');
      same(
        await readiness(),
        roles.map(() => 'true true'),
        `${waiting}'s readiness for each sender once ${blocker} closed`,
      );
    },
  },
  {
    id: 'state-3-waiting-parent-holds-descendants',
    rule: 'STATE-3',
    level: 'core',
    title: 'A parent that waits on an open task holds every task under it, at any depth',
    async run(context) {
      const blocker = await file(context);
      const epic = await file(context, { type: 'epic', dependsOn: [blocker] });
      const child = await file(context, { parent: epic });
      const grandchild = await file(context, { parent: child });
      const api = context.api();
      for (const id of [child, grandchild])
        same((await taskOf(api, id)).ready, false, `${id}'s readiness while ${epic} waits on ${blocker}`);
      answered(await context.setup().close(blocker, { reason: 'Done', link: 'https://example.com/done' }), 'closing');
      same((await taskOf(api, grandchild)).ready, true, `${grandchild}'s readiness once ${blocker} closed`);
    },
  },
  {
    id: 'state-3-deferred-is-not-ready',
    rule: 'STATE-3',
    level: 'core',
    title: 'A task deferred to a later time, or under a parent deferred to one, is not ready',
    async run(context) {
      const parent = await file(context, { type: 'epic' });
      const child = await file(context, { parent });
      answered(await context.setup().update(parent, { defer: nextYear() }), `deferring ${parent}`);
      const api = context.api();
      for (const id of [parent, child])
        same((await taskOf(api, id)).ready, false, `${id}'s readiness while ${parent} is deferred`);
      expect(
        !answered(await api.ready(), 'listing ready work').includes(child),
        `${child} is listed as ready work under the deferred ${parent}`,
      );
    },
  },
  {
    id: 'state-4-claim-takes-an-open-task-only',
    rule: 'STATE-4',
    level: 'core',
    title:
      'A claim takes an open task, recording the sender as holder, and is refused on a closed, blocked or deferred one',
    async run(context) {
      const api = context.api();
      const open = await file(context);
      const claim = answered(await api.claim(open), `claiming ${open}`);
      const task = await taskOf(api, open);
      same(task.status, 'in_progress', `${open}'s status after the claim`);
      expect(typeof task.assignee === 'string' && task.assignee !== '', `${open} names no holder after the claim`);
      if (claim.assignee !== undefined) same(claim.assignee, task.assignee, 'the holder the claim answered');

      const closed = await file(context);
      answered(await context.setup().close(closed, { reason: 'Dropped', resolution: 'wont-do' }), 'closing');
      for (const [status, id] of [
        ['closed', closed],
        ['blocked', await file(context)],
        ['deferred', await file(context)],
        ['in_progress', await file(context)],
      ] as const) {
        if (status !== 'closed') {
          const set = await context.setup().update(id, { status });
          // A server that never lets a task be in progress with nobody holding it keeps the rule by refusing that.
          if (status === 'in_progress' && !set.ok) continue;
          answered(set, `setting ${id}'s status to ${status}`);
        }
        const before = await snapshot(api, id);
        refused(await api.claim(id), `claiming the ${status} task ${id}, which nobody holds`);
        await unchanged(api, id, before, `the refused claim of the ${status} task`);
      }
    },
  },
  {
    id: 'state-5-holder-releases',
    rule: 'STATE-5',
    level: 'core',
    title: 'The holder releases a task, which becomes open with nobody holding it; another sender cannot release it so',
    async run(context) {
      const id = await file(context);
      answered(await context.setup().claim(id), `claiming ${id}`);
      const other = context.api('otherAgent');
      const before = await snapshot(other, id);
      refused(await other.update(id, { assignee: '' }), `another agent releasing ${id}`);
      await unchanged(other, id, before, "another agent's refused release");
      answered(await context.api().update(id, { assignee: '' }), `the holder releasing ${id}`);
      const task = await taskOf(context.api(), id);
      same(task.status, 'open', `${id}'s status after the release`);
      same(task.assignee ?? null, null, `${id}'s holder after the release`);
    },
  },
  {
    id: 'state-6-handover-from-the-holder-only',
    rule: 'STATE-6',
    level: 'core',
    title: 'A task someone holds goes to someone else only from its holder',
    async run(context) {
      const otherActor = await actorOf(context, 'otherAgent');
      const agentActor = await actorOf(context, 'agent');
      const id = await file(context);
      answered(await context.setup().claim(id), `claiming ${id}`);
      const other = context.api('otherAgent');
      const before = await snapshot(other, id);
      refused(await other.update(id, { assignee: otherActor }), `another agent taking ${id} from its holder`);
      await unchanged(other, id, before, "another agent's refused hand-over");
      answered(await context.api().update(id, { assignee: otherActor }), `the holder handing ${id} over`);
      same((await taskOf(context.api(), id)).assignee, otherActor, `${id}'s holder after ${agentActor} handed it over`);
    },
  },
  {
    id: 'state-7-close-refusals',
    rule: 'STATE-7',
    level: 'core',
    title: "A close is refused on another's task and on a parent with open children, and proof only goes with done",
    async run(context) {
      const api = context.api();
      const held = await file(context, {}, 'otherAgent');
      answered(await context.setup('otherAgent').claim(held), `another agent claiming ${held}`);
      const parent = await file(context, { type: 'epic' });
      await file(context, { parent });
      const dropped = await file(context);
      for (const [id, close, what] of [
        [held, { reason: 'Mine now' }, `closing ${held}, which another agent holds`],
        [parent, { reason: 'All done' }, `closing ${parent}, whose child is open`],
        [dropped, { reason: 'Dropped', resolution: 'wont-do', commit: 'abcdef1' }, 'a wont-do close with a commit'],
        [
          dropped,
          { reason: 'Dropped', resolution: 'wont-do', pr: 'https://example.com/pull/1' },
          'a wont-do close with a pull request',
        ],
        [
          dropped,
          { reason: 'Dropped', resolution: 'wont-do', link: 'https://example.com/doc' },
          'a wont-do close with a link',
        ],
        [dropped, { reason: 'Same work', resolution: 'duplicate' }, 'a duplicate close naming no task'],
      ] as const) {
        const before = await snapshot(api, id);
        refused(await api.close(id, close), what);
        await unchanged(api, id, before, what);
      }
    },
  },
  {
    id: 'state-7-duplicate-links-related',
    rule: 'STATE-7',
    level: 'core',
    title: 'A close as duplicate names the task it duplicates, which the server links as related',
    async run(context) {
      const original = await file(context);
      const later = await file(context);
      answered(
        await context.api().close(later, { reason: 'Filed twice', resolution: 'duplicate', duplicateOf: original }),
        `closing ${later} as a duplicate`,
      );
      const task = await taskOf(context.api(), later);
      same(task.resolution, 'duplicate', `${later}'s resolution`);
      same(task.duplicateOf, original, `the task ${later} duplicates`);
      const links = [...linksTo(task, original), ...linksTo(await taskOf(context.api(), original), later)];
      same(links, ['related'], `the link between ${later} and ${original}`);
    },
  },
  {
    id: 'state-8-reopen-clears-the-close',
    rule: 'STATE-8',
    level: 'core',
    title: 'Setting a status on a closed task reopens it, clearing its close and link',
    async run(context) {
      const api = context.api();
      const id = await file(context);
      answered(await api.close(id, { reason: 'Shipped', link: 'https://example.com/shipped' }), `closing ${id}`);
      answered(await api.update(id, { status: 'open' }), `reopening ${id}`);
      const task = await taskOf(api, id);
      same(task.status, 'open', `${id}'s status after the reopen`);
      for (const field of ['resolution', 'closeReason', 'closeLink', 'delivery'] as const)
        same(task[field] ?? null, null, `${id}'s ${field} after the reopen`);
    },
  },
  {
    id: 'state-9-epic-closes-once-children-close',
    rule: 'STATE-9',
    level: 'core',
    title: 'An epic closes once every child is closed',
    async run(context) {
      const epic = await file(context, { type: 'epic' });
      const child = await file(context, { parent: epic });
      answered(await context.setup().close(child, { reason: 'Done', link: 'https://example.com/done' }), 'closing');
      answered(await context.api().close(epic, { reason: 'Every child is done' }), `closing ${epic}`);
      same((await taskOf(context.api(), epic)).status, 'closed', `${epic}'s status`);
    },
  },
  {
    id: 'auth-2-actor-derived-from-sign-in',
    rule: 'AUTH-2',
    level: 'core',
    title:
      "Each change is recorded under the actor the sender's sign-in names: agent:… for an agent, service:… for a service",
    senders: ['service'],
    async run(context) {
      const id = await file(context);
      answered(await context.api().claim(id), `claiming ${id}`);
      answered(await context.api('service').comment(id, 'Checked by the service.'), `the service commenting`);
      const read = answered(await context.api().read(id), `reading ${id}`);
      expect(read.task.assignee?.startsWith('agent:'), `the agent's claim names ${read.task.assignee}, not agent:…`);
      const comment = read.comments.at(-1);
      expect(comment?.author.startsWith('service:'), `the service's comment names ${comment?.author}, not service:…`);
      const history = answered(await context.api().history(id), `reading ${id}'s history`);
      const claimed = claimsIn(history)[0];
      same(claimed?.actor, read.task.assignee, "the claim's actor in history");
      expect(
        history.some((event) => event.actions.includes('commented') && event.actor === comment?.author),
        "history records the service's comment under its actor",
      );
    },
  },
  {
    id: 'auth-9-release-by-another-needs-evidence',
    rule: 'AUTH-9',
    level: 'core',
    title:
      'Another sender releases a task only naming its holder, how it checked the holder stopped, and the progress left',
    async run(context) {
      const id = await file(context);
      answered(await context.setup().claim(id, { work: { next: 'Write the test' } }), `claiming ${id}`);
      const holder = (await taskOf(context.setup(), id)).assignee!;
      const proposalVersion = answered(await context.setup().read(id), `reading ${id}`).proposalVersion ?? '';
      const other = context.api('otherAgent');
      const release = {
        action: 'release',
        proposalVersion,
        holder,
        inactive: true,
        activityCheck: 'The holder answered no message for a week and its session is closed.',
        progress: 'Next step was to write the test.',
        explanation: 'The holder stopped.',
        evidence: 'Its session shows no activity.',
      } as const;
      const before = await snapshot(other, id);
      refused(await other.relay(id, { ...release, holder: 'agent:Somebody else' }), 'a release naming another holder');
      refused(
        await other.relay(id, { ...release, inactive: false }),
        'a release that does not state the holder stopped',
      );
      await unchanged(other, id, before, 'the refused releases');
      answered(await other.relay(id, release), `releasing ${id} with evidence`);
      const task = await taskOf(other, id);
      same(task.status, 'open', `${id}'s status after the release`);
      same(task.assignee ?? null, null, `${id}'s holder after the release`);
    },
  },
  {
    id: 'auth-9-person-frees-on-their-call',
    rule: 'AUTH-9',
    level: 'core',
    title:
      'A person frees a task someone holds on their own call: nobody holds it, it is recorded as theirs, and what the holder left stays on it; a free naming another holder changes nothing',
    async run(context) {
      if (!context.target.senders.person) throw new MissingSender('person');
      const person = context.api('person');
      const id = await file(context);
      answered(
        await context.setup().claim(id, { work: { branch: 'free-me', next: 'Write the free test' } }),
        `claiming ${id}`,
      );
      const before = await snapshot(context.api(), id);
      refused(await context.api().decide(id, { kind: 'release' }), `an agent freeing ${id} as a person would`);
      await unchanged(context.api(), id, before, "the agent's refused free");
      const other = context.unique('earlier-holder');
      refused(await person.decide(id, { kind: 'release', holder: other }), `freeing ${id} as held by ${other}`);
      await unchanged(context.api(), id, before, `the free naming ${other}`);
      answered(await person.decide(id, { kind: 'release' }), `the person freeing ${id}`);
      const read = answered(await person.read(id), `reading ${id}`);
      same([read.task.status, read.task.assignee ?? null], ['open', null], `${id}'s status and holder after the free`);
      const freedBy = await actorOf(context, 'person');
      const history = answered(await person.history(id), `reading ${id}'s history`);
      expect(
        history.some((event) => event.actor === freedBy && event.actions.some((action) => action !== 'commented')),
        `${id}'s history does not record the person as freeing it`,
      );
      const kept = read.comments.map((comment) => comment.text).join('\n');
      for (const left of ['free-me', 'Write the free test'])
        expect(kept.includes(left), `${id} no longer shows ${left}, which its holder left`);
    },
  },
  {
    id: 'auth-10-read-only-project-refuses-writes',
    rule: 'AUTH-10',
    level: 'core',
    title: 'A write to a project granted for reading only is refused',
    projects: ['readOnly'],
    async run(context) {
      const project = context.target.projects.readOnly!;
      refused(
        await context.api().create({ project, title: context.unique('read-only') }),
        'filing in a read-only project',
      );
    },
  },
  {
    id: 'auth-10-unreachable-reads-as-missing',
    rule: 'AUTH-10',
    level: 'core',
    title: 'A project or task the sender cannot reach answers exactly as one that does not exist',
    projects: ['hidden'],
    senders: ['person'],
    async run(context) {
      const hidden = answered(
        await context
          .setup('person')
          .create({ project: context.target.projects.hidden!, title: context.unique('hidden') }),
        'the person filing in the hidden project',
      ).id;
      const api = context.api();
      const projects = answered(await api.projects(), 'listing projects');
      expect(
        !projects.some((project) => project.projectId === context.target.projects.hidden),
        'the agent lists the project it cannot reach',
      );
      const missing = `${hidden.slice(0, hidden.lastIndexOf('-'))}-zz9zz9`;
      const unreachable = refused(await api.read(hidden), `reading ${hidden}, which the agent cannot reach`);
      const absent = refused(await api.read(missing), `reading ${missing}, which does not exist`);
      same(
        unreachable.kind,
        absent.kind,
        'the kind of refusal for a task the agent cannot reach and one that does not exist',
      );
      same(
        unreachable.status,
        absent.status,
        'the status for a task the agent cannot reach and one that does not exist',
      );
      same(
        unreachable.text.replaceAll(hidden, '<id>'),
        absent.text.replaceAll(missing, '<id>'),
        'the refusal for a task the agent cannot reach and one that does not exist',
      );
    },
  },
  {
    id: 'inv-1-one-claim-wins',
    rule: 'INV-1',
    level: 'core',
    title:
      'When two senders claim the same task at once, exactly one claim succeeds and nothing is recorded for the other',
    async run(context) {
      for (let round = 1; round <= 5; round += 1) {
        const id = await file(context, { title: context.unique(`race ${round}`) });
        const [first, second] = await together(
          () => context.api('agent').claim(id),
          () => context.api('otherAgent').claim(id),
        );
        const won = [first, second].filter((outcome) => outcome.ok).length;
        same(won, 1, `claims answered of two sent at once for ${id} (round ${round})`);
        const task = await taskOf(context.api(), id);
        const winner = (first.ok ? first.value : second.value)!;
        if (winner.assignee !== undefined)
          same(task.assignee, winner.assignee, `${id}'s holder is the winning claim's`);
        const claims = claimsIn(answered(await context.api().history(id), `reading ${id}'s history`));
        same(claims.length, 1, `claims recorded in ${id}'s history (round ${round})`);
      }
    },
  },
  {
    id: 'inv-2-time-never-releases',
    rule: 'INV-2',
    level: 'core',
    title: 'A claim stays held while time passes with no activity',
    async run(context) {
      const id = await file(context);
      answered(await context.setup().claim(id), `claiming ${id}`);
      const before = await snapshot(context.api(), id);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await unchanged(context.api(), id, before, 'two seconds without activity');
    },
  },
  {
    id: 'inv-3-retry-answers-once',
    rule: 'INV-3',
    level: 'core',
    title:
      'A write sent again with its idempotency key answers the first answer, marked as replayed, and changes nothing',
    async run(context) {
      const api = context.api();
      const id = await file(context);
      const key = context.key();
      const first = answered(await api.comment(id, 'Tested once.', { key }), 'the first comment');
      const after = await snapshot(api, id);
      const again = answered(await api.comment(id, 'Tested once.', { key }), 'the comment sent again');
      await unchanged(api, id, after, 'the comment sent again');
      same(after.read.comments.length, 1, `comments on ${id}`);
      const commentId = (written: { raw: unknown }) => {
        const raw = written.raw as Record<string, unknown>;
        return raw.commentId ?? (raw.comment as { id?: unknown } | undefined)?.id ?? null;
      };
      same(commentId(again), commentId(first), 'the comment the retry answered');
      same(again.replayed, true, 'the retry is marked as replayed');

      const claimKey = context.key();
      answered(await api.claim(id, { key: claimKey }), `claiming ${id}`);
      const claimed = await snapshot(api, id);
      const replay = answered(await api.claim(id, { key: claimKey }), `the claim of ${id} sent again`);
      await unchanged(api, id, claimed, 'the claim sent again');
      same(replay.replayed, true, 'the claim sent again is marked as replayed');
    },
  },
  {
    id: 'inv-3-key-reuse-refused',
    rule: 'INV-3',
    level: 'core',
    title: 'The same idempotency key with a different request or another task is refused, writing nothing',
    async run(context) {
      const api = context.api();
      const id = await file(context);
      const elsewhere = await file(context);
      const key = context.key();
      answered(await api.comment(id, 'First words.', { key }), 'the first comment');
      const before = await snapshot(api, id);
      refused(await api.comment(id, 'Other words.', { key }), 'the key sent again with other words');
      await unchanged(api, id, before, 'the key sent again with other words');
      const beforeElsewhere = await snapshot(api, elsewhere);
      refused(await api.comment(elsewhere, 'First words.', { key }), 'the key sent again for another task');
      await unchanged(api, elsewhere, beforeElsewhere, 'the key sent again for another task');
    },
  },
  {
    id: 'inv-4-version-rises-by-one',
    rule: 'INV-4',
    level: 'core',
    title: "A task's version rises by exactly one with each change, and a comment leaves it as it was",
    async run(context) {
      const api = context.api();
      const filed = answered(await api.create({ title: context.unique('versioned') }), 'filing');
      if (filed.version === null) throw new NotOffered(context.binding, "answer a task's version");
      const versionOf = (outcome: Outcome<Written>, what: string) => answered(outcome, what).version;
      const renamed = versionOf(await api.update(filed.id, { title: context.unique('renamed') }), 'changing the title');
      answered(await api.comment(filed.id, 'A note.'), 'commenting');
      const claimed = versionOf(await api.claim(filed.id), 'claiming after the comment');
      const closed = versionOf(
        await api.close(filed.id, { reason: 'Done', link: 'https://example.com/done' }),
        'closing',
      );
      const start = filed.version;
      same(
        [renamed, claimed, closed],
        [start + 1, start + 2, start + 3],
        'the versions the change, claim and close answered',
      );
    },
  },
  {
    id: 'inv-4-concurrent-writes-keep-both',
    rule: 'INV-4',
    level: 'core',
    title: 'Two writes to one task at once each apply to the version they were checked against: neither is lost',
    async run(context) {
      const id = await file(context);
      const title = context.unique('new title');
      const description = 'A description written at the same moment.';
      const [first, second] = await together(
        () => context.api('agent').update(id, { title }),
        () => context.api('otherAgent').update(id, { description }),
      );
      const task = await taskOf(context.api(), id);
      if (first.ok) same(task.title, title, `${id}'s title, which one write answered`);
      else expect(first.refusal.kind !== 'other', `the title change failed: ${first.refusal.text}`);
      if (second.ok) same(task.description, description, `${id}'s description, which the other write answered`);
      else expect(second.refusal.kind !== 'other', `the description change failed: ${second.refusal.text}`);
      const updates = answered(await context.api().history(id), 'reading history').filter((event) =>
        event.actions.includes('updated'),
      );
      same(updates.length, [first, second].filter((outcome) => outcome.ok).length, 'changes recorded in history');
    },
  },
  {
    id: 'inv-5-refused-write-leaves-no-retry-record',
    rule: 'INV-5',
    level: 'core',
    title:
      'A refused write leaves no change, history event or retry record: sent again with its key, it is a new attempt',
    async run(context) {
      const id = await file(context);
      answered(await context.setup().close(id, { reason: 'Dropped', resolution: 'wont-do' }), `closing ${id}`);
      const api = context.api();
      const key = context.key();
      const before = await snapshot(api, id);
      refused(await api.claim(id, { key }), `claiming the closed task ${id}`);
      await unchanged(api, id, before, 'the refused claim');
      answered(await context.setup().update(id, { status: 'open' }), `reopening ${id}`);
      const retried = answered(await api.claim(id, { key }), 'the refused claim sent again with its key');
      expect(retried.replayed !== true, 'the claim sent again replayed a refusal the server should not have recorded');
      same((await taskOf(api, id)).status, 'in_progress', `${id}'s status after the claim sent again`);
    },
  },
  {
    id: 'inv-6-history-is-kept',
    rule: 'INV-6',
    level: 'core',
    title: 'History is never edited or deleted, and a task keeps its id and creation time',
    async run(context) {
      const api = context.api();
      const id = await file(context);
      answered(await api.comment(id, 'First note.'), 'commenting');
      answered(await api.update(id, { title: context.unique('renamed') }), 'renaming');
      const earlier = await snapshot(api, id);
      answered(await api.claim(id), 'claiming');
      answered(await api.close(id, { reason: 'Done', link: 'https://example.com/done' }), 'closing');
      answered(await api.update(id, { status: 'open' }), 'reopening');
      const later = await snapshot(api, id);
      const kept = later.history.filter((event) => earlier.history.some((old) => old.revision === event.revision));
      same(
        [...kept].sort((a, b) => a.revision.localeCompare(b.revision)),
        [...earlier.history].sort((a, b) => a.revision.localeCompare(b.revision)),
        'the earlier history events, read again',
      );
      same(later.read.comments.slice(0, 1), earlier.read.comments.slice(0, 1), 'the first comment, read again');
      same(later.read.task.id, id, "the task's id");
      same(later.read.task.createdAt, earlier.read.task.createdAt, "the task's creation time");
    },
  },
  {
    id: 'inv-7-done-carries-proof',
    rule: 'INV-7',
    level: 'core',
    title: 'A close as done records its proof, and work done with none is marked proof: none',
    async run(context) {
      const api = context.api();
      for (const type of ['task', 'bug', 'feature', 'chore']) {
        const bare = await file(context, { type });
        answered(await api.close(bare, { reason: 'Done' }), `closing the ${type} ${bare} with no proof`);
        same((await taskOf(api, bare)).proof, 'none', `the proof of the ${type} ${bare}, closed as done with none`);
      }
      const linked = await file(context);
      answered(await api.close(linked, { reason: 'Done', link: 'https://example.com/report' }), 'closing with a link');
      const withLink = await taskOf(api, linked);
      same(withLink.closeLink, 'https://example.com/report', `${linked}'s close link`);
      expect(withLink.proof !== 'none', `${linked} closed with a link is marked proof: none`);
      const committed = await file(context);
      answered(await api.close(committed, { reason: 'Done', commit: 'abcdef1234' }), 'closing with a commit');
      const withCommit = await taskOf(api, committed);
      expect(withCommit.proof !== 'none', `${committed} closed with a commit is marked proof: none`);
      expect(
        JSON.stringify(withCommit).includes('abcdef1234'),
        `${committed} does not record the commit it closed with`,
      );
      const epic = await file(context, { type: 'epic' });
      answered(await api.close(epic, { reason: 'Every part shipped' }), `closing the epic ${epic}`);
      expect((await taskOf(api, epic)).proof !== 'none', `the epic ${epic} is marked proof: none`);
    },
  },
  {
    id: 'inv-7-holder-work-counts-as-proof',
    rule: 'INV-7',
    level: 'core',
    title: "A commit in the holder's work details counts as the proof of a close as done",
    async run(context) {
      const api = context.api();
      const id = await file(context);
      answered(await api.claim(id, { work: { commit: 'feedbeef1234' } }), `claiming ${id} with a commit`);
      answered(await api.close(id, { reason: 'Done' }), `closing ${id}`);
      expect((await taskOf(api, id)).proof !== 'none', `${id}, whose holder recorded a commit, is marked proof: none`);
    },
  },
  {
    id: 'inv-9-reopen-keeps-earlier-close',
    rule: 'INV-9',
    level: 'core',
    title: 'A reopened task keeps every earlier close and its evidence in its history',
    async run(context) {
      const api = context.api();
      const id = await file(context);
      answered(await api.close(id, { reason: 'First close', link: 'https://example.com/first' }), 'closing');
      answered(await api.update(id, { status: 'open' }), 'reopening');
      const history = JSON.stringify(answered(await api.history(id), `reading ${id}'s history`));
      for (const kept of ['First close', 'https://example.com/first'])
        expect(history.includes(kept), `${id}'s history no longer holds its earlier close's ${kept}`);
    },
  },
  {
    id: 'inv-11-one-link-per-pair',
    rule: 'INV-11',
    level: 'core',
    title: 'Two tasks hold at most one link: another kind, or the same kind the other way round, replaces it',
    async run(context) {
      const api = context.api();
      const a = await file(context);
      const b = await file(context);
      const links = async () => [
        ...linksTo(await taskOf(api, a), b).map((type) => `${a} ${type} ${b}`),
        ...linksTo(await taskOf(api, b), a).map((type) => `${b} ${type} ${a}`),
      ];
      answered(await api.link(a, b, 'blocks'), `linking ${a} to ${b}`);
      answered(await api.link(a, b, 'related'), `linking ${a} to ${b} as related`);
      same(await links(), [`${a} related ${b}`], 'the links between the two tasks');
      answered(await api.link(b, a, 'related'), `linking ${b} to ${a} as related`);
      same((await links()).length, 1, 'how many links the two tasks hold after the same kind the other way round');
      answered(await api.link(a, b, null), 'removing the link');
      same(await links(), [], 'the links after the removal');
    },
  },
  {
    id: 'inv-11-no-waiting-loops',
    rule: 'INV-11',
    level: 'core',
    title: 'A blocks link or a parent that would make tasks wait on each other in a loop is refused',
    async run(context) {
      const api = context.api();
      const a = await file(context);
      const b = await file(context, { dependsOn: [a] });
      const c = await file(context, { dependsOn: [b] });
      const before = await snapshot(api, a);
      refused(await api.link(a, c, 'blocks'), `making ${a} wait on ${c}, which waits on it`);
      await unchanged(api, a, before, 'the refused loop');
      const parent = await file(context, { type: 'epic' });
      const child = await file(context, { parent, type: 'epic' });
      refused(await api.update(parent, { parent: child }), `making ${parent} a child of its own child ${child}`);
    },
  },
  {
    id: 'inv-12-history-names-actor-and-model',
    rule: 'INV-12',
    level: 'core',
    title: 'Each change records its actor, its time and the model the sender named, and history returns them',
    async run(context) {
      const api = context.api();
      const models = [
        'conformance-model-1',
        'Conformance Model 2 (test)',
        'conformance/model-3',
        'conformance-model-4',
      ];
      const filed = answered(
        await api.create({ title: context.unique('provenance') }, { model: models[0]! }),
        'filing',
      );
      answered(await api.claim(filed.id, { model: models[1]! }), 'claiming');
      answered(await api.update(filed.id, { title: context.unique('renamed') }, { model: models[2]! }), 'renaming');
      answered(
        await api.close(filed.id, { reason: 'Done', link: 'https://example.com/done' }, { model: models[3]! }),
        'closing',
      );
      const history = [...answered(await api.history(filed.id), 'reading history')].reverse();
      same(
        history.map((event) => event.model),
        models,
        'the models history records, oldest first',
      );
      const actor = history[0]?.actor;
      expect(typeof actor === 'string' && actor.startsWith('agent:'), `history names ${actor} for the agent`);
      for (const event of history) {
        same(event.actor, actor, `the actor of the ${event.actions.join(', ')} event`);
        expect(!Number.isNaN(Date.parse(event.at)), `the ${event.actions.join(', ')} event has no time`);
      }
    },
  },
  {
    id: 'ext-1-metadata-kept-as-given',
    rule: 'EXT-1',
    level: 'core',
    title: "A task's metadata is stored and returned as given, where the server takes its keys",
    async run(context) {
      const metadata = { conformance_note: 'Kept as given.', conformance_count: 3 };
      const filed = await context.api().create({ title: context.unique('metadata'), metadata });
      if (!filed.ok) {
        expect(filed.refusal.kind === 'invalid', `metadata was refused, not as an argument: ${filed.refusal.text}`);
        return;
      }
      const task = await taskOf(context.api(), filed.value.id);
      same(
        Object.fromEntries(Object.entries(task.metadata ?? {}).filter(([key]) => key in metadata)),
        metadata,
        'the metadata read back',
      );
    },
  },
  {
    id: 'ext-4-closed-value-lists',
    rule: 'EXT-4',
    level: 'core',
    title: 'Statuses, types, resolutions, link types and history actions stay within the lists of v0',
    async run(context) {
      const api = context.api();
      const ids: string[] = [];
      for (const type of ['task', 'bug', 'feature', 'chore', 'epic']) ids.push(await file(context, { type }));
      const [first, second, third] = ids as [string, string, string];
      answered(await context.setup().link(first, second, 'related'), 'linking');
      answered(await api.claim(third), 'claiming');
      answered(await api.comment(third, 'A note.'), 'commenting');
      answered(await api.close(third, { reason: 'Done', link: 'https://example.com/done' }), 'closing');
      answered(await api.update(third, { status: 'open' }), 'reopening');
      answered(await api.close(second, { reason: 'Dropped', resolution: 'wont-do' }), 'closing');
      for (const id of ids) {
        const task = await taskOf(api, id);
        expect(STATUSES.includes(task.status), `${id}'s status ${task.status} is not one of v0's`);
        expect(TYPES.includes(task.type), `${id}'s type ${task.type} is not one of v0's`);
        if (task.resolution != null)
          expect(RESOLUTIONS.includes(task.resolution), `${id}'s resolution ${task.resolution} is not one of v0's`);
        for (const link of task.dependencies ?? [])
          expect(LINK_TYPES.includes(link.type), `${id}'s link type ${link.type} is not one of v0's`);
        for (const event of answered(await api.history(id), `reading ${id}'s history`))
          for (const action of event.actions)
            expect(ACTIONS.includes(action), `${id}'s history action ${action} is not one of v0's`);
      }
    },
  },
  {
    id: 'ext-3-unknown-argument-refused',
    rule: 'EXT-3',
    level: 'core',
    strength: 'should',
    title: 'An argument the server does not take is refused, not ignored',
    async run(context) {
      const id = await file(context);
      const api = context.api();
      const before = await snapshot(api, id);
      const refusal = refused(await api.misnamed(id), 'a change naming an argument the server does not take');
      same(refusal.kind, 'invalid', 'the kind of refusal for an argument the server does not take');
      await unchanged(api, id, before, 'the change with a misnamed argument');
    },
  },
];
