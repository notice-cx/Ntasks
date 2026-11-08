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

/** What the Worker asked the stand-in, for the test that is running. */
export interface GitHubCalls {
  /** Each token exchange's client id and secret, as `<id>:<secret>`. */
  readonly tokenClients: string[];
  /** Each manifest code the Worker converted. */
  readonly conversions: string[];
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
  const calls = { tokenClients: [] as string[], conversions: [] as string[] };
  const appTokens = new Set<string>();
  beforeEach(() => {
    calls.tokenClients.length = 0;
    calls.conversions.length = 0;
    appTokens.clear();
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
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
            webhook_secret: null,
            pem: '-----BEGIN RSA PRIVATE KEY-----\nstand-in\n-----END RSA PRIVATE KEY-----\n',
            html_url: `https://github.com/apps/ntasks-${owner}`,
          },
          { status: 201 },
        );
      }
      const user = /^Bearer stand-in-token-(\d+)(?:\.([A-Za-z0-9-]+))?$/iu.exec(
        request.headers.get('authorization') ?? '',
      );
      const id = user?.[1];
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
