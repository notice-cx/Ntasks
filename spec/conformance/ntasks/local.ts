/**
 * A local Ntasks Worker for the conformance suite: this repository's Worker,
 * run by wrangler's test harness on a port of this machine, with a workspace,
 * three projects and one sender of each kind the suite needs written into its
 * local D1 database. Nothing here reaches Cloudflare or a deployed Ntasks.
 *
 * The rows are the ones Ntasks writes itself when a person signs in and
 * approves an agent (workers/api/src/access): a session and an agent's access
 * token are stored by their hashes, and the session cookie carries the token
 * with its HMAC under AUTH_SECRET. This file is Ntasks's own: it stays with
 * Ntasks if the protocol moves to a home of its own.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTestHarness, unstable_readConfig } from 'wrangler';
import type { Target } from '../src/target.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG = fileURLToPath(new URL('../../../wrangler.jsonc', import.meta.url));
/** Invented values: nobody signs in through GitHub here. */
const AUTH_SECRET = randomBytes(32).toString('base64url');
const GITHUB = { GITHUB_CLIENT_ID: 'conformance-github-client', GITHUB_CLIENT_SECRET: 'conformance-github-secret' };

interface D1 {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
}

/** The checks Ntasks fails today, each with the task that fixes it. */
export const KNOWN_GAPS: Readonly<Record<string, string>> = {
  'state-5-holder-releases': 'ro-k0pv: a release with assignee "" leaves the task in_progress',
  'inv-3-retry-answers-once@http': 'ro-mhh0: an HTTP write sent again is not marked as replayed',
};

export interface LocalNtasks {
  readonly target: Target;
  close(): Promise<void>;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest();

/** Starts the Worker and writes its senders; `close` stops it and drops its storage. */
export async function startLocalNtasks(): Promise<LocalNtasks> {
  const config = unstable_readConfig({ config: CONFIG }, { hideWarnings: true });
  const workerConfig = (origin: string) => ({
    name: config.name,
    main: config.main,
    compatibility_date: config.compatibility_date,
    d1_databases: config.d1_databases.map(
      ({
        binding,
        database_name,
        migrations_dir,
      }: {
        binding: string;
        database_name?: string;
        migrations_dir?: string;
      }) => ({
        binding,
        ...(database_name === undefined ? {} : { database_name }),
        ...(migrations_dir === undefined ? {} : { migrations_dir }),
      }),
    ),
    ratelimits: config.ratelimits,
    durable_objects: config.durable_objects,
    migrations: config.migrations,
    rules: config.rules,
    vars: { AUTH_SECRET, NTASKS_ORIGIN: origin, ...GITHUB },
  });
  const server = createTestHarness({ root: ROOT, workers: [{ config: workerConfig('http://localhost:8787') }] });
  const { url } = await server.listen();
  // Sign-in is bound to the origin people use, which is known only once the server listens.
  await server.update({ root: ROOT, workers: [{ config: workerConfig(url.origin) }] });
  try {
    const target = await provision(server, new URL(url.origin));
    return { target, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function provision(server: ReturnType<typeof createTestHarness>, origin: URL): Promise<Target> {
  const worker = server.getWorker();
  await worker.applyD1Migrations('DB');
  const { DB } = (await worker.getEnv()) as { DB: D1 };
  const run = (statements: readonly (readonly [string, ...unknown[]])[]) =>
    DB.batch(statements.map(([sql, ...values]) => DB.prepare(sql).bind(...values)));
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  const workspace = randomUUID();
  const owner = randomUUID();
  const session = randomBytes(24).toString('base64url');
  await run([
    [
      'INSERT INTO auth_user (id, name, email, email_verified, image, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, ?, ?)',
      owner,
      'Pat Example',
      'pat@example.com',
      now,
      now,
    ],
    [
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      workspace,
      'Conformance',
      owner,
      now,
    ],
    [
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      workspace,
      owner,
      now,
    ],
    [
      'INSERT INTO auth_session (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(),
      later,
      session,
      now,
      now,
      owner,
    ],
  ]);
  // Better Auth signs the cookie's value as base64 of HMAC-SHA-256 under AUTH_SECRET.
  const signature = createHmac('sha256', AUTH_SECRET).update(session).digest('base64');
  const person = {
    cookie: `ntasks.session_token=${encodeURIComponent(`${session}.${signature}`)}`,
    origin: origin.origin,
  };

  const projects: Record<string, string> = {};
  for (const [name, prefix] of [
    ['Conformance', 'cf'],
    ['Conformance read-only', 'cfr'],
    ['Conformance hidden', 'cfh'],
  ] as const) {
    const response = await fetch(new URL('/api/tasks/projects', origin), {
      method: 'POST',
      headers: { ...person, 'content-type': 'application/json' },
      body: JSON.stringify({ name, prefix }),
    });
    const body = (await response.json()) as { project?: { projectId: string } };
    if (response.status !== 201 || !body.project) throw new Error(`creating ${prefix} answered ${response.status}`);
    projects[prefix] = body.project.projectId;
  }
  const main = projects.cf!;
  // The main project goes live by a deploy, so a live signal moves its tasks past merged.
  const deploys = await fetch(new URL('/api/tasks/projects', origin), {
    method: 'PATCH',
    headers: { ...person, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: main, deploys: true }),
  });
  if (deploys.status !== 200) throw new Error(`making cf deploy answered ${deploys.status}`);
  const readOnly = projects.cfr!;
  const hidden = projects.cfh!;

  const agent = async (name: string): Promise<Record<string, string>> => {
    const clientId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const scopes = JSON.stringify(['tasks:read', 'tasks:write']);
    await run([
      [
        'INSERT INTO auth_oauth_client (id, client_id, disabled, name, redirect_uris, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)',
        randomUUID(),
        clientId,
        name,
        JSON.stringify(['http://127.0.0.1:43110/callback']),
        now,
        now,
      ],
      [
        'INSERT INTO auth_oauth_consent (id, client_id, user_id, scopes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        randomUUID(),
        clientId,
        owner,
        scopes,
        now,
        now,
      ],
      [
        'INSERT INTO auth_oauth_access_token (id, token, client_id, user_id, expires_at, created_at, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        randomUUID(),
        // Better Auth stores an opaque token as base64url(SHA-256(token)).
        sha256(token).toString('base64url'),
        clientId,
        owner,
        later,
        now,
        scopes,
      ],
      ...[
        [main, 'write'],
        [readOnly, 'read'],
      ].map(
        ([project, access]) =>
          [
            'INSERT INTO access_agent_grants (user_id, client_id, workspace_id, project_id, access, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            owner,
            clientId,
            workspace,
            project,
            access,
            now,
          ] as const,
      ),
    ]);
    return { authorization: `Bearer ${token}` };
  };

  const credential = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  await run([
    [
      'INSERT INTO access_service_credentials (id, workspace_id, name, secret_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      credential,
      workspace,
      'conformance-service',
      sha256(secret).toString('hex'),
      owner,
      now,
    ],
    [
      'INSERT INTO access_service_grants (credential_id, project_id, access) VALUES (?, ?, ?)',
      credential,
      main,
      'write',
    ],
    [
      'INSERT INTO access_service_grants (credential_id, project_id, access) VALUES (?, ?, ?)',
      credential,
      readOnly,
      'read',
    ],
  ]);

  return {
    url: origin.origin,
    levels: ['core', 'human', 'delivery', 'live'],
    bindings: { mcp: { path: '/api/mcp' }, http: { path: '/api' } },
    workspace,
    projects: { main, readOnly, hidden },
    senders: {
      agent: { headers: await agent('Conformance agent A') },
      otherAgent: { headers: await agent('Conformance agent B') },
      service: { headers: { authorization: `Bearer ntasks_service.${credential}.${secret}` } },
      person: { headers: person },
    },
    knownGaps: KNOWN_GAPS,
  };
}
