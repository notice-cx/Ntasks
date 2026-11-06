// A stand-in for GitHub's OAuth endpoints, so sign-in runs end to end with
// no network. Better Auth calls GitHub through globalThis.fetch, which tests
// share with the Worker. An authorization code `github-user-<id>` signs in
// as the GitHub user with that numeric id.
import { afterEach, beforeEach, vi } from 'vitest';

export const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';

export function codeFor(githubId: number): string {
  return `github-user-${githubId}`;
}

async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return new Response(body).text();
}

/** Answers GitHub's token, user and email endpoints for every test in the file. */
export function standInForGitHub(): void {
  beforeEach(() => {
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.href === 'https://github.com/login/oauth/access_token') {
        const code = new URLSearchParams(await bodyText(init?.body)).get('code') ?? '';
        const id = /^github-user-(\d+)$/u.exec(code)?.[1];
        if (!id) return Response.json({ error: 'bad_verification_code' });
        return Response.json({ access_token: `stand-in-token-${id}`, token_type: 'bearer', scope: 'read:user,user:email' });
      }
      const id = /^Bearer stand-in-token-(\d+)$/iu.exec(request.headers.get('authorization') ?? '')?.[1];
      if (url.href === 'https://api.github.com/user') {
        if (!id) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        return Response.json({ id: Number(id), login: `person-${id}`, name: `Person ${id}`, email: null, avatar_url: null });
      }
      if (url.href === 'https://api.github.com/user/emails') {
        if (!id) return Response.json({ message: 'Bad credentials' }, { status: 401 });
        return Response.json([{ email: `person-${id}@example.com`, primary: true, verified: true }]);
      }
      return original(input, init);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}
