/** The checks of the Delivery level: where a done task's change has reached. */
import type { Signal } from '../api.ts';
import { answered, expect, same, type Check, type Context } from '../check.ts';
import { commitName, file, taskOf } from './steps.ts';

const repositoryOf = (context: Context) => context.target.repository ?? 'example/conformance';

async function signal(context: Context, stage: Signal['stage'], refs: Omit<Signal, 'repository' | 'stage'>) {
  return answered(
    await context.api().signal({ repository: repositoryOf(context), stage, ...refs }),
    `sending the ${stage} signal`,
  ).moved.map((moved) => moved.id);
}

async function deploys(context: Context): Promise<boolean> {
  const projects = answered(await context.setup().projects(), 'listing projects');
  return projects.find((project) => project.projectId === context.target.projects.main)?.deploys === true;
}

export const delivery: readonly Check[] = [
  {
    id: 'state-12-built-merged-live',
    rule: 'STATE-12',
    level: 'delivery',
    title: 'A close as done with a commit starts at built; signals move it to merged and live, and only forward',
    async run(context) {
      const commit = commitName();
      const id = await file(context);
      answered(await context.api().close(id, { reason: 'Shipped', commit }), `closing ${id} with a commit`);
      const built = (await taskOf(context.api(), id)).delivery;
      same([built?.stage, built?.commit], ['built', commit], `${id}'s delivery after the close`);
      expect(
        (await signal(context, 'merged', { commits: [commit] })).includes(id),
        `the merged signal did not move ${id}`,
      );
      const merged = (await taskOf(context.api(), id)).delivery;
      same([merged?.stage, merged?.mergeCommit], ['merged', commit], `${id}'s delivery after the merged signal`);
      expect(!(await signal(context, 'merged', { commits: [commit] })).includes(id), `a repeated signal moved ${id}`);
      await signal(context, 'live', { commits: [commit] });
      const expected = (await deploys(context)) ? 'live' : 'merged';
      same((await taskOf(context.api(), id)).delivery?.stage, expected, `${id}'s stage after the live signal`);
    },
  },
  {
    id: 'state-12-commit-prefix-matches',
    rule: 'STATE-12',
    level: 'delivery',
    title: 'A signal matches a commit when one name starts with the other',
    async run(context) {
      const commit = commitName();
      const id = await file(context);
      answered(await context.api().close(id, { reason: 'Shipped', commit: commit.slice(0, 7) }), 'closing');
      expect(
        (await signal(context, 'merged', { commits: [commit] })).includes(id),
        `a merged signal naming the whole commit did not move ${id}, closed with its first seven characters`,
      );
    },
  },
  {
    id: 'state-12-pull-request-matches',
    rule: 'STATE-12',
    level: 'delivery',
    title: 'A close as done with a pull request starts at built, and a signal naming the pull request moves it',
    async run(context) {
      const pr = `https://github.com/${repositoryOf(context)}/pull/${Date.now() % 1000000}`;
      const id = await file(context);
      answered(await context.api().close(id, { reason: 'Shipped', pr }), 'closing with a pull request');
      same((await taskOf(context.api(), id)).delivery?.stage, 'built', `${id}'s stage after the close`);
      expect((await signal(context, 'merged', { pullRequests: [pr] })).includes(id), `the signal did not move ${id}`);
      same((await taskOf(context.api(), id)).delivery?.stage, 'merged', `${id}'s stage after the signal`);
    },
  },
  {
    id: 'state-12-holder-commit-starts-delivery',
    rule: 'STATE-12',
    level: 'delivery',
    title: "A commit the close leaves out comes from the holder's work details",
    async run(context) {
      const commit = commitName();
      const id = await file(context);
      answered(await context.setup().claim(id, { work: { commit } }), `claiming ${id} with a commit`);
      answered(await context.api().close(id, { reason: 'Shipped' }), 'closing');
      const delivery = (await taskOf(context.api(), id)).delivery;
      same([delivery?.stage, delivery?.commit], ['built', commit], `${id}'s delivery`);
    },
  },
  {
    id: 'state-18-reported-merge-closes-nothing',
    rule: 'STATE-18',
    level: 'delivery',
    title: 'A merged signal a sender reports leaves a task in progress whose work names the pull request as it was',
    async run(context) {
      const pr = `https://github.com/${repositoryOf(context)}/pull/${Date.now() % 1000000}`;
      const id = await file(context);
      answered(await context.setup().claim(id, { work: { pr } }), `claiming ${id} with a pull request`);
      const holder = (await taskOf(context.api(), id)).assignee;
      await signal(context, 'merged', { pullRequests: [pr], commits: [commitName()] });
      const task = await taskOf(context.api(), id);
      same([task.status, task.assignee, task.work?.pr], ['in_progress', holder, pr], `${id} after the merged signal`);
    },
  },
  {
    id: 'state-12-reopen-clears-delivery',
    rule: 'STATE-12',
    level: 'delivery',
    title: 'A reopen clears the delivery, and history keeps each stage',
    async run(context) {
      const commit = commitName();
      const id = await file(context);
      answered(await context.setup().close(id, { reason: 'Shipped', commit }), 'closing');
      await signal(context, 'merged', { commits: [commit] });
      answered(await context.api().update(id, { status: 'open' }), `reopening ${id}`);
      same((await taskOf(context.api(), id)).delivery ?? null, null, `${id}'s delivery after the reopen`);
      const history = JSON.stringify(answered(await context.api().history(id), 'reading history'));
      for (const stage of ['built', 'merged'])
        expect(history.includes(`"${stage}"`), `${id}'s history no longer holds its ${stage} stage`);
    },
  },
];
