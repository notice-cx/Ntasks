/**
 * The calls Ntasks makes to GitHub's REST API as a workspace's GitHub App
 * (github-app.ts): a JSON Web Token signed with the app's private key
 * (docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
 * exchanged for an installation's token, which reads a pull request. GitHub
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

/** The most pages of an installation's repositories read, 100 to a page. */
const REPOSITORY_PAGES = 2;

/**
 * The repositories an installation reaches, as lowercase `owner/name`, read
 * with its token; null when GitHub does not answer, or the installation
 * reaches more than REPOSITORY_PAGES pages of them, and so cannot be listed
 * cheaply. Each page is one request.
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
  return { repositories: null, requests: REPOSITORY_PAGES };
}

/** A pull request as GitHub answers it: whether it merged, its merge commit, and the branch it merged into and the repository's default one. */
export interface PullRequestState {
  readonly merged: boolean;
  readonly mergeCommit: string | null;
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
    base: typeof base.ref === 'string' ? base.ref : null,
    defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : null,
  };
}
