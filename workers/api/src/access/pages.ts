/**
 * The pages the Worker serves itself: setting sign-in up, signing in,
 * approving an AI agent, and a link that expired. They are plain HTML forms
 * with no script, so they work before the web app loads and hold nothing an
 * agent could read; the one exception is the step that sends the setup's
 * manifest to GitHub, which submits its own form with one inline script and
 * shows its button when scripts are off. They draw in the design system's
 * look (page-look.ts). This module imports no runtime code beyond that, so
 * tools/screenshots can draw the pages in Node.
 */
import { ALERT_SVG, githubSvg, LOGO_SVG, PAGE_STYLE } from './page-look.ts';
import type { ProjectAccess } from './principal.ts';

/** The owner's sign-in page. It is also the OAuth login page. */
export const SIGN_IN_PAGE = '/sign-in';
/** The page where a person approves or denies an agent and picks its projects. */
export const AGENT_ACCESS_PAGE = '/agent-access';

/** AGPL-3.0 section 13: people who use Ntasks over a network can get its source. */
const SOURCE_URL = 'https://github.com/notice-cx/Ntasks';

function escape(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

/** A page; `scriptNonce` lets the one inline script that carries it run. */
function page(title: string, body: string, scriptNonce?: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>${escape(title)} · Ntasks</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
${LOGO_SVG}
${body}
</main>
<footer><a href="${SOURCE_URL}">${githubSvg(14)}Source code</a></footer>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // No script, no framing: another site cannot overlay the approval
      // buttons. form-action is left out because an approval redirects to the
      // agent's own address. Fonts and the favicon come from this origin's
      // static files.
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'${scriptNonce === undefined ? '' : `; script-src 'nonce-${scriptNonce}'`}`,
      'x-frame-options': 'DENY',
      // same-origin, not no-referrer: under no-referrer a browser sends
      // Origin: null with these pages' own form posts, and the routes refuse
      // a post whose Origin is not this deployment's. Other sites still get
      // no referrer, so a page's address never leaves this origin.
      'referrer-policy': 'same-origin',
    },
  });
}

/** An error's words after the alert icon, in Text: an error is never red. */
function alert(words: string | null): string {
  return words ? `<p class="alert" role="alert">${ALERT_SVG}${escape(words)}</p>` : '';
}

/** The error code sign-in sends a GitHub account back with when it is not a
 * deployment admin, a member of a workspace or invited to one (auth.ts). */
export const NOT_INVITED = 'not_invited';

/** What went wrong on the way back from GitHub, in words. */
function signInError(code: string | null): string | null {
  if (code === null) return null;
  if (code === NOT_INVITED) {
    return 'This GitHub account is not a member of a workspace here. Ask a workspace owner to invite your GitHub username, then sign in again.';
  }
  return 'Signing in did not finish. Try again.';
}

/**
 * The sign-in page: who is signed in, with Sign out, or the Sign in with
 * GitHub button, which carries an agent's signed OAuth query when there is one.
 */
export function signInPage(input: {
  readonly signedInAs: string | null;
  readonly oauthQuery: string | null;
  readonly error: string | null;
}): Response {
  const error = alert(signInError(input.error));
  if (input.signedInAs !== null && input.oauthQuery === null) {
    return page(
      'Signed in',
      `<h1>Signed in</h1>
${error}
<dl><dt>Account</dt><dd>${escape(input.signedInAs)}</dd></dl>
<form method="post" action="${SIGN_IN_PAGE}" class="actions">
<button type="submit" name="action" value="sign-out" class="button secondary">Sign out</button>
<a href="/" class="button primary">Open Ntasks</a>
</form>`,
    );
  }
  const agent = input.oauthQuery === null ? '' : '<p class="sub">An agent asks to connect</p>';
  const query =
    input.oauthQuery === null ? '' : `<input type="hidden" name="oauth_query" value="${escape(input.oauthQuery)}">`;
  return page(
    'Sign in',
    `<h1>Sign in to Ntasks</h1>
${agent}
${error}
<form method="post" action="${SIGN_IN_PAGE}">
${query}
<button type="submit" name="action" value="github" class="button primary wide">${githubSvg(16)}Sign in with GitHub</button>
</form>`,
  );
}

/** The value of the setup page's button, which starts the setup. */
export const SETUP_ACTION = 'setup';
/** The setup page's field for AUTH_SECRET. */
export const AUTH_SECRET_FIELD = 'auth_secret';

/**
 * The setup page, which /sign-in shows until the deployment can sign in with
 * GitHub: AUTH_SECRET, and the button that has GitHub create the app people
 * sign in through.
 */
export function setupPage(input: { readonly error: string | null; readonly status?: number }): Response {
  const response = page(
    'Set up sign-in',
    `<h1>Set up sign-in</h1>
<p class="sub">Enter this deployment's AUTH_SECRET. GitHub then creates the app people sign in through, under your GitHub account, and that account becomes this deployment's admin.</p>
${alert(input.error)}
<form method="post" action="${SIGN_IN_PAGE}">
<label class="field">AUTH_SECRET<input type="password" name="${AUTH_SECRET_FIELD}" required autocomplete="off" spellcheck="false"></label>
<button type="submit" name="action" value="${SETUP_ACTION}" class="button primary wide">${githubSvg(16)}Create the GitHub App</button>
</form>`,
  );
  return new Response(response.body, { status: input.status ?? 200, headers: response.headers });
}

/**
 * The step after the setup page: a form that posts the app's manifest to
 * GitHub, which its script submits at once. Its button stays for a browser
 * that runs no script.
 */
export function manifestPage(input: { readonly action: string; readonly manifest: string }, nonce: string): Response {
  return page(
    'Continue on GitHub',
    `<h1>Continue on GitHub</h1>
<p class="sub">GitHub shows the app it will create. Once you create it, GitHub returns here and you sign in.</p>
<form method="post" action="${escape(input.action)}" id="manifest">
<input type="hidden" name="manifest" value="${escape(input.manifest)}">
<button type="submit" class="button primary wide">${githubSvg(16)}Continue to GitHub</button>
</form>
<script nonce="${escape(nonce)}">document.getElementById('manifest').submit();</script>`,
    nonce,
  );
}

/** Where a setup stopped: why, and the link back to /sign-in, labelled `next`. */
export function setupEndPage(input: {
  readonly status: number;
  readonly heading: string;
  readonly words: string;
  readonly next: string;
}): Response {
  const response = page(
    input.heading,
    `<h1>${escape(input.heading)}</h1>
<p class="sub">${escape(input.words)}</p>
<div class="actions"><a href="${SIGN_IN_PAGE}" class="button primary">${escape(input.next)}</a></div>`,
  );
  return new Response(response.body, { status: input.status, headers: response.headers });
}

/** The access an agent's scopes ask for, in words. */
const ACCESS_WORDS: Readonly<Record<ProjectAccess, string>> = {
  write: 'Read and change tasks',
  read: 'Read tasks',
};

/** The form value that names one project of one workspace on the approval
 * page: the workspace's id, which holds no slash, a slash, then the project's id. */
export function projectChoice(workspaceId: string, projectId: string): string {
  return `${workspaceId}/${projectId}`;
}

/** A workspace and its projects, as the approval page lists them. */
export interface WorkspaceProjects {
  readonly id: string;
  readonly name: string;
  readonly projects: readonly { readonly id: string; readonly key: string; readonly name: string }[];
}

/**
 * The page where a person allows or denies an agent and chooses its
 * projects, in each workspace they belong to: who asks, for what access, for
 * whom and where the answer goes. Allow is left out when the agent asked for
 * no access to tasks or there is no project to choose.
 */
export function agentAccessPage(input: {
  readonly personName: string;
  readonly client: { readonly name: string; readonly uri: string | null };
  /**
   * Where the browser goes after the person answers: the agent's registered
   * redirect address. Any client can register with any name, but the code
   * only ever goes here, so the page shows it.
   */
  readonly returnsTo: string;
  /** The most the agent's scopes let it do; null when it asked for no access to tasks. */
  readonly access: ProjectAccess | null;
  readonly workspaces: readonly WorkspaceProjects[];
  readonly oauthQuery: string;
  readonly error: string | null;
}): Response {
  const from = input.client.uri ? ` <span class="quiet">${escape(input.client.uri)}</span>` : '';
  const access = input.access === null ? '<span class="quiet">None</span>' : ACCESS_WORDS[input.access];
  const listed = input.workspaces.filter((workspace) => workspace.projects.length > 0);
  const choosing = input.access !== null && listed.length > 0;
  const projects = choosing
    ? listed
        .map(
          (workspace) => `<fieldset>
<legend>${listed.length === 1 ? 'Projects' : `Projects in ${escape(workspace.name)}`}</legend>
<div class="options">
${workspace.projects
  .map(
    (project) =>
      `<label><input type="checkbox" name="project" value="${escape(projectChoice(workspace.id, project.id))}">${escape(project.name)}<span class="key">${escape(project.key)}</span></label>`,
  )
  .join('\n')}
</div>
</fieldset>`,
        )
        .join('\n')
    : '';
  return page(
    'Allow an agent',
    `<h1>Allow ${escape(input.client.name)} to use Ntasks?</h1>
${alert(input.error)}
<dl>
<dt>Agent</dt><dd>${escape(input.client.name)}${from}</dd>
<dt>Access</dt><dd>${access}</dd>
${input.access !== null && listed.length === 0 ? '<dt>Projects</dt><dd><span class="quiet">None yet</span></dd>' : ''}
<dt>Account</dt><dd>${escape(input.personName)}</dd>
<dt>Returns to</dt><dd>${escape(input.returnsTo)}</dd>
</dl>
<form method="post" action="${AGENT_ACCESS_PAGE}">
<input type="hidden" name="oauth_query" value="${escape(input.oauthQuery)}">
${projects}
<div class="actions">
<button type="submit" name="decision" value="deny" class="button secondary">Deny</button>
${choosing ? '<button type="submit" name="decision" value="allow" class="button primary">Allow</button>' : ''}
</div>
</form>`,
  );
}

/** A page for a link that no longer works, such as an approval that expired. */
export function expiredPage(): Response {
  const response = page(
    'Link expired',
    `<h1>This link has expired</h1>
<p class="sub">Start again from the agent.</p>`,
  );
  return new Response(response.body, { status: 400, headers: response.headers });
}
