/**
 * What an answer to an approval that gates a pull request does on GitHub, as
 * the workspace's GitHub App (access/github-app.ts). A person's own approval
 * turns on the pull request's auto-merge, or merges it when GitHub can merge
 * it already; a relayed approval, a decline, the person's report that they
 * did it themselves and a dispute turn on nothing. Each of them is posted on
 * the pull request as one comment that names the answer, the person and the
 * approval, so an agent watching the pull request learns of it. What GitHub
 * did, or why it did not, is recorded on the approval as a comment by
 * service:GitHub. The task store runs this right after the answer lands
 * (store/index.ts); an approval that gates no pull request asks nothing of GitHub.
 */
import type { Actor, TaskEngine } from '@ntasks/domain';
import { signInSecrets, storedOrigin } from './access/config.ts';
import {
  appToken,
  commentOnPullRequest,
  installationToken,
  RETRY,
  turnOnAutoMerge,
  UNCONFIRMED,
  type AutoMerge,
  type GitHubRefusal,
} from './access/github-api.ts';
import { githubAppOf, installationOn, permissionLinks } from './access/github-app.ts';
import { githubPullOf } from './delivery.ts';
import type { ApprovalAnswer } from './task-writes.ts';

/** Who records on the approval what GitHub did. */
const RECORDER: Actor = Object.freeze({ name: 'service:GitHub' });

/** Whether an answer turns on its pull request's auto-merge: only a person's own approval, which no dispute withdraws. */
export function turnsOnAutoMerge(answer: ApprovalAnswer): boolean {
  return answer.answer === 'approved' && answer.relayedBy === null;
}

/** Text that mentions nobody on GitHub: an @ starts a mention there, which would notify that account. */
function unmentioned(text: string): string {
  return text.replaceAll('@', '@​');
}

const isRefusal = (value: unknown): value is GitHubRefusal =>
  value !== null && typeof value === 'object' && 'refused' in value;

/** The comment posted on the pull request: the answer, who gave it, the approval, and what became of auto-merge. */
export function pullRequestComment(answer: ApprovalAnswer, merge: AutoMerge | null, origin: string | null): string {
  const { gate } = answer;
  const approval = `${origin === null ? gate.id : `[${gate.id}](${origin}/tasks/${gate.id})`}, ${unmentioned(gate.title)}`;
  const relayed = answer.relayedBy === null ? '' : `, relayed by ${unmentioned(answer.relayedBy)}`;
  const by = `${unmentioned(answer.by)}${relayed}`;
  switch (answer.answer) {
    case 'approved':
      return `**Approved** in Ntasks by ${by}: ${approval}.\n\n${mergeSentence(merge)}`;
    case 'performed':
      return `**Done by ${unmentioned(answer.by)} themselves**, recorded in Ntasks${relayed}: ${approval}.\n\nNo agent does the action it asked for.`;
    case 'declined':
      return `**Declined** in Ntasks by ${by}: ${approval}.\n\nThe action it asked for must not happen.`;
    case 'withdrawn':
      return `**Approval withdrawn** in Ntasks by ${by}: ${approval}.\n\nThe approval an agent relayed no longer stands, and the action waits for a new approval.`;
  }
}

/** What became of auto-merge, for the pull request's readers. */
function mergeSentence(merge: AutoMerge | null): string {
  if (merge === null)
    return 'Ntasks turns on auto-merge only for an approval a person gives in Ntasks, not for one an agent relays.';
  if (merge === RETRY) return 'Auto-merge is off: GitHub did not answer Ntasks.';
  if (merge === UNCONFIRMED) return 'GitHub did not confirm turning on auto-merge: check this pull request.';
  if (isRefusal(merge)) return `Auto-merge is off: GitHub refused it (${merge.refused}).`;
  switch (merge) {
    case 'on':
      return 'Ntasks turned on auto-merge for this pull request.';
    case 'merged':
      return 'Ntasks merged this pull request, which GitHub could merge already.';
    case 'already':
      return 'Auto-merge was on already.';
    case 'merged-before':
      return 'This pull request had merged already.';
    case 'closed':
      return 'This pull request is closed, so auto-merge is off.';
  }
}

/** What became of auto-merge, as the approval's history records it. */
function mergeRecord(named: string, merge: AutoMerge): string {
  if (merge === RETRY) return `GitHub did not answer, so auto-merge is not on for ${named}.`;
  if (merge === UNCONFIRMED)
    return `GitHub did not confirm turning on auto-merge for ${named}: check the pull request on GitHub.`;
  if (isRefusal(merge))
    return merge.forbidden
      ? `GitHub refused to turn on auto-merge for ${named}, because the app lacks permission: ${merge.refused}.`
      : `GitHub refused to turn on auto-merge for ${named}: ${merge.refused}.`;
  switch (merge) {
    case 'on':
      return `Turned on auto-merge for ${named}.`;
    case 'merged':
      return `Merged ${named}, which GitHub could merge already.`;
    case 'already':
      return `Auto-merge was on already for ${named}.`;
    case 'merged-before':
      return `${named} had merged already, so auto-merge was not turned on.`;
    case 'closed':
      return `${named} is closed, so auto-merge was not turned on.`;
  }
}

/** Whether the comment was posted, as the approval's history records it. */
function commentRecord(named: string, posted: true | GitHubRefusal | typeof UNCONFIRMED): string {
  if (posted === true) return `Posted this answer on ${named}.`;
  if (posted === UNCONFIRMED)
    return `GitHub did not confirm the comment with this answer on ${named}: check the pull request on GitHub.`;
  return posted.forbidden
    ? `GitHub refused to post this answer on ${named}, because the app lacks permission: ${posted.refused}.`
    : `GitHub refused to post this answer on ${named}: ${posted.refused}.`;
}

/** Asks GitHub for what the answer does there; answers the lines the approval's history records. */
async function onGitHub(env: Env, workspaceId: string, answer: ApprovalAnswer): Promise<string[]> {
  // gatedPullRequest names only a pull request on GitHub.
  const pull = githubPullOf(answer.pullRequest)!;
  const named = `${pull.repository}#${pull.number}`;
  const secrets = signInSecrets(env);
  const app = secrets === null ? null : await githubAppOf(env.DB, secrets.secret, workspaceId);
  if (secrets === null || app === null)
    return [
      `Posted nothing on ${named}: this workspace has no GitHub App. An owner connects one in Settings, under GitHub.`,
    ];
  const account = pull.repository.slice(0, pull.repository.indexOf('/'));
  const installation = await installationOn(env.DB, workspaceId, account);
  if (installation === null)
    return [`Posted nothing on ${named}: the workspace's GitHub App is not installed on ${account}.`];
  const jwt = await appToken(app.appId, app.privateKey);
  const token = jwt === null ? null : await installationToken(jwt, installation.installationId);
  if (token === null)
    return [`Posted nothing on ${named}: GitHub gave the app no token for its installation on ${account}.`];
  const merge = turnsOnAutoMerge(answer) ? await turnOnAutoMerge(token, pull.repository, pull.number) : null;
  const origin = secrets.app?.origin ?? (await storedOrigin(env.DB));
  const comment = pullRequestComment(answer, merge, origin);
  const posted = await commentOnPullRequest(token, pull.repository, pull.number, comment);
  const lines = [...(merge === null ? [] : [mergeRecord(named, merge)]), commentRecord(named, posted)];
  if ([merge, posted].some((result) => isRefusal(result) && result.forbidden)) {
    const links = permissionLinks(app.slug, installation);
    lines.push(
      `To give the app that permission, set Contents and Pull requests to Read and write at ${links.appPermissions}, then accept the new permissions at ${links.installation}.`,
    );
  }
  return lines;
}

/**
 * Posts a landed answer to an approval that gates a pull request on GitHub,
 * turning on its auto-merge for a person's own approval, and records what
 * GitHub did on the approval. It never throws: the answer stands whatever
 * GitHub does.
 */
export async function tellGitHub(
  env: Env,
  workspaceId: string,
  engine: TaskEngine,
  answer: ApprovalAnswer,
): Promise<void> {
  let lines: string[];
  try {
    lines = await onGitHub(env, workspaceId, answer);
  } catch (error) {
    console.error('approval answer not posted on GitHub', error);
    lines = [`Posted nothing on ${answer.pullRequest}: telling GitHub failed in Ntasks.`];
  }
  try {
    await engine.addComment(answer.projectId, answer.gate.id, lines.join('\n'), RECORDER);
  } catch (error) {
    console.error('what GitHub did with an approval answer was not recorded', error);
  }
}
