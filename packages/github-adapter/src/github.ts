/**
 * The few GitHub REST calls the adapter makes: issues, their comments and
 * labels. A refusal GitHub gives for its rate limits is waited out and sent
 * again, up to a minute; any other failure is a GitHubError.
 */

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: 'open' | 'closed';
  readonly state_reason?: string | null;
  readonly labels: readonly ({ readonly name: string } | string)[];
  readonly user: { readonly login: string } | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly pull_request?: unknown;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly login: string } | null;
  readonly created_at: string;
}

/** How long one request to GitHub may take. */
const REQUEST_MS = 30_000;

/** A request GitHub refused or did not answer: status 0 when no answer came. */
export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const labelName = (label: { readonly name: string } | string): string =>
  typeof label === 'string' ? label : label.name;

export class GitHub {
  private readonly api: string;
  private readonly token: string;
  /** The least time between two writes, which GitHub's limits on creating content ask for. */
  private readonly spacing: number;
  private lastWrite = 0;

  constructor(api: string, token: string, options: { readonly spacing?: number } = {}) {
    this.api = api.replace(/\/$/u, '');
    this.token = token;
    this.spacing = options.spacing ?? 0;
  }

  createIssue(repository: string, issue: { title: string; body: string; labels: readonly string[] }): Promise<Issue> {
    return this.call('POST', `/repos/${repository}/issues`, issue) as Promise<Issue>;
  }

  updateIssue(
    repository: string,
    number: number,
    change: { title?: string; body?: string; state?: 'open' | 'closed'; state_reason?: string; labels?: string[] },
  ): Promise<Issue> {
    return this.call('PATCH', `/repos/${repository}/issues/${number}`, change) as Promise<Issue>;
  }

  async getIssue(repository: string, number: number): Promise<Issue | null> {
    try {
      const issue = (await this.call('GET', `/repos/${repository}/issues/${number}`)) as Issue;
      return issue.pull_request === undefined ? issue : null;
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  }

  /** Every issue of the repository, open and closed, with `label` when one is given; pull requests left out. */
  async listIssues(repository: string, label?: string): Promise<Issue[]> {
    const query = new URLSearchParams({ state: 'all', per_page: '100', sort: 'created', direction: 'asc' });
    if (label !== undefined) query.set('labels', label);
    const issues = (await this.pages(`/repos/${repository}/issues?${query}`)) as Issue[];
    return issues.filter((issue) => issue.pull_request === undefined);
  }

  listComments(repository: string, number: number): Promise<IssueComment[]> {
    return this.pages(`/repos/${repository}/issues/${number}/comments?per_page=100`) as Promise<IssueComment[]>;
  }

  createComment(repository: string, number: number, body: string): Promise<IssueComment> {
    return this.call('POST', `/repos/${repository}/issues/${number}/comments`, { body }) as Promise<IssueComment>;
  }

  /** Makes the label when the repository lacks it. */
  async ensureLabel(repository: string, name: string): Promise<void> {
    try {
      await this.call('POST', `/repos/${repository}/labels`, { name, color: 'ededed' });
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422)) throw error;
    }
  }

  private async pages(path: string): Promise<unknown[]> {
    const all: unknown[] = [];
    let next: string | null = `${this.api}${path}`;
    while (next !== null) {
      const response = await this.send('GET', next);
      all.push(...((await response.json()) as unknown[]));
      next = /<([^>]+)>;\s*rel="next"/u.exec(response.headers.get('link') ?? '')?.[1] ?? null;
    }
    return all;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.send(method, `${this.api}${path}`, body);
    return response.status === 204 ? null : ((await response.json()) as unknown);
  }

  private async send(method: string, url: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      if (method !== 'GET' && this.spacing > 0) {
        const wait = this.lastWrite + this.spacing - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        this.lastWrite = Date.now();
      }
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.token}`,
            'x-github-api-version': '2022-11-28',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          // Writes run one at a time, so a request that hangs would hold every later write.
          signal: AbortSignal.timeout(REQUEST_MS),
        });
      } catch (error) {
        throw new GitHubError(0, `GitHub did not answer ${method} ${new URL(url).pathname}: ${String(error)}`);
      }
      if (response.ok) return response;
      const limited = response.status === 429 || (response.status === 403 && response.headers.has('retry-after'));
      const exhausted = response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
      // GitHub may have made an issue or a comment before a server error, so only reads and edits are sent again
      // after one; a rate limit means GitHub did nothing, so any request is.
      const again = limited || exhausted || (response.status >= 500 && method !== 'POST');
      if (again && attempt < 3) {
        const after = Number(response.headers.get('retry-after') ?? '');
        const reset = Number(response.headers.get('x-ratelimit-reset') ?? '') * 1000 - Date.now();
        const wait = Number.isFinite(after) && after > 0 ? after * 1000 : reset > 0 ? reset : 1000 * 2 ** attempt;
        if (wait <= 60_000) {
          await response.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
      }
      const text = await response.text();
      throw new GitHubError(
        response.status,
        `GitHub answered ${response.status} to ${method} ${new URL(url).pathname}: ${text.slice(0, 200)}`,
      );
    }
  }
}
