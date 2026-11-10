/**
 * The adapter against the Shared Work Protocol's conformance suite, over the
 * stand-in for GitHub: every check of the core level passes, and the broken
 * server's defects that reach the core level each fail exactly their
 * checks, so the passes are the adapter's own. What the suite cannot see,
 * the GitHub side of each write, is checked against the stand-in directly.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { DEFECTS, startBrokenServer, type Defect } from '../../../spec/conformance/fixtures/broken.ts';
import { mcpApi } from '../../../spec/conformance/src/mcp.ts';
import { McpConnection } from '../../../spec/conformance/src/transport.ts';
import { runSuite } from '../../../spec/conformance/src/suite.ts';
import { KNOWN_GAPS, startLocalAdapter } from '../conformance/local.ts';
import { checkConfig, type AdapterConfig } from '../src/config.ts';
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

  it('files no issue for a task it refuses, such as one that would close a waiting loop', async () => {
    const local = await startLocalAdapter();
    try {
      const agent = mcpApi(local.target, 'agent');
      const github = new GitHub(local.githubApi!, local.githubToken);
      const first = (await agent.create({ title: 'Ship the page' })).value!.id;
      const second = (await agent.create({ title: 'Write the copy', dependsOn: [first] })).value!.id;
      const issues = (await github.listIssues(local.repository)).length;
      const connection = await new McpConnection(
        new URL('/mcp', local.target.url),
        local.target.senders.agent.headers,
      ).initialize();
      const refused = await connection.callTool('create_task', {
        project: local.target.projects.main,
        title: 'Review it',
        depends_on: [second],
        blocks: [first],
      });
      expect([refused.isError, refused.text.split('\n')[0]?.startsWith('refused:')]).toEqual([true, true]);
      expect((await github.listIssues(local.repository)).length).toBe(issues);
    } finally {
      await local.close();
    }
  }, 60_000);

  it('links a task to one in a project the sender only reads, and leaves that task’s own link to it alone', async () => {
    const local = await startLocalAdapter();
    try {
      const agent = mcpApi(local.target, 'agent');
      const person = mcpApi(local.target, 'person');
      const readOnly = local.target.projects.readOnly;
      const theirs = (await person.create({ project: readOnly, title: 'Change the shared schema' })).value!.id;
      const mine = (await agent.create({ title: 'Read the new schema' })).value!.id;
      expect((await agent.link(mine, theirs, 'merges-after')).ok).toBe(true);
      const read = (await agent.read(theirs)).value!;
      expect(read.task.dependents).toEqual([expect.objectContaining({ id: mine, type: 'merges-after' })]);
      expect((await agent.link(mine, theirs, 'blocks')).refusal?.kind).toBe('refused');

      const other = (await person.create({ project: readOnly, title: 'Rename the schema' })).value!.id;
      expect((await person.link(other, mine, 'related')).ok).toBe(true);
      const refused = await agent.link(mine, other, 'merges-after');
      expect([refused.refusal?.kind, refused.refusal?.text.includes('reading only')]).toEqual(['refused', true]);
      expect((await agent.read(mine)).value!.task.dependents).toEqual([
        expect.objectContaining({ id: other, type: 'related' }),
      ]);
    } finally {
      await local.close();
    }
  }, 60_000);

  it('names a task by one spelling of its issue number, and refuses an argument name the tool does not own', async () => {
    const local = await startLocalAdapter();
    try {
      const agent = mcpApi(local.target, 'agent');
      const id = (await agent.create({ title: 'Count the visits' })).value!.id;
      const [prefix, number] = id.split('-') as [string, string];
      for (const alias of [`${prefix}-0${number}`, `${prefix}-${number}.0`, `${prefix}-${number}e0`]) {
        const claimed = await agent.claim(alias);
        expect([alias, claimed.ok, claimed.refusal?.kind]).toEqual([alias, false, 'refused']);
      }
      expect((await agent.claim(id)).ok).toBe(true);
      const connection = await new McpConnection(
        new URL('/mcp', local.target.url),
        local.target.senders.agent.headers,
      ).initialize();
      for (const args of [{ title: 'x', toString: 1 }, JSON.parse('{"title": "x", "__proto__": {}}') as object]) {
        const answer = await connection.callTool('create_task', { project: local.target.projects.main, ...args });
        expect([answer.isError, answer.text.split('\n')[0]?.startsWith('invalid arguments: unknown argument')]).toEqual(
          [true, true],
        );
      }
    } finally {
      await local.close();
    }
  }, 60_000);

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

describe('the GitHub client', () => {
  it('sends a read again after a server error, never a create, and answers a GitHub that does not answer, or answers what it cannot read, as unavailable', async () => {
    const seen: string[] = [];
    const flaky = createServer((request, response) => {
      seen.push(request.method ?? '');
      const failing = seen.filter((method) => method === request.method).length === 1;
      response.writeHead(failing ? 502 : 200, { 'content-type': 'application/json' });
      response.end(failing ? '{}' : JSON.stringify({ number: 1, title: 'x', state: 'open', labels: [], user: null }));
    });
    await new Promise<void>((resolve) => flaky.listen(0, '127.0.0.1', resolve));
    try {
      const github = new GitHub(`http://127.0.0.1:${(flaky.address() as AddressInfo).port}`, 'token');
      await expect(github.createIssue('example/site', { title: 'x', body: '', labels: [] })).rejects.toMatchObject({
        status: 502,
      });
      expect((await github.getIssue('example/site', 1))?.number).toBe(1);
      expect(seen).toEqual(['POST', 'GET', 'GET']);
    } finally {
      await new Promise((resolve) => flaky.close(resolve));
    }
    await expect(new GitHub('http://127.0.0.1:1', 'token').getIssue('example/site', 1)).rejects.toMatchObject({
      status: 0,
    });
    const stalling = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.url?.endsWith('/1')) response.write('{"number": 1');
      else response.end('{"number":');
    });
    await new Promise<void>((resolve) => stalling.listen(0, '127.0.0.1', resolve));
    try {
      const github = new GitHub(`http://127.0.0.1:${(stalling.address() as AddressInfo).port}`, 'token', {
        timeout: 300,
      });
      for (const number of [1, 2])
        await expect(github.getIssue('example/site', number), `issue ${number}`).rejects.toMatchObject({ status: 0 });
    } finally {
      stalling.closeAllConnections();
      await new Promise((resolve) => stalling.close(resolve));
    }
  }, 20_000);
});

describe('the configuration', () => {
  const token = 'a'.repeat(64);
  const project = { projectId: 'p1', key: 'web', name: 'Website', prefix: 'web', repository: 'example/site' };
  const sender = { kind: 'agent', name: 'Claude', tokenSha256: token, projects: { p1: 'write' } } as const;
  const config = (change: Partial<AdapterConfig>): AdapterConfig => ({
    githubApi: 'https://api.github.com',
    ledger: null,
    projects: [project],
    senders: [sender],
    ...change,
  });

  it('refuses two projects with one id, two senders with one token, and a kind it does not know', () => {
    expect(() => checkConfig(config({}))).not.toThrow();
    expect(() => checkConfig(config({ projects: [project, { ...project, prefix: 'web2', key: 'web2' }] }))).toThrow(
      /projectId p1/u,
    );
    expect(() => checkConfig(config({ senders: [sender, { ...sender, name: 'Other' }] }))).toThrow(/tokenSha256/u);
    expect(() => checkConfig(config({ senders: [{ ...sender, kind: 'Agent' as never }] }))).toThrow(/kind/u);
  });

  it('refuses a service under the name the adapter records its own changes under', () => {
    const service = { ...sender, kind: 'service', name: 'github-adapter' } as const;
    expect(() => checkConfig(config({ senders: [service] }))).toThrow(/its own changes/u);
    expect(() => checkConfig(config({ senders: [{ ...sender, name: 'github-adapter' }] }))).not.toThrow();
  });
});
