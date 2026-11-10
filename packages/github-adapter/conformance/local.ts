/**
 * The adapter set up for the conformance suite: three projects in one
 * repository, each the issues carrying its label, and the suite's senders,
 * each with a fresh token. Against the stand-in for GitHub by default; given
 * a repository and a token, against GitHub itself.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Target } from '../../../spec/conformance/src/target.ts';
import { checkConfig, tokenHash, type AdapterConfig, type SenderConfig } from '../src/config.ts';
import { createAdapter, MCP_PATH } from '../src/server.ts';
import { startFakeGitHub } from './fake-github.ts';

/** The checks the adapter is known to fail, each with its reason. */
export const KNOWN_GAPS: Readonly<Record<string, string>> = {};

export interface LocalAdapter {
  readonly target: Target;
  /** Every request the stand-in for GitHub answered, when the run used it. */
  readonly githubRequests: readonly string[] | null;
  /** The stand-in's address, when the run used it, and the token it answers. */
  readonly githubApi: string | null;
  readonly githubToken: string;
  readonly repository: string;
  /** The label that puts an issue in the main project. */
  readonly mainLabel: string;
  close(): Promise<void>;
}

export async function startLocalAdapter(
  github: { readonly repository: string; readonly token: string } | null = null,
): Promise<LocalAdapter> {
  const githubToken = github?.token ?? randomBytes(16).toString('hex');
  const fake = github === null ? await startFakeGitHub(githubToken) : null;
  const repository = github?.repository ?? 'example/conformance';
  const run = randomBytes(3).toString('hex');
  const ids = { main: randomUUID(), readOnly: randomUUID(), hidden: randomUUID() };
  const tokens = { agent: '', otherAgent: '', service: '', person: '' };
  for (const role of Object.keys(tokens) as (keyof typeof tokens)[])
    tokens[role] = randomBytes(24).toString('base64url');
  const sender = (kind: SenderConfig['kind'], name: string, token: string, projects: SenderConfig['projects']) => ({
    kind,
    name,
    tokenSha256: tokenHash(token),
    projects,
  });
  const agentGrants = { [ids.main]: 'write', [ids.readOnly]: 'read' } as const;
  const folder = mkdtempSync(join(tmpdir(), 'swp-github-'));
  const config: AdapterConfig = checkConfig({
    githubApi: fake?.url ?? 'https://api.github.com',
    ledger: join(folder, 'ledger.json'),
    projects: [
      {
        projectId: ids.main,
        key: 'main',
        name: 'Conformance',
        prefix: `m${run}`,
        repository,
        label: `swp-${run}-main`,
      },
      {
        projectId: ids.readOnly,
        key: 'read-only',
        name: 'Read only',
        prefix: `r${run}`,
        repository,
        label: `swp-${run}-read-only`,
      },
      {
        projectId: ids.hidden,
        key: 'hidden',
        name: 'Hidden',
        prefix: `h${run}`,
        repository,
        label: `swp-${run}-hidden`,
      },
    ],
    senders: [
      sender('agent', 'Conformance agent A', tokens.agent, agentGrants),
      sender('agent', 'Conformance agent B', tokens.otherAgent, agentGrants),
      sender('service', 'conformance-service', tokens.service, agentGrants),
      sender('person', 'Pat Example', tokens.person, {
        [ids.main]: 'write',
        [ids.readOnly]: 'write',
        [ids.hidden]: 'write',
      }),
    ],
  });
  // GitHub limits how fast one token creates content; the stand-in does not.
  const { server } = createAdapter(config, { githubToken, githubSpacing: fake === null ? 1000 : 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  return {
    target: {
      url: `http://127.0.0.1:${port}`,
      levels: ['core'],
      bindings: { mcp: { path: MCP_PATH } },
      projects: ids,
      senders: {
        agent: bearer(tokens.agent),
        otherAgent: bearer(tokens.otherAgent),
        service: bearer(tokens.service),
        person: bearer(tokens.person),
      },
      knownGaps: KNOWN_GAPS,
    },
    githubRequests: fake?.requests ?? null,
    githubApi: fake?.url ?? null,
    githubToken,
    repository,
    mainLabel: `swp-${run}-main`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fake?.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
