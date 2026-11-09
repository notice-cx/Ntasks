/** The checks of the Live work level: work in hand, and what a connecting agent is told. */
import { NotOffered } from '../api.ts';
import { answered, expect, same, snapshot, type Check } from '../check.ts';
import { actorOf, file, taskOf } from './steps.ts';

export const live: readonly Check[] = [
  {
    id: 'state-13-work-details-from-the-holder',
    rule: 'STATE-13',
    level: 'live',
    title:
      'Only the holder records work details, each replacing the one before, and a close clears them while history keeps them',
    async run(context) {
      const api = context.api();
      const id = await file(context);
      answered(
        await api.claim(id, { for: 'helper-one', work: { branch: 'fix-sign-in', next: 'Write the test' } }),
        `claiming ${id} with work details`,
      );
      const claimed = await taskOf(api, id);
      same(claimed.for, 'helper-one', `${id}'s helper`);
      same(
        [claimed.work?.branch, claimed.work?.next],
        ['fix-sign-in', 'Write the test'],
        `${id}'s branch and next step`,
      );
      const other = context.api('otherAgent');
      const before = await snapshot(other, id);
      await other.comment(id, 'Taking a look.', { work: { next: 'Something else' } });
      same((await taskOf(other, id)).work, before.read.task.work, `${id}'s work details after another agent's comment`);
      answered(await api.comment(id, 'Test written.', { work: { next: 'Open the pull request' } }), 'commenting');
      const next = (await taskOf(api, id)).work;
      same(
        [next?.branch, next?.next],
        ['fix-sign-in', 'Open the pull request'],
        `${id}'s work details after the comment`,
      );
      answered(await api.close(id, { reason: 'Done', link: 'https://example.com/done' }), 'closing');
      const closed = await taskOf(api, id);
      same(closed.for ?? null, null, `${id}'s helper after the close`);
      same(Object.keys(closed.work ?? {}), [], `${id}'s work details after the close`);
      const history = JSON.stringify(answered(await api.history(id), 'reading history'));
      for (const kept of ['helper-one', 'fix-sign-in', 'Open the pull request'])
        expect(history.includes(kept), `${id}'s history no longer holds ${kept}`);
    },
  },
  {
    id: 'state-13-handover-clears-work-details',
    rule: 'STATE-13',
    level: 'live',
    title: 'Giving a task to someone else clears its helper and work details',
    async run(context) {
      const other = await actorOf(context, 'otherAgent');
      const id = await file(context);
      answered(await context.setup().claim(id, { for: 'helper-two', work: { branch: 'b-two' } }), 'claiming');
      answered(await context.api().update(id, { assignee: other }), `handing ${id} over`);
      const task = await taskOf(context.api(), id);
      same(task.for ?? null, null, `${id}'s helper after the hand-over`);
      same(Object.keys(task.work ?? {}), [], `${id}'s work details after the hand-over`);
    },
  },
  {
    id: 'state-13-unchanged-details-keep-the-version',
    rule: 'STATE-13',
    level: 'live',
    title: "Work details that change nothing leave the task's version as it was",
    async run(context) {
      const api = context.api();
      const id = await file(context);
      const claimed = answered(await api.claim(id, { work: { branch: 'same-branch' } }), 'claiming');
      if (claimed.version === null) throw new NotOffered(context.binding, "answer a task's version");
      answered(await api.comment(id, 'Still on it.', { work: { branch: 'same-branch' } }), 'commenting');
      const renamed = answered(await api.update(id, { title: context.unique('renamed') }), 'renaming');
      same(renamed.version, claimed.version + 1, 'the version of a rename after work details that changed nothing');
    },
  },
  {
    id: 'inv-10-held-tasks-on-connect',
    rule: 'INV-10',
    level: 'live',
    title:
      'A connecting agent is told the open tasks it holds, with id, title, helper, branch and next step, and not others’',
    async run(context) {
      const id = await file(context);
      answered(
        await context.setup().claim(id, {
          for: 'helper-three',
          work: { branch: 'conformance-branch', next: 'Run the suite again' },
        }),
        `claiming ${id}`,
      );
      const title = (await taskOf(context.setup(), id)).title;
      const told = answered(await context.api().connect(), 'connecting').instructions;
      for (const [what, text] of [
        ['id', id],
        ['title', title],
        ['helper', 'helper-three'],
        ['branch', 'conformance-branch'],
        ['next step', 'Run the suite again'],
      ] as const)
        expect(told.includes(text), `the instructions a connecting agent reads leave out the held task's ${what}`);
      const others = answered(await context.api('otherAgent').connect(), 'another agent connecting').instructions;
      expect(!others.includes(id), `another agent is told ${id}, which it does not hold`);
    },
  },
  {
    id: 'inv-10-most-recently-active-first',
    rule: 'INV-10',
    level: 'live',
    title: 'The held tasks a connecting agent is told come most recently active first',
    async run(context) {
      const older = await file(context);
      answered(await context.setup().claim(older), `claiming ${older}`);
      const newer = await file(context);
      answered(await context.setup().claim(newer), `claiming ${newer}`);
      const told = answered(await context.api().connect(), 'connecting').instructions;
      const [first, second] = [told.indexOf(newer), told.indexOf(older)];
      expect(first >= 0 && second >= 0, 'the instructions leave out a task the agent holds');
      expect(first < second, `${older} is listed before ${newer}, which was active more recently`);
    },
  },
];
