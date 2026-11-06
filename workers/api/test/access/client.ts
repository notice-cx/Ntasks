// Drives the Worker the way a browser and an MCP client do: a browser keeps
// cookies and submits forms; an MCP client registers, sends the person
// through authorization and exchanges the code for tokens.
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { codeFor, GITHUB_AUTHORIZE } from './github.ts';

export const ORIGIN = 'https://ntasks.test';
export const MCP_RESOURCE = `${ORIGIN}/api/mcp`;
export const REDIRECT_URI = 'http://127.0.0.1:43110/callback';
export const OWNER_GITHUB_ID = 1001;

const worker = exports.default;

/** A client address the sign-in rate limit has not seen, so tests do not share a budget. */
export function freshAddress(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return `198.51.${bytes[0]}.${bytes[1]}`;
}

/** Calls the Worker as a client at `address`, without following redirects. */
export function call(path: string, init: RequestInit = {}, address = freshAddress()): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', address);
  return worker.fetch(new Request(new URL(path, ORIGIN), { ...init, headers, redirect: 'manual' }));
}

/** Where a redirect goes, as a URL. */
export function locationOf(response: Response): URL {
  expect([302, 303, 307]).toContain(response.status);
  const location = response.headers.get('location');
  expect(location).not.toBeNull();
  return new URL(location ?? '', ORIGIN);
}

export class Browser {
  readonly address = freshAddress();
  private readonly cookies = new Map<string, string>();

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  /** Sends JSON from a script on this origin, as the web app does. */
  fetchJson(path: string, body: unknown): Promise<Response> {
    return this.fetch(path, { method: 'POST', json: body });
  }

  /** Loads a page or submits a form, as a browser on this origin does. */
  async fetch(
    path: string,
    init: { method?: string; form?: Record<string, string | string[]>; json?: unknown; origin?: string } = {},
  ): Promise<Response> {
    const method = init.method ?? (init.form ? 'POST' : 'GET');
    const headers = new Headers({ accept: 'text/html', 'sec-fetch-mode': 'navigate' });
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    let body: string | undefined;
    if (method !== 'GET') headers.set('origin', init.origin ?? ORIGIN);
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers.set('content-type', 'application/json');
      headers.set('accept', 'application/json');
      headers.set('sec-fetch-mode', 'cors');
    }
    if (init.form) {
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(init.form)) {
        for (const item of Array.isArray(value) ? value : [value]) form.append(name, item);
      }
      body = form.toString();
      headers.set('content-type', 'application/x-www-form-urlencoded');
    }
    const response = await call(path, { method, headers, body }, this.address);
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = value === '' || attributes.some((attribute) => /^\s*max-age=0\s*$/iu.test(attribute));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  /**
   * Signs in with GitHub as the given GitHub user, from the sign-in page,
   * and returns where the Worker sends the browser afterwards.
   */
  async signInWithGitHub(githubId: number, oauthQuery?: string): Promise<URL> {
    const started = await this.fetch('/sign-in', {
      form: { action: 'github', ...(oauthQuery === undefined ? {} : { oauth_query: oauthQuery }) },
    });
    const github = locationOf(started);
    expect(`${github.origin}${github.pathname}`).toBe(GITHUB_AUTHORIZE);
    expect(github.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/github`);
    const state = github.searchParams.get('state') ?? '';
    const back = await this.fetch(
      `/api/auth/callback/github?code=${codeFor(githubId)}&state=${encodeURIComponent(state)}`,
    );
    return locationOf(back);
  }

  /** Signs in as the allowlisted owner. */
  async signInAsOwner(): Promise<void> {
    const next = await this.signInWithGitHub(OWNER_GITHUB_ID);
    expect(next.pathname).toBe('/');
  }

  /** GET /api/access/me with this browser's cookies. */
  async me(): Promise<Response> {
    return this.fetch('/api/access/me', { method: 'GET' });
  }
}

/** Adds a project straight to the task store, as the engine would. */
export async function createProject(name = 'Example'): Promise<string> {
  const id = crypto.randomUUID();
  const suffix = id.replace(/-/gu, '').slice(0, 8);
  await env.DB.prepare('INSERT INTO projects (id, key, name, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, `${name.toLowerCase()}-${suffix}.example.com`, name, `p${suffix}`, new Date().toISOString())
    .run();
  return id;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
  return { verifier, challenge };
}

export interface Tokens {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly scope: string;
  readonly expires_in: number;
}

/** An MCP client: it registers itself, then gets tokens through a person's browser. */
export class McpClient {
  readonly address = freshAddress();
  clientId = '';

  async register(name = 'Example Agent', scope = 'tasks:read tasks:write offline_access'): Promise<void> {
    const response = await call(
      '/api/auth/oauth2/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: name,
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope,
        }),
      },
      this.address,
    );
    expect(response.status).toBe(201);
    const body = await response.json<{ client_id: string }>();
    this.clientId = body.client_id;
  }

  /**
   * Sends the browser to authorize with the given scopes and returns the
   * page it lands on, with the PKCE verifier for the token exchange.
   */
  async authorize(browser: Browser, scope: string): Promise<{ landing: URL; verifier: string }> {
    const { verifier, challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: REDIRECT_URI,
      scope,
      state: 'client-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: MCP_RESOURCE,
    });
    const response = await browser.fetch(`/api/auth/oauth2/authorize?${query}`);
    return { landing: locationOf(response), verifier };
  }

  async token(form: Record<string, string>): Promise<Response> {
    return call(
      '/api/auth/oauth2/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: this.clientId, ...form }).toString(),
      },
      this.address,
    );
  }

  async exchange(code: string, verifier: string): Promise<Tokens> {
    const response = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: MCP_RESOURCE,
    });
    expect(response.status).toBe(200);
    return response.json<Tokens>();
  }

  async refresh(refreshToken: string): Promise<Response> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken, resource: MCP_RESOURCE });
  }
}

/**
 * The whole connection: register, authorize through the owner's signed-in
 * browser, allow the given projects, and exchange the code for tokens.
 */
export async function connectAgent(
  browser: Browser,
  projects: readonly string[],
  scope = 'tasks:read tasks:write offline_access',
): Promise<{ client: McpClient; tokens: Tokens }> {
  const client = new McpClient();
  await client.register();
  const { landing, verifier } = await client.authorize(browser, scope);
  expect(landing.pathname).toBe('/agent-access');
  const approved = await browser.fetch('/agent-access', {
    form: { oauth_query: landing.search.slice(1), decision: 'allow', project: [...projects] },
  });
  const back = locationOf(approved);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  expect(back.searchParams.get('state')).toBe('client-state');
  const code = back.searchParams.get('code') ?? '';
  return { client, tokens: await client.exchange(code, verifier) };
}

/** Calls GET /api/access/me with a bearer token. */
export function meWithToken(token: string): Promise<Response> {
  return call('/api/access/me', { headers: { authorization: `Bearer ${token}` } });
}
