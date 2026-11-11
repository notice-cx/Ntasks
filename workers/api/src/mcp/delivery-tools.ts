/**
 * The MCP tool that reports where closed tasks' changes are: an agent that
 * merges a pull request or finishes a deploy says so, as POST /api/delivery
 * does for a repository's automation.
 */
import { DELIVERY_STAGES } from '@ntasks/domain';
import { modelArg, type Args } from '../args.ts';
import { SCOPES } from '../auth.ts';
import { movedView, reportDelivery, signalArgs } from '../delivery.ts';
import { SIGNAL_ITEMS } from '../engine/validate.ts';
import { schema, type TaskTool, type ToolContext } from './read-tools.ts';
import { MODEL, WRITE } from './write-tools.ts';

export const REPORT_DELIVERY: TaskTool = Object.freeze({
  name: 'report_delivery',
  description:
    'Say that pull requests or commits merged or went live. Each closed task whose pull request, commit or merge commit matches moves to that stage, ' +
    'in the projects you may change; a project that does not deploy stops at merged. A task never moves back, so sending it again changes nothing. ' +
    'For a change that went live where no signal reaches Ntasks, such as a deploy by hand, name its tasks instead.',
  inputSchema: schema(
    {
      repository: {
        type: 'string',
        description: 'The repository, as owner/name. Needed with pull_requests or commits; tasks alone need none.',
      },
      stage: { type: 'string', enum: DELIVERY_STAGES.filter((stage) => stage !== 'built') },
      pull_requests: {
        type: 'array',
        items: { type: ['string', 'integer'] },
        maxItems: SIGNAL_ITEMS,
        description:
          "Pull requests: each its URL, or its number in repository. A merge's one commit is recorded as the merge commit.",
      },
      commits: {
        type: 'array',
        items: { type: 'string' },
        maxItems: SIGNAL_ITEMS,
        description:
          "Commits, each 7 to 64 hexadecimal characters. One matches a task's commit or merge commit when either starts with the other.",
      },
      tasks: {
        type: 'array',
        items: { type: 'string' },
        maxItems: SIGNAL_ITEMS,
        description:
          'Closed tasks by id, whose change merged or went live where no pull request or commit signal reached Ntasks.',
      },
      model: MODEL,
    },
    ['stage'],
  ),
  annotations: WRITE,
  scope: SCOPES.write,
  async run(context: ToolContext, args: Args) {
    const signal = signalArgs(args, { pullRequests: 'pull_requests', commits: 'commits', tasks: 'tasks' });
    const moves = await reportDelivery(context, signal, modelArg(args));
    return { moved: movedView(moves) };
  },
});
