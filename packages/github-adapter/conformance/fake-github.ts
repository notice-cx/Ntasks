/**
 * A stand-in for the GitHub REST API calls the adapter makes, kept in
 * memory: issues, their comments and a repository's labels, in GitHub's
 * shapes, with paging by `Link` headers. It answers only the token it was
 * started with. CI runs the conformance suite against the adapter over it,
 * so no run needs a GitHub token or reaches GitHub.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface FakeIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: string[];
  user: { login: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface FakeComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
}

export interface FakeGitHub {
  readonly url: string;
  /** Every request it answered, as `METHOD path`. */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

export async function startFakeGitHub(token: string, login = 'swp-adapter'): Promise<FakeGitHub> {
  const repositories = new Map<
    string,
    { issues: FakeIssue[]; comments: Map<number, FakeComment[]>; labels: Set<string> }
  >();
  const requests: string[] = [];
  let ids = 1000;
  const now = () => new Date().toISOString();
  const repository = (name: string) => {
    let found = repositories.get(name);
    if (!found) repositories.set(name, (found = { issues: [], comments: new Map(), labels: new Set() }));
    return found;
  };
  const shown = (issue: FakeIssue) => ({ ...issue, labels: issue.labels.map((name) => ({ name })) });

  const handle = (method: string, url: URL, body: Record<string, unknown>, origin: string) => {
    const match = /^\/repos\/([^/]+\/[^/]+)\/(issues|labels)(?:\/(\d+))?(?:\/(comments))?$/u.exec(url.pathname);
    if (!match) return { status: 404, body: { message: 'Not Found' } };
    const repo = repository(match[1]!);
    const number = match[3] === undefined ? null : Number(match[3]);
    const page = (items: unknown[]) => {
      const size = Math.min(Number(url.searchParams.get('per_page') ?? '30'), 100);
      const at = Number(url.searchParams.get('page') ?? '1');
      const slice = items.slice((at - 1) * size, at * size);
      const next = at * size < items.length ? new URL(url.toString()) : null;
      next?.searchParams.set('page', String(at + 1));
      return {
        status: 200,
        body: slice,
        headers: (next === null ? {} : { link: `<${origin}${next.pathname}${next.search}>; rel="next"` }) as Record<
          string,
          string
        >,
      };
    };
    if (match[2] === 'labels') {
      if (method !== 'POST') return { status: 405, body: {} };
      const name = String(body.name);
      if (repo.labels.has(name)) return { status: 422, body: { message: 'Validation Failed' } };
      repo.labels.add(name);
      return { status: 201, body: { name } };
    }
    if (number === null) {
      if (method === 'POST') {
        const issue: FakeIssue = {
          id: (ids += 1),
          number: repo.issues.length + 1,
          title: String(body.title),
          body: String(body.body ?? ''),
          state: 'open',
          state_reason: null,
          labels: [...((body.labels as string[] | undefined) ?? [])],
          user: { login },
          created_at: now(),
          updated_at: now(),
          closed_at: null,
        };
        for (const label of issue.labels) repo.labels.add(label);
        repo.issues.push(issue);
        return { status: 201, body: shown(issue) };
      }
      const labels = url.searchParams.get('labels')?.split(',').filter(Boolean) ?? [];
      const state = url.searchParams.get('state') ?? 'open';
      return page(
        repo.issues
          .filter((issue) => state === 'all' || issue.state === state)
          .filter((issue) => labels.every((label) => issue.labels.includes(label)))
          .map(shown),
      );
    }
    const issue = repo.issues.find((each) => each.number === number);
    if (!issue) return { status: 404, body: { message: 'Not Found' } };
    if (match[4] === 'comments') {
      const comments = repo.comments.get(number) ?? [];
      if (method === 'POST') {
        const comment: FakeComment = { id: (ids += 1), body: String(body.body), user: { login }, created_at: now() };
        repo.comments.set(number, [...comments, comment]);
        return { status: 201, body: comment };
      }
      return page(comments);
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) issue.labels = [...(body.labels as string[])];
      if (body.state === 'closed' && issue.state === 'open') {
        issue.state = 'closed';
        issue.closed_at = now();
        issue.state_reason = typeof body.state_reason === 'string' ? body.state_reason : 'completed';
      } else if (body.state === 'open' && issue.state === 'closed') {
        issue.state = 'open';
        issue.closed_at = null;
        issue.state_reason = 'reopened';
      }
      issue.updated_at = now();
    }
    return { status: 200, body: shown(issue) };
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const origin = `http://${request.headers.host}`;
      const url = new URL(request.url ?? '/', origin);
      requests.push(`${request.method} ${url.pathname}`);
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });
      const text = Buffer.concat(chunks).toString('utf8');
      const answered = handle(request.method ?? 'GET', url, text === '' ? {} : (JSON.parse(text) as Json), origin);
      reply(answered.status, answered.body, 'headers' in answered ? answered.headers : {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Json = Record<string, unknown>;
