/**
 * The adapter against the Shared Work Protocol's conformance suite, over the
 * stand-in for GitHub: every check of the core level passes, and the broken
 * server's defects that reach the core level each fail exactly their
 * checks, so the passes are the adapter's own. What the suite cannot see,
 * the GitHub side of each write, is checked against the stand-in directly.
 */
import { describe, expect, it } from 'vitest';
import { DEFECTS, startBrokenServer, type Defect } from '../../../spec/conformance/fixtures/broken.ts';
import { mcpApi } from '../../../spec/conformance/src/mcp.ts';
import { runSuite } from '../../../spec/conformance/src/suite.ts';
import { KNOWN_GAPS, startLocalAdapter } from '../conformance/local.ts';
import { GitHub } from '../src/github.ts';

/** The defects whose checks the core level holds, and those checks. */
const FAILS: Partial<Readonly<Record<Defect, readonly string[]>>> = {
  'two-claims-win': ['inv-1-one-claim-wins'],
  'retries-repeat': ['inv-3-retry-answers-once', 'inv-3-key-reuse-refused'],
  'proof-dropped': ['inv-7-done-carries-proof', 'inv-9-reopen-keeps-earlier-close'],
  'models-dropped': ['inv-12-history-names-actor-and-model'],
};

const failedIn = (report: Awaited<ReturnType<typeof runSuite>>) =>
  report.results
    .filter((result) => !['passed', 'known-gap', 'not-applicable'].includes(result.status))
    .map((result) => result.id);

describe('the adapter', () => {
  it('passes every check of the core level', async () => {
    const local = await startLocalAdapter();
    try {
      const report = await runSuite(local.target, { knownGaps: KNOWN_GAPS });
      expect(failedIn(report)).toEqual([]);
      expect(report.levels.find((level) => level.level === 'core')?.status).toBe('passed');
    } finally {
      await local.close();
    }
  }, 60_000);

  it.each(
    Object.entries(FAILS).map(([defect, fails]) => ({
      defect: defect as Defect,
      fails: fails!,
      breaks: DEFECTS[defect as Defect],
    })),
  )(
    'fails exactly its checks behind a server that $breaks',
    async ({ defect, fails }) => {
      const local = await startLocalAdapter();
      try {
        const broken = await startBrokenServer(local.target, defect);
        try {
          expect(failedIn(await runSuite(broken.target, { knownGaps: KNOWN_GAPS })).sort()).toEqual([...fails].sort());
        } finally {
          await broken.close();
        }
      } finally {
        await local.close();
      }
    },
    60_000,
  );

  it('keeps each task an issue people can read in GitHub, and takes up an issue filed there', async () => {
    const local = await startLocalAdapter();
    try {
      const agent = mcpApi(local.target, 'agent');
      const github = new GitHub(local.githubApi!, local.githubToken);
      const repository = local.repository;
      const filed = await agent.create({
        title: 'Shrink the images',
        description: 'They load slowly.',
        labels: ['ui'],
      });
      expect(filed.ok).toBe(true);
      const id = filed.value!.id;
      const number = Number(id.slice(id.indexOf('-') + 1));
      await agent.comment(id, 'Measured: 2 MB each.');
      await agent.close(id, { reason: 'Shrunk to 200 KB', link: 'https://example.com/report' });
      const issue = (await github.getIssue(repository, number))!;
      expect([issue.title, issue.body, issue.state, issue.state_reason]).toEqual([
        'Shrink the images',
        'They load slowly.',
        'closed',
        'completed',
      ]);
      expect(issue.labels.map((label) => (typeof label === 'string' ? label : label.name))).toEqual([
        local.mainLabel,
        'ui',
      ]);
      const comments = (await github.listComments(repository, number)).map((comment) => comment.body);
      expect(comments).toEqual([
        'Measured: 2 MB each.\n\n— agent:Conformance agent A',
        'Closed as done: Shrunk to 200 KB\nhttps://example.com/report\n\n— agent:Conformance agent A',
      ]);

      const outside = await github.createIssue(repository, {
        title: 'Filed in GitHub',
        body: 'By a person.',
        labels: [local.mainLabel],
      });
      const taken = `${id.slice(0, id.indexOf('-'))}-${outside.number}`;
      const ready = await agent.ready();
      expect(ready.ok && ready.value.includes(taken)).toBe(true);
      expect((await agent.claim(taken)).ok).toBe(true);
      const history = await agent.history(taken);
      expect(history.ok && history.value.map((event) => [event.actions, event.actor]).reverse()).toEqual([
        [['created'], 'swp-adapter'],
        [['claimed'], 'agent:Conformance agent A'],
      ]);
    } finally {
      await local.close();
    }
  }, 60_000);
});
