/**
 * The two pages the Worker serves itself: signing in, and approving an AI
 * agent. They are plain HTML forms with no script, so they work before the
 * web app loads and hold nothing an agent could read.
 */
import type { ProjectAccess } from './principal.ts';
import { AGENT_ACCESS_PAGE, SIGN_IN_PAGE } from './protocol.ts';

/** AGPL-3.0 section 13: people who use Ntasks over a network can get its source. */
const SOURCE_URL = 'https://github.com/notice-cx/Ntasks';

function escape(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light dark; --text: #1b1b1f; --muted: #5b5b66; --line: #d6d6de; --surface: #ffffff; --page: #f5f5f7; --accent: #1f4fd1; --accent-text: #ffffff; --alert: #a3261c; }
@media (prefers-color-scheme: dark) { :root { --text: #ececf1; --muted: #a4a4b0; --line: #3a3a44; --surface: #1d1d22; --page: #121215; --accent: #7aa2ff; --accent-text: #0b0b0e; --alert: #ff8a7f; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--page); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
main { width: 100%; max-width: 440px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
h1 { font-size: 1.25rem; margin: 0 0 12px; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); font-size: 0.875rem; }
.alert { color: var(--alert); }
fieldset { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 16px; padding: 8px 12px; }
legend { padding: 0 4px; font-weight: 600; }
label { display: flex; gap: 8px; align-items: center; padding: 4px 0; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
a { color: var(--accent); }
footer { margin-top: 16px; }
`;

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)} · Ntasks</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<footer class="muted"><a href="${SOURCE_URL}">Ntasks source code</a></footer>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // No script, no framing: another site cannot overlay the approval
      // buttons. form-action is left out because an approval redirects to the
      // agent's own address.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** What went wrong on the way back from GitHub, in words. */
function signInError(code: string | null): string | null {
  if (code === null) return null;
  if (code === 'not_an_owner') return 'This GitHub account may not sign in to this Ntasks.';
  return 'Signing in did not finish. Try again.';
}

export function signInPage(input: {
  readonly signedInAs: string | null;
  readonly oauthQuery: string | null;
  readonly error: string | null;
}): Response {
  const error = signInError(input.error);
  const alert = error ? `<p class="alert" role="alert">${escape(error)}</p>` : '';
  if (input.signedInAs !== null && input.oauthQuery === null) {
    return page(
      'Signed in',
      `<h1>Signed in</h1>
${alert}
<p>You are signed in as ${escape(input.signedInAs)}.</p>
<form method="post" action="${SIGN_IN_PAGE}" class="actions">
<a href="/">Open Ntasks</a>
<button type="submit" name="action" value="sign-out">Sign out</button>
</form>`,
    );
  }
  const agent = input.oauthQuery === null
    ? ''
    : '<p>An AI agent asked to connect to this Ntasks. Sign in, then choose the projects it may reach.</p>';
  const query = input.oauthQuery === null ? '' : `<input type="hidden" name="oauth_query" value="${escape(input.oauthQuery)}">`;
  return page(
    'Sign in',
    `<h1>Sign in to Ntasks</h1>
${alert}
${agent}
<form method="post" action="${SIGN_IN_PAGE}">
${query}
<button type="submit" name="action" value="github" class="primary">Sign in with GitHub</button>
</form>`,
  );
}

export function agentAccessPage(input: {
  readonly personName: string;
  readonly client: { readonly name: string; readonly uri: string | null };
  /**
   * Where the browser goes after the owner answers: the agent's registered
   * redirect address. Any client can register with any name, but the code
   * only ever goes here, so the page shows it.
   */
  readonly returnsTo: string;
  /** The most the agent's scopes let it do; null when it asked for no access to tasks. */
  readonly access: ProjectAccess | null;
  readonly projects: readonly { readonly id: string; readonly key: string; readonly name: string }[];
  readonly oauthQuery: string;
  readonly error: string | null;
}): Response {
  const from = input.client.uri ? ` (${escape(input.client.uri)})` : '';
  const alert = input.error ? `<p class="alert" role="alert">${escape(input.error)}</p>` : '';
  const ask = input.access === null
    ? `<p>${escape(input.client.name)}${from} asks for no access to tasks, so it cannot be allowed.</p>`
    : `<p>${escape(input.client.name)}${from} asks to ${input.access === 'write' ? 'read and change tasks' : 'read tasks'} for you, ${escape(input.personName)}, in the projects you choose.</p>`;
  const projects = input.access === null
    ? ''
    : input.projects.length === 0
    ? '<p>There are no projects yet. Create a project before allowing an agent.</p>'
    : `<fieldset>
<legend>Projects it may reach</legend>
${input.projects
  .map(
    (project) =>
      `<label><input type="checkbox" name="project" value="${escape(project.id)}"> ${escape(project.name)} <span class="muted">${escape(project.key)}</span></label>`,
  )
  .join('\n')}
</fieldset>`;
  const allow = input.access === null || input.projects.length === 0
    ? ''
    : '<button type="submit" name="decision" value="allow" class="primary">Allow</button>';
  return page(
    'Allow an agent',
    `<h1>Allow ${escape(input.client.name)} to use Ntasks?</h1>
${alert}
${ask}
<p class="muted">After you answer, your browser goes to ${escape(input.returnsTo)}.</p>
<form method="post" action="${AGENT_ACCESS_PAGE}">
<input type="hidden" name="oauth_query" value="${escape(input.oauthQuery)}">
${projects}
<div class="actions">
${allow}
<button type="submit" name="decision" value="deny">Deny</button>
</div>
</form>`,
  );
}

/** A page for a link that no longer works, such as an approval that expired. */
export function expiredPage(): Response {
  const response = page(
    'Link expired',
    `<h1>This link has expired</h1>
<p>Start connecting the agent again from the agent itself.</p>`,
  );
  return new Response(response.body, { status: 400, headers: response.headers });
}
