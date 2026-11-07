/**
 * The pages the Worker serves itself: signing in, approving an AI agent, and
 * a link that expired. They are plain HTML forms with no script, so they work
 * before the web app loads and hold nothing an agent could read. They draw in
 * the design system's look (page-look.ts). This module imports no runtime
 * code beyond that, so tools/screenshots can draw the pages in Node.
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

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
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
      // agent's own address. Fonts come from this origin's static files.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** An error's words after the alert icon, in Text: an error is never red. */
function alert(words: string | null): string {
  return words ? `<p class="alert" role="alert">${ALERT_SVG}${escape(words)}</p>` : '';
}

/** What went wrong on the way back from GitHub, in words. */
function signInError(code: string | null): string | null {
  if (code === null) return null;
  if (code === 'not_an_owner') return 'This GitHub account may not sign in to this Ntasks.';
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
