/**
 * The conformance suite stays true to the protocol: each check names a rule
 * the protocol defines, at that rule's anchor, and every rule a level lists
 * has a check. Run through the deliberately broken server, each defect fails
 * exactly the checks of the rule it breaks and passes every other, so each
 * check is shown to tell a server that keeps its rule from one that does not.
 * Each run starts its own local Ntasks Worker; nothing here reaches a
 * deployed one.
 */
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFECTS, startBrokenServer, type Defect } from '../conformance/fixtures/broken.ts';
import { KNOWN_GAPS, startLocalNtasks } from '../conformance/ntasks/local.ts';
import { MissingSender } from '../conformance/src/api.ts';
import { fail, sectionOf, type Check } from '../conformance/src/check.ts';
import { checks } from '../conformance/src/checks/index.ts';
import { runSuite, type Report } from '../conformance/src/suite.ts';
import { httpApi } from '../conformance/src/http.ts';
import { mcpApi } from '../conformance/src/mcp.ts';
import { addressOf, checkTarget, LEVELS, type Level } from '../conformance/src/target.ts';

const SPEC = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(join(SPEC, name), 'utf8');

/** The checks each defect must fail, and no others. */
const FAILS: Readonly<Record<Defect, readonly string[]>> = {
  'two-claims-win': ['inv-1-one-claim-wins'],
  'retries-repeat': ['inv-3-retry-answers-once', 'inv-3-key-reuse-refused'],
  'stale-answers-accepted': [
    'auth-3-stale-proposal-refused',
    'state-15-refuses-an-unknown-criterion-or-an-old-proposal',
  ],
  'agents-decide': ['auth-1-only-a-person-answers', 'auth-11-only-a-person-accepts'],
  'relays-unmarked': ['auth-3-relayed-answer-recorded-as-relayed'],
  'disputes-refused': [
    'auth-5-dispute-reopens-a-relayed-approval',
    'state-14-relayed-report-can-be-disputed',
    'auth-11-dispute-reopens-a-relayed-acceptance',
  ],
  'proof-dropped': [
    'inv-7-done-carries-proof',
    'inv-9-reopen-keeps-earlier-close',
    'state-12-built-merged-live',
    'state-12-commit-prefix-matches',
    'state-12-pull-request-matches',
    'state-12-reopen-clears-delivery',
    // A closed sibling's proof, which a child's parent context shows.
    'state-17-parent-context',
  ],
  'models-dropped': ['inv-12-history-names-actor-and-model'],
  'held-tasks-hidden': [
    'inv-10-held-tasks-on-connect',
    'inv-10-most-recently-active-first',
    'mcp-1-held-tasks-lead-the-instructions',
  ],
};

/** The rules each level lists in section 7's table, with ranges such as `STATE-1 to STATE-9` spelled out. */
function rulesOfLevels(): Map<Level, string[]> {
  const names: Readonly<Record<string, Level>> = {
    Core: 'core',
    'Human decisions and approvals': 'human',
    Delivery: 'delivery',
    'Live work': 'live',
  };
  const levels = new Map<Level, string[]>();
  for (const match of read('protocol.md').matchAll(/^\| \*\*([^*]+)\*\* \| [^|]+ \| ([^|]+) \|/gmu)) {
    const level = names[match[1]!];
    if (level === undefined) continue;
    const rules = match[2]!.split(',').flatMap((part) => {
      const range = /^([A-Z]+)-(\d+) to [A-Z]+-(\d+)$/u.exec(part.trim());
      if (!range) return [part.trim()];
      return Array.from(
        { length: Number(range[3]) - Number(range[2]) + 1 },
        (_, i) => `${range[1]}-${Number(range[2]) + i}`,
      );
    });
    levels.set(level, rules);
  }
  return levels;
}

describe('the conformance checks', () => {
  it('each have an id of their own that starts with the rule they test', () => {
    const ids = checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      checks.filter((check) => !check.id.startsWith(`${check.rule.toLowerCase()}-`)).map((check) => check.id),
    ).toEqual([]);
  });

  it("each name a rule the protocol defines, at an anchor in that rule's section", () => {
    const missing = checks.filter((check) => {
      const [file, anchor] = sectionOf(check.rule).split('#') as [string, string];
      return !read(file).includes(`<a id="${anchor}"></a>`);
    });
    expect(missing.map((check) => `${check.id}: ${sectionOf(check.rule)}`)).toEqual([]);
  });

  it('cover every rule each conformance level lists, at that level', () => {
    const levels = rulesOfLevels();
    expect([...levels.keys()]).toEqual([...LEVELS]);
    const uncovered = [...levels].flatMap(([level, rules]) =>
      rules
        .filter((rule) => !checks.some((check) => check.rule === rule && check.level === level))
        .map((rule) => `${level} ${rule}`),
    );
    expect(uncovered).toEqual([]);
  });

  it('read a target file that follows target.schema.json, and refuse one that does not', () => {
    const example = JSON.parse(read('conformance/target.example.json')) as Record<string, unknown>;
    expect(checkTarget(example).projects.main).toBe('a1111111-0000-4000-8000-000000000001');
    expect(() => checkTarget({ ...example, levels: ['core', 'everything'] })).toThrow(/levels/u);
    expect(() => checkTarget({ ...example, senders: { agent: { headers: {} } } })).toThrow(/otherAgent/u);
  });

  it('refuse a binding path that a URL parser could read as another origin', () => {
    const example = JSON.parse(read('conformance/target.example.json')) as Record<string, unknown>;
    for (const path of ['//other.example/mcp', '/\\other.example/mcp', '/api mcp', 'api/mcp'])
      expect(() => checkTarget({ ...example, bindings: { mcp: { path } } }), path).toThrow(/bindings\/mcp\/path/u);
    const target = checkTarget(example);
    expect(addressOf(target, '/api/mcp').href).toBe('https://ntasks.example.com/api/mcp');
    expect(() => addressOf(target, '//other.example/mcp')).toThrow(/not the target's/u);
  });

  it("never follow a redirect, so a sender's headers stay on the target's origin", async () => {
    const elsewhere: string[] = [];
    const other = createServer((request, response) => {
      elsewhere.push(request.headers.authorization ?? 'no credential');
      response.end('{}');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as AddressInfo).port;
    const redirecting = createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${otherPort}/api/mcp` });
      response.end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
    try {
      const example = JSON.parse(read('conformance/target.example.json')) as Record<string, unknown>;
      const target = checkTarget({
        ...example,
        url: `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`,
      });
      for (const binding of ['mcp', 'http'] as const) {
        const api = binding === 'mcp' ? mcpApi(target, 'agent') : httpApi(target, 'agent', () => target.projects.main);
        const listed = await api.projects();
        expect(listed.ok, binding).toBe(false);
        expect(listed.refusal?.wellFormed, binding).toBe(false);
      }
      expect(elsewhere).toEqual([]);
    } finally {
      await Promise.all([redirecting, other].map((server) => new Promise((resolve) => server.close(resolve))));
    }
  });

  it('read an MCP reply from an event stream the server keeps open after it', async () => {
    const open: ServerResponse[] = [];
    const streaming = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        const message = JSON.parse(body) as { id?: number; method: string };
        if (message.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'streaming', version: '0' } }
            : { content: [{ type: 'text', text: '{"projects":[]}' }], structuredContent: { projects: [] } };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
        open.push(response);
      });
    });
    await new Promise<void>((resolve) => streaming.listen(0, '127.0.0.1', resolve));
    try {
      const example = JSON.parse(read('conformance/target.example.json')) as Record<string, unknown>;
      const target = checkTarget({
        ...example,
        url: `http://127.0.0.1:${(streaming.address() as AddressInfo).port}`,
      });
      const listed = await mcpApi(target, 'agent').projects();
      expect(listed).toEqual({ ok: true, value: [] });
    } finally {
      for (const response of open) response.end();
      streaming.closeAllConnections();
      await new Promise((resolve) => streaming.close(resolve));
    }
  }, 10_000);

  it("list as Ntasks's known gaps only checks that exist", () => {
    const ids = new Set(checks.map((check) => check.id));
    expect(Object.keys(KNOWN_GAPS).filter((key) => !ids.has(key.split('@')[0]!))).toEqual([]);
  });
});

describe("the suite's verdicts", () => {
  it('read a level incomplete when a sender or --only leaves checks out, and known-gaps when only listed gaps fail', async () => {
    const nothing = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not_found"}');
    });
    await new Promise<void>((resolve) => nothing.listen(0, '127.0.0.1', resolve));
    try {
      const example = JSON.parse(read('conformance/target.example.json')) as Record<string, unknown>;
      const target = checkTarget({
        ...example,
        url: `http://127.0.0.1:${(nothing.address() as AddressInfo).port}`,
        levels: ['core', 'human'],
      });
      const stand: Check[] = [
        { id: 'state-1-listed', rule: 'STATE-1', level: 'core', title: 'Fails as a listed gap', run: () => fail('no') },
        {
          id: 'state-10-needs-a-person',
          rule: 'STATE-10',
          level: 'human',
          title: 'Needs a person on HTTP',
          run: async (context) => {
            if (context.binding === 'http') throw new MissingSender('person');
          },
        },
      ];
      const knownGaps = { 'state-1-listed': 'tracked elsewhere' };
      const verdicts = (report: Report) => [
        Object.fromEntries(report.results.map((result) => [result.id, result.status])),
        Object.fromEntries(report.levels.filter((level) => level.claimed).map((level) => [level.level, level.status])),
        report.passed,
        report.filtered,
      ];
      expect(verdicts(await runSuite(target, { checks: stand, knownGaps }))).toEqual([
        { 'state-1-listed': 'known-gap', 'state-10-needs-a-person': 'not-run' },
        { core: 'known-gaps', human: 'incomplete' },
        true,
        false,
      ]);
      expect(verdicts(await runSuite(target, { checks: stand, knownGaps, bindings: ['mcp'] }))).toEqual([
        { 'state-1-listed': 'known-gap', 'state-10-needs-a-person': 'passed' },
        { core: 'incomplete', human: 'incomplete' },
        true,
        true,
      ]);
      expect(verdicts(await runSuite(target, { checks: stand, knownGaps, only: ['STATE-1'] }))).toEqual([
        { 'state-1-listed': 'known-gap' },
        { core: 'known-gaps', human: 'incomplete' },
        true,
        true,
      ]);
    } finally {
      await new Promise((resolve) => nothing.close(resolve));
    }
  });
});

describe.concurrent('the suite against a server that breaks one rule', () => {
  it.each((Object.entries(DEFECTS) as [Defect, string][]).map(([defect, breaks]) => ({ defect, breaks })))(
    'fails exactly the checks of the rule broken by a server that $breaks',
    async ({ defect }) => {
      const local = await startLocalNtasks();
      try {
        const broken = await startBrokenServer(local.target, defect);
        try {
          const report = await runSuite(broken.target, { knownGaps: KNOWN_GAPS });
          const failed = report.results
            .filter((result) => !['passed', 'known-gap'].includes(result.status))
            .map((result) => result.id);
          expect(failed.sort()).toEqual([...FAILS[defect]].sort());
        } finally {
          await broken.close();
        }
      } finally {
        await local.close();
      }
    },
    240_000,
  );
});
