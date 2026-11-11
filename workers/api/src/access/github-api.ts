/**
 * The calls Ntasks makes to GitHub's API as a workspace's GitHub App
 * (github-app.ts): a JSON Web Token signed with the app's private key
 * (docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
 * exchanged for an installation's token, which reads a pull request and
 * whether one commit is in another's history from the REST API, and a
 * commit's passing check runs from the GraphQL API. GitHub
 * hands the key over in PKCS #1 PEM, which Web Crypto does not import, so it
 * is wrapped as PKCS #8 first.
 */
import { base64url } from './crypto.ts';

const API = 'https://api.github.com';
const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'Ntasks',
  'x-github-api-version': '2022-11-28',
};

const encoder = new TextEncoder();

/** A DER length: short form below 128, long form above. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return new Uint8Array([tag, ...derLength(content.length), ...content]);
}

/** PrivateKeyInfo's version 0 and the rsaEncryption algorithm (RFC 8017 appendix A.1, RFC 5208). */
const RSA_KEY_INFO_HEAD = new Uint8Array([
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** The DER of a PEM key, as PKCS #8: an `RSA PRIVATE KEY` (PKCS #1) wrapped, a `PRIVATE KEY` as it is. Null for anything else. */
export function pkcs8Of(pem: string): Uint8Array | null {
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END (RSA )?PRIVATE KEY-----/u.exec(pem);
  if (match === null || match[1] !== match[3]) return null;
  let body: Uint8Array;
  try {
    body = Uint8Array.from(atob(match[2]!.replace(/\s+/gu, '')), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  if (match[1] === undefined) return body;
  return der(0x30, new Uint8Array([...RSA_KEY_INFO_HEAD, ...der(0x04, body)]));
}

/** A JSON Web Token for the app `appId`, signed with its key: GitHub accepts one for up to 10 minutes. */
export async function appToken(appId: number, privateKey: string, now = Date.now()): Promise<string | null> {
  const pkcs8 = pkcs8Of(privateKey);
  if (pkcs8 === null) return null;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
      'sign',
    ]);
  } catch {
    return null;
  }
  const seconds = Math.floor(now / 1000);
  // Issued a minute early, since GitHub's clock may be behind this one.
  const part = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
  const signed = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: seconds - 60, exp: seconds + 540, iss: String(appId) })}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signed)));
  return `${signed}.${base64url(signature)}`;
}

/** An installation's token, which reads what the installation reaches for an hour; null when GitHub gives none. */
export async function installationToken(appJwt: string, installationId: number): Promise<string | null> {
  const response = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...HEADERS, authorization: `Bearer ${appJwt}` },
  }).catch(() => null);
  if (response === null) return null;
  if (response.status !== 201) {
    await response.body?.cancel();
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  const token = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).token : undefined;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Whether an installation is on all of its account's repositories or on
 * selected ones, from its record (`GET /app/installations/{id}`, read with
 * the app's token), which always carries it; null when GitHub does not
 * answer.
 */
export async function installationSelection(
  appJwt: string,
  installationId: number,
): Promise<'all' | 'selected' | null> {
  const response = await fetch(`${API}/app/installations/${installationId}`, {
    headers: { ...HEADERS, authorization: `Bearer ${appJwt}` },
  }).catch(() => null);
  if (response === null) return null;
  if (response.status !== 200) {
    await response.body?.cancel();
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  const selection =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>).repository_selection : null;
  return selection === 'all' || selection === 'selected' ? selection : null;
}

/** The most pages of an installation's repositories read, 100 to a page. */
export const REPOSITORY_PAGES = 2;

/**
 * The selected repositories an installation reaches, read with its token, as
 * lowercase `owner/name`: up to REPOSITORY_PAGES pages of them, or null when
 * GitHub does not answer. Each page is one request.
 */
export async function installationRepositories(token: string): Promise<{
  readonly repositories: ReadonlySet<string> | null;
  readonly requests: number;
}> {
  const repositories = new Set<string>();
  for (let page = 1; page <= REPOSITORY_PAGES; page += 1) {
    const response = await fetch(`${API}/installation/repositories?per_page=100&page=${page}`, {
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (response === null) return { repositories: null, requests: page };
    if (response.status !== 200) {
      await response.body?.cancel();
      return { repositories: null, requests: page };
    }
    const body: unknown = await response.json().catch(() => null);
    const listed = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const total = typeof listed.total_count === 'number' ? listed.total_count : 0;
    for (const repository of Array.isArray(listed.repositories) ? listed.repositories : []) {
      const name =
        repository !== null && typeof repository === 'object'
          ? (repository as Record<string, unknown>).full_name
          : undefined;
      if (typeof name === 'string') repositories.add(name.toLowerCase());
    }
    if (repositories.size >= total) return { repositories, requests: page };
  }
  // More selected repositories than the pages read: the ones listed are the ones asked about.
  return { repositories, requests: REPOSITORY_PAGES };
}

/** A pull request as GitHub answers it: whether it merged, its merge commit, and the branch it merged into and the repository's default one. */
export interface PullRequestState {
  readonly merged: boolean;
  readonly mergeCommit: string | null;
  /** When GitHub merged it, as ISO 8601 text, or null. */
  readonly mergedAt: string | null;
  readonly base: string | null;
  readonly defaultBranch: string | null;
}

/** The pull request `number` of `repository` (owner/name), read with an installation's token; null when GitHub does not answer it. */
export async function pullRequestState(
  token: string,
  repository: string,
  number: number,
): Promise<PullRequestState | null> {
  const response = await fetch(`${API}/repos/${repository}/pulls/${number}`, {
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (response === null) return null;
  if (response.status !== 200) {
    await response.body?.cancel();
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== 'object') return null;
  const pull = body as Record<string, unknown>;
  const base = pull.base !== null && typeof pull.base === 'object' ? (pull.base as Record<string, unknown>) : {};
  const repo = base.repo !== null && typeof base.repo === 'object' ? (base.repo as Record<string, unknown>) : {};
  return {
    merged: pull.merged === true,
    mergeCommit: typeof pull.merge_commit_sha === 'string' ? pull.merge_commit_sha : null,
    mergedAt: typeof pull.merged_at === 'string' ? pull.merged_at : null,
    base: typeof base.ref === 'string' ? base.ref : null,
    defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
  };
}

/** A time GitHub gives, as UTC ISO 8601 text, or null when it gives none that reads as one. */
function timeOf(value: unknown): string | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** What a read answers when GitHub did not answer it this time and may on another try: no response, a server error or too many requests. */
export const RETRY = 'retry';

/** Whether a read GitHub did not answer with 200 may be answered on another try. */
function retryable(response: Response | null): boolean {
  return response === null || response.status === 429 || response.status >= 500;
}

/** The value at `path` in an answer, or undefined when any step of it is missing. */
function at(value: unknown, ...path: readonly string[]): unknown {
  let found = value;
  for (const key of path) {
    if (found === null || typeof found !== 'object' || Array.isArray(found)) return undefined;
    found = (found as Record<string, unknown>)[key];
  }
  return found;
}

/** A check run of a commit: its name, the branch of its check suite, when it started and completed, and how it ended. */
export interface CheckRun {
  /** GitHub's id of the run, as a check_run event names it; null when GitHub gives none. */
  readonly id: number | null;
  readonly name: string;
  /** The branch GitHub ran its check suite for, or null when it names none. */
  readonly branch: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** GitHub's conclusion in lowercase, such as success or failure; null while the run is queued or running. */
  readonly conclusion: string | null;
}

/** The check runs of a commit, and its repository's default branch, which tells a deploy from a preview. */
export interface CommitChecks {
  readonly defaultBranch: string;
  readonly runs: readonly CheckRun[];
}

/** The most check suites of a commit read, and the most runs of each, in one request. */
const CHECK_SUITES = 50;
const CHECK_RUNS = 50;

// The REST API names a check run's suite by its id alone; the GraphQL API
// gives the suite's branch with its runs, so one request answers all of it.
const COMMIT_CHECKS = `query ($owner: String!, $name: String!, $commit: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    object(expression: $commit) {
      ... on Commit {
        checkSuites(last: ${CHECK_SUITES}) {
          nodes {
            branch { name }
            checkRuns(last: ${CHECK_RUNS}, filterBy: { checkType: ALL }) {
              nodes { databaseId name startedAt completedAt conclusion }
            }
          }
        }
      }
    }
  }
}`;

/**
 * The check runs of `commit` in `repository`, finished or not, up to
 * CHECK_RUNS in each of up to CHECK_SUITES check suites, with the branch of
 * each run's suite and the repository's default branch, read with an
 * installation's token in one request; RETRY when GitHub may answer on
 * another try, and null when it does not answer.
 */
export async function checksOf(
  token: string,
  repository: string,
  commit: string,
): Promise<CommitChecks | typeof RETRY | null> {
  const [owner = '', name = ''] = repository.split('/');
  const response = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {
      'user-agent': HEADERS['user-agent'],
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: COMMIT_CHECKS, variables: { owner, name, commit } }),
  }).catch(() => null);
  if (response?.status !== 200) {
    await response?.body?.cancel();
    // GraphQL answers a repository the token does not reach with 200 and an
    // error, so its 403 is a rate limit, which GitHub may send without a
    // header that says so.
    return retryable(response) || response?.status === 403 ? RETRY : null;
  }
  const body: unknown = await response.json().catch(() => null);
  // GraphQL answers with 200 and errors: a rate limit as an error of type
  // RATE_LIMITED, and a part it could not read as null beside an error, so an
  // answer with any other error lacks runs, and one still running would read
  // as none.
  const errors = at(body, 'errors');
  if (Array.isArray(errors) && errors.length > 0)
    return errors.some((error) => at(error, 'type') === 'RATE_LIMITED') ? RETRY : null;
  const defaultBranch = at(body, 'data', 'repository', 'defaultBranchRef', 'name');
  if (typeof defaultBranch !== 'string') return null;
  const suites = at(body, 'data', 'repository', 'object', 'checkSuites', 'nodes');
  if (!Array.isArray(suites) || !suites.every((suite: unknown) => Array.isArray(at(suite, 'checkRuns', 'nodes'))))
    return null;
  const runs = suites.flatMap((suite: unknown) => {
    const branch = at(suite, 'branch', 'name');
    const nodes = at(suite, 'checkRuns', 'nodes') as unknown[];
    return nodes.flatMap((run: unknown): CheckRun[] => {
      const runName = at(run, 'name');
      if (typeof runName !== 'string') return [];
      const conclusion = at(run, 'conclusion');
      const id = at(run, 'databaseId');
      return [
        {
          id: typeof id === 'number' && Number.isSafeInteger(id) ? id : null,
          name: runName,
          branch: typeof branch === 'string' ? branch : null,
          startedAt: timeOf(at(run, 'startedAt')),
          completedAt: timeOf(at(run, 'completedAt')),
          conclusion: typeof conclusion === 'string' ? conclusion.toLowerCase() : null,
        },
      ];
    });
  });
  return { defaultBranch, runs };
}

/**
 * Whether `commit` is in the history of `head` in `repository`, read with an
 * installation's token in one request; RETRY when GitHub may answer on
 * another try, and null when it does not answer. GitHub compares
 * `head...commit`: `behind` or `identical` when it is.
 */
export async function inHistoryOf(
  token: string,
  repository: string,
  head: string,
  commit: string,
): Promise<boolean | typeof RETRY | null> {
  // Compared this way round, the answer lists only what `commit` adds after
  // the two commits' merge base, which is nothing when it is in head's
  // history, so the answer stays small however far apart they are.
  const response = await fetch(`${API}/repos/${repository}/compare/${head}...${commit}?per_page=1`, {
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (response?.status !== 200) {
    await response?.body?.cancel();
    return retryable(response) ? RETRY : null;
  }
  const body: unknown = await response.json().catch(() => null);
  const status = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).status : null;
  if (typeof status !== 'string') return null;
  return status === 'behind' || status === 'identical';
}
