/**
 * A deliberately broken server: a proxy in front of a conforming one that
 * breaks one rule of the protocol and passes everything else through
 * unchanged. Each defect names the rule it breaks; the suite's test runs
 * every check through each defect and expects exactly the checks of that
 * rule to fail, which shows each check can tell a server that keeps its
 * rule from one that does not.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Target } from '../src/target.ts';

export const DEFECTS = {
  'two-claims-win': 'answers a claim refused as held by someone else as a success (INV-1)',
  'retries-repeat': 'gives every write a fresh idempotency key, so a retry writes again (INV-3)',
  'stale-answers-accepted': 'applies an answer to the proposal as it stands, whatever version it names (AUTH-3)',
  'agents-decide': "lets an agent or a service send a person's decisions (AUTH-1)",
  'relays-unmarked': 'reads every recorded answer as made directly, never relayed (AUTH-3)',
  'disputes-refused': 'refuses every dispute (AUTH-5)',
  'proof-dropped': 'drops the commit, pull request and link of a close as done (INV-7)',
  'models-dropped': 'drops the model each write names (INV-12)',
  'held-tasks-hidden': 'tells a connecting agent nothing of the tasks it holds (INV-10)',
  'activity-misread': 'answers every task in progress as active, whatever its last activity (STATE-20)',
  'activity-filter-ignored':
    'drops the groups of activity a list names, so it lists and counts as if it named none (STATE-21)',
  'activity-miscounted':
    'counts one quiet task more than a list by activity holds, leaving its tasks as they are (STATE-21)',
  'epics-left-open': 'answers an epic the server closed on its own, with a reason no sender sent, as open (STATE-22)',
} as const;
export type Defect = keyof typeof DEFECTS;

export interface BrokenServer {
  readonly target: Target;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Starts the proxy in front of `backend` with `defect`, and answers the target that reaches it. */
export async function startBrokenServer(backend: Target, defect: Defect): Promise<BrokenServer> {
  const mcpPath = backend.bindings.mcp?.path ?? null;
  const httpPath = (backend.bindings.http?.path ?? '/api').replace(/\/$/u, '');
  const person = backend.senders.person?.headers;

  const forward = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; type: string; text: string }> => {
    const response = await fetch(new URL(path, backend.url), {
      method,
      headers,
      ...(body === undefined || method === 'GET' ? {} : { body }),
      redirect: 'manual',
    });
    return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
  };

  /** A tool call made to the backend as the same sender, for the proposal version a defect substitutes. */
  const currentProposal = async (headers: Record<string, string>, args: Json): Promise<unknown> => {
    const answer = await forward(
      'POST',
      mcpPath!,
      headers,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'broken-proxy',
        method: 'tools/call',
        params: {
          name: 'get_task',
          arguments: { task: args.task, ...(args.workspace ? { workspace: args.workspace } : {}) },
        },
      }),
    );
    const reply = JSON.parse(answer.text) as { result?: { structuredContent?: { proposalVersion?: unknown } } };
    return reply.result?.structuredContent?.proposalVersion ?? args.proposal_version;
  };

  /** Every close reason and evidence a sender sent through the proxy, so a close no sender sent stands out. */
  const sentReasons = new Set<string>();
  const recordReasons = (value: unknown): void => {
    if (Array.isArray(value)) for (const entry of value) recordReasons(entry);
    else if (isObject(value))
      for (const [key, entry] of Object.entries(value))
        if ((key === 'reason' || key === 'evidence') && typeof entry === 'string') sentReasons.add(entry);
        else recordReasons(entry);
  };

  /** A list's counts of activity, with the defect applied. */
  const readCounts = (counts: unknown): void => {
    if (defect === 'activity-miscounted' && isObject(counts)) counts.quiet = Number(counts.quiet) + 1;
  };

  /** A task as a read answers it, with the defect applied. */
  const readTask = (task: unknown): void => {
    if (defect === 'relays-unmarked' && isObject(task) && isObject(task.answer)) task.answer.relayed = false;
    if (defect === 'activity-misread' && isObject(task) && task.status === 'in_progress') task.activity = 'active';
    if (
      defect === 'epics-left-open' &&
      isObject(task) &&
      task.type === 'epic' &&
      task.status === 'closed' &&
      !sentReasons.has(String(task.closeReason))
    )
      Object.assign(task, { status: 'open', resolution: null, closeReason: null });
  };

  const mcp = async (
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; type: string; text: string }> => {
    const message = JSON.parse(body) as Json;
    const params = isObject(message.params) ? message.params : {};
    const tool = message.method === 'tools/call' ? String(params.name) : null;
    const args = isObject(params.arguments) ? params.arguments : {};
    if (tool !== null) {
      recordReasons(args);
      if (defect === 'retries-repeat' && typeof args.idempotency_key === 'string')
        args.idempotency_key = `broken-${randomBytes(8).toString('hex')}`;
      if (defect === 'models-dropped') delete args.model;
      if (defect === 'proof-dropped' && tool === 'close_task' && (args.resolution ?? 'done') === 'done')
        for (const proof of ['commit', 'pr', 'link']) delete args[proof];
      if (defect === 'stale-answers-accepted' && tool === 'reconcile_task')
        args.proposal_version = await currentProposal(headers, args);
      if (defect === 'activity-filter-ignored' && tool === 'list_tasks') delete args.activity;
    }
    const answer = await forward('POST', mcpPath!, headers, JSON.stringify(message));
    if (!answer.type.includes('application/json')) return answer;
    const reply = JSON.parse(answer.text) as Json;
    const result = isObject(reply.result) ? reply.result : null;
    if (result === null) return answer;
    if (message.method === 'initialize' && defect === 'held-tasks-hidden')
      result.instructions = 'Tasks that people and AI agents share.';
    if (tool === 'claim_task' && defect === 'two-claims-win' && result.isError === true) {
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      if (/is held by/u.test(text)) {
        const won = { id: args.task, status: 'in_progress', replayed: false };
        result.isError = false;
        result.content = [{ type: 'text', text: JSON.stringify(won) }];
        result.structuredContent = won;
      }
    }
    if ((tool === 'get_task' || tool === 'list_tasks') && isObject(result.structuredContent)) {
      readTask(result.structuredContent.task);
      if (Array.isArray(result.structuredContent.tasks))
        for (const task of result.structuredContent.tasks) readTask(task);
      readCounts(result.structuredContent.activities);
      result.content = [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
    }
    return { ...answer, text: JSON.stringify(reply) };
  };

  const http = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; type: string; text: string }> => {
    const route = path.slice(httpPath.length).split('?')[0] ?? '';
    const json = body === undefined || body === '' ? null : (JSON.parse(body) as Json);
    recordReasons(json);
    const decision =
      /^\/(?:tasks\/[^/]+\/(?:choose|respond|dismiss|dispute|accept)|gates\/[^/]+\/(?:resolve|steps))$/u.test(route);
    if (defect === 'disputes-refused' && /\/dispute$/u.test(route))
      return {
        status: 409,
        type: 'application/json',
        text: JSON.stringify({ error: 'task_refused', detail: 'Disputes are not taken.' }),
      };
    if (defect === 'agents-decide' && decision && person && headers.authorization !== undefined) {
      delete headers.authorization;
      delete headers['x-ntasks-on-behalf-of'];
      Object.assign(headers, person);
    }
    if (defect === 'retries-repeat' && headers['idempotency-key'] !== undefined)
      headers['idempotency-key'] = `broken-${randomBytes(8).toString('hex')}`;
    if (json !== null) {
      if (defect === 'stale-answers-accepted' && decision && json.proposalVersion !== undefined) {
        const task = route.split('/')[2] ?? '';
        const current = await forward(
          'GET',
          `${httpPath}/tasks/${task}?project=${encodeURIComponent(String(json.projectId))}`,
          headers,
          undefined,
        );
        json.proposalVersion = (JSON.parse(current.text) as { proposalVersion?: unknown }).proposalVersion;
      }
      if (defect === 'proof-dropped' && /\/close$/u.test(route) && (json.resolution ?? 'done') === 'done')
        for (const proof of ['commit', 'pullRequest', 'link']) delete json[proof];
    }
    let sent = path;
    if (defect === 'activity-filter-ignored' && method === 'GET' && route === '/tasks') {
      const url = new URL(path, backend.url);
      url.searchParams.delete('activity');
      sent = `${url.pathname}${url.search}`;
    }
    const answer = await forward(method, sent, headers, json === null ? body : JSON.stringify(json));
    if (defect === 'two-claims-win' && method === 'PATCH' && json?.claim === true && answer.status === 409) {
      const detail = (JSON.parse(answer.text) as { detail?: string }).detail ?? '';
      if (/held by|holds it/u.test(detail)) {
        const read = await forward('GET', `${path}?project=${String(json.projectId)}`, headers, undefined);
        return { status: 200, type: 'application/json', text: read.text };
      }
    }
    if (answer.type.includes('application/json') && answer.text !== '') {
      const value = JSON.parse(answer.text) as Json;
      readTask(value.task);
      if (Array.isArray(value.tasks)) for (const task of value.tasks) readTask(task);
      readCounts(value.activities);
      return { ...answer, text: JSON.stringify(value) };
    }
    return answer;
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers))
        if (typeof value === 'string' && !['host', 'content-length', 'connection'].includes(name))
          headers[name] = value;
      const path = request.url ?? '/';
      const method = request.method ?? 'GET';
      const answer =
        mcpPath !== null && path.split('?')[0] === mcpPath && method === 'POST' && body !== undefined
          ? mcp(headers, body)
          : http(method, path, headers, body);
      answer.then(
        ({ status, type, text }) => {
          response.writeHead(status, type === '' ? {} : { 'content-type': type });
          response.end(text);
        },
        (error: unknown) => {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'broken_proxy', detail: String(error) }));
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    target: { ...backend, url: `http://127.0.0.1:${port}` },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
