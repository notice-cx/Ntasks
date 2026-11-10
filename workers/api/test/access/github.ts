// A stand-in for GitHub's OAuth endpoints, so sign-in runs end to end with
// no network. Better Auth calls GitHub through globalThis.fetch, which tests
// share with the Worker. An authorization code `github-user-<id>` signs in
// as the GitHub user with that numeric id and the login `person-<id>`, and
// `github-user-<id>.<login>` as that user under another login, as after a
// rename. A manifest code `manifest-<id>` converts into a GitHub App owned by
// the GitHub user with that id.
import { afterEach, beforeEach, vi } from 'vitest';

export const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';

export function codeFor(githubId: number, login?: string): string {
  return login === undefined ? `github-user-${githubId}` : `github-user-${githubId}.${login}`;
}

/** The code GitHub returns once the GitHub user `ownerId` creates the app from the setup's manifest. */
export function manifestCodeFor(ownerId: number): string {
  return `manifest-${ownerId}`;
}

/** How the client id of an app a manifest converts into starts. */
const APP_CLIENT_PREFIX = 'Iv23-';

/** The credentials of the app a manifest code converts into. */
export function convertedApp(ownerId: number): { readonly clientId: string; readonly clientSecret: string } {
  return {
    clientId: `${APP_CLIENT_PREFIX}app-of-${ownerId}`,
    clientSecret: `app-secret-of-${ownerId}-0123456789abcdef`,
  };
}

/** The webhook secret GitHub hands back with the app a manifest code converts into. */
export function convertedWebhookSecret(ownerId: number): string {
  return `webhook-secret-of-${ownerId}-0123456789abcdef`;
}

/** A pull request as the stand-in answers it, by `owner/name#number`. */
export interface StandInPull {
  readonly merged: boolean;
  readonly mergeCommit: string | null;
  readonly mergedAt?: string;
  readonly base: string;
}

/** A check run that completed on a commit, as the stand-in lists it. */
export interface StandInCheckRun {
  readonly name: string;
  readonly conclusion: 'success' | 'failure';
  readonly startedAt: string;
  readonly completedAt: string;
  /** The branch of its check suite; main when a test names none. */
  readonly branch?: string;
}

let appKeys: Promise<CryptoKeyPair> | undefined;

/** The RSA key of every app a manifest converts into, made the first time a test needs it. */
function appKeyPair(): Promise<CryptoKeyPair> {
  appKeys ??= crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
  return appKeys;
}

/** A DER element's tag and where its content starts and ends. */
function derAt(bytes: Uint8Array, offset: number): { readonly start: number; readonly end: number } {
  let length = bytes[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[start + i]!;
    start += count;
  }
  return { start, end: start + length };
}

/** The app's private key as GitHub hands it over: PKCS #1 PEM, taken out of the PKCS #8 that Web Crypto exports. */
async function appKeyPem(): Promise<string> {
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', (await appKeyPair()).privateKey)) as ArrayBuffer,
  );
  const outer = derAt(pkcs8, 0);
  const version = derAt(pkcs8, outer.start);
  const algorithm = derAt(pkcs8, version.end);
  const key = derAt(pkcs8, algorithm.end);
  const base64 = btoa(String.fromCharCode(...pkcs8.slice(key.start, key.end)));
  return `-----BEGIN RSA PRIVATE KEY-----\n${base64.replace(/(.{64})/gu, '$1\n')}\n-----END RSA PRIVATE KEY-----\n`;
}

/** Whether `jwt` is a token an app signed with the stand-in's key, unexpired. */
async function signedByApp(jwt: string): Promise<boolean> {
  const [header, payload, signature] = jwt.split('.');
  if (!header || !payload || !signature) return false;
  const decode = (part: string) =>
    Uint8Array.from(atob(part.replace(/-/gu, '+').replace(/_/gu, '/')), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    (await appKeyPair()).publicKey,
    decode(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const claims = JSON.parse(new TextDecoder().decode(decode(payload))) as { exp?: number };
  return valid && typeof claims.exp === 'number' && claims.exp * 1000 > Date.now();
}

/** What the Worker asked the stand-in, for the test that is running. */
export interface GitHubCalls {
  /** Each token exchange's client id and secret, as `<id>:<secret>`. */
  readonly tokenClients: string[];
  /** Each manifest code the Worker converted. */
  readonly conversions: string[];
  /** The pull requests GitHub's API answers, by `owner/name#number`, which a test sets. */
  readonly pulls: Map<string, StandInPull>;
  /** Each installation an installation token was made for. */
  readonly installationTokens: number[];
  /** The repositories an installation reaches, by its id, which a test sets; without one, every repository of `pulls`. */
  readonly repositories: Map<number, string[]>;
  /** Each pull request the Worker read, as `owner/name#number`. */
  readonly pullReads: string[];
  /** The check runs of each commit, which a test sets; a commit not set has none. */
  readonly checkRuns: Map<string, StandInCheckRun[]>;
  /** Each commit whose check runs the Worker read. */
  readonly checkReads: string[];
  /** The commits whose check runs GitHub fails to answer, with a server error, which a test sets. */
  readonly checkOutages: Set<string>;
  /** The earlier commits in each commit's history, which a test sets; a commit not set has none GitHub compares it with. */
  readonly histories: Map<string, string[]>;
  /** Each request the Worker made to GitHub's API, as `<method> <path>`. */
  readonly apiRequests: string[];
}

/** A fetch body as text, in whichever form the library passed it. */
async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return new Response(body).text();
}

/** The client a token exchange names, in its body or in Basic authentication. */
function tokenClient(form: URLSearchParams, authorization: string | null): string {
  const basic = /^Basic (.+)$/iu.exec(authorization ?? '')?.[1];
  if (basic) return atob(basic);
  return `${form.get('client_id') ?? ''}:${form.get('client_secret') ?? ''}`;
}

/** Answers GitHub's token, user, email and manifest endpoints for every test in the file. */
export function standInForGitHub(): GitHubCalls {
  const calls = {
    tokenClients: [] as string[],
    conversions: [] as string[],
    pulls: new Map<string, StandInPull>(),
    installationTokens: [] as number[],
    repositories: new Map<number, string[]>(),
    pullReads: [] as string[],
    checkRuns: new Map<string, StandInCheckRun[]>(),
    checkReads: [] as string[],
    checkOutages: new Set<string>(),
    histories: new Map<string, string[]>(),
    apiRequests: [] as string[],
  };
  const appTokens = new Set<string>();
  beforeEach(() => {
    calls.tokenClients.length = 0;
    calls.conversions.length = 0;
    calls.pulls.clear();
    calls.installationTokens.length = 0;
    calls.repositories.clear();
    calls.pullReads.length = 0;
    calls.checkRuns.clear();
    calls.checkReads.length = 0;
    calls.checkOutages.clear();
    calls.histories.clear();
    calls.apiRequests.length = 0;
    appTokens.clear();
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === 'https://api.github.com') calls.apiRequests.push(`${request.method} ${url.pathname}`);
      if (url.href === 'https://github.com/login/oauth/access_token') {
        const form = new URLSearchParams(await bodyText(init?.body));
        const client = tokenClient(form, request.headers.get('authorization'));
        calls.tokenClients.push(client);
        const code = form.get('code') ?? '';
        const user = /^github-user-(\d+(?:\.[A-Za-z0-9-]+)?)$/u.exec(code)?.[1];
        if (!user) return Response.json({ error: 'bad_verification_code' });
        // A setup's GitHub App asks for no permission, so GitHub refuses its tokens the account's emails.
        if (client.startsWith(APP_CLIENT_PREFIX)) appTokens.add(`stand-in-token-${user}`);
        return Response.json({
          access_token: `stand-in-token-${user}`,
          token_type: 'bearer',
          scope: 'read:user,user:email',
        });
      }
      const conversion = /^https:\/\/api\.github\.com\/app-manifests\/([^/]+)\/conversions$/u.exec(url.href)?.[1];
      if (conversion !== undefined && request.method === 'POST') {
        calls.conversions.push(conversion);
        const owner = /^manifest-(\d+)$/u.exec(conversion)?.[1];
        if (!owner) return Response.json({ message: 'Not Found' }, { status: 404 });
        const app = convertedApp(Number(owner));
        return Response.json(
          {
            id: 9000 + Number(owner),
            slug: `ntasks-${owner}`,
            owner: { id: Number(owner), login: `person-${owner}`, type: 'User' },
            client_id: app.clientId,
            client_secret: app.clientSecret,
            webhook_secret: convertedWebhookSecret(Number(owner)),
            pem: await appKeyPem(),
            html_url: `https://github.com/apps/ntasks-${owner}`,
          },
          { status: 201 },
        );
      }
      const user = /^Bearer stand-in-token-(\d+)(?:\.([A-Za-z0-9-]+))?$/iu.exec(
        request.headers.get('authorization') ?? '',
      );
      const id = user?.[1];
      // An installation's record says whether it is on all of its account's repositories or on selected ones.
      const record = /^https:\/\/api\.github\.com\/app\/installations\/(\d+)$/u.exec(url.href)?.[1];
      if (record !== undefined && request.method === 'GET') {
        const jwt = /^Bearer (.+)$/u.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
        if (!(await signedByApp(jwt))) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        const selection = calls.repositories.has(Number(record)) ? 'selected' : 'all';
        return Response.json({ id: Number(record), repository_selection: selection });
      }
      const installation = /^https:\/\/api\.github\.com\/app\/installations\/(\d+)\/access_tokens$/u.exec(
        url.href,
      )?.[1];
      if (installation !== undefined && request.method === 'POST') {
        const jwt = /^Bearer (.+)$/u.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
        if (!(await signedByApp(jwt))) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        calls.installationTokens.push(Number(installation));
        return Response.json({ token: `installation-token-${installation}` }, { status: 201 });
      }
      const reading = /^Bearer installation-token-(\d+)$/u.exec(request.headers.get('authorization') ?? '')?.[1];
      if (url.origin + url.pathname === 'https://api.github.com/installation/repositories') {
        if (reading === undefined) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        const names = calls.repositories.get(Number(reading)) ?? [
          ...new Set([...calls.pulls.keys()].map((key) => key.slice(0, key.indexOf('#')))),
        ];
        const perPage = Number(url.searchParams.get('per_page') ?? '30');
        const page = Number(url.searchParams.get('page') ?? '1');
        return Response.json({
          total_count: names.length,
          repositories: names.slice((page - 1) * perPage, page * perPage).map((full_name) => ({ full_name })),
        });
      }
      const pull = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/u.exec(url.href);
      if (pull) {
        if (reading === undefined) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        calls.pullReads.push(`${pull[1]}#${pull[2]}`);
        const found = calls.pulls.get(`${pull[1]}#${pull[2]}`);
        if (!found) return Response.json({ message: 'Not Found' }, { status: 404 });
        return Response.json({
          number: Number(pull[2]),
          merged: found.merged,
          merge_commit_sha: found.mergeCommit,
          merged_at: found.mergedAt ?? null,
          base: { ref: found.base, repo: { full_name: pull[1], default_branch: 'main' } },
        });
      }
      // GitHub's GraphQL API, for the one query the Worker sends: a commit's passing check runs, by check suite.
      if (url.href === 'https://api.github.com/graphql' && request.method === 'POST') {
        if (reading === undefined) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        const { variables } = (await request.json()) as { variables: { commit: string } };
        calls.checkReads.push(variables.commit);
        if (calls.checkOutages.has(variables.commit)) return new Response('Bad gateway', { status: 502 });
        const suites = new Map<string, StandInCheckRun[]>();
        for (const run of calls.checkRuns.get(variables.commit) ?? []) {
          const branch = run.branch ?? 'main';
          suites.set(branch, [...(suites.get(branch) ?? []), run]);
        }
        return Response.json({
          data: {
            repository: {
              defaultBranchRef: { name: 'main' },
              object: {
                checkSuites: {
                  nodes: [...suites].map(([branch, runs]) => ({
                    branch: { name: branch },
                    checkRuns: {
                      nodes: runs
                        .filter((run) => run.conclusion === 'success')
                        .map((run) => ({ name: run.name, startedAt: run.startedAt, completedAt: run.completedAt })),
                    },
                  })),
                },
              },
            },
          },
        });
      }
      // GitHub's comparison of base...head: whether head is ahead of base, behind it, the same commit, or neither.
      const compare = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/u.exec(
        url.origin + url.pathname,
      );
      if (compare) {
        if (reading === undefined) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        const [, base = '', head = ''] = compare;
        const status =
          base === head
            ? 'identical'
            : calls.histories.get(base)?.includes(head)
              ? 'behind'
              : calls.histories.get(head)?.includes(base)
                ? 'ahead'
                : 'diverged';
        return Response.json({ status, commits: [], files: [] });
      }
      if (url.href === 'https://api.github.com/user') {
        if (!id) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        return Response.json({
          id: Number(id),
          login: user?.[2] ?? `person-${id}`,
          name: `Person ${id}`,
          email: null,
          avatar_url: null,
        });
      }
      if (url.href === 'https://api.github.com/user/emails') {
        if (!id) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        const token = /^Bearer (.+)$/iu.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
        if (appTokens.has(token))
          return Response.json({ message: 'Resource not accessible by integration' }, { status: 403 });
        return Response.json([{ email: `person-${id}@example.com`, primary: true, verified: true }]);
      }
      return original(input, init);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return calls;
}
