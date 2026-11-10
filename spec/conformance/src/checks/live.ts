/** The checks of the Live work level: work in hand, and what a connecting agent is told. */
import { NotOffered, type Api, type ParentContext } from '../api.ts';
import { answered, expect, refused, same, snapshot, unchanged, type Check } from '../check.ts';
import { actorOf, commitName, file, taskOf } from './steps.ts';

/**
 * Comments on `task` with `pin` and `unpin`, and answers the new comment's
 * id: the one the write answers, or else the newest comment of the task's
 * read with this text. Each check comments on a task it filed, so the text
 * names one comment.
 */
async function pinned(api: Api, task: string, text: string, unpin?: readonly string[]): Promise<string> {
  const written = answered(
    await api.comment(task, text, { pin: true, ...(unpin === undefined ? {} : { unpin }) }),
    `pinning a comment on ${task}`,
  );
  if (written.commentId !== undefined) return written.commentId;
  const comments = answered(await api.read(task), `reading ${task}`).comments;
  const id = comments.filter((comment) => comment.text === text).at(-1)?.id;
  if (id === undefined) throw new NotOffered(api.binding, "answer a new comment's id, in the write or the task's read");
  return id;
}

/** The parent context a read of `task` answers, which must be there. */
async function parentOf(api: Api, task: string): Promise<ParentContext> {
  const read = answered(await api.read(task), `reading ${task}`);
  if (read.parent === null) throw new Error(`a read of ${task}, which has a parent, answers no parent context`);
  return read.parent;
}

export const live: readonly Check[] = [
  {
    id: 'state-16-stalled-is-shown-and-frees-nothing',
    rule: 'STATE-16',
    level: 'live',
    title:
      'A task in progress whose holder has recorded nothing is stalled and listed as stalled, a freshly claimed one is not, and neither changes',
    async run(context) {
      const api = context.api();
      const holder = await actorOf(context, 'otherAgent');
      const quiet = await file(context);
      answered(await api.update(quiet, { assignee: holder, status: 'in_progress' }), `giving ${quiet} to ${holder}`);
      const fresh = await file(context);
      answered(await api.claim(fresh), `claiming ${fresh}`);
      const [stalled, busy] = [await taskOf(api, quiet), await taskOf(api, fresh)];
      same([stalled.stalled, busy.stalled ?? false], [true, false], `${quiet} and ${fresh} marked stalled`);
      const listed = answered(await api.stalled(), 'listing stalled tasks');
      expect(listed.includes(quiet), `the stalled tasks leave out ${quiet}`);
      expect(!listed.includes(fresh), `the stalled tasks list ${fresh}, whose holder just claimed it`);
      same([stalled.status, stalled.assignee], ['in_progress', holder], `${quiet} after it read as stalled`);
    },
  },
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
  {
    id: 'state-17-parent-context',
    rule: 'STATE-17',
    level: 'live',
    title:
      "A read of a child, and a claim of it, show its parent's pinned comments and its closed siblings' closes, with the totals",
    async run(context) {
      const api = context.api();
      const epic = await file(context, { type: 'epic', title: context.unique('epic') });
      const done = await file(context, { parent: epic, title: context.unique('done child') });
      const commit = commitName();
      answered(await api.close(done, { reason: 'Merged; the header is shared now.', commit }), `closing ${done}`);
      answered(await api.comment(epic, 'An ordinary note.'), `commenting on ${epic}`);
      const fact = await pinned(api, epic, 'Every page shares the header.');
      const child = await file(context, { parent: epic, title: context.unique('open child') });
      const parent = await parentOf(api, child);
      same(parent.id, epic, `the parent ${child}'s read names`);
      same(
        parent.pinned.map((comment) => [comment.id, comment.text]),
        [[fact, 'Every page shares the header.']],
        `the pinned comments ${child}'s read shows`,
      );
      same(parent.pinnedTotal, 1, `the pinned comments ${child}'s read counts`);
      same(
        parent.closedSiblings.map((sibling) => [sibling.id, sibling.resolution, sibling.closeReason, sibling.commit]),
        [[done, 'done', 'Merged; the header is shared now.', commit]],
        `the closed siblings ${child}'s read shows`,
      );
      same(parent.closedSiblingsTotal, 1, `the closed siblings ${child}'s read counts`);
      const alone = await file(context);
      same(answered(await api.read(alone), `reading ${alone}`).parent, null, `the parent context of ${alone}`);
      if (context.binding !== 'mcp') return;
      const claimed = answered(await api.claim(child), `claiming ${child}`);
      same(
        claimed.parent?.pinned.map((comment) => comment.id),
        [fact],
        `the pinned comments ${child}'s claim shows`,
      );
      same(
        claimed.parent?.closedSiblings.map((sibling) => sibling.id),
        [done],
        `the closed siblings ${child}'s claim shows`,
      );
    },
  },
  {
    id: 'state-17-unpin',
    rule: 'STATE-17',
    level: 'live',
    title:
      "A later comment unpins a pinned one, leaving the task's version; unpinning a comment that is not pinned is refused",
    async run(context) {
      const api = context.api();
      const epic = await file(context, { type: 'epic', title: context.unique('epic') });
      const child = await file(context, { parent: epic, title: context.unique('child') });
      const before = answered(await api.update(epic, { title: context.unique('renamed epic') }), 'renaming');
      const wrong = await pinned(api, epic, 'The launch is on Monday.');
      const right = await pinned(api, epic, 'The launch is on Tuesday.', [wrong]);
      const parent = await parentOf(api, child);
      same(
        parent.pinned.map((comment) => comment.id),
        [right],
        `the pinned comments ${child}'s read shows after one is unpinned`,
      );
      same(parent.pinnedTotal, 1, `the pinned comments ${child}'s read counts after one is unpinned`);
      const comments = answered(await api.read(epic), `reading ${epic}`).comments;
      same(
        comments.filter((comment) => comment.id === wrong).map((comment) => comment.pinned),
        [false],
        `${epic}'s unpinned comment`,
      );
      const history = JSON.stringify(answered(await api.history(epic), `reading ${epic}'s history`));
      expect(history.includes(wrong), `${epic}'s history does not record which comment was unpinned`);
      const snapshotted = await snapshot(api, epic);
      refused(
        await api.comment(epic, 'Unpin it again.', { unpin: [wrong] }),
        `unpinning ${wrong}, which is no longer pinned`,
      );
      await unchanged(api, epic, snapshotted, 'a refused unpin');
      if (before.version === null) return;
      const after = answered(await api.update(epic, { title: context.unique('renamed again') }), 'renaming again');
      same(after.version, before.version + 1, `${epic}'s version after pinning and unpinning`);
    },
  },
  {
    id: 'state-19-overlaps-on-claim',
    rule: 'STATE-19',
    level: 'live',
    title:
      'A claim that records touches is never refused for an overlap, and answers the other held tasks whose touches meet them',
    async run(context) {
      if (context.binding !== 'mcp') throw new NotOffered(context.binding, "answer a claim's overlaps");
      const shared = `conformance/${context.unique('shared')}`;
      const first = await file(context, {}, 'otherAgent');
      answered(
        await context.setup('otherAgent').claim(first, { work: { touches: [`${shared}/baseline.json`] } }),
        `another agent claiming ${first}`,
      );
      const api = context.api();
      const later = await file(context);
      const claimed = answered(await api.claim(later, { work: { touches: [`./${shared}/`] } }), `claiming ${later}`);
      same(claimed.status ?? 'in_progress', 'in_progress', `${later}'s status after a claim that overlaps`);
      same(
        (claimed.overlaps ?? [])
          .filter((overlap) => overlap.id === first)
          .map((overlap) => [overlap.touches, overlap.mergeOrder]),
        [[[`${shared}/baseline.json`], null]],
        `the overlaps ${later}'s claim answers`,
      );
      answered(await api.link(later, first, 'merges-after'), `linking ${later} to merge after ${first}`);
      const noted = answered(
        await api.comment(later, 'Waiting for the other change to land.', { work: { touches: [shared] } }),
        `commenting on ${later} with touches`,
      );
      same(
        (noted.overlaps ?? []).filter((overlap) => overlap.id === first).map((overlap) => overlap.mergeOrder),
        ['after'],
        `the merge order ${later}'s comment answers`,
      );
    },
  },
];
