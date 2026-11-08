import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { signInSecrets, storeGitHubApp } from '../../src/access/config.ts';
import { handleAccess } from '../../src/access/routes.ts';
import { startSetupState } from '../../src/access/setup.ts';
import { Browser, freshAddress, locationOf, ORIGIN } from './client.ts';
import { codeFor, convertedApp, GITHUB_AUTHORIZE, manifestCodeFor, standInForGitHub } from './github.ts';

const calls = standInForGitHub();

const SECRET = 'test-only-auth-secret-0123456789abcdef';
const ROTATED_SECRET = 'test-only-rotated-auth-secret-fedcba9876543210';
const SETUP_COOKIE = '__Host-ntasks.setup';

/** A deployment that sets only AUTH_SECRET, as the Deploy to Cloudflare button makes one. */
function onlyAuthSecret(secret = SECRET): Env {
  return {
    ...env,
    AUTH_SECRET: secret,
    NTASKS_ORIGIN: undefined,
    GITHUB_CLIENT_ID: undefined,
    GITHUB_CLIENT_SECRET: undefined,
    OWNER_GITHUB_IDS: undefined,
  } as Env;
}

afterEach(async () => {
  await env.DB.prepare('DELETE FROM access_github_app').run();
});

async function storedApps(): Promise<{ origin: string; credentials: string }[]> {
  const rows = await env.DB.prepare('SELECT origin, credentials FROM access_github_app').all<{
    origin: string;
    credentials: string;
  }>();
  return rows.results;
}

async function recordedAdmins(): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT admin_github_id FROM access_github_app').all<{
    admin_github_id: string;
  }>();
  return rows.results.map((row) => row.admin_github_id);
}

function unescape(html: string): string {
  return html.replace(/&#(\d+);/gu, (_, code: string) => String.fromCharCode(Number(code)));
}

/** Submits the setup page with `secret`, and reads the form it answers with: where it posts and the manifest. */
async function startSetup(
  browser: Browser,
  secret = SECRET,
): Promise<{ readonly state: string; readonly action: URL; readonly manifest: Record<string, unknown> }> {
  const response = await browser.fetch('/sign-in', { form: { action: 'setup', auth_secret: secret } });
  expect(response.status).toBe(200);
  const html = await response.text();
  const action = new URL(unescape(/<form method="post" action="([^"]+)"/u.exec(html)?.[1] ?? ''));
  const manifest = JSON.parse(unescape(/name="manifest" value="([^"]*)"/u.exec(html)?.[1] ?? '')) as Record<
    string,
    unknown
  >;
  return { state: action.searchParams.get('state') ?? '', action, manifest };
}

/** GitHub's return to the deployment once the GitHub user `ownerId` created the app. */
function returnFromGitHub(browser: Browser, state: string, ownerId: number): Promise<Response> {
  return browser.fetch(`/sign-in?code=${manifestCodeFor(ownerId)}&state=${encodeURIComponent(state)}`);
}

/** The whole setup in a new browser, ending on GitHub's authorize page for the new app. */
async function setUp(ownerId: number, bindings = onlyAuthSecret(), secret = SECRET): Promise<Browser> {
  const browser = new Browser({ bindings, joinTestWorkspace: false });
  const { state } = await startSetup(browser, secret);
  const github = locationOf(await returnFromGitHub(browser, state, ownerId));
  expect(github.searchParams.get('client_id')).toBe(convertedApp(ownerId).clientId);
  return browser;
}

/** Signs `githubId` in from the sign-in page, and returns where the Worker sends the browser afterwards. */
async function signIn(browser: Browser, githubId: number): Promise<URL> {
  const github = locationOf(await browser.fetch('/sign-in', { form: { action: 'github' } }));
  const state = github.searchParams.get('state') ?? '';
  return locationOf(
    await browser.fetch(`/api/auth/callback/github?code=${codeFor(githubId)}&state=${encodeURIComponent(state)}`),
  );
}

describe('a deployment with only AUTH_SECRET', () => {
  it('shows the setup page at /sign-in, and signs nobody in until it runs', async () => {
    const browser = new Browser({ bindings: onlyAuthSecret() });

    const page = await browser.fetch('/sign-in');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('name="auth_secret"');
    expect(html).not.toContain('value="github"');
    const me = await browser.fetch('/api/access/me');
    expect(me.status).toBe(503);
    expect(await me.json()).toMatchObject({ error: 'sign_in_not_configured' });
    expect((await browser.fetch('/.well-known/oauth-protected-resource/api/mcp')).status).toBe(503);
  });

  it('refuses a wrong AUTH_SECRET, and starts no setup', async () => {
    const browser = new Browser({ bindings: onlyAuthSecret() });

    const refused = await browser.fetch('/sign-in', {
      form: { action: 'setup', auth_secret: 'not-this-deployment-secret-0123456789' },
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain('name="manifest"');
    expect(browser.cookie(SETUP_COOKIE)).toBeUndefined();
  });

  it('refuses a setup posted from another site', async () => {
    const browser = new Browser({ bindings: onlyAuthSecret() });
    const crossSite = await browser.fetch('/sign-in', {
      form: { action: 'setup', auth_secret: SECRET },
      origin: 'https://elsewhere.example.com',
    });
    expect(crossSite.status).toBe(403);
    expect(browser.cookie(SETUP_COOKIE)).toBeUndefined();
  });

  it('never shows the setup page over http at an address that is not local, and sends each step to https', async () => {
    const overHttp = (init: RequestInit = {}) =>
      handleAccess(
        new Request('http://ntasks.example.com/sign-in', {
          ...init,
          headers: { ...init.headers, origin: 'http://ntasks.example.com', 'cf-connecting-ip': freshAddress() },
        }),
        onlyAuthSecret(),
      );

    const page = await overHttp();
    const posted = await overHttp({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'setup', auth_secret: SECRET }).toString(),
    });
    for (const response of [page, posted]) {
      expect(response?.status).toBe(303);
      expect(response?.headers.get('location')).toBe('https://ntasks.example.com/sign-in');
      expect(response?.headers.get('set-cookie')).toBeNull();
      expect(await response?.text()).not.toContain('name="auth_secret"');
    }
  });

  it('registers an app for this origin, stores it encrypted, and signs its owner in through it as admin', async () => {
    const browser = new Browser({ bindings: onlyAuthSecret(), joinTestWorkspace: false });

    const { state, action, manifest } = await startSetup(browser);
    expect(`${action.origin}${action.pathname}`).toBe('https://github.com/settings/apps/new');
    expect(manifest).toMatchObject({
      url: ORIGIN,
      redirect_url: `${ORIGIN}/sign-in`,
      callback_urls: [`${ORIGIN}/api/auth/callback/github`],
      public: true,
    });
    expect(manifest.default_permissions).toEqual({ emails: 'read' });
    expect(browser.cookie(SETUP_COOKIE)).toBeDefined();

    const github = locationOf(await returnFromGitHub(browser, state, 5005));
    const app = convertedApp(5005);
    expect(`${github.origin}${github.pathname}`).toBe(GITHUB_AUTHORIZE);
    expect(github.searchParams.get('client_id')).toBe(app.clientId);
    expect(github.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/github`);
    expect(browser.cookie(SETUP_COOKIE)).toBeUndefined();
    expect(calls.conversions).toEqual([manifestCodeFor(5005)]);

    const [stored, ...others] = await storedApps();
    expect(others).toEqual([]);
    expect(stored?.origin).toBe(ORIGIN);
    expect(stored?.credentials).not.toContain(app.clientSecret);
    expect(stored?.credentials).not.toContain(app.clientId);
    expect(await recordedAdmins()).toEqual(['5005']);

    const back = await browser.fetch(
      `/api/auth/callback/github?code=${codeFor(5005)}&state=${encodeURIComponent(github.searchParams.get('state') ?? '')}`,
    );
    expect(locationOf(back).pathname).toBe('/');
    expect(calls.tokenClients).toEqual([`${app.clientId}:${app.clientSecret}`]);
    expect(await (await browser.me()).json()).toMatchObject({ kind: 'person', deploymentAdmin: true });
  });

  it('refuses to run again once sign-in exists, and keeps the stored app', async () => {
    const bindings = onlyAuthSecret();
    const first = new Browser({ bindings, joinTestWorkspace: false });
    const { state } = await startSetup(first);
    expect(locationOf(await returnFromGitHub(first, state, 5006)).origin).toBe('https://github.com');
    const before = await storedApps();

    const second = new Browser({ bindings });
    expect(await (await second.fetch('/sign-in')).text()).toContain('value="github"');
    const again = await second.fetch('/sign-in', { form: { action: 'setup', auth_secret: SECRET } });
    expect(again.status).toBe(409);
    expect(await again.text()).not.toContain('name="manifest"');
    expect((await returnFromGitHub(first, state, 5007)).status).toBe(409);

    expect(await storedApps()).toEqual(before);
    expect(await recordedAdmins()).toEqual(['5006']);
    expect(calls.conversions).toEqual([manifestCodeFor(5006)]);
  });

  it('refuses a state from another browser, a forged one, a used one and an expired one, asking GitHub nothing', async () => {
    const bindings = onlyAuthSecret();
    const started = new Browser({ bindings });
    const { state } = await startSetup(started);

    // Another browser, even one with a setup of its own, cannot finish this one.
    expect((await returnFromGitHub(new Browser({ bindings }), state, 5008)).status).toBe(400);
    const other = new Browser({ bindings });
    await startSetup(other);
    expect((await returnFromGitHub(other, state, 5008)).status).toBe(400);
    const [expires, signature] = state.split('.');
    expect((await returnFromGitHub(started, `${Number(expires) + 3600}.${signature}`, 5008)).status).toBe(400);
    // That answer ended this browser's setup, so its real state no longer works.
    expect((await returnFromGitHub(started, state, 5008)).status).toBe(400);

    const late = new Browser({ bindings });
    const expired = await startSetupState(SECRET, ORIGIN, Date.now() - 11 * 60_000);
    late.setCookie(SETUP_COOKIE, /=([^;]*)/u.exec(expired.cookie)?.[1] ?? '');
    expect((await returnFromGitHub(late, expired.state, 5008)).status).toBe(400);

    expect(calls.conversions).toEqual([]);
    expect(await storedApps()).toEqual([]);
    expect(await recordedAdmins()).toEqual([]);
  });

  it('stores one app, and records one admin, when two setups finish at once', async () => {
    const secrets = signInSecrets(onlyAuthSecret());
    if (!secrets) throw new Error('AUTH_SECRET alone is a valid setting');
    const store = (ownerId: number) =>
      storeGitHubApp(
        env.DB,
        secrets,
        { origin: ORIGIN, github: convertedApp(ownerId), adminGithubId: String(ownerId) },
        null,
      );

    const results = await Promise.all([store(5009), store(5010)]);
    expect([...results].sort()).toEqual([false, true]);
    const winner = results[0] ? '5009' : '5010';
    expect(await storedApps()).toHaveLength(1);
    expect(await recordedAdmins()).toEqual([winner]);
  });

  it('shows the setup page again after AUTH_SECRET changes, behind the new one, and its run replaces the admin', async () => {
    await setUp(5011);
    const rotated = onlyAuthSecret(ROTATED_SECRET);
    const browser = new Browser({ bindings: rotated, joinTestWorkspace: false });

    expect(await (await browser.fetch('/sign-in')).text()).toContain('name="auth_secret"');
    expect((await browser.fetch('/sign-in', { form: { action: 'github' } })).status).toBe(503);
    const oldSecret = await browser.fetch('/sign-in', { form: { action: 'setup', auth_secret: SECRET } });
    expect(oldSecret.status).toBe(403);
    expect(await recordedAdmins()).toEqual(['5011']);

    await setUp(5012, rotated, ROTATED_SECRET);
    expect(await storedApps()).toHaveLength(1);
    expect(await recordedAdmins()).toEqual(['5012']);
    const earlierAdmin = new Browser({ bindings: rotated, joinTestWorkspace: false });
    const refused = await signIn(earlierAdmin, 5011);
    expect(refused.pathname).toBe('/sign-in');
    expect(refused.searchParams.get('error')).toBe('not_invited');
    const newAdmin = new Browser({ bindings: rotated, joinTestWorkspace: false });
    expect((await signIn(newAdmin, 5012)).pathname).toBe('/');
    expect(await (await newAdmin.me()).json()).toMatchObject({ deploymentAdmin: true });
  });
});

describe('a deployment that sets the GitHub secrets', () => {
  it('signs in through the app the secrets name, whatever app is stored, and refuses the setup', async () => {
    await setUp(5013);
    const browser = new Browser();

    const github = locationOf(await browser.fetch('/sign-in', { form: { action: 'github' } }));
    expect(github.searchParams.get('client_id')).toBe('test-github-client-id');
    const setup = await browser.fetch('/sign-in', { form: { action: 'setup', auth_secret: SECRET } });
    expect(setup.status).toBe(409);
  });
});
