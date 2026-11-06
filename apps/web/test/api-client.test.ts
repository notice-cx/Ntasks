import { describe, expect, it } from 'vitest';
import { ApiError, createHttpTasksApi, retryRead, UnreadableAnswer } from '@/api/client';

interface Sent {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

const PROJECTS = {
  projects: [{ projectId: 'p-web', logicalKey: 'web', displayName: 'Example web app', prefix: 'web' }],
};

/** A server that answers the project list and records every other request. */
function server(answer: (sent: Sent) => Response = () => Response.json({ id: 'web-n1' })) {
  const sent: Sent[] = [];
  const api = createHttpTasksApi(async (url, init) => {
    const request: Sent = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      headers: new Headers(init?.headers),
    };
    if (url === '/api/tasks/projects') return Response.json(PROJECTS);
    sent.push(request);
    return answer(request);
  });
  return { api, sent };
}

describe('which failed reads are tried again', () => {
  it('retries a lost connection or a server error, never a refusal', () => {
    expect(retryRead(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(retryRead(0, new ApiError('The task list: the server answered 503.', 503, null))).toBe(true);
    expect(retryRead(3, new ApiError('The task list: the server answered 503.', 503, null))).toBe(false);
    expect(retryRead(0, new ApiError('Sign in to see your tasks.', 401, 'sign_in_required'))).toBe(false);
    expect(retryRead(0, new ApiError('Task web-a1: not found.', 404, 'not_found'))).toBe(false);
  });

  it('does not retry an answer whose shape the app cannot read', async () => {
    const api = createHttpTasksApi(async () => Response.json({ projects: [{ projectId: 'p-web' }] }));
    const error: unknown = await api.projects().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(UnreadableAnswer);
    expect(retryRead(0, error)).toBe(false);
  });

  it('does not retry a successful answer whose body is not JSON', async () => {
    const page = () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } });
    const { api } = server(page);
    for (const read of [
      () => api.board('web'),
      () => api.changes(0),
      () => createHttpTasksApi(async () => page()).projects(),
    ]) {
      const error: unknown = await read().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(UnreadableAnswer);
      expect(retryRead(0, error)).toBe(false);
    }
  });
});

describe('the HTTP Tasks API client', () => {
  it('reads a board and a task by the project id the project list gives', async () => {
    const { api, sent } = server(() => Response.json({ project: 'web', tasks: [] }));
    await api.board('web');
    await api.task('web-a1b2', 'web');
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/tasks?project=p-web',
      'GET /api/tasks/web-a1b2?project=p-web',
    ]);
  });

  it('asks the change feed for the changes after a sequence number', async () => {
    const { api, sent } = server(() =>
      Response.json({ events: [{ seq: 8, projectId: 'p-web', taskId: 'web-a1' }], lastSeq: 8 }),
    );
    await expect(api.changes(7)).resolves.toEqual({
      events: [{ seq: 8, projectId: 'p-web', taskId: 'web-a1' }],
      lastSeq: 8,
    });
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual(['GET /api/changes?after=7']);
  });

  it('refuses a project the list does not hold, without a request', async () => {
    const { api, sent } = server();
    await expect(api.board('other')).rejects.toBeInstanceOf(ApiError);
    await expect(api.closeTask('other-a1', 'other', 'done')).rejects.toThrow('No project named other.');
    expect(sent).toEqual([]);
  });

  it('sends writes in the /api/tasks shapes, naming the project by id', async () => {
    const { api, sent } = server();
    const created = await api.createTask({ project: 'web', title: 'Write the guide', priority: 1, labels: ['docs'] });
    await api.updateTask('web-a1b2', 'web', { claim: true });
    await api.closeTask('web-a1b2', 'web', 'Landed in 1a2b3c4');
    await api.closeTask('web-a1b2', 'web', 'Same as web-c3', { resolution: 'duplicate', duplicateOf: 'web-c3' });
    await api.comment('web-a1b2', 'web', 'A note');
    await api.respond('web-a1b2', 'web', 'Use the support address');
    await api.choose('web-a1b2', 'web', 'b', 'Second is safer');
    await api.dismiss('web-a1b2', 'web');
    await api.dismiss('web-a1b2', 'web', 'Handled elsewhere', { resolution: 'already-handled' });
    await api.resolveGate('web-g1', 'web');

    expect(created).toEqual({ id: 'web-n1', project: 'web' });
    expect(sent.map((request) => [request.method, request.url, request.body])).toEqual([
      ['POST', '/api/tasks', { title: 'Write the guide', priority: 1, labels: ['docs'], projectId: 'p-web' }],
      ['PATCH', '/api/tasks/web-a1b2', { claim: true, projectId: 'p-web' }],
      ['POST', '/api/tasks/web-a1b2/close', { reason: 'Landed in 1a2b3c4', projectId: 'p-web' }],
      [
        'POST',
        '/api/tasks/web-a1b2/close',
        { reason: 'Same as web-c3', resolution: 'duplicate', duplicateOf: 'web-c3', projectId: 'p-web' },
      ],
      ['POST', '/api/tasks/web-a1b2/comments', { text: 'A note', projectId: 'p-web' }],
      ['POST', '/api/tasks/web-a1b2/respond', { response: 'Use the support address', projectId: 'p-web' }],
      ['POST', '/api/tasks/web-a1b2/choose', { option: 'b', note: 'Second is safer', projectId: 'p-web' }],
      ['POST', '/api/tasks/web-a1b2/dismiss', { projectId: 'p-web' }],
      [
        'POST',
        '/api/tasks/web-a1b2/dismiss',
        { reason: 'Handled elsewhere', resolution: 'already-handled', projectId: 'p-web' },
      ],
      ['POST', '/api/gates/web-g1/resolve', { projectId: 'p-web' }],
    ]);
  });

  it('gives every write its own retry key', async () => {
    const { api, sent } = server();
    await api.comment('web-a1b2', 'web', 'one');
    await api.comment('web-a1b2', 'web', 'two');
    const keys = sent.map((request) => request.headers.get('idempotency-key'));
    expect(keys.every((key) => typeof key === 'string' && key.length >= 8)).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });

  it('reads the project list again for a key the last list did not hold', async () => {
    let lists = 0;
    const api = createHttpTasksApi(async (url) => {
      if (url !== '/api/tasks/projects') return Response.json({ project: 'docs', tasks: [] });
      lists += 1;
      const docs = { projectId: 'p-docs', logicalKey: 'docs', displayName: 'Example docs', prefix: 'docs' };
      return Response.json({ projects: lists === 1 ? PROJECTS.projects : [...PROJECTS.projects, docs] });
    });
    await api.board('web');
    await expect(api.board('docs')).resolves.toMatchObject({ project: 'docs' });
    expect(lists).toBe(2);
  });

  it('uses the retry key a caller passes, so a second attempt is the same submission', async () => {
    const { api, sent } = server();
    await api.createTask({ project: 'web', title: 'Once' }, { idempotencyKey: 'submission-1' });
    await api.createTask({ project: 'web', title: 'Once' }, { idempotencyKey: 'submission-1' });
    await api.comment('web-a1b2', 'web', 'Note', { idempotencyKey: 'comment-1' });
    expect(sent.map((request) => request.headers.get('idempotency-key'))).toEqual([
      'submission-1',
      'submission-1',
      'comment-1',
    ]);
  });

  it('sends the retry key a caller passes on every kind of write', async () => {
    const { api, sent } = server();
    const idempotencyKey = 'one-submission';
    await api.updateTask('web-a1b2', 'web', { claim: true }, { idempotencyKey });
    await api.closeTask('web-a1b2', 'web', 'Done', { idempotencyKey });
    await api.respond('web-a1b2', 'web', 'Yes', { idempotencyKey });
    await api.choose('web-a1b2', 'web', 'a', undefined, { idempotencyKey });
    await api.dismiss('web-a1b2', 'web', undefined, { resolution: 'duplicate', duplicateOf: 'web-c3', idempotencyKey });
    await api.resolveGate('web-g1', 'web', undefined, { idempotencyKey, keepalive: true });
    expect(sent.map((request) => request.headers.get('idempotency-key'))).toEqual(Array(6).fill(idempotencyKey));
    expect(sent[4]?.body).toEqual({ resolution: 'duplicate', duplicateOf: 'web-c3', projectId: 'p-web' });
  });

  it("lets one caller stop waiting without failing another caller's read", async () => {
    let answerList: (response: Response) => void = () => {};
    const api = createHttpTasksApi(async (url, init) => {
      if (url === '/api/tasks/projects') {
        // The shared list is read without any caller's signal.
        expect(init?.signal).toBeUndefined();
        return new Promise<Response>((resolve) => {
          answerList = resolve;
        });
      }
      return Response.json({ project: 'web', tasks: [] });
    });
    const leaving = new AbortController();
    const first = api.board('web', leaving.signal);
    const second = api.board('web');
    leaving.abort();
    answerList(Response.json(PROJECTS));
    await expect(first).rejects.toBeDefined();
    await expect(second).resolves.toMatchObject({ project: 'web' });
  });

  it("shows a refusal in the server's own words", async () => {
    const { api } = server(() =>
      Response.json({ error: 'task_refused', detail: 'Task web-a1b2 is held by agent-one.' }, { status: 409 }),
    );
    await expect(api.updateTask('web-a1b2', 'web', { claim: true })).rejects.toMatchObject({
      status: 409,
      code: 'task_refused',
      message: 'Task web-a1b2 is held by agent-one.',
    });
  });
});
