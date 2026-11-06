// The MCP transport (src/mcp/protocol.ts): one POST route that speaks both
// eras of the protocol, 2026-07-28's self-describing requests and the
// initialize handshake before it, in the runtime the Worker runs in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_LEGACY_VERSIONS,
  MCP_MODERN_VERSIONS,
  McpRefused,
  McpToolError,
  parseMcpMessage,
  serveMcp,
  type McpServeOptions,
  type McpServer,
} from '../../src/mcp/protocol.ts';

const URL_ = 'https://ntasks.test/api/mcp';
const MODERN = MCP_MODERN_VERSIONS[0]!;
const META = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };

type Body = Record<string, unknown>;

/** A JSON-RPC reply, with the fields these tests read. */
interface Reply {
  readonly result: {
    readonly [field: string]: unknown;
    readonly resultType?: string;
    readonly tools: readonly { readonly name: string }[];
    readonly content: readonly { readonly type: string; readonly text: string }[];
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
  };
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data: { readonly [field: string]: unknown };
  };
}

function server(): McpServer & { calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    info: { name: 'example-server', version: '1.0.0' },
    instructions: 'Start with echo.',
    tools: [
      { name: 'echo', description: 'Echo.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'refuse', description: 'Refuse.', inputSchema: { type: 'object' } },
      { name: 'fault', description: 'Fault.', inputSchema: { type: 'object' } },
    ],
    async call(name, args) {
      calls.push([name, args]);
      if (name === 'refuse') throw new McpToolError('refused: not yours');
      if (name === 'fault') throw new Error('password=secret in a SQL error');
      return { echoed: args };
    },
  };
}

function post(body: unknown, headers: Record<string, string> = {}, method = 'POST'): Request {
  return new Request(URL_, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

function legacy(
  method: string,
  params?: Body,
  { headers = {}, id = 1 }: { headers?: Record<string, string>; id?: number } = {},
) {
  return post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, headers);
}

function modern(
  method: string,
  params: Body = {},
  { headers = {} as Record<string, string>, meta = META as Body, id = 1 } = {},
) {
  return post(
    { jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } },
    {
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
      ...headers,
    },
  );
}

async function answer(request: Request, target: McpServer = server(), options?: McpServeOptions) {
  const response = await serveMcp(request, target, options);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : null) as Reply };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the 2026-07-28 era', () => {
  it('discovers, lists and calls with no handshake, and lists may be cached', async () => {
    const target = server();
    const discovered = await answer(modern('server/discover'), target);
    expect(discovered.status).toBe(200);
    expect(discovered.body.result).toEqual({
      resultType: 'complete',
      supportedVersions: [MODERN],
      capabilities: { tools: {} },
      instructions: 'Start with echo.',
      ttlMs: 300000,
      cacheScope: 'public',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'example-server', version: '1.0.0' } },
    });
    const listed = (await answer(modern('tools/list'), target)).body.result;
    expect([listed.resultType, listed.ttlMs, listed.cacheScope]).toEqual(['complete', 300000, 'public']);
    expect(listed.tools.map((tool) => tool.name)).toEqual(['echo', 'refuse', 'fault']);
    expect(Object.keys(listed.tools[0]!)).toEqual(['name', 'description', 'inputSchema', 'annotations']);
    expect((await answer(modern('ping'), target)).body.result.resultType).toBe('complete');

    const called = (await answer(modern('tools/call', { name: 'echo', arguments: { a: 1 } }), target)).body.result;
    expect([called.resultType, called.structuredContent, JSON.parse(called.content[0]!.text)]).toEqual([
      'complete',
      { echoed: { a: 1 } },
      { echoed: { a: 1 } },
    ]);
    // A name a header cannot carry plainly arrives base64-encoded and still matches.
    const encoded = `=?base64?${btoa('echo')}?=`;
    expect(
      (await answer(modern('tools/call', { name: 'echo' }, { headers: { 'mcp-name': encoded } }), target)).status,
    ).toBe(200);
    // Client info is optional; the client's capabilities are not.
    const withClient = { ...META, 'io.modelcontextprotocol/clientInfo': { name: 'agent', version: '1' } };
    expect((await answer(modern('ping', {}, { meta: withClient }), target)).status).toBe(200);
    const refused = (await answer(modern('tools/call', { name: 'refuse' }), target)).body.result;
    expect([refused.resultType, refused.isError, refused.content[0]!.text]).toEqual([
      'complete',
      true,
      'refused: not yours',
    ]);
  });

  it('refuses a request whose meta or headers disagree, before any tool runs', async () => {
    const target = server();
    const refusal = async (request: Request, status: number, code: number) => {
      const { status: got, body } = await answer(request, target);
      expect([got, body.error.code], JSON.stringify(body)).toEqual([status, code]);
      return body.error;
    };
    await refusal(modern('ping', {}, { meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } }), 400, -32602);
    const unsupported = await refusal(
      modern(
        'ping',
        {},
        {
          meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2027-01-01' },
          headers: { 'mcp-protocol-version': '2027-01-01' },
        },
      ),
      400,
      -32022,
    );
    expect(unsupported.data).toEqual({ supported: [MODERN], requested: '2027-01-01' });
    const mismatched: Record<string, string>[] = [
      { 'mcp-protocol-version': '2025-06-18' },
      { 'mcp-protocol-version': '' },
      { 'mcp-method': 'tools/list' },
      { 'mcp-name': 'refuse' },
      { 'mcp-name': '=?base64?not base64?=' },
    ];
    for (const headers of mismatched) {
      await refusal(modern('tools/call', { name: 'echo' }, { headers }), 400, -32020);
    }
    const missing = modern('tools/call', { name: 'echo' });
    missing.headers.delete('mcp-name');
    await refusal(missing, 400, -32020);
    await refusal(modern('resources/list'), 404, -32601);
    await refusal(modern('initialize', { protocolVersion: MODERN }), 404, -32601);
    await refusal(modern('tools/list', { cursor: 'next' }), 200, -32602);
    await refusal(modern('tools/call', { name: 'missing' }), 200, -32602);
    expect(target.calls).toEqual([]);
  });
});

describe('the initialize era', () => {
  it('agrees a version once, then reads it from a header on every request', async () => {
    const target = server();
    for (const [requested, agreed] of [
      ['2025-06-18', '2025-06-18'],
      ['2025-03-26', '2025-03-26'],
      ['2024-11-05', MCP_LEGACY_VERSIONS[0]],
      [MODERN, MCP_LEGACY_VERSIONS[0]],
    ]) {
      const { body } = await answer(
        legacy('initialize', {
          protocolVersion: requested,
          capabilities: {},
          clientInfo: { name: 'agent', version: '1' },
        }),
        target,
      );
      expect(body.result).toEqual({
        protocolVersion: agreed,
        capabilities: { tools: {} },
        serverInfo: { name: 'example-server', version: '1.0.0' },
        instructions: 'Start with echo.',
      });
    }
    expect((await answer(legacy('initialize', { capabilities: {} }), target)).body.error.code).toBe(-32602);
    const notified = await serveMcp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), target);
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe('');
    const versions: Record<string, string>[] = [
      {},
      { 'mcp-protocol-version': '2025-11-25' },
      { 'mcp-protocol-version': '2025-03-26' },
    ];
    for (const headers of versions) {
      const listed = await answer(legacy('tools/list', undefined, { headers }), target);
      expect(listed.status).toBe(200);
      // No 2026-07-28 fields in an older answer.
      expect(Object.keys(listed.body.result)).toEqual(['tools']);
    }
    const called = (await answer(legacy('tools/call', { name: 'echo', arguments: { b: 'x' } }), target)).body.result;
    expect(called).toEqual({
      content: [{ type: 'text', text: '{"echoed":{"b":"x"}}' }],
      structuredContent: { echoed: { b: 'x' } },
    });

    const unsupported = await answer(
      legacy('ping', undefined, { headers: { 'mcp-protocol-version': '2024-01-01' } }),
      target,
    );
    expect([unsupported.status, unsupported.body.error.code, unsupported.body.error.data.requested]).toEqual([
      400,
      -32022,
      '2024-01-01',
    ]);
    // A 2026-07-28 header, or discovery, without the meta is a modern request missing its version.
    for (const request of [
      legacy('ping', undefined, { headers: { 'mcp-protocol-version': MODERN } }),
      legacy('server/discover'),
    ]) {
      const { status, body } = await answer(request, target);
      expect([status, body.error.code]).toEqual([400, -32602]);
    }
    // Never a 404, which an older client reads as a lost session.
    const unknown = await answer(legacy('resources/list'), target);
    expect([unknown.status, unknown.body.error.code]).toEqual([200, -32601]);
    expect((await answer(legacy('tools/call', { name: 'missing' }), target)).body.error.code).toBe(-32602);
  });
});

describe('a tool fault', () => {
  it('is logged by name only and never echoed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const request of [legacy('tools/call', { name: 'fault' }), modern('tools/call', { name: 'fault' })]) {
      const { status, body } = await answer(request);
      expect([status, body.error.code, body.error.message]).toEqual([
        200,
        -32603,
        'tool fault failed; see the server log',
      ]);
      expect(JSON.stringify(body)).not.toMatch(/secret|SQL/u);
    }
    expect(logged.mock.calls).toEqual([
      ['MCP tool failed', 'example-server', 'fault'],
      ['MCP tool failed', 'example-server', 'fault'],
    ]);
  });
});

describe('the transport', () => {
  it('takes POST only, from the same origin, as application/json', async () => {
    const target = server();
    const got = await serveMcp(post(null, {}, 'GET'), target);
    expect([got.status, got.headers.get('allow'), ((await got.json()) as Reply).error.code]).toEqual([
      405,
      'POST',
      -32600,
    ]);
    expect(
      (await answer(legacy('ping', undefined, { headers: { origin: 'https://elsewhere.example' } }), target)).status,
    ).toBe(403);
    expect(
      (await answer(legacy('ping', undefined, { headers: { origin: 'https://ntasks.test' } }), target)).status,
    ).toBe(200);
    // A configured origin replaces the request's own.
    expect(
      (
        await answer(legacy('ping', undefined, { headers: { origin: 'https://ntasks.test' } }), target, {
          origin: 'https://public.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (await answer(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-type': 'text/plain' }), target)).status,
    ).toBe(415);
  });

  it('reads one bounded, strict JSON-RPC message', async () => {
    const target = server();
    for (const [body, status, code] of [
      ['{"jsonrpc":"2.0","id":1,"method":"ping","method":"tools/list"}', 400, -32700],
      ['{"jsonrpc":"2.0","id":1,"method":"ping"} trailing', 400, -32700],
      [{ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { pad: 'x'.repeat(70 * 1024) } } }, 400, -32700],
      [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], 400, -32600],
      [{ jsonrpc: '2.0', id: null, method: 'ping' }, 400, -32600],
      [{ jsonrpc: '2.0', id: 1.5, method: 'ping' }, 400, -32600],
      [{ jsonrpc: '1.0', id: 1, method: 'ping' }, 400, -32600],
      [{ jsonrpc: '2.0', id: 1, method: 'ping', extra: true }, 400, -32600],
      [{ jsonrpc: '2.0', id: 1, method: 'ping', params: { action: 'write' } }, 400, -32602],
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: [] } }, 400, -32602],
    ] as const) {
      const { status: got, body: reply } = await answer(post(body), target);
      expect([got, reply.error.code], JSON.stringify(body).slice(0, 80)).toEqual([status, code]);
    }
    // The bound is the caller's.
    const padded = post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { pad: 'x'.repeat(70 * 1024) } } });
    expect((await answer(padded, target, { maxBytes: 128 * 1024 })).status).toBe(200);
  });

  it('keeps a "__proto__" key an ordinary field', async () => {
    const target = server();
    const echoed = await answer(
      post('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"__proto__":{"x":1}}}}'),
      target,
    );
    expect(Object.getPrototypeOf(target.calls[0]![1])).toBe(Object.prototype);
    expect(Object.keys(target.calls[0]![1])).toEqual(['__proto__']);
    expect(JSON.parse(echoed.body.result.content[0]!.text).echoed.__proto__.x).toBe(1);
  });

  it('lets the endpoint refuse a message before its method runs', async () => {
    const target = server();
    const refused = await serveMcp(legacy('tools/call', { name: 'echo' }), target, {
      authorize: (message) =>
        message.method === 'tools/call' ? Response.json({ error: 'refused' }, { status: 403 }) : null,
    });
    expect(refused.status).toBe(403);
    expect(target.calls).toEqual([]);
  });
});

describe('parseMcpMessage', () => {
  it('reads every message the same way', () => {
    expect(
      parseMcpMessage({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'echo', _meta: META } }),
    ).toEqual({
      id: 'a',
      method: 'tools/call',
      params: { name: 'echo', _meta: META },
      version: MODERN,
    });
    expect(
      parseMcpMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'stop' } }),
    ).toEqual({
      method: 'notifications/cancelled',
      params: { requestId: 1, reason: 'stop' },
      version: null,
    });
    // A method no reader knows parses, and each reader decides; its params are not checked.
    expect(parseMcpMessage({ jsonrpc: '2.0', id: 1, method: 'future/method', params: { any: 1 } }).method).toBe(
      'future/method',
    );
  });

  it('refuses malformed messages', () => {
    for (const value of [
      null,
      [],
      {},
      { jsonrpc: '2.0', id: 1, method: '' },
      { jsonrpc: '2.0', id: 1, method: 'ping', params: [] },
      { jsonrpc: '2.0', id: 'x'.repeat(513), method: 'ping' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: [] } },
      { jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': 7 } } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
    ]) {
      expect(() => parseMcpMessage(value), JSON.stringify(value)).toThrow(McpRefused);
    }
  });
});
