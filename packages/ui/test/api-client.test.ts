import { describe, expect, it } from 'vitest';
import {
  ApiError,
  createHttpTasksApi,
  refusedField,
  retryRead,
  UnreadableAnswer,
  WORKSPACE_HEADER,
} from '@/api/client';

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
      'GET /api/tasks?project=p-web&externalLinks=none',
      'GET /api/tasks/web-a1b2?project=p-web',
    ]);
  });

  it('searches every project in one read, and refuses an answer without its tasks', async () => {
    const { api, sent } = server(() => Response.json({ readAt: '2026-11-06T12:00:00.000Z', total: 0, tasks: [] }));
    expect(await api.search('docs-a1b2 claim')).toEqual({ readAt: '2026-11-06T12:00:00.000Z', total: 0, tasks: [] });
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/tasks/search?q=docs-a1b2+claim',
    ]);
    const { api: broken } = server(() => Response.json({ total: 0 }));
    expect(await broken.search('claim').catch((failure: unknown) => failure)).toBeInstanceOf(UnreadableAnswer);
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
    await api.resolveGate('web-g1', 'web', 'Ship it');
    await api.dispute('web-g1', 'web');
    await api.choose('web-a1b2', 'web', 'a', undefined, { proposalVersion: '0123456789abcdef0123456789abcdef' });

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
      ['POST', '/api/gates/web-g1/resolve', { reason: 'Ship it', projectId: 'p-web' }],
      ['POST', '/api/tasks/web-g1/dispute', { projectId: 'p-web' }],
      [
        'POST',
        '/api/tasks/web-a1b2/choose',
        { option: 'a', proposalVersion: '0123456789abcdef0123456789abcdef', projectId: 'p-web' },
      ],
    ]);
  });

  it("reads a project's custom fields, and a board filtered by them, by the project's id", async () => {
    const fields = [
      {
        key: 'area',
        name: 'Product area',
        type: 'single-choice',
        options: ['Email', 'Sign-in'],
        createdAt: '2026-11-01T00:00:00.000Z',
        retiredAt: null,
      },
      {
        key: 'sprint',
        name: 'Sprint',
        type: 'text',
        options: null,
        createdAt: '2026-11-01T00:00:00.000Z',
        retiredAt: '2026-11-02T00:00:00.000Z',
      },
    ];
    const { api, sent } = server((request) =>
      Response.json(request.url.startsWith('/api/fields') ? { project: 'web', fields } : { project: 'web', tasks: [] }),
    );
    await expect(api.fields('web')).resolves.toEqual({ project: 'web', fields });
    await api.board('web', undefined, { area: 'Sign-in', customer_facing: 'true' });
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/fields?project=p-web',
      'GET /api/tasks?project=p-web&externalLinks=none&field.area=Sign-in&field.customer_facing=true',
    ]);
  });

  it('does not retry a field list whose shape it cannot read', async () => {
    const { api } = server(() => Response.json({ project: 'web', fields: [{ key: 'area' }] }));
    const error: unknown = await api.fields('web').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(UnreadableAnswer);
    expect(retryRead(0, error)).toBe(false);
  });

  it("sends a change to notes, design, estimate, due date, links and custom fields in the route's shape, with a retry key", async () => {
    const { api, sent } = server(() => Response.json({ task: {} }));
    await api.updateTask('web-a1b2', 'web', {
      notes: 'Tab order fixed.',
      design: '',
      estimateMinutes: 90,
      dueAt: '2030-01-15',
      addExternalLinks: [{ url: 'https://example.com/spec', title: 'The spec', kind: 'document' }],
      removeExternalLinks: ['https://example.com/old'],
      fields: { area: 'Email', platforms: ['Web', 'iOS'], points: 3, customer_facing: false, team: null },
    });
    await api.updateTask('web-a1b2', 'web', { estimateMinutes: null, dueAt: null }, { idempotencyKey: 'retry-one' });
    await api.updateTask('web-a1b2', 'web', {
      addLinks: [{ taskId: 'web-c3d4', type: 'duplicates' }],
      removeLinks: ['web-e5f6'],
    });
    expect(sent.map((request) => [request.method, request.url, request.body])).toEqual([
      [
        'PATCH',
        '/api/tasks/web-a1b2',
        {
          notes: 'Tab order fixed.',
          design: '',
          estimateMinutes: 90,
          dueAt: '2030-01-15',
          addExternalLinks: [{ url: 'https://example.com/spec', title: 'The spec', kind: 'document' }],
          removeExternalLinks: ['https://example.com/old'],
          fields: { area: 'Email', platforms: ['Web', 'iOS'], points: 3, customer_facing: false, team: null },
          projectId: 'p-web',
        },
      ],
      ['PATCH', '/api/tasks/web-a1b2', { estimateMinutes: null, dueAt: null, projectId: 'p-web' }],
      [
        'PATCH',
        '/api/tasks/web-a1b2',
        { addLinks: [{ taskId: 'web-c3d4', type: 'duplicates' }], removeLinks: ['web-e5f6'], projectId: 'p-web' },
      ],
    ]);
    expect(sent[0]?.headers.get('idempotency-key')?.length).toBeGreaterThanOrEqual(8);
    expect(sent[1]?.headers.get('idempotency-key')).toBe('retry-one');
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

  it("shows a decision refused to a sign-in that is not a person in the server's own words", async () => {
    const detail = 'Only a person signed in to the web app can take this decision.';
    const { api } = server(() => Response.json({ error: 'insufficient_scope', detail }, { status: 403 }));
    for (const decide of [
      () => api.respond('web-a1b2', 'web', 'Yes'),
      () => api.choose('web-a1b2', 'web', 'a'),
      () => api.dismiss('web-a1b2', 'web'),
      () => api.dispute('web-a1b2', 'web'),
      () => api.resolveGate('web-g1', 'web'),
    ]) {
      await expect(decide()).rejects.toMatchObject({ status: 403, code: 'insufficient_scope', message: detail });
    }
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

describe('the workspace a call is made in', () => {
  /** A server whose project list names the workspace it was asked in, recording each request and its workspace. */
  function workspaces(answer: (path: string) => Response = () => Response.json({})) {
    const sent: { method: string; url: string; workspace: string | null; body: unknown }[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;
    const api = createHttpTasksApi(async (url, init) => {
      const workspace = new Headers(init?.headers).get(WORKSPACE_HEADER);
      sent.push({
        method: init?.method ?? 'GET',
        url,
        workspace,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (url === '/api/tasks/projects') {
        if (holding) await held;
        return Response.json({
          projects: [{ projectId: `p-${workspace}`, logicalKey: 'web', displayName: 'Example web app', prefix: 'web' }],
        });
      }
      return answer(url);
    });
    return {
      api,
      sent,
      hold: () => {
        holding = true;
      },
      release,
    };
  }

  it('names the selected workspace on every call in it, and on none of the calls about the sign-in', async () => {
    const { api, sent } = workspaces((url) =>
      url === '/api/workspaces'
        ? Response.json({ workspaces: [{ workspaceId: 'ws-a', name: 'Example', role: 'owner' }] })
        : url === '/api/access/me'
          ? Response.json({ kind: 'person', name: 'Example Owner', deploymentAdmin: true })
          : url === '/api/access/members'
            ? Response.json({ members: [], invitations: [] })
            : Response.json({ project: 'web', tasks: [] }),
    );
    await api.workspaces();
    await api.account();
    api.selectWorkspace('ws-a');
    await api.board('web');
    await api.createProject({ name: 'Example shop', prefix: 'shop' });
    await api.members();
    await api.invite({ githubLogin: 'example-new', role: 'member' });
    await api.revokeInvitation('i-1');
    await api.removeMember('u-2');
    expect(sent.map((request) => [request.method, request.url, request.workspace, request.body])).toEqual([
      ['GET', '/api/workspaces', null, null],
      ['GET', '/api/access/me', null, null],
      ['GET', '/api/tasks/projects', 'ws-a', null],
      ['GET', '/api/tasks?project=p-ws-a&externalLinks=none', 'ws-a', null],
      ['POST', '/api/tasks/projects', 'ws-a', { name: 'Example shop', prefix: 'shop' }],
      ['GET', '/api/access/members', 'ws-a', null],
      ['POST', '/api/access/invitations', 'ws-a', { githubLogin: 'example-new', role: 'member' }],
      ['POST', '/api/access/invitations/i-1/revoke', 'ws-a', {}],
      ['POST', '/api/access/members/u-2/remove', 'ws-a', {}],
    ]);
  });

  it("finishes a call in the workspace it started in, and reads each workspace's own projects", async () => {
    const { api, sent, hold, release } = workspaces(() => Response.json({ project: 'web', tasks: [] }));
    api.selectWorkspace('ws-a');
    hold();
    const started = api.board('web');
    api.selectWorkspace('ws-b');
    release();
    await started;
    await api.board('web');
    expect(sent.map((request) => [request.url, request.workspace])).toEqual([
      ['/api/tasks/projects', 'ws-a'],
      ['/api/tasks?project=p-ws-a&externalLinks=none', 'ws-a'],
      ['/api/tasks/projects', 'ws-b'],
      ['/api/tasks?project=p-ws-b&externalLinks=none', 'ws-b'],
    ]);
  });

  it('reads a new workspace, the members, and a role this build does not know as a member', async () => {
    const { api } = workspaces((url) =>
      url === '/api/workspaces'
        ? Response.json({ workspace: { workspaceId: 'ws-new', name: 'Example Co', role: 'owner' } }, { status: 201 })
        : Response.json({
            members: [{ userId: 'u-1', name: 'Example Owner', githubLogin: 'example-owner', role: 'admin' }],
            invitations: [{ invitationId: 'i-1', githubLogin: 'example-new', role: 'owner' }],
          }),
    );
    await expect(api.createWorkspace('Example Co')).resolves.toEqual({
      workspaceId: 'ws-new',
      name: 'Example Co',
      role: 'owner',
    });
    await expect(api.members()).resolves.toEqual({
      members: [{ userId: 'u-1', name: 'Example Owner', githubLogin: 'example-owner', role: 'member' }],
      invitations: [{ invitationId: 'i-1', githubLogin: 'example-new', role: 'owner', createdAt: null }],
    });
  });
});

describe('the field a refusal is about', () => {
  it("is the field the server names, else the one its sentence starts with, and none for a server's failure", () => {
    const fields = ['name', 'prefix'] as const;
    expect(refusedField(new ApiError('That is taken.', 409, 'project_exists', 'prefix'), fields)).toBe('prefix');
    expect(refusedField(new ApiError('Prefix web is taken.', 409, 'project_exists'), fields)).toBe('prefix');
    expect(refusedField(new ApiError('name must be 1 to 80 characters.', 400, 'invalid_request'), fields)).toBe('name');
    expect(refusedField(new ApiError('Only an owner may do that.', 403, 'forbidden'), fields)).toBeNull();
    expect(refusedField(new ApiError('prefix: the server answered 503.', 503, null), fields)).toBeNull();
    expect(refusedField(new Error('prefix'), fields)).toBeNull();
  });

  it("reads the field from the server's refusal", async () => {
    const api = createHttpTasksApi(async () =>
      Response.json({ error: 'invalid_request', detail: 'That prefix is taken.', field: 'prefix' }, { status: 409 }),
    );
    api.selectWorkspace('ws-a');
    const error: unknown = await api.createProject({ name: 'Example', prefix: 'web' }).catch((failure) => failure);
    expect(refusedField(error, ['name', 'prefix'])).toBe('prefix');
  });
});
