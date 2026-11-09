/**
 * The wire: JSON over HTTP, and MCP's JSON-RPC over Streamable HTTP. A
 * server may answer an MCP request with one JSON object or with an event
 * stream; both are read. A session id the server hands out on `initialize`
 * is sent back on every later request of that connection.
 */

export interface HttpAnswer {
  readonly status: number;
  readonly headers: Headers;
  /** The parsed JSON body, or null when the body is empty or not JSON. */
  readonly body: unknown;
}

/** Every request the suite sends, so a report can show what a failed check did. */
export type Trace = (line: string) => void;

export async function sendJson(
  url: URL,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly trace?: Trace;
  },
): Promise<HttpAnswer> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    redirect: 'manual',
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    body = null;
  }
  init.trace?.(`${init.method} ${url.pathname}${url.search} → ${response.status}`);
  return { status: response.status, headers: response.headers, body };
}

/** The MCP revision the suite asks for in its `initialize` handshake. */
export const MCP_REVISION = '2025-06-18';

export interface ToolResult {
  readonly isError: boolean;
  /** The text of the result's first content item. */
  readonly text: string;
  /** The result's value: its structured content, else its text read as JSON, else null. */
  readonly value: unknown;
}

export class McpError extends Error {}

/** One MCP connection: an `initialize` handshake, then tool calls. */
export class McpConnection {
  private session: string | null = null;
  private nextId = 1;
  private readonly endpoint: URL;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly trace: Trace | undefined;
  instructions = '';

  constructor(endpoint: URL, headers: Readonly<Record<string, string>>, trace?: Trace) {
    this.endpoint = endpoint;
    this.headers = headers;
    this.trace = trace;
  }

  async initialize(): Promise<this> {
    const result = (await this.request('initialize', {
      protocolVersion: MCP_REVISION,
      capabilities: {},
      clientInfo: { name: 'shared-work-protocol-conformance', version: '0.0.0' },
    })) as { instructions?: unknown };
    this.instructions = typeof result.instructions === 'string' ? result.instructions : '';
    await this.notify('notifications/initialized');
    return this;
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      isError?: unknown;
      content?: { type?: string; text?: string }[];
      structuredContent?: unknown;
    };
    const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
    let value: unknown = result.structuredContent ?? null;
    if (value === null && !result.isError) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        value = null;
      }
    }
    this.trace?.(`  ${name} ${result.isError === true ? `refused: ${text.split('\n')[0]}` : 'answered'}`);
    return { isError: result.isError === true, text, value };
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: '2.0', method });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const reply = (await this.post({ jsonrpc: '2.0', id, method, params })) as {
      result?: unknown;
      error?: { code: number; message: string };
    } | null;
    if (reply === null) throw new McpError(`${method} answered nothing`);
    if (reply.error) throw new McpError(`${method} failed: ${reply.error.code} ${reply.error.message}`);
    if (!('result' in reply)) throw new McpError(`${method} answered neither a result nor an error`);
    return reply.result;
  }

  private async post(message: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      ...this.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_REVISION,
    };
    if (this.session !== null) headers['mcp-session-id'] = this.session;
    // A redirect is never followed, so a sender's credentials and the body never leave the target's origin.
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400)
      throw new McpError(
        `${String(message.method)} answered a redirect (${response.status}), which the suite does not follow`,
      );
    const session = response.headers.get('mcp-session-id');
    if (session !== null) this.session = session;
    if (!('id' in message)) {
      await response.body?.cancel();
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new McpError(`${String(message.method)} was refused sign-in: ${response.status}`);
    }
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) return replyIn(response, message.id);
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new McpError(`${String(message.method)} answered ${response.status} with no JSON`);
    }
  }
}

/**
 * The JSON-RPC reply to `id` in an event stream, read event by event: a
 * server may keep the stream open after it, so the read stops at the reply.
 */
async function replyIn(response: Response, id: unknown): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = done ? '' : (events.pop() ?? '');
      for (const event of events) {
        const reply = replyOf(event, id);
        if (reply !== null) return reply;
      }
      if (done) return null;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The message one event carries, when it is the reply to `id`. */
function replyOf(event: string, id: unknown): unknown {
  const data = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data === '') return null;
  try {
    const message = JSON.parse(data) as { id?: unknown };
    return message.id === id ? message : null;
  } catch {
    return null;
  }
}
